// node --test editor/static/diagram-types.test.mjs
// Every diagram type beyond the flowchart: detection, tokens, blocks and folding, formatting,
// names (rename, definition), lint, and the drawn elements' DOM records (recorded from
// Mermaid 12.1.0's renders) mapped back to source lines.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { keyOfRecord } from './diagram-link.js'
import {
  definition,
  foldingRanges,
  format,
  initialState,
  lineTokens,
  linkModel,
  lint,
  occurrences,
  rename,
  renameProblem,
  symbolAt,
  symbols,
  TYPES,
  typeOf,
} from './mermaid-lang.js'

const S = {
  sequence: `sequenceDiagram
    participant A as Alice
    actor B
    A->>+B: hello
    loop every min
        B-->>A: tick
    end
    Note right of A: n1
    alt ok
        A->>B: yes
    else no
        A-xB: no
    end
    B-->>-A: done
`,
  class: `classDiagram
    direction LR
    class Animal {
        +String name
        +eat() void
    }
    class Duck["Duck bird"]
    Animal <|-- Duck : extends
    Animal "1" *-- "many" Leg
    namespace Zoo {
        class Keeper
    }
    Keeper --> Animal
    note for Duck "quacks"
`,
  state: `stateDiagram-v2
    [*] --> Still
    state "Moving fast" as Moving
    Still --> Moving : push
    Moving --> Still
    state Crash {
        [*] --> Broken
        Broken --> [*]
    }
    Moving --> Crash
    state fork1 <<fork>>
    note right of Still : resting
`,
  er: `erDiagram
    CUSTOMER ||--o{ ORDER : places
    ORDER ||--|{ LINE_ITEM : contains
    CUSTOMER {
        string name PK
        string email
    }
    p["Product item"] {
        int id
    }
    LINE_ITEM }o--|| p : refers
`,
  requirement: `requirementDiagram
    requirement test_req {
        id: 1
        text: the test text.
        risk: high
        verifymethod: test
    }
    element test_entity {
        type: simulation
    }
    test_entity - satisfies -> test_req
`,
  c4: `C4Context
    title System Context
    Person(customerA, "Banking Customer A", "A customer")
    Enterprise_Boundary(b0, "BankBoundary") {
        System(SystemAA, "Internet Banking System", "Allows customers")
        SystemDb(db1, "Database")
    }
    Rel(customerA, SystemAA, "Uses")
    BiRel(SystemAA, db1, "Reads")
`,
  gantt: `gantt
    title A Gantt Diagram
    dateFormat YYYY-MM-DD
    section Section
        A task           :a1, 2014-01-01, 30d
        Another task     :after a1, 20d
    section Another
        Task in sec      :2014-01-12, 12d
        another task     :24d
`,
  gitGraph: `gitGraph
    commit id: "init"
    branch develop
    checkout develop
    commit
    commit id: "feat"
    checkout main
    merge develop
    commit type: HIGHLIGHT
    cherry-pick id: "feat"
`,
  architecture: `architecture-beta
    group api(cloud)[API]
    service db(database)[Database] in api
    service server(server)[Server] in api
    service disk1(disk)[Storage] in api
    junction j1
    db:L -- R:server
    disk1:T -- B:server
`,
  block: `block
    columns 3
    a["A label"] b c
    block:group1:2
        columns 2
        d e
    end
    f
    a --> d
    b -- "x" --> f
`,
  mindmap: `mindmap
    root((mindmap))
        Origins
            Long history
            Popularisation
        Research
            id1[On effectiveness]
        Tools
`,
}

