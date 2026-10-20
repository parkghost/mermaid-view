"""The editor as an MCP server: JSON-RPC 2.0 over Streamable HTTP at POST /mcp, the protocol
only (what the tools do is mcp_tools.py's). Each POST carries one message and is answered with
one JSON object (application/json), never an SSE stream: the tools answer at once and the server
sends nothing unasked.

Both eras of the protocol are served on the same endpoint:
  - modern, 2026-07-28: stateless. Every request carries its version and the client's
    capabilities in params._meta, mirrored in the MCP-Protocol-Version, Mcp-Method and
    Mcp-Name headers (a mismatch is refused); server/discover tells what is supported.
  - legacy, 2025-11-25 back to 2025-03-26: an initialize handshake picks the version, later
    requests name it in MCP-Protocol-Version (absent: 2025-03-26). No session is kept, so no
    Mcp-Session-Id is given and DELETE has nothing to end. Batches only in 2025-03-26, the one
    version that had them.
GET (a server-to-client stream) and DELETE are 405 in either era.

Origin is checked against DNS rebinding: a browser's request is taken from a localhost page only;
a request without Origin (not from a browser) is taken. The caller checks Host.
"""

from __future__ import annotations

import base64
import json
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Protocol
from urllib.parse import urlsplit

MODERN = "2026-07-28"
LEGACY = ("2025-11-25", "2025-06-18", "2025-03-26")  # newest first: initialize falls back to the first
WITHOUT_HEADER = "2025-03-26"  # what a request without MCP-Protocol-Version speaks
META = "io.modelcontextprotocol/"
LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}
TOOLS_TTL_MS = 3_600_000  # the tools never change while the server runs

# JSON-RPC's codes, and MCP's own (-32020 and up).
PARSE_ERROR, INVALID_REQUEST, METHOD_NOT_FOUND, INVALID_PARAMS, INTERNAL_ERROR = -32700, -32600, -32601, -32602, -32603
HEADER_MISMATCH, UNSUPPORTED_VERSION = -32020, -32022


class Headers(Protocol):
    def get(self, name: str, default: Any = None) -> Any: ...


class ToolError(Exception):
    """A tool could not do what it was asked (no such page, a conflict): the model reads why and
    can try again. structured: what the result carries besides the message."""

    def __init__(self, message: str, structured: dict | None = None):
        super().__init__(message)
        self.structured = structured


@dataclass(frozen=True)
class Result:
    """What a tool returns: text for the model, and the same as data when there is some."""

    text: str
    structured: dict | None = None


@dataclass(frozen=True)
class Tool:
    name: str
    title: str
    description: str
    input_schema: dict
    run: Callable[[dict], Result]  # raises ToolError
    annotations: dict = field(default_factory=dict)

    def listing(self) -> dict:
        return {
            "name": self.name,
            "title": self.title,
            "description": self.description,
            "inputSchema": self.input_schema,
            "annotations": self.annotations,
        }


@dataclass
class Reply:
    """The HTTP answer to a POST: a status and a JSON body (None: no body, 202)."""

    status: int
    body: Any = None


class Failure(Exception):
    """A JSON-RPC error answer, with the HTTP status it goes back with."""

    def __init__(self, code: int, message: str, status: int = 200, data: Any = None):
        super().__init__(message)
        self.code, self.status, self.data = code, status, data

    def body(self, msg_id: Any = None) -> dict:
        error = {"code": self.code, "message": str(self)}
        if self.data is not None:
            error["data"] = self.data
        out: dict = {"jsonrpc": "2.0", "error": error}
        if msg_id is not None:
            out["id"] = msg_id
        return out


def origin_allowed(origin: str | None) -> bool:
    """No Origin (not a browser), or a page on this machine."""
    if origin is None:
        return True
    try:
        parts = urlsplit(origin)
        host = parts.hostname
    except ValueError:
        return False
    return parts.scheme in ("http", "https") and host in LOCAL_HOSTS


def header_value(raw: str | None) -> str | None:
    """A mirrored header's value, its Base64 form (=?base64?...?=) decoded."""
    if raw is not None and raw.startswith("=?base64?") and raw.endswith("?="):
        try:
            return base64.b64decode(raw[9:-2], validate=True).decode("utf-8")
        except ValueError:
            return None
    return raw


