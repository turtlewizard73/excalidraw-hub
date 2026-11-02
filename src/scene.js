// Pure scene logic: comparing canvas state with the last load/save, and building the file to save.
// Rules and the probes behind them: docs/specs/2026-11-02-excalidraw-hub.md, "Unsaved-changes indicator".
export const SERVER_KEYS = ['createdAt', 'updatedAt', 'syncedAt', 'source', 'syncTimestamp'];
const VOLATILE = new Set(['version', 'versionNonce', 'updated', ...SERVER_KEYS]);
export const DEFAULT_APP_STATE = { viewBackgroundColor: '#ffffff', gridSize: null };

const isEmpty = (v) => v === null || v === undefined || v === false || (Array.isArray(v) && v.length === 0);
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const live = (elements) => elements.filter((e) => !e.isDeleted);

function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).sort().filter((k) => !isEmpty(v[k])).map((k) => [k, canon(v[k])]));
  }
  return typeof v === 'number' ? Math.round(v * 100) / 100 : v;
}

function strictElement(e) {
  const o = {};
  for (const [k, v] of Object.entries(e)) if (!VOLATILE.has(k)) o[k] = v;
  if (Array.isArray(o.boundElements)) o.boundElements = [...o.boundElements].sort(byId);
  return canon(o);
}

function tolerantElement(e) {
  const o = strictElement(e);
  delete o.boundElements;
  if (e.type === 'text') {
    delete o.width;
    delete o.height;
    if (e.containerId) { delete o.x; delete o.y; }
  }
  return o;
}

export const strictForm = (elements) => JSON.stringify(live(elements).map(strictElement).sort(byId));

/** True when `current` matches `base` up to the open tab's normalization (see spec). */
export function tolerantlyEqual(base, current) {
  const b = new Map(live(base).map((e) => [e.id, tolerantElement(e)]));
  const c = live(current).map(tolerantElement);
  if (b.size !== c.length) return false;
  return c.every((e) => {
    const o = b.get(e.id);
    return o !== undefined && Object.keys(e).every((k) => JSON.stringify(e[k]) === JSON.stringify(o[k]));
  });
}

const browserSynced = (elements) => elements.length > 0 && elements.every((e) => e.source === 'frontend_sync');

/**
 * Tracks the last loaded/saved state. Tolerant compare until the canvas is first fully browser-synced
 * and equal; then the strict form of that synced state becomes the anchor.
 */
export class Baseline {
  constructor() { this.reset(); }
  reset() { this.current = null; this.elements = null; this.anchor = null; this.appState = { ...DEFAULT_APP_STATE }; }

  /** After loading or saving `doc`; `canvasElements` is the canvas state at that moment, if known. */
  set(current, elements, appState, canvasElements = null) {
    this.current = current;
    this.elements = elements;
    this.appState = appState && typeof appState === 'object' ? appState : { ...DEFAULT_APP_STATE };
    this.anchor = canvasElements && browserSynced(canvasElements) ? strictForm(canvasElements) : null;
  }

  /** Is the canvas (`elements`, as GET /api/elements returns them) different from the baseline? */
  isDirty(elements) {
    if (this.elements === null) return live(elements).length > 0;
    if (this.anchor !== null) return strictForm(elements) !== this.anchor;
    const equal = tolerantlyEqual(this.elements, elements);
    if (equal && browserSynced(elements)) this.anchor = strictForm(elements);
    return !equal;
  }
}

/** Agent-format elements the canvas stores until a browser tab re-syncs them. */
export const hasShorthand = (elements) => elements.some((e) => 'label' in e || 'start' in e || 'end' in e);

/** The .excalidraw document for the current canvas state. */
export function buildDocument(elements, files, appState) {
  const kept = live(elements).map((e) => {
    const o = { ...e };
    for (const k of SERVER_KEYS) delete o[k];
    return o;
  });
  const used = new Set(kept.filter((e) => e.type === 'image' && e.fileId).map((e) => e.fileId));
  const keptFiles = Object.fromEntries(Object.entries(files ?? {}).filter(([id]) => used.has(id)));
  return {
    type: 'excalidraw',
    version: 2,
    source: 'excalidraw-hub',
    elements: kept,
    appState: appState ?? { ...DEFAULT_APP_STATE },
    ...(Object.keys(keptFiles).length ? { files: keptFiles } : {}),
  };
}