test('every type is detected by its keyword line, after front matter and comments', () => {
  const heads = {
    flowchart: 'flowchart LR',
    sequence: 'sequenceDiagram',
    class: 'classDiagram-v2',
    state: 'stateDiagram',
    er: 'erDiagram',
    requirement: 'requirementDiagram',
    c4: 'C4Container',
    gantt: 'gantt',
    pie: 'pie showData',
    journey: 'journey',
    timeline: 'timeline',
    mindmap: 'mindmap',
    kanban: 'kanban',
    gitGraph: 'gitGraph LR:',
    quadrant: 'quadrantChart',
    xychart: 'xychart-beta horizontal',
    sankey: 'sankey-beta',
    packet: 'packet-beta',
    block: 'block-beta',
    architecture: 'architecture-beta',
    radar: 'radar-beta',
    treemap: 'treemap-beta',
    treeView: 'treeView-beta',
    eventmodeling: 'eventmodeling',
    ishikawa: 'ishikawa-beta',
    venn: 'venn-beta',
    usecase: 'usecase-beta',
    wardley: 'wardley-beta',
    cynefin: 'cynefin-beta',
    railroad: 'railroad-beta',
    railroadEbnf: 'railroad-ebnf-beta',
    railroadAbnf: 'railroad-abnf-beta',
    railroadPeg: 'railroad-peg-beta',
    swimlane: 'swimlane-beta LR',
    agentflow: 'agentflow-beta',
    zenuml: 'zenuml',
    info: 'info',
  }
  for (const [id, head] of Object.entries(heads)) {
    assert.equal(typeOf(`---\ntitle: x\n---\n%%{init: {}}%%\n%% note\n${head}\n`).id, id, head)
  }
  for (const d of TYPES) assert.ok(d.id in heads, `${d.id}: not covered here`) // every registered type is
  assert.equal(typeOf('plantuml\n  A -> B').id, '') // not a Mermaid diagram
})

test('every type has a starter that is detected as itself and lints clean', () => {
  for (const d of TYPES) {
    const text = d.starter
      .replace(/\$\{\d+(?::([^}]*))?\}/g, '$1')
      .replace(/\$\{\d+\|([^,|]*)[^}]*\}/g, '$1')
      .replace(/\$0/g, '')
      .replace(/\t/g, '    ')
    assert.equal(typeOf(text).id, d.id, d.id)
    assert.deepEqual(
      lint(text).filter(f => f.severity === 'error'),
      [],
      d.id,
    )
  }
})

const typesOf = (text, n) => {
  let state = initialState()
  let out
  text
    .split('\n')
    .slice(0, n)
    .forEach(line => ({ tokens: out, state } = lineTokens(line, state)))
  return out.filter(t => t.type !== 'space').map(t => `${t.type}:${t.text}`)
}

test('highlighting follows the type of the keyword line', () => {
  assert.deepEqual(typesOf(S.sequence, 4), ['id:A', 'arrow:->>+', 'id:B', 'punct::', 'label: hello'])
  assert.deepEqual(typesOf(S.er, 2), ['id:CUSTOMER', 'arrow:||--o{', 'id:ORDER', 'punct::', 'label: places'])
  assert.deepEqual(typesOf(S.gantt, 5).slice(0, 3), ['label:A task           ', 'punct::', 'id:a1'])
  assert.deepEqual(typesOf('---\ntitle: a\n---\npie\n    "Dogs" : 386', 5), ['string:"Dogs"', 'punct::', 'number:386'])
  assert.deepEqual(typesOf('---\ntitle: a', 2), ['meta:title: a'])
  assert.deepEqual(typesOf('classDiagram\n    accDescr {\n    two words\n    }', 3), ['string:    two words'])
  assert.deepEqual(typesOf('railroad-peg-beta\nNum <- Digit+ ; # c', 2), [
    'id:Num',
    'arrow:<-',
    'id:Digit',
    'arrow:+',
    'punct:;',
    'comment:# c',
  ])
})

test('blocks fold and their balance is checked, keyword-end and braces alike', () => {
  assert.deepEqual(foldingRanges(S.sequence), [
    { start: 5, end: 7 },
    { start: 9, end: 13 },
  ])
  assert.deepEqual(foldingRanges(S.class), [
    { start: 3, end: 6 },
    { start: 10, end: 12 },
  ])
  assert.deepEqual(foldingRanges(S.state), [{ start: 6, end: 9 }])
  assert.deepEqual(foldingRanges(S.er), [
    { start: 4, end: 7 },
    { start: 8, end: 10 },
  ]) // `o{` is a cardinality
  assert.deepEqual(foldingRanges(S.gantt), [
    { start: 4, end: 6 },
    { start: 7, end: 9 },
  ]) // sections
  assert.deepEqual(foldingRanges(S.block), [{ start: 4, end: 7 }])
  assert.deepEqual(foldingRanges(S.mindmap), [
    { start: 2, end: 8 },
    { start: 3, end: 5 },
    { start: 6, end: 7 },
  ]) // indentation
  assert.deepEqual(foldingRanges('---\ntitle: a\n---\npie\n  "a" : 1'), [{ start: 1, end: 3 }])
  const rules = t => lint(t).map(f => `${f.line}:${f.rule}`)
  assert.deepEqual(rules('sequenceDiagram\n  loop x\n  A->>B: y\n'), ['2:block-balance'])
  assert.deepEqual(rules('classDiagram\n  class A {\n  +x\n'), ['2:block-balance'])
  assert.deepEqual(rules('stateDiagram\n  A --> B\n  }\n'), ['3:block-balance'])
  assert.deepEqual(rules('stateDiagram\n  note left of A\n  text\n'), ['2:block-balance'])
  assert.deepEqual(rules('sequenceDiagram\n  box Aqua\n  participant A\n  end\n  end\n'), ['5:block-balance'])
})