def invalid_arguments(args: dict, schema: dict) -> str | None:
    """Why arguments do not fit a tool's schema (its required properties and their types), or
    None. Enough for the schemas the tools declare: strings, integers, arrays of strings."""
    props = schema.get("properties", {})
    for name in schema.get("required", []):
        if name not in args:
            return f"missing argument: {name}"
    for name, value in args.items():
        spec = props.get(name)
        if spec is None:
            if schema.get("additionalProperties") is False:
                return f"unknown argument: {name}"
            continue
        kind = spec.get("type")
        ok = {
            "string": isinstance(value, str),
            "integer": isinstance(value, int) and not isinstance(value, bool),
            "boolean": isinstance(value, bool),
            "array": isinstance(value, list) and all(isinstance(v, str) for v in value),
        }.get(kind, True)
        if not ok:
            return f"{name} must be {'an array of strings' if kind == 'array' else f'a {kind}'}"
        if "enum" in spec and value not in spec["enum"]:
            return f"{name} must be one of {', '.join(map(str, spec['enum']))}"
        if kind == "integer" and value < spec.get("minimum", value):
            return f"{name} must be at least {spec['minimum']}"
        if kind == "array" and len(value) < spec.get("minItems", 0):
            return f"{name} needs at least {spec['minItems']} item(s)"
    return None


