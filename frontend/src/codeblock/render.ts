// Turns a code block's source into the image for its current view. Add a language: one entry in RENDERERS.
import type { CodeLang } from './detect.ts'
import { wrapPlantuml } from './detect.ts'
import { codeSvg, errorSvg } from './svg.ts'

export type CodeView = 'diagram' | 'code'

export interface CodeBlockData {
  kind: 'codeblock'
  lang: CodeLang
  source: string
  view: CodeView
  /** Natural width of the current render, so a user resize survives re-renders. */
  naturalWidth?: number
}

export interface RenderedView {
  dataURL: string
  mimeType: 'image/png'
  id: string
  width: number // natural size in scene units
  height: number
}

let mermaidSeq = 0

async function renderMermaid(source: string): Promise<string> {
  const mermaid = (await import('mermaid')).default
  // Re-initialised per call: the Mermaid-to-Excalidraw converter shares this module with its own config.
  // htmlLabels off: <foreignObject> labels taint the canvas we rasterise on.
  mermaid.initialize({
    startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true,
    htmlLabels: false, flowchart: { htmlLabels: false }, class: { htmlLabels: false },
  })
  const id = `codeblock-mermaid-${++mermaidSeq}`
  try {
    const { svg } = await mermaid.render(id, source)
    return svg
  } finally {
    // mermaid leaves its scratch element behind when the source has a syntax error
    document.getElementById(id)?.remove()
    document.getElementById(`d${id}`)?.remove()
  }
}

async function renderPlantuml(lang: CodeLang, source: string): Promise<string> {
  const res = await fetch('/api/render/plantuml', {
    method: 'POST', headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    body: wrapPlantuml(lang, source), signal: AbortSignal.timeout(20000),
  })
  // PlantUML answers syntax errors with an SVG that shows the error; show it as the diagram.
  if ((res.headers.get('content-type') ?? '').includes('svg')) return res.text()
  const body = await res.json().catch(() => ({}))
  throw new Error(body.error ?? `HTTP ${res.status}`)
}

const RENDERERS: Record<CodeLang, (source: string, lang: CodeLang) => Promise<string>> = {
  mermaid: (s) => renderMermaid(s),
  plantuml: (s, l) => renderPlantuml(l, s),
  salt: (s, l) => renderPlantuml(l, s),
}

export async function viewSvg(data: CodeBlockData): Promise<string> {
  if (data.view === 'code') return codeSvg(data.source, data.lang)
  try {
    return await RENDERERS[data.lang](data.source, data.lang)
  } catch (error) {
    return errorSvg(data.lang, error instanceof Error ? error.message : String(error), data.source)
  }
}

/** Natural size from width/height attributes, else the viewBox (mermaid writes width="100%"). */
function svgSize(root: Element): { width: number; height: number } {
  const num = (v: string | null) => (v && /^[\d.]+(px)?$/.test(v.trim()) ? parseFloat(v) : NaN)
  let width = num(root.getAttribute('width'))
  let height = num(root.getAttribute('height'))
  const vb = root.getAttribute('viewBox')?.split(/[\s,]+/).map(Number)
  if ((!width || !height) && vb && vb.length === 4) {
    width = width || vb[2]
    height = height || vb[3]
  }
  return { width: width || 300, height: height || 150 }
}

const RASTER_SCALE = 2 // sharp at 200% zoom
const MAX_PIXELS = 4096 // keeps big diagrams to a few MB of data URL (canvas sync body limit is 10 MB)

/**
 * PNG, not SVG: the canvas server's headless exporter (resvg) drops text inside nested SVG images,
 * which would blank every diagram in exports and in the hub's PNG. See docs/specs/2026-11-14-code-block.md.
 */
export async function rasterize(svg: string): Promise<RenderedView> {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
  const root = doc.documentElement
  if (root.nodeName !== 'svg' || doc.getElementsByTagName('parsererror').length) throw new Error('renderer did not return a valid SVG')
  const { width, height } = svgSize(root)
  root.setAttribute('width', String(width))
  root.setAttribute('height', String(height))
  root.removeAttribute('style') // mermaid's max-width would shrink the image
  const markup = new XMLSerializer().serializeToString(root)

  const img = new Image()
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(markup)
  await img.decode().catch(() => { throw new Error('the browser could not draw the rendered SVG') })
  const scale = Math.min(RASTER_SCALE, MAX_PIXELS / width, MAX_PIXELS / height)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * scale))
  canvas.height = Math.max(1, Math.round(height * scale))
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  const dataURL = canvas.toDataURL('image/png')

  return { dataURL, mimeType: 'image/png', id: `codeblock-${hash(dataURL)}`, width, height }
}

/** cyrb53 + length: stable id per render, so toggling back reuses the file. Not crypto.subtle: that needs a secure origin. */
function hash(s: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36) + s.length.toString(36)
}

export async function renderView(data: CodeBlockData): Promise<RenderedView> {
  try {
    return await rasterize(await viewSvg(data))
  } catch (error) {
    // e.g. a renderer returned SVG that is not well-formed XML: show why, keep the source
    return rasterize(errorSvg(data.lang, error instanceof Error ? error.message : String(error), data.source))
  }
}