test('format indents by depth where indentation is free, and only tidies where it is meaning', () => {
  const messy =
    'stateDiagram-v2\n[*] --> A\nstate A {\n[*] --> B\nnote left of B\n  keep   this\nend note\n}\n\n\n%% c\n'
  assert.equal(
    format(messy),
    'stateDiagram-v2\n    [*] --> A\n    state A {\n        [*] --> B\n        note left of B\n  keep   this\n        end note\n    }\n\n    %% c\n',
  )
  assert.equal(
    format('---\ntitle:  x\n---\ngantt\nsection A\nT :a, 2024-01-01, 1d\n'),
    '---\ntitle:  x\n---\ngantt\n    section A\n        T :a, 2024-01-01, 1d\n',
  )
  assert.equal(
    format('mindmap\n  root\n\t\tchild   \n\n\n      other\n'),
    'mindmap\n  root\n\t\tchild\n\n      other\n',
  )
  assert.equal(format('railroad-abnf-beta\na = "x" ; \n'), 'railroad-abnf-beta\na = "x" ; \n') // `; ` is a comment there
  const strip = s => s.replace(/\s+/g, '')
  for (const [name, text] of Object.entries(S)) {
    const once = format(text)
    assert.equal(format(once), once, `${name}: idempotent`)
    assert.equal(strip(once), strip(text), `${name}: only whitespace changes`)
  }
})

test('names: occurrences, definition and rename per type', () => {
  assert.deepEqual(
    occurrences(S.sequence, 'A').map(o => o.line),
    [2, 4, 6, 8, 10, 12, 14],
  )
  assert.deepEqual(definition(S.sequence, 'A'), { line: 2, start: 17, end: 18 })
  assert.equal(rename(S.sequence, 'A', 'Ann').split('\n')[7], '    Note right of Ann: n1')
  assert.equal(symbolAt(S.sequence, 4, 6).name, 'A')
  assert.equal(symbolAt(S.sequence, 4, 16), undefined) // message text
  assert.equal(occurrences('sequenceDiagram\n  John Doe->>Bob: hi\n  participant John Doe', 'John Doe').length, 2)

  assert.deepEqual(
    occurrences(S.class, 'Animal').map(o => o.line),
    [3, 8, 9, 13],
  )
  assert.deepEqual(occurrences(S.class, 'name'), []) // a member, not a class
  assert.deepEqual(
    occurrences(S.state, 'Moving').map(o => o.line),
    [3, 4, 5, 10],
  )
  assert.equal(definition(S.state, 'Moving').line, 3)
  assert.deepEqual(
    occurrences(S.er, 'p').map(o => o.line),
    [8, 11],
  )
  assert.equal(definition(S.er, 'CUSTOMER').line, 4)
  assert.deepEqual(
    occurrences(S.requirement, 'test_req').map(o => o.line),
    [2, 11],
  )
  assert.deepEqual(
    occurrences(S.c4, 'SystemAA').map(o => o.line),
    [5, 8, 9],
  )
  assert.deepEqual(
    occurrences(S.gantt, 'a1').map(o => o.line),
    [5, 6],
  )
  assert.equal(rename(S.gantt, 'a1', 'design').split('\n')[5], '        Another task     :after design, 20d')
  assert.deepEqual(
    occurrences(S.gitGraph, 'develop').map(o => o.line),
    [3, 4, 8],
  )
  assert.deepEqual(
    occurrences(S.gitGraph, 'feat').map(o => o.line),
    [6, 10],
  )
  assert.equal(rename(S.gitGraph, 'feat', 'f2').split('\n')[9], '    cherry-pick id: "f2"')
  assert.deepEqual(
    occurrences(S.architecture, 'server').map(o => o.line),
    [4, 7, 8],
  )
  assert.deepEqual(
    occurrences(S.architecture, 'api').map(o => o.line),
    [2, 3, 4, 5],
  )
  assert.deepEqual(
    occurrences(S.block, 'd').map(o => o.line),
    [6, 9],
  )
  assert.deepEqual(
    occurrences('sankey\nA b,C,1\nC,D,2\n', 'C').map(o => `${o.line}:${o.start}`),
    ['2:5', '3:1'],
  )
  assert.deepEqual(
    occurrences('railroad-ebnf-beta\nexpr = term ;\nterm = "x" ;\n', 'term').map(o => o.line),
    [2, 3],
  )
  assert.deepEqual(
    occurrences('wardley-beta\ncomponent Cup of Tea [0.5, 0.5]\nUser -> Cup of Tea\n', 'Cup of Tea').length,
    2,
  )
  // ZenUML: a participant in a declaration, an async message, a call, a reply and `new`; not a
  // variable, a parameter, a condition or message text.
  const zen =
    'zenuml\n  @Actor Ann\n  Ann->Shop: buy Shop now\n  Ann->Shop.pay(Bank) {\n    x = Bank.charge()\n    if(Shop.ok) {\n      new Receipt(Ann)\n    }\n  }'
  assert.deepEqual(
    occurrences(zen, 'Shop').map(o => o.line),
    [3, 4],
  )
  assert.deepEqual(
    occurrences(zen, 'Bank').map(o => o.line),
    [5],
  )
  assert.deepEqual([...new Set(symbols(zen).map(x => x.name))].sort(), ['Ann', 'Bank', 'Receipt', 'Shop'])
  assert.equal(definition(zen, 'Ann').line, 2)
  assert.equal(rename(zen, 'Ann', 'Amy').split('\n')[3], '  Amy->Shop.pay(Bank) {')

  assert.equal(renameProblem(S.sequence, 'A', 'B'), 'An element named B already exists')
  assert.match(renameProblem(S.state, 'Still', 'a-b'), /state ID/)
  assert.equal(renameProblem(S.class, 'Duck', 'Goose'), undefined)
})