class Endpoint:
    """The MCP endpoint over a set of tools: a POST's headers and body in, the reply out."""

    def __init__(self, tools: list[Tool], name: str, version: str, instructions: str = ""):
        self.tools = {t.name: t for t in tools}
        self.info = {"name": name, "version": version}
        self.instructions = instructions

    # ---- HTTP

    def post(self, headers: Headers, body: bytes) -> Reply:
        accept = headers.get("Accept") or ""
        if accept and not any(t in accept for t in ("application/json", "application/*", "*/*")):
            return Reply(406, Failure(INVALID_REQUEST, "Not Acceptable: the reply is application/json").body())
        if (headers.get("Content-Type") or "").split(";")[0].strip() != "application/json":
            return Reply(415, Failure(INVALID_REQUEST, "Unsupported Media Type: send application/json").body())
        try:
            message = json.loads(body)
        except ValueError:
            return Reply(400, Failure(PARSE_ERROR, "Parse error").body())
        if isinstance(message, list):
            return self._batch(headers, message)
        status, reply = self._one(headers, message, batched=False)
        return Reply(status, reply)

    def _batch(self, headers: Headers, messages: list) -> Reply:
        """A JSON array of messages: only 2025-03-26 had them."""
        version = headers.get("MCP-Protocol-Version") or WITHOUT_HEADER
        if version != WITHOUT_HEADER:
            return Reply(400, Failure(INVALID_REQUEST, f"Batches are not part of protocol version {version}").body())
        if not messages:
            return Reply(400, Failure(INVALID_REQUEST, "Empty batch").body())
        replies = [reply for _, reply in (self._one(headers, m, batched=True) for m in messages) if reply is not None]
        return Reply(200, replies) if replies else Reply(202)

    def _one(self, headers: Headers, message: Any, batched: bool) -> tuple[int, dict | None]:
        """One message: (HTTP status, the JSON-RPC answer or None for a notification)."""
        msg_id = message.get("id") if isinstance(message, dict) else None
        try:
            if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
                raise Failure(INVALID_REQUEST, "Invalid Request", 400)
            if "method" not in message and ("result" in message or "error" in message):
                return 202, None  # a client's answer: the server asks nothing, so none is awaited
            method, params = message.get("method"), message.get("params", {})
            if not isinstance(method, str) or not isinstance(params, dict):
                raise Failure(INVALID_REQUEST, "Invalid Request", 400)
            if "id" not in message:
                return 202, None  # a notification (notifications/initialized, cancelled, ...): nothing to answer
            if not isinstance(msg_id, (str, int)) or isinstance(msg_id, bool):
                msg_id = None
                raise Failure(INVALID_REQUEST, "The id must be a string or an integer", 400)
            meta = params.get("_meta")
            modern = isinstance(meta, dict) and f"{META}protocolVersion" in meta
            result = self._modern(headers, method, params) if modern else self._legacy(headers, method, params, batched)
            return 200, {"jsonrpc": "2.0", "id": msg_id, "result": result}
        except Failure as f:
            return f.status, f.body(msg_id)
        except Exception as err:  # noqa: BLE001 (a bug in a tool must not end the server)
            return 500, Failure(INTERNAL_ERROR, f"Internal error: {err}").body(msg_id)

    # ---- the two eras

    def _modern(self, headers: Headers, method: str, params: dict) -> dict:
        meta = params["_meta"]
        version = meta.get(f"{META}protocolVersion")
        if version != MODERN:
            raise Failure(
                UNSUPPORTED_VERSION,
                "Unsupported protocol version",
                400,
                {"supported": [MODERN, *LEGACY], "requested": version},
            )
        if not isinstance(meta.get(f"{META}clientCapabilities"), dict):
            raise Failure(INVALID_PARAMS, f"Missing _meta {META}clientCapabilities", 400)
        mirrored = [("MCP-Protocol-Version", version), ("Mcp-Method", method)]
        if method == "tools/call":
            mirrored.append(("Mcp-Name", params.get("name")))
        for name, body_value in mirrored:
            value = header_value(headers.get(name))
            if value is None:
                raise Failure(HEADER_MISMATCH, f"Header mismatch: {name} is missing", 400)
            if value != body_value:
                raise Failure(
                    HEADER_MISMATCH,
                    f"Header mismatch: {name} header value {value!r} does not match body value {body_value!r}",
                    400,
                )
        if method == "server/discover":
            result = {
                "supportedVersions": [MODERN, *LEGACY],
                "capabilities": self._capabilities(),
                "instructions": self.instructions,
            }
        elif method == "tools/list":
            result = {"tools": self._listing(), "ttlMs": TOOLS_TTL_MS, "cacheScope": "private"}
        elif method == "tools/call":
            result = self._call(params)
        else:
            raise Failure(METHOD_NOT_FOUND, f"Method not found: {method}", 404)
        return {"resultType": "complete", **result, "_meta": {f"{META}serverInfo": self.info}}

    def _legacy(self, headers: Headers, method: str, params: dict, batched: bool) -> dict:
        if method == "initialize":
            if batched:
                raise Failure(INVALID_REQUEST, "initialize cannot be part of a batch")
            requested = params.get("protocolVersion")
            # The client's version when it is one of these, else the newest: the client decides
            # whether it can speak that.
            return {
                "protocolVersion": requested if requested in LEGACY else LEGACY[0],
                "capabilities": self._capabilities(),
                "serverInfo": self.info,
                "instructions": self.instructions,
            }
        version = headers.get("MCP-Protocol-Version") or WITHOUT_HEADER
        if version not in LEGACY:
            if version == MODERN:
                raise Failure(INVALID_PARAMS, f"Missing _meta {META}protocolVersion (required in {MODERN})", 400)
            raise Failure(
                UNSUPPORTED_VERSION,
                "Unsupported protocol version",
                400,
                {"supported": [MODERN, *LEGACY], "requested": version},
            )
        if method == "ping":
            return {}
        if method == "tools/list":
            return {"tools": self._listing()}
        if method == "tools/call":
            return self._call(params)
        raise Failure(METHOD_NOT_FOUND, f"Method not found: {method}")

    # ---- tools

    def _capabilities(self) -> dict:
        return {"tools": {"listChanged": False}}

    def _listing(self) -> list[dict]:
        return [t.listing() for t in self.tools.values()]

    def _call(self, params: dict) -> dict:
        name, args = params.get("name"), params.get("arguments", {})
        tool = self.tools.get(name) if isinstance(name, str) else None
        if tool is None:
            raise Failure(INVALID_PARAMS, f"Unknown tool: {name}")
        if not isinstance(args, dict):
            raise Failure(INVALID_PARAMS, "arguments must be an object")
        problem = invalid_arguments(args, tool.input_schema)
        if problem:
            return {"content": [{"type": "text", "text": f"Invalid arguments: {problem}."}], "isError": True}
        try:
            result = tool.run(args)
        except ToolError as err:
            out = {"content": [{"type": "text", "text": str(err)}], "isError": True}
            if err.structured is not None:
                out["structuredContent"] = err.structured
            return out
        out = {"content": [{"type": "text", "text": result.text}], "isError": False}
        if result.structured is not None:
            out["structuredContent"] = result.structured
        return out
