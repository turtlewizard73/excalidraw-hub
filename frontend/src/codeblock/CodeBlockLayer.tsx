// Code blocks on the canvas: create on paste, hover toggle Code/Diagram, edit dialog.
// App.tsx wires it in with useCodeBlocks(api): pass onPaste/onPointerUpdate to <Excalidraw>, render `layer`.
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { CaptureUpdateAction, convertToExcalidrawElements, sceneCoordsToViewportCoords } from '@excalidraw/excalidraw'
import type { ExcalidrawElement, ExcalidrawImageElement, FileId } from '@excalidraw/excalidraw/element/types'
import type { BinaryFileData, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { CODE_LANGS, detectLang, type CodeLang } from './detect.ts'
import { renderView, type CodeBlockData, type CodeView } from './render.ts'

type CodeBlockElement = ExcalidrawImageElement & { customData: CodeBlockData }

export function isCodeBlock(el: ExcalidrawElement | undefined | null): el is CodeBlockElement {
  return !!el && el.type === 'image' && !el.isDeleted && (el.customData as CodeBlockData | undefined)?.kind === 'codeblock'
}

function toFile(r: { id: string; dataURL: string; mimeType: string }): BinaryFileData {
  return { id: r.id as FileId, dataURL: r.dataURL, mimeType: r.mimeType, created: Date.now() } as BinaryFileData
}

/** Create a block centred on (x, y) in scene coordinates and select it. */
async function createBlock(api: ExcalidrawImperativeAPI, lang: CodeLang, source: string, x: number, y: number): Promise<void> {
  const data: CodeBlockData = { kind: 'codeblock', lang, source, view: 'diagram' }
  const r = await renderView(data)
  api.addFiles([toFile(r)])
  const [el] = convertToExcalidrawElements([{
    type: 'image', fileId: r.id as FileId, status: 'saved',
    x: x - r.width / 2, y: y - r.height / 2, width: r.width, height: r.height,
    customData: { ...data, naturalWidth: r.width },
  }])
  api.updateScene({
    elements: [...api.getSceneElementsIncludingDeleted(), el],
    appState: { selectedElementIds: { [el.id]: true } },
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  })
}

/** Re-render a block with new data, keeping its position and the user's resize factor. */
async function updateBlock(api: ExcalidrawImperativeAPI, id: string, patch: Partial<CodeBlockData>): Promise<void> {
  const before = api.getSceneElements().find((e) => e.id === id)
  if (!isCodeBlock(before)) return
  const data: CodeBlockData = { ...before.customData, ...patch }
  const r = await renderView(data)
  api.addFiles([toFile(r)])
  const current = api.getSceneElementsIncludingDeleted()
  const el = current.find((e) => e.id === id)
  if (!isCodeBlock(el)) return // deleted while rendering
  const factor = el.width / (el.customData.naturalWidth || el.width)
  const next = {
    ...el, fileId: r.id as FileId, status: 'saved' as const, crop: null,
    width: r.width * factor, height: r.height * factor,
    customData: { ...data, naturalWidth: r.width },
    version: el.version + 1, versionNonce: Math.floor(Math.random() * 2 ** 31), updated: Date.now(),
  } as ExcalidrawElement
  api.updateScene({
    elements: current.map((e) => (e.id === id ? next : e)),
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  })
}

interface EditorState { id: string | null; lang: CodeLang; source: string }

export function useCodeBlocks(api: ExcalidrawImperativeAPI | null) {
  const pointer = useRef<{ x: number; y: number } | null>(null)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [busy, setBusy] = useState(false)
  const [, setTick] = useState(0)

  // Keep the hover buttons attached while the view scrolls/zooms or the block moves.
  // Only when the hovered block's box on screen changes: onChange also fires when App re-renders,
  // so an unconditional setState here loops (React #185).
  const hoveredIdRef = useRef<string | null>(null)
  hoveredIdRef.current = hoveredId
  const boxKey = useRef('')
  useEffect(() => {
    if (!api) return
    const check = () => {
      const el = hoveredIdRef.current ? api.getSceneElements().find((e) => e.id === hoveredIdRef.current) : null
      const { scrollX, scrollY, zoom } = api.getAppState()
      const key = el ? [el.x, el.y, el.width, el.height, el.isDeleted, scrollX, scrollY, zoom.value].join() : ''
      if (key !== boxKey.current) { boxKey.current = key; setTick((t) => t + 1) }
    }
    const offScroll = api.onScrollChange(check)
    const offChange = api.onChange(check)
    return () => { offScroll(); offChange() }
  }, [api])

  // A counter, not a flag: overlapping jobs (paste + toggle) keep the buttons disabled until all finish.
  const jobs = useRef(0)
  const run = useCallback(async (job: () => Promise<void>) => {
    jobs.current += 1
    setBusy(true)
    try { await job() } catch (error) { console.error('Code block:', error) } finally {
      jobs.current -= 1
      if (jobs.current === 0) setBusy(false)
    }
  }, [])

  const onPointerUpdate = useCallback(({ pointer: p }: { pointer: { x: number; y: number } }) => {
    pointer.current = p
    if (!api) return
    const st = api.getAppState() as any
    if (st.selectedElementsAreBeingDragged || st.resizingElement || st.newElement) {
      if (hoveredIdRef.current) setHoveredId(null)
      return
    }
    const els = api.getSceneElements()
    let hit: string | null = null
    for (let i = els.length - 1; i >= 0; i--) {
      const e = els[i]
      if (isCodeBlock(e) && p.x >= e.x && p.x <= e.x + e.width && p.y >= e.y && p.y <= e.y + e.height) { hit = e.id; break }
    }
    if (hit !== hoveredIdRef.current) setHoveredId(hit)
  }, [api])

  /** Excalidraw's onPaste: diagram text becomes a code block; anything else pastes as usual. */
  const onPaste = useCallback((data: { text?: string; elements?: unknown; files?: unknown }) => {
    if (!api || !data.text || data.elements) return true
    const found = detectLang(data.text)
    if (!found) return true
    const { width, height, scrollX, scrollY, zoom } = api.getAppState()
    const at = pointer.current ?? { x: width / 2 / zoom.value - scrollX, y: height / 2 / zoom.value - scrollY }
    void run(() => createBlock(api, found.lang, found.source, at.x, at.y))
    return false
  }, [api, run])

  const openNew = useCallback(() => setEditor({ id: null, lang: 'mermaid', source: 'flowchart LR\n  A --> B' }), [])

  const save = useCallback(() => {
    if (!api || !editor) return
    const { id, lang, source } = editor
    setEditor(null)
    if (!source.trim()) return
    void run(async () => {
      if (id) return updateBlock(api, id, { lang, source, view: 'diagram' })
      const { width, height, scrollX, scrollY, zoom } = api.getAppState()
      return createBlock(api, lang, source, width / 2 / zoom.value - scrollX, height / 2 / zoom.value - scrollY)
    })
  }, [api, editor, run])

  const hovered = api && hoveredId ? api.getSceneElements().find((e) => e.id === hoveredId) : null
  let hoverUi: JSX.Element | null = null
  if (api && isCodeBlock(hovered) && !editor) {
    const appState = api.getAppState()
    const { x, y } = sceneCoordsToViewportCoords({ sceneX: hovered.x + hovered.width, sceneY: hovered.y }, appState)
    const view: CodeView = hovered.customData.view
    const other: CodeView = view === 'code' ? 'diagram' : 'code'
    hoverUi = (
      <div className="codeblock-hover" data-testid="codeblock-hover" style={{ ...styles.hover, left: x, top: y }}
        onPointerLeave={(e) => { if (!(e.relatedTarget as Element | null)?.closest?.('canvas')) setHoveredId(null) }}>
        <button style={styles.btn} disabled={busy} data-testid="codeblock-toggle"
          onClick={() => void run(() => updateBlock(api, hovered.id, { view: other }))}>
          {other === 'code' ? '</> Code' : '◇ Diagram'}
        </button>
        <button style={styles.btn} disabled={busy} data-testid="codeblock-edit"
          onClick={() => setEditor({ id: hovered.id, lang: hovered.customData.lang, source: hovered.customData.source })}>
          ✎ Edit
        </button>
      </div>
    )
  }

  const toolbar = (
    <button className="codeblock-new" style={styles.newBtn} onClick={openNew} title="Insert a Mermaid / PlantUML / Salt code block">
      {'</>'} Code block
    </button>
  )

  /** For the canvas container: the pointer left the canvas (not onto the buttons), so hide them. */
  const onPointerLeave = useCallback((e: React.PointerEvent) => {
    if ((e.relatedTarget as Element | null)?.closest?.('.codeblock-hover')) return
    setHoveredId(null)
  }, [])

  const layer = (
    <>
      {hoverUi}
      {editor && (
        <div style={styles.backdrop} onKeyDown={(e) => { if (e.key === 'Escape') setEditor(null) }}>
          <div style={styles.dialog} role="dialog" aria-label="Edit code block" data-testid="codeblock-editor">
            <div style={styles.row}>
              <strong>{editor.id ? 'Edit code block' : 'New code block'}</strong>
              <select value={editor.lang} data-testid="codeblock-lang"
                onChange={(e) => setEditor({ ...editor, lang: e.target.value as CodeLang })}>
                {CODE_LANGS.map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
            </div>
            <textarea autoFocus spellCheck={false} value={editor.source} style={styles.textarea} data-testid="codeblock-source"
              onChange={(e) => setEditor({ ...editor, source: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save() }} />
            <div style={{ ...styles.row, justifyContent: 'flex-end' }}>
              <span style={{ marginRight: 'auto', opacity: 0.6, fontSize: 12 }}>Ctrl+Enter to save, Esc to cancel</span>
              <button style={styles.btn} onClick={() => setEditor(null)}>Cancel</button>
              <button style={{ ...styles.btn, ...styles.primary }} onClick={save} data-testid="codeblock-save">Save</button>
            </div>
          </div>
        </div>
      )}
    </>
  )

  return { onPaste, onPointerUpdate, onPointerLeave, toolbar, layer }
}

const styles: Record<string, React.CSSProperties> = {
  hover: { position: 'fixed', transform: 'translate(-100%, 0)', display: 'flex', gap: 4, padding: 4, zIndex: 10 },
  btn: { font: '12px system-ui, sans-serif', padding: '3px 8px', border: '1px solid #ced4da', borderRadius: 4, background: '#fff', color: '#212529', cursor: 'pointer', boxShadow: '0 1px 2px rgba(0,0,0,.15)' },
  primary: { background: '#4263eb', color: '#fff', borderColor: '#4263eb' },
  newBtn: { font: '12px system-ui, sans-serif', padding: '6px 10px', border: '1px solid #ced4da', borderRadius: 8, background: '#fff', color: '#212529', cursor: 'pointer' },
  backdrop: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 },
  dialog: { background: '#fff', color: '#212529', borderRadius: 8, padding: 16, width: 'min(720px, 90vw)', display: 'flex', flexDirection: 'column', gap: 10, boxShadow: '0 8px 30px rgba(0,0,0,.3)' },
  row: { display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' },
  textarea: { width: '100%', height: '50vh', fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: 13, padding: 8, boxSizing: 'border-box', border: '1px solid #ced4da', borderRadius: 4, resize: 'vertical' },
}