test('lint: correctness checks of each type', () => {
  const rules = t => lint(t).map(f => `${f.line}:${f.rule}`)
  assert.deepEqual(rules('sequenceDiagram\n  participant A\n  participant A\n  A->>B: x; y\n'), [
    '3:duplicate',
    '4:text-cut',
  ])
  assert.deepEqual(rules('classDiagram\n  class A\n  style Nope fill:#f00\n  A --> B : go direction LR\n'), [
    '3:unknown-class',
    '4:direction-text',
  ])
  assert.deepEqual(rules('erDiagram\n  A ||--o{ B : has %% why\n'), ['2:trailing-comment'])
  assert.equal(lint('erDiagram\n  A ||--o{ B : has %% why\n')[0].fix, '  A ||--o{ B : has')
  assert.deepEqual(rules('requirementDiagram\n  requirement r {\n  id: 1\n  }\n  e - satisfies -> r\n'), [
    '5:undeclared',
  ])
  assert.deepEqual(rules('C4Context\n  Person(a, "A")\n  Rel(a, b)\n'), ['3:undeclared', '3:rel-label'])
  assert.deepEqual(rules('gantt\n  A :a1, 2024-01-01, 1d\n  B :after a2, 1d\n'), ['3:undeclared'])
  assert.deepEqual(rules('gitGraph\n  commit\n  checkout dev\n'), ['3:undeclared'])
  assert.deepEqual(
    rules(
      'architecture-beta\n  service a(server)[A]\n  group g(cloud)[G] in h\n  group h(cloud)[H]\n  service b(server)[B] in nope\n',
    ),
    ['3:declare-later', '5:undeclared'],
  )
  assert.deepEqual(rules('pie\n  "a" : 1\n  "a" : 2\n'), ['3:duplicate'])
  assert.deepEqual(rules('packet\n  0-15: "a"\n  20-31: "b"\n'), ['3:gap'])
  assert.deepEqual(rules('mindmap\n  root\n    a\n  other\n'), ['4:one-root'])
  assert.deepEqual(rules('timeline\n  : orphan\n'), ['2:event-first'])
  assert.deepEqual(rules('xychart\n  x-axis [a, b, c]\n  bar [1, 2]\n'), ['3:length'])
  assert.deepEqual(rules('venn-beta\n  set A\n  union A,B\n'), ['3:undeclared'])
  assert.deepEqual(rules('railroad-abnf-beta\n  a = b DIGIT\n'), ['2:undefined'])
  assert.deepEqual(rules('block\n  a["x"]\n  b[y]\n'), ['3:label-quote'])
  // ZenUML's parser takes Mermaid's other sequence syntax without an error: the lint names it.
  assert.deepEqual(
    rules('zenuml\n  participant A\n  A->>B: hi\n  A-xB: lost\n  loop every day\n  end\n  A\n  A->B: ok\n  B.m() {\n'),
    [
      '2:sequence-syntax',
      '3:sequence-syntax',
      '4:sequence-syntax',
      '5:sequence-syntax',
      '6:sequence-syntax',
      '9:block-balance',
    ],
  )
  assert.deepEqual(rules('zenuml\n  @Actor A\n  A as Ann\n  A->B: hi\n'), ['3:duplicate'])
  // @Starter above an annotated or aliased declaration: ZenUML draws next to nothing.
  assert.deepEqual(rules('zenuml\n  @Starter(A)\n  @Actor A\n  A->B: hi\n'), ['2:starter-order'])
  assert.deepEqual(rules('zenuml\n  @Starter(B)\n  B as Bob\n  B->A: hi\n'), ['2:starter-order'])
  assert.deepEqual(rules('zenuml\n  @Actor A\n  B\n  @Starter(A)\n  A->B: hi\n  loop(items) {\n    A.m()\n  }\n'), [])
  // The flowchart house style stays the flowchart's: other types take no such warnings.
  assert.deepEqual(rules('swimlane-beta\n  subgraph a [Lane one]\n  x[plain] -->|go| y\n  end\n'), [])
  assert.deepEqual(rules(S.sequence), [])
  assert.deepEqual(rules(S.class), [])
  assert.deepEqual(rules(S.state), [])
})

