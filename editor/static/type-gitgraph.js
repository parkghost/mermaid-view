// Git graphs: branches (declared by `branch`, used by checkout/switch/merge; `main` is there
// from the start) and commit ids (`id: "x"`, used by cherry-pick and `parent:`); the drawing's
// commits in order (each carries its id as a class) and branch labels.

import { t } from './i18n.js'
import { duplicates, scan, symbolList } from './type-core.js'

const BRANCH = '([\\w][-.\\/\\w]*[-\\w]|\\w|"[^"]*"|\'[^\']*\')'
const COMMIT_STMT = /^\s*(commit|merge|cherry-pick)\b/

// A quoted name's inner text (the symbol is what is inside the quotes).
const unquote = h => (/^["']/.test(h.name) ? { name: h.name.slice(1, -1), start: h.start + 1, end: h.end - 1 } : h)

function symbols(lines) {
  const out = symbolList()
  lines.forEach((l, i) => {
    const n = i + 1
    let m
    if ((m = scan(l, new RegExp(`^\\s*branch\\s+${BRANCH}`))).length) out.add(unquote(m[0]), n, true, 'branch')
    else if ((m = scan(l, new RegExp(`^\\s*(?:checkout|switch|merge)\\s+${BRANCH}`))).length)
      out.add(unquote(m[0]), n, false, 'branch')
    const stmt = COMMIT_STMT.exec(l)?.[1]
    for (const h of scan(l, /\bid:\s*("[^"]*"|'[^']*')/)) out.add(unquote(h), n, stmt !== 'cherry-pick', 'commit')
    for (const h of scan(l, /\bparent:\s*("[^"]*"|'[^']*')/)) out.add(unquote(h), n, false, 'commit')
  })
  return out.list
}

// Commits in order: `commit`, `merge` and `cherry-pick` each make one, numbered from 0.
function items(lines) {
  const out = []
  lines.forEach((l, i) => {
    if (!COMMIT_STMT.test(l)) return
    const id = /\bid:\s*["']([^"']*)["']/.exec(l)?.[1]
    out.push({ key: `commit:${out.length}`, line: i + 1, id: /^\s*cherry-pick\b/.test(l) ? undefined : id })
  })
  return out
}

export default {
  id: 'gitGraph',
  name: 'Git graph',
  header: /^gitGraph\b/,
  lexer: {
    keywords: [
      'commit',
      'branch',
      'merge',
      'checkout',
      'switch',
      'cherry-pick',
      'id',
      'msg',
      'tag',
      'type',
      'order',
      'parent',
      'NORMAL',
      'REVERSE',
      'HIGHLIGHT',
      'LR',
      'TB',
      'BT',
      'title',
      'accTitle',
      'accDescr',
    ],
    id: /^[A-Za-z_][\w./-]*/,
    numbers: true,
  },
  indent: 'depth',
  symbols,
  items,
  idPattern: /^[\w][-./\w]*$/,
  idHint: t('A branch name may only use letters, digits, _, -, . and /'),
  check(ctx) {
    const findings = [
      ...duplicates(
        ctx.symbols,
        (name, line) => t('Branch {name} is already created on line {line}', { name, line }),
        'branch',
      ),
      ...duplicates(
        ctx.symbols,
        (name, line) => t('Commit id "{name}" is already used on line {line}', { name, line }),
        'commit',
      ),
    ]
    // The first branch is `main`, or what the config's gitGraph.mainBranchName says.
    const config = ctx.text
      .split('\n')
      .slice(0, Math.max(0, ctx.header - 1))
      .join('\n')
    const main = /mainBranchName["']?\s*:\s*["']?([^"'\s,}]+)/.exec(config)?.[1] ?? 'main'
    const branches = new Set([main, ...ctx.symbols.filter(s => s.kind === 'branch' && s.def).map(s => s.name)])
    for (const s of ctx.symbols) {
      if (s.kind === 'branch' && !s.def && !branches.has(s.name))
        findings.push({
          line: s.line,
          severity: 'error',
          rule: 'undeclared',
          message: t('No branch {name}: create it first with branch {name}', { name: s.name }),
        })
    }
    return findings
  },
  snippets: [
    [t('commit'), 'commit id: "${1:id}"'],
    [t('branch'), 'branch ${1:feature}\ncheckout ${1:feature}'],
    [t('checkout'), 'checkout ${1:main}'],
    [t('merge'), 'merge ${1:feature}'],
    [t('cherry-pick'), 'cherry-pick id: "${1:id}"'],
  ],
  starter:
    'gitGraph\n\tcommit id: "${1:init}"\n\tbranch ${2:develop}\n\tcheckout ${2:develop}\n\tcommit\n\tcheckout main\n\tmerge ${2:develop}',
  link: {
    kinds: [
      {
        selector: 'g.commit-bullets .commit',
        info: el => ({ commit: [...el.classList].find(c => !/^commit(-|\d|$)/.test(c)) }),
        key: (rec, ctx) => commitKey(rec.commit, ctx.model.items),
      },
      {
        selector: 'g.branchLabel',
        key: (rec, ctx) => (ctx.model.names.includes(rec.text) ? `node:${rec.text}` : undefined),
      },
    ],
  },
}

// A commit's class is its id: a custom one, or "<seq>-<hash>" (seq counts the commits from 0).
function commitKey(id, items) {
  if (!id) return undefined
  const custom = items.find(it => it.id === id)
  if (custom) return custom.key
  const seq = /^(\d+)-[0-9a-f]+$/.exec(id)?.[1]
  return seq !== undefined && items[Number(seq)] ? items[Number(seq)].key : undefined
}
