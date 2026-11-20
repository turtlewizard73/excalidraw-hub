// Code blocks on the canvas: create on paste, Code/Diagram toggle + Edit buttons above the block, edit dialog.
// The buttons belong to the selected code block (if exactly one is selected), else to the hovered one.
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
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [busy, setBusy] = useState(false)
  const [, setTick] = useState(0)

  // Track the selected code block, and keep the buttons attached while the view scrolls/zooms or the block moves.
  // setState only when something changed: onChange also fires when App re-renders,
  // so an unconditional setState here loops (React #185).
  const hoveredIdRef = useRef<string | null>(null)
  hoveredIdRef.current = hoveredId
  const selectedIdRef = useRef<string | null>(null)
  selectedIdRef.current = selectedId
  const boxKey = useRef('')
  useEffect(() => {
    if (!api) return
    const check = () => {
      const els = api.getSceneElements()
      const st = api.getAppState()
      const { scrollX, scrollY, zoom, selectedElementIds } = st
      const ids = Object.keys(selectedElementIds).filter((id) => selectedElementIds[id])
      const sel = ids.length === 1 ? els.find((e) => e.id === ids[0]) : null
      const selId = isCodeBlock(sel) ? sel.id : null
      if (selId !== selectedIdRef.current) { selectedIdRef.current = selId; setSelectedId(selId) }
      const targetId = selId ?? hoveredIdRef.current
      const el = targetId ? els.find((e) => e.id === targetId) : null
      // While moving, no bar is drawn: leave position out of the key so drag frames don't re-render.
      const key = !el ? '' : isMoving(st) ? `${el.id},moving` : [el.id, el.x, el.y, el.width, el.height, scrollX, scrollY, zoom.value].join()
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
    if (isMoving(st)) {
      if (hoveredIdRef.current) setHoveredId(null)
      return
    }
    const els = api.getSceneElements()
    // The hit area reaches over the button bar (above, or below when flipped), so the pointer can travel to the buttons.
    const reach = BAR_REACH / st.zoom.value
    let hit: string | null = null
    for (let i = els.length - 1; i >= 0; i--) {
      const e = els[i]
      if (!isCodeBlock(e) || p.x < e.x || p.x > e.x + e.width) continue
      const below = barBelow(e, st)
      if (p.y >= e.y - (below ? 0 : reach) && p.y <= e.y + e.height + (below ? reach : 0)) { hit = e.id; break }
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

  const targetId = selectedId ?? hoveredId
  const hovered = api && targetId ? api.getSceneElements().find((e) => e.id === targetId) : null
  let hoverUi: JSX.Element | null = null
  if (api && isCodeBlock(hovered) && !editor && !isMoving(api.getAppState())) {
    const appState = api.getAppState()
    const { x, y } = sceneCoordsToViewportCoords({ sceneX: hovered.x + hovered.width, sceneY: hovered.y }, appState)
    const below = barBelow(hovered, appState)
    const bottom = below ? sceneCoordsToViewportCoords({ sceneX: 0, sceneY: hovered.y + hovered.height }, appState).y : 0
    const view: CodeView = hovered.customData.view
    const other: CodeView = view === 'code' ? 'diagram' : 'code'
    hoverUi = (
      <div className="codeblock-hover" data-testid="codeblock-hover" data-block-id={hovered.id} style={{ ...styles.hover, left: x, ...(below ? { top: bottom + BAR_GAP, transform: 'translate(-100%, 0)' } : { top: y - BAR_GAP }) }}
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

/** Excalidraw is moving, resizing or drawing an element: no buttons meanwhile. */
function isMoving(st: any): boolean {
  return !!(st.selectedElementsAreBeingDragged || st.resizingElement || st.newElement)
}

/** No room for the bar above the block (it is at the top edge of the canvas): the bar goes under it. */
function barBelow(el: ExcalidrawElement, st: any): boolean {
  return sceneCoordsToViewportCoords({ sceneX: el.x, sceneY: el.y }, st).y - BAR_REACH < (st.offsetTop ?? 0)
}

/** Screen px between the block's top edge and the button bar (clears Excalidraw's selection outline). */
const BAR_GAP = 8
/** Screen px above the block that still counts as hovering it: gap + bar height. */
const BAR_REACH = BAR_GAP + 34

const styles: Record<string, React.CSSProperties> = {
  hover: { position: 'fixed', transform: 'translate(-100%, -100%)', display: 'flex', gap: 4, padding: 4, zIndex: 10 },
  btn: { font: '12px system-ui, sans-serif', padding: '3px 8px', border: '1px solid #ced4da', borderRadius: 4, background: '#fff', color: '#212529', cursor: 'pointer', boxShadow: '0 1px 2px rgba(0,0,0,.15)' },
  primary: { background: '#4263eb', color: '#fff', borderColor: '#4263eb' },
  newBtn: { font: '12px system-ui, sans-serif', padding: '6px 10px', border: '1px solid #ced4da', borderRadius: 8, background: '#fff', color: '#212529', cursor: 'pointer' },
  backdrop: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 },
  dialog: { background: '#fff', color: '#212529', borderRadius: 8, padding: 16, width: 'min(720px, 90vw)', display: 'flex', flexDirection: 'column', gap: 10, boxShadow: '0 8px 30px rgba(0,0,0,.3)' },
  row: { display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' },
  textarea: { width: '100%', height: '50vh', fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: 13, padding: 8, boxSizing: 'border-box', border: '1px solid #ced4da', borderRadius: 4, resize: 'vertical' },
}