// Valid Mermaid 12.1.0 the lint once took for mistakes (each from its docs).
test('lint: no findings on valid syntax', () => {
  const rules = t => lint(t).map(f => `${f.line}:${f.rule}`)
  // Comments are not rule references, in each railroad notation.
  assert.deepEqual(
    rules('railroad-ebnf-beta\n(* words in a\n   comment *)\nexpr = term ; /* more words */\nterm = "x" ;\n'),
    [],
  )
  assert.deepEqual(rules('railroad-abnf-beta\n; words in a comment\nword = 1*letter ;\nletter = ALPHA ;\n'), [])
  assert.deepEqual(
    rules('railroad-peg-beta\n# words in a comment\nNum <- Digit+ ; # more words\nDigit <- "0" / "#" ;\n'),
    [],
  )
  assert.deepEqual(
    rules('railroad-beta\n/* nonterminal("zz") */\nd = oneOrMore(nonterminal("digit"));\ndigit = special("0-9");\n'),
    [],
  )
  assert.deepEqual(rules('railroad-ebnf-beta\nexpr = term ; (* term is not defined *)\n'), ['2:undefined'])
  // Radar options name no axis; a curve may share an axis's name; a line may hold several curves.
  const radar =
    'radar-beta\n  axis m["Math"], a["Art"]\n  curve a["Alice"]{1, 2}, b{ m: 1, a 2 }\n  curve c{\n    m: 3,\n    zz: 4\n  }\n  max 100, min 0\n  ticks 5\n  graticule polygon\n  showLegend true\n'
  assert.deepEqual(rules(radar), ['6:undeclared'])
  assert.deepEqual(
    linkModel(radar).items.map(it => `${it.key}:${it.line}`),
    ['curve:0:3', 'curve:1:3', 'curve:2:4'],
  )
  // Wardley: `(inertia)` and other suffixes end a component's name; evolution stages are no components.
  assert.deepEqual(
    rules(
      'wardley-beta\nevolution Genesis -> Custom -> Product\ncomponent Legacy System [0.45, 0.40] (inertia)\ncomponent K [0.4, 0.3] label [-10, 5] (build) (inertia)\nLegacy System -> K\n',
    ),
    [],
  )
  // Mindmap: a quoted text may span lines.
  assert.deepEqual(rules('mindmap\n    id1["`**Root** with\na second line`"]\n      id2["child"]\n'), [])
  assert.deepEqual(
    linkModel('mindmap\n    id1["`a\nb`"]\n      id2\n').items.map(it => it.line),
    [2, 4],
  )
  // Git graph: the first branch is the config's mainBranchName.
  assert.deepEqual(
    rules(
      "---\nconfig:\n  gitGraph:\n    mainBranchName: 'trunk'\n---\ngitGraph\n  commit\n  branch dev\n  checkout trunk\n  checkout main\n",
    ),
    ['10:undeclared'],
  )
  // Architecture: Mermaid adds the groups, then services and junctions, then edges, so an edge or
  // an `in` may name what a later line declares.
  assert.deepEqual(
    rules(
      'architecture-beta\n  a:R -- L:b\n  a{group}:B -- T:j\n  service a(server)[A] in g\n  service b(server)[B] in h\n  junction j in h\n  group g(cloud)[G]\n  group h(cloud)[H]\n',
    ),
    [],
  )
  // Use case: a relation's id (`pays@-->`) is declared by its relation; a note on an unknown id is not.
  assert.deepEqual(
    rules(
      'usecase-beta\n  actor U\n  U pays@--> Login\n  pays@{ animation: fast }\n  style pays stroke:#000\n  note for Nope "x"\n',
    ),
    ['6:undeclared'],
  )
})

