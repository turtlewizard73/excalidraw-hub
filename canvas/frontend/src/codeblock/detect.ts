// Which diagram language a piece of pasted text is, if any. No imports: unit-tested with plain node.

export type CodeLang = 'mermaid' | 'plantuml' | 'salt'
export const CODE_LANGS: readonly CodeLang[] = ['mermaid', 'plantuml', 'salt']

export interface Detected {
  lang: CodeLang
  source: string
}

const FENCE = /^\s*```[ \t]*([\w-]+)[ \t]*\r?\n([\s\S]*?)\r?\n?```\s*$/
const FENCE_LANG: Record<string, CodeLang> = {
  mermaid: 'mermaid', mmd: 'mermaid',
  plantuml: 'plantuml', puml: 'plantuml', uml: 'plantuml',
  salt: 'salt',
}

// First keyword of every Mermaid diagram type (mermaid 11).
const MERMAID_START = new RegExp('^(' + [
  'graph', 'flowchart', 'sequenceDiagram', 'classDiagram(-v2)?', 'stateDiagram(-v2)?', 'erDiagram',
  'gantt', 'pie', 'mindmap', 'timeline', 'journey', 'gitGraph', 'quadrantChart', 'requirementDiagram',
  'C4Context', 'C4Container', 'C4Component', 'C4Dynamic', 'C4Deployment', 'sankey(-beta)?',
  'xychart(-beta)?', 'block(-beta)?', 'packet(-beta)?', 'kanban', 'architecture(-beta)?',
  'radar(-beta)?', 'treemap(-beta)?',
].join('|') + ')\\b')

/** Lines with `%%` comments and a leading `---` front-matter block removed. */
function mermaidBody(source: string): string[] {
  const lines = source.split(/\r?\n/).map((l) => l.trim())
  let i = 0
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1)
    i = end === -1 ? lines.length : end + 1
  }
  return lines.slice(i).filter((l) => l && !l.startsWith('%%'))
}

function plantumlLang(source: string): CodeLang | null {
  const lines = source.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("'"))
  const first = lines[0] ?? ''
  if (/^@startsalt\b/i.test(first)) return 'salt'
  if (/^@startuml\b/i.test(first)) return /^salt\b/i.test(lines[1] ?? '') ? 'salt' : 'plantuml'
  if (/^@start\w+/i.test(first)) return 'plantuml'
  return null
}

export function detectLang(text: string): Detected | null {
  const fence = text.match(FENCE)
  if (fence) {
    const lang = FENCE_LANG[fence[1].toLowerCase()]
    return lang ? { lang, source: fence[2].trim() } : null
  }
  const source = text.trim()
  if (!source) return null
  const puml = plantumlLang(source)
  if (puml) return { lang: puml, source }
  if (looksLikeMermaid(mermaidBody(source))) return { lang: 'mermaid', source }
  return null
}

/**
 * The keyword alone is not enough: "pie chart ideas" or "timeline for Q4" are prose. After the keyword the
 * first line may only hold a direction, `title …`, `showData`, `horizontal`, or `;`/`{` that starts syntax.
 * A bare keyword line needs a next line that looks like syntax.
 */
function looksLikeMermaid(body: string[]): boolean {
  const m = (body[0] ?? '').match(MERMAID_START)
  if (!m) return false
  const rest = body[0].slice(m[0].length).trim()
  if (!rest) return body.length > 1 && MERMAID_SYNTAX.test(body[1])
  return /^((TB|TD|BT|RL|LR)\b|title\b|showData\b|horizontal\b|vertical\b|[;{])/.test(rest)
}

// A bare keyword line ("timeline", "kanban") must be followed by a line that looks like diagram syntax.
const MERMAID_SYNTAX = /-->|->>|-->>|--|==>|:::|[\[\](){}|:]|^(title|section|commit|participant|actor|accTitle|accDescr|direction|branch|checkout|merge|dateFormat|axisFormat|x-axis|y-axis|state|class|note|loop|alt|opt|par|rect|autonumber)\b/

/** PlantUML needs @start/@end lines; add them when the user typed a bare body. */
export function wrapPlantuml(lang: CodeLang, source: string): string {
  if (/^\s*@start\w+/i.test(source)) return source
  return lang === 'salt' ? `@startsalt\n${source}\n@endsalt` : `@startuml\n${source}\n@enduml`
}
