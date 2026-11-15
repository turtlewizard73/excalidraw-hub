// Unit tests for the pure code-block helpers. Run: node --experimental-strip-types --test frontend/src/codeblock/codeblock.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectLang, wrapPlantuml } from './detect.ts'
import { codeSvg, errorSvg, escapeXml } from './svg.ts'

test('detects mermaid by first keyword, skipping comments and front matter', () => {
  assert.deepEqual(detectLang('graph TD; A-->B'), { lang: 'mermaid', source: 'graph TD; A-->B' })
  assert.equal(detectLang('  sequenceDiagram\n  A->>B: hi\n')?.lang, 'mermaid')
  assert.equal(detectLang('%% note\nflowchart LR\nA-->B')?.lang, 'mermaid')
  assert.equal(detectLang('---\ntitle: x\n---\nclassDiagram\nA <|-- B')?.lang, 'mermaid')
  assert.equal(detectLang('stateDiagram-v2\n[*] --> S')?.lang, 'mermaid')
  assert.equal(detectLang('pie title Pets\n"Dogs": 3')?.lang, 'mermaid')
  assert.equal(detectLang('gitGraph LR:\ncommit')?.lang, 'mermaid')
  assert.equal(detectLang('timeline\n  title History\n  2002 : LinkedIn')?.lang, 'mermaid')
  assert.equal(detectLang('kanban\n  todo[Todo]\n    t1[Write]')?.lang, 'mermaid')
  assert.equal(detectLang('gitGraph\n  commit')?.lang, 'mermaid')
})

test('detects plantuml and salt', () => {
  assert.equal(detectLang('@startuml\nAlice -> Bob\n@enduml')?.lang, 'plantuml')
  assert.equal(detectLang('@startmindmap\n* a\n@endmindmap')?.lang, 'plantuml')
  assert.equal(detectLang('@startsalt\n{\n[OK]\n}\n@endsalt')?.lang, 'salt')
  assert.equal(detectLang("@startuml\n' comment\nsalt\n{\n[OK]\n}\n@enduml")?.lang, 'salt')
})

test('fences pick the language and are stripped', () => {
  assert.deepEqual(detectLang('```mermaid\ngraph TD\nA-->B\n```'), { lang: 'mermaid', source: 'graph TD\nA-->B' })
  assert.deepEqual(detectLang('```puml\nA -> B\n```\n'), { lang: 'plantuml', source: 'A -> B' })
  assert.equal(detectLang('```salt\n{ [OK] }\n```')?.lang, 'salt')
  assert.equal(detectLang('```python\nprint(1)\n```'), null)
})

test('plain text is not a code block', () => {
  for (const t of ['', '   ', 'hello world', 'graphics are nice', 'pie chart ideas', 'timeline for Q4\nand more', 'journey', 'graph paper', '@ home', 'timeline: key dates', 'journey: notes', 'timeline\nQ4 plan', 'kanban\nboard ideas', 'pie\nslices']) {
    assert.equal(detectLang(t), null, JSON.stringify(t))
  }
})

test('wrapPlantuml adds start/end lines only when missing', () => {
  assert.equal(wrapPlantuml('plantuml', 'A -> B'), '@startuml\nA -> B\n@enduml')
  assert.equal(wrapPlantuml('salt', '{ [OK] }'), '@startsalt\n{ [OK] }\n@endsalt')
  assert.equal(wrapPlantuml('plantuml', '@startuml\nA->B\n@enduml'), '@startuml\nA->B\n@enduml')
})

test('code and error SVGs escape markup and size to content', () => {
  assert.equal(escapeXml(`<a & 'b'>`), '&lt;a &amp; &apos;b&apos;&gt;')
  const svg = codeSvg('A --> B\n<script>x</script>', 'mermaid')
  assert.ok(!svg.includes('<script>'))
  assert.match(svg, /&lt;script&gt;/)
  const [, w, h] = svg.match(/width="(\d+)" height="(\d+)"/)!.map(Number)
  assert.ok(w > 100 && h > 40)
  const taller = codeSvg('a\nb\nc\nd\ne', 'mermaid').match(/height="(\d+)"/)![1]
  assert.ok(Number(taller) > h)
  assert.match(errorSvg('plantuml', 'boom', 'A -> B'), /boom[\s\S]*A -&gt; B/)
})