// The lint runs on every keystroke: a long line its patterns do not match must not freeze the tab.
test('lint and names stay fast on long lines, and still read spaced names', () => {
  const pad = n => ' '.repeat(n)
  for (const text of [
    `sequenceDiagram\n  A${pad(3000)}:`,
    `sequenceDiagram\n  A ()${pad(3000)}`,
    `sequenceDiagram\n  note over a ,${pad(3000)}b x`,
    `quadrantChart\n${pad(800)}`,
    `quadrantChart\n  a: [${pad(5000)}`,
    `erDiagram\n  a${pad(3000)}:`,
  ]) {
    const t = performance.now()
    lint(text)
    linkModel(text)
    assert.ok(
      performance.now() - t < 200,
      `${Math.round(performance.now() - t)} ms on ${JSON.stringify(text.slice(0, 40))}...`,
    )
  }
  const seq =
    'sequenceDiagram\n  participant John Doe as J\n  John Doe () ->> + Big Bob : hi\n  note over John Doe , Big Bob : n\n'
  assert.deepEqual(
    symbols(seq).map(s => `${s.line}:${s.name}`),
    ['2:John Doe', '3:John Doe', '3:Big Bob', '4:John Doe', '4:Big Bob'],
  )
  assert.deepEqual(
    linkModel(seq).items.map(it => it.key),
    ['msg:0', 'msg:3'],
  )
  const quad = 'quadrantChart\n  Point A :::hot : [ 0.3 , 0.6 ]\n  Point B: [ 1.5 , 0.2 ]\n  classDef hot color: #f00\n'
  assert.deepEqual(
    linkModel(quad).items.map(it => it.key),
    ['point:Point A', 'point:Point B'],
  )
  assert.deepEqual(
    lint(quad).map(f => `${f.line}:${f.rule}`),
    ['3:range'],
  )
  assert.deepEqual(
    symbols('erDiagram\n  CAR [Vehicle] :::hot \n')
      .filter(s => s.def)
      .map(s => s.name),
    ['CAR'],
  )
})

