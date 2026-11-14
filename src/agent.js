// Expands agent-format canvas elements into complete Excalidraw elements, the way an open canvas tab would.
// Rules and the probe behind them: docs/specs/2026-11-02-excalidraw-hub.md, "Agent-format elements are expanded on save".

const COMMON = {
  angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid',
  roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: null, version: 1, isDeleted: false, boundElements: [],
  link: null, locked: false,
};
const TEXT = { fontSize: 20, fontFamily: 5, textAlign: 'left', verticalAlign: 'top', containerId: null, autoResize: true, lineHeight: 1.25 };
const LINEAR = { lastCommittedPoint: null, startBinding: null, endBinding: null, startArrowhead: null, elbowed: false };
const LABEL_STYLE = ['fontSize', 'fontFamily', 'strokeColor', 'textAlign', 'verticalAlign'];
const SHORTHAND = ['label', 'start', 'end'];
const GAP = 8;
// Fractional-index suffix digits: base 62 without '0', so a key never ends in '0' and fixed-width suffixes sort in order.
const DIGITS = '123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

const isLinear = (e) => e.type === 'arrow' || e.type === 'line';

/** Stored by the canvas as an agent sent it: MCP shorthand, or never filled in by a tab (no seed). */
export const isAgentFormat = (e) => !e.isDeleted && (SHORTHAND.some((k) => k in e) || !('seed' in e));

function fill(e, defaults) {
  for (const [k, v] of Object.entries(defaults)) if (e[k] === undefined) e[k] = Array.isArray(v) ? [] : v;
}

function textSize(text, fontSize, lineHeight) {
  const lines = String(text).split('\n');
  return { width: Math.max(1, ...lines.map((l) => l.length)) * fontSize * 0.5, height: lines.length * fontSize * lineHeight };
}

/** Where a label sits: the shape's centre, or the middle of an arrow's path. */
function labelCentre(c) {
  if (!isLinear(c)) return [c.x + (c.width ?? 0) / 2, c.y + (c.height ?? 0) / 2];
  const p = c.points ?? [[0, 0]];
  const n = p.length;
  const [mx, my] = n % 2 ? p[(n - 1) / 2] : [(p[n / 2 - 1][0] + p[n / 2][0]) / 2, (p[n / 2 - 1][1] + p[n / 2][1]) / 2];
  return [c.x + mx, c.y + my];
}

function place(text, container) {
  const { width, height } = textSize(text.text, text.fontSize, text.lineHeight);
  const [cx, cy] = labelCentre(container);
  Object.assign(text, { width, height, x: cx - width / 2, y: cy - height / 2 });
}

/** `count` keys greater than `after`, ascending. */
function keysAfter(after, count) {
  let width = 1;
  while (DIGITS.length ** width < count) width++;
  return Array.from({ length: count }, (_, i) => {
    let s = '';
    for (let w = 0, n = i; w < width; w++, n = Math.floor(n / DIGITS.length)) s = DIGITS[n % DIGITS.length] + s;
    return after + s;
  });
}

/**
 * @param {object[]} elements canvas elements (GET /api/elements), not mutated
 * @param {{rand?: () => number, now?: number}} [opts]
 * @returns {{elements: object[], changed: number}} complete elements, and how many were in agent format
 */
export function expandAgentElements(elements, { rand = Math.random, now = Date.now() } = {}) {
  const agent = elements.filter(isAgentFormat);
  if (!agent.length) return { elements, changed: 0 };
  const randInt = () => 1 + Math.floor(rand() * 2147483646);
  const out = new Map(elements.map((e) => [e.id, e])); // a repeated id keeps its last element, once
  const own = new Set(); // ids already copied, safe to mutate
  const edit = (id) => {
    if (!own.has(id)) {
      const e = structuredClone(out.get(id));
      // A complete element we change gets a new version, so a connected tab does not keep its older copy.
      if (!isAgentFormat(e)) Object.assign(e, { version: (e.version ?? 1) + 1, versionNonce: randInt(), updated: now });
      out.set(id, e); own.add(id);
    }
    return out.get(id);
  };
  const addRef = (id, ref) => {
    const e = edit(id);
    const refs = Array.isArray(e.boundElements) ? e.boundElements : [];
    if (!refs.some((b) => b.id === ref.id)) e.boundElements = ref.type === 'text' ? [ref, ...refs] : [...refs, ref];
  };
  const liveId = (id) => out.has(id) && !out.get(id).isDeleted;

  for (const src of agent) {
    const e = edit(src.id);
    const { label, start, end } = e;
    for (const k of SHORTHAND) delete e[k];
    if (e.type !== 'text') delete e.text;
    fill(e, { ...COMMON, seed: randInt(), versionNonce: randInt(), updated: now });
    if (e.type === 'text') {
      fill(e, { ...TEXT, originalText: e.text ?? '' });
      e.text ??= '';
      if (!e.width || !e.height) Object.assign(e, textSize(e.text, e.fontSize, e.lineHeight));
    }
    if (e.type !== 'text' && !isLinear(e)) fill(e, { width: 100, height: 100 });
    if (isLinear(e)) {
      fill(e, { ...LINEAR, points: [[0, 0], [100, 0]], endArrowhead: e.type === 'arrow' ? 'arrow' : null });
      const xs = e.points.map((p) => p[0]); const ys = e.points.map((p) => p[1]);
      e.width ??= Math.max(...xs) - Math.min(...xs);
      e.height ??= Math.max(...ys) - Math.min(...ys);
      for (const [ref, key] of [[start, 'startBinding'], [end, 'endBinding']]) {
        if (!ref?.id) continue; // `start: null` or `{}` leaves any existing binding alone
        e[key] = ref?.id && liveId(ref.id) ? { elementId: ref.id, focus: 0, gap: GAP } : null;
        if (e[key]) addRef(ref.id, { type: 'arrow', id: e.id });
      }
    }
    const text = typeof label?.text === 'string' ? label.text : '';
    if (!text) continue;
    const style = Object.fromEntries(LABEL_STYLE.filter((k) => label[k] !== undefined).map((k) => [k, label[k]]));
    const existing = (e.boundElements ?? []).find((b) => b.type === 'text' && liveId(b.id));
    if (existing) {
      const t = edit(existing.id);
      Object.assign(t, style, { text, originalText: text });
      place(t, e);
      continue;
    }
    let id = `${e.id}-label`;
    for (let i = 2; out.has(id); i++) id = `${e.id}-label-${i}`;
    const t = { id, type: 'text', x: 0, y: 0 };
    fill(t, { ...COMMON, seed: randInt(), versionNonce: randInt(), updated: now });
    Object.assign(t, TEXT, { textAlign: 'center', verticalAlign: 'middle' }, style, { text, originalText: text, containerId: e.id });
    place(t, e);
    out.set(id, t); own.add(id);
    addRef(e.id, { type: 'text', id });
  }

  // Array order is z-order and stays as it was; labels go last. Only agent elements and labels without an
  // index get one, after the highest existing key. Complete elements without one are left to the tab.
  const all = [...out.values()]; // labels were added to `out` last
  const hasKey = (e) => typeof e.index === 'string' && e.index;
  const fresh = all.filter((e) => own.has(e.id) && !e.isDeleted && !hasKey(e));
  const max = all.reduce((m, e) => (!e.isDeleted && hasKey(e) && e.index > m ? e.index : m), 'a0');
  keysAfter(max, fresh.length).forEach((k, i) => { fresh[i].index = k; });
  return { elements: all, changed: agent.length };
}
