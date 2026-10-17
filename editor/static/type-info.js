// The info diagram: Mermaid's version, nothing to name or link.

export default {
  id: 'info',
  name: 'Info',
  header: /^info\b/,
  lexer: { keywords: ['showInfo', 'title', 'accTitle', 'accDescr'] },
  indent: 'depth',
  snippets: [],
  starter: 'info\nshowInfo',
}