// The drawn elements' records as Mermaid 12.1.0 renders them (ids without the render's id).
test('drawn elements map back to their source lines', () => {
  const key = (name, rec) => keyOfRecord(S[name], { cls: [], text: '', id: '', dataId: '', nth: 0, ...rec })
  const lines = (name, k) => linkModel(S[name]).select(k)
  // Sequence: participants by name, statements by Mermaid's index ("i<n>"), a group by its end.
  assert.equal(key('sequence', { kind: 0, dataId: 'A' }), 'node:A')
  assert.deepEqual(lines('sequence', key('sequence', { kind: 1, dataId: 'i0' })), { primary: 4, related: [4] })
  assert.deepEqual(lines('sequence', key('sequence', { kind: 1, dataId: 'i4' })), { primary: 5, related: [5, 6, 7] })
  assert.deepEqual(lines('sequence', key('sequence', { kind: 1, dataId: 'i5' })), { primary: 8, related: [8] })
  assert.deepEqual(lines('sequence', key('sequence', { kind: 1, dataId: 'i10' })).primary, 9)
  assert.deepEqual(linkModel(S.sequence).keysAt(11), ['msg:10'])
  // Class: "classId-<name>-<n>", relations "id_<a>_<b>_<n>" from 1, notes.
  assert.equal(key('class', { kind: 0, id: 'classId-Duck-1' }), 'node:Duck')
  assert.equal(lines('class', key('class', { kind: 1, dataId: 'id_Animal_Leg_2' })).primary, 9)
  assert.equal(lines('class', key('class', { kind: 1, dataId: 'edgeNote0' })).primary, 14)
  assert.equal(key('class', { kind: 2, id: 'Zoo' }), 'node:Zoo')
  // State: "state-<id>-<n>", transitions "edge<n>" in source order, notes.
  assert.equal(key('state', { kind: 0, id: 'state-Moving-5' }), 'node:Moving')
  assert.equal(key('state', { kind: 0, id: 'state-Crash-5', dataId: 'Crash' }), 'node:Crash')
  assert.equal(lines('state', key('state', { kind: 1, dataId: 'edge4' })).primary, 8)
  assert.equal(lines('state', key('state', { kind: 0, id: 'state-Still----note-6' })).primary, 12)
  // ER, requirement, C4.
  assert.equal(key('er', { kind: 0, id: 'entity-LINE_ITEM-2' }), 'node:LINE_ITEM')
  assert.equal(lines('er', key('er', { kind: 1, dataId: 'id_entity-LINE_ITEM-2_entity-p-3_2' })).primary, 11)
  assert.equal(key('requirement', { kind: 0, id: 'test_req' }), 'node:test_req')
  assert.equal(lines('requirement', key('requirement', { kind: 1, dataId: 'test_entity-test_req-0' })).primary, 11)
  assert.equal(key('c4', { kind: 0, id: 'db1' }), 'node:db1')
  assert.equal(lines('c4', key('c4', { kind: 1, nth: 1 })).primary, 9)
  // Gantt bars by task id (generated ids count the tasks without one).
  assert.equal(lines('gantt', key('gantt', { kind: 0, id: 'task2' })).primary, 8)
  assert.equal(lines('gantt', key('gantt', { kind: 0, id: 'a1-text' })).primary, 5)
  // Git graph: a commit's class is its id, custom or "<seq>-<hash>".
  assert.equal(lines('gitGraph', key('gitGraph', { kind: 0, commit: 'feat' })).primary, 6)
  assert.equal(lines('gitGraph', key('gitGraph', { kind: 0, commit: '3-c4f6a43' })).primary, 8)
  assert.equal(key('gitGraph', { kind: 1, text: 'develop' }), 'node:develop')
  // Architecture, block.
  assert.equal(key('architecture', { kind: 0, id: 'service-db' }), 'node:db')
  assert.equal(key('architecture', { kind: 0, id: 'group-api' }), 'node:api')
  assert.equal(lines('architecture', key('architecture', { kind: 1, id: 'L_disk1_server_0' })).primary, 8)
  assert.equal(key('block', { kind: 0, id: 'group1' }), 'node:group1')
  assert.equal(
    lines('block', keyOfRecord(S.block, { kind: 1, dataId: 'p21-1-b-f', cls: [], text: '', id: '', nth: 0 }, 'p21'))
      .primary,
    10,
  )
  // Mindmap nodes "node_<n>" in source order.
  assert.equal(lines('mindmap', key('mindmap', { kind: 0, id: 'node_5' })).primary, 7)
})

test('a node is connected by the relations on its lines, in types without a model of their own', () => {
  const sorted = (text, key) => linkModel(text).neighbors(key).sort()
  const state =
    'stateDiagram-v2\n  [*] --> Still\n  Still --> Moving\n  Moving --> Crash\n  note right of Crash : boom\n'
  assert.deepEqual(sorted(state, 'node:Moving'), ['edge:1', 'edge:2', 'node:Crash', 'node:Still'])
  const er =
    'erDiagram\n  CUSTOMER ||--o{ ORDER : places\n  ORDER ||--|{ LINE : contains\n  CUSTOMER {\n    string name\n  }\n'
  assert.deepEqual(sorted(er, 'node:CUSTOMER'), ['node:ORDER', 'rel:0'])
  assert.deepEqual(sorted(er, 'node:ORDER'), ['node:CUSTOMER', 'node:LINE', 'rel:0', 'rel:1'])
  // A note is beside what it names, not a connection: it lights neither itself nor the others it names.
  const seq = 'sequenceDiagram\n  Note over Alice,Bob: hi\n  Alice->>Carol: ask\n'
  assert.deepEqual(sorted(seq, 'node:Alice'), ['msg:1', 'node:Carol'])
  assert.deepEqual(sorted(state, 'node:Crash'), ['edge:2', 'node:Moving'])
  const cls = 'classDiagram\n  Duck <|-- Mallard\n  note for Duck "quacks"\n'
  assert.deepEqual(sorted(cls, 'node:Duck'), ['node:Mallard', 'rel:1'])
})

