// SVGs drawn without a renderer: the code view and the error view. No imports: unit-tested with plain node.

const FONT = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
const FONT_SIZE = 14
const LINE = 20
const CHAR_W = 8.5 // generous average advance for 14px monospace
const PAD = 14
const MAX_COLS = 160

export function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]!))
}

function box(lines: string[], title: string, colors: { bg: string; border: string; text: string; title: string }): string {
  const shown = lines.map((l) => {
    const t = l.replace(/\t/g, '  ')
    return t.length > MAX_COLS ? t.slice(0, MAX_COLS - 1) + '…' : t
  })
  const cols = Math.max(title.length + 4, ...shown.map((l) => l.length), 10)
  const width = Math.ceil(cols * CHAR_W + 2 * PAD)
  const top = PAD + LINE // first line sits under the title row
  const height = top + shown.length * LINE + PAD
  const text = shown
    .map((l, i) => `<text x="${PAD}" y="${top + (i + 1) * LINE - 5}" xml:space="preserve">${escapeXml(l)}</text>`)
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
    + `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="6" fill="${colors.bg}" stroke="${colors.border}"/>`
    + `<text x="${width - PAD}" y="${PAD + 8}" text-anchor="end" font-family="${FONT}" font-size="11" fill="${colors.title}">${escapeXml(title)}</text>`
    + `<g font-family="${FONT}" font-size="${FONT_SIZE}" fill="${colors.text}">${text}</g></svg>`
}

/** The source as a monospace code panel, labelled with its language. */
export function codeSvg(source: string, lang: string): string {
  const lines = source.split(/\r?\n/)
  return box(lines.length ? lines : [''], lang, { bg: '#f8f9fa', border: '#ced4da', text: '#212529', title: '#868e96' })
}

/** A render failure: the message, then the source so nothing is lost. */
export function errorSvg(lang: string, message: string, source: string): string {
  const lines = [`Could not render ${lang}:`, ...message.split(/\r?\n/).slice(0, 8), '', ...source.split(/\r?\n/)]
  return box(lines, `${lang} error`, { bg: '#fff5f5', border: '#ff8787', text: '#c92a2a', title: '#fa5252' })
}