// Mermaid's shapes class a node's group `rough-node` instead of `node` in the hand-drawn look
// (sankey's `g.nodes > g.node` is drawn otherwise, the same in every look).
test('a drawing links its nodes in the hand-drawn look as in the others', () => {
  for (const desc of TYPES) {
    for (const kind of desc.link?.kinds ?? []) {
      const parts = kind.selector.split(',').map(x => x.trim())
      if (parts.includes('g.node')) assert.ok(parts.includes('g.rough-node'), `${desc.id}: ${kind.selector}`)
    }
  }
})

test('order- and text-mapped drawings', () => {
  const k = (text, rec) => keyOfRecord(text, { cls: [], text: '', id: '', dataId: '', nth: 0, ...rec })
  const at = (text, rec) => linkModel(text).select(k(text, rec))?.primary
  const pie = 'pie\n  "a" : 1000\n  "tiny" : 1\n  "b" : 500\n'
  assert.equal(at(pie, { kind: 0, nth: 1 }), 4) // the 0.07% slice is not drawn
  assert.equal(at(pie, { kind: 2, nth: 1 }), 3) // but it has its legend entry
  const journey = 'journey\n  section S\n    a: 5: Me\n    b: 3: Me\n'
  assert.equal(at(journey, { kind: 0, nth: 1 }), 4)
  const timeline = 'timeline\n  section S\n    2002 : A : B\n    2004 : C\n'
  assert.equal(at(timeline, { kind: 0, nth: 3 }), 3)
  assert.equal(at(timeline, { kind: 0, nth: 4 }), 4)
  const quadrant = 'quadrantChart\n  quadrant-1 A\n  Point B: [0.1, 0.2]\n'
  assert.equal(at(quadrant, { kind: 1, text: 'Point B' }), 3)
  assert.equal(at('xychart\n  x-axis [a]\n  bar [1]\n  line [2]\n', { kind: 0, cls: ['line-plot-1'] }), 4)
  const sankey = 'sankey\nA,B,1\nB,C,2\n'
  assert.equal(k(sankey, { kind: 0, nth: 2 }), 'node:C')
  assert.equal(at(sankey, { kind: 1, nth: 1 }), 3)
  assert.equal(at('packet\n  0-15: "a"\n  16-63: "b"\n', { kind: 0, bit: 32 }), 3) // a piece of a field over two rows
  assert.equal(at('radar-beta\n  axis a, b\n  curve x{1, 2}\n  curve y{2, 1}\n', { kind: 0, cls: ['radarCurve-1'] }), 4)
  assert.equal(k('radar-beta\n  axis a, b\n  curve x{1, 2}\n', { kind: 2, nth: 1 }), 'node:b')
  assert.equal(at('treemap\n"S"\n    "L": 1\n', { kind: 0, label: 'L' }), 3)
  assert.equal(at('ishikawa\n  Effect\n  Cause one\n', { kind: 0, text: 'Causeone' }), 3)
  assert.equal(at('venn-beta\n  set A\n  set B\n  union B,A["x"]\n', { kind: 0, sets: 'A_B' }), 4)
  assert.equal(at('usecase-beta\nactor U\nU --> Buy\nnote for U "n"\n', { kind: 1, dataId: 'note-0-edge' }), 4)
  assert.equal(at('eventmodeling\ntf 01 ui A\ntf 02 cmd B\n', { kind: 0, nth: 1 }), 3)
  assert.equal(at('railroad-beta\na = terminal("x");\nb = nonterminal("a");\n', { kind: 1, text: 'a' }), 2)
  assert.equal(at('cynefin-beta\ncomplex\n  "Probe"\n', { kind: 0, text: 'Complex' }), 2)
  assert.equal(at('treeView-beta\n  src/\n    a.ts ## entry\n', { kind: 0, text: 'a.ts' }), 3)
  assert.equal(at('wardley-beta\ncomponent Cup of Tea [0.5, 0.5]\n', { kind: 0, text: 'Cup of Tea' }), 2)
  assert.equal(at('kanban\n  todo[Todo]\n    t1[Do]\n', { kind: 0, id: 't1' }), 3)
  assert.equal(at('agentflow-beta\n  flow f["F"]\n    a["A"] --> b["B"]\n  end\n', { kind: 0, id: 'agentflow-b-3' }), 3)
  assert.equal(at('swimlane-beta\n  subgraph l [Lane]\n    a[A]\n  end\n', { kind: 2, title: 'Lane' }), 2)
})
