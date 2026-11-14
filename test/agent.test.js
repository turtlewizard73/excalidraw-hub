import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandAgentElements, isAgentFormat } from '../src/agent.js';

// A complete element as a browser tab leaves it (has seed and index).
const full = (id, extra = {}) => ({
  id, type: 'rectangle', x: 0, y: 0, width: 100, height: 50, angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent',
  fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null,
  index: 'a0', roundness: null, seed: 7, version: 3, versionNonce: 9, isDeleted: false, boundElements: null, updated: 1,
  link: null, locked: false, ...extra,
});
const rand = () => 0.5;
const expand = (els) => expandAgentElements(els, { rand, now: 1000 });
const byId = (els) => Object.fromEntries(els.map((e) => [e.id, e]));

test('isAgentFormat: shorthand or no seed', () => {
  assert.equal(isAgentFormat(full('a')), false);
  assert.equal(isAgentFormat(full('a', { label: { text: 'x' } })), true);
  assert.equal(isAgentFormat(full('a', { start: { id: 'b' } })), true);
  assert.equal(isAgentFormat({ id: 'a', type: 'rectangle', x: 0, y: 0 }), true);
  assert.equal(isAgentFormat({ id: 'a', type: 'rectangle', isDeleted: true }), false, 'deleted elements are ignored');
});

test('complete elements stay byte-identical; nothing to do means no change', () => {
  const els = [full('a'), full('b', { index: 'a1' })];
  const before = JSON.stringify(els);
  const r = expand(els);
  assert.equal(r.changed, 0);
  assert.equal(JSON.stringify(r.elements), before);
});

test('mixed scene: label becomes bound text, arrow gets bindings and back-references, complete elements untouched', () => {
  const loaded = full('loaded', { index: 'a5' });
  const els = [
    loaded,
    { id: 'r', type: 'rectangle', x: 0, y: 0, width: 160, height: 60, label: { text: 'Hub server' }, version: 1 },
    { id: 'arr', type: 'arrow', x: 168, y: 30, points: [[0, 0], [124, 4]], start: { id: 'r' }, end: { id: 'loaded' }, label: { text: 'calls' } },
  ];
  const r = expand(els);
  assert.equal(r.changed, 2);
  const m = byId(r.elements);
  // r: shorthand gone, defaults filled (roundness stays null: the tab's default), label + arrow back-refs
  assert.equal('label' in m.r, false);
  assert.equal(m.r.roundness, null);
  assert.equal(m.r.strokeColor, '#1e1e1e');
  assert.ok(Number.isInteger(m.r.seed) && m.r.seed > 0);
  assert.deepEqual(m.r.boundElements, [{ type: 'text', id: 'r-label' }, { type: 'arrow', id: 'arr' }]);
  // label text centred in r
  const t = m['r-label'];
  assert.equal(t.type, 'text');
  assert.equal(t.containerId, 'r');
  assert.equal(t.text, 'Hub server');
  assert.equal(t.originalText, 'Hub server');
  assert.equal(t.textAlign, 'center');
  assert.equal(t.verticalAlign, 'middle');
  assert.equal(t.fontFamily, 5);
  assert.equal(t.x + t.width / 2, 80);
  assert.equal(t.y + t.height / 2, 30);
  // arrow
  assert.equal('start' in m.arr || 'end' in m.arr, false);
  assert.deepEqual(m.arr.startBinding, { elementId: 'r', focus: 0, gap: 8 });
  assert.deepEqual(m.arr.endBinding, { elementId: 'loaded', focus: 0, gap: 8 });
  assert.equal(m.arr.endArrowhead, 'arrow');
  assert.equal(m.arr.width, 124);
  assert.equal(m.arr.height, 4);
  assert.equal(m['arr-label'].x + m['arr-label'].width / 2, 168 + 62, 'arrow label at the path middle');
  // loaded element: only its boundElements gained the arrow back-reference; input not mutated
  assert.deepEqual(m.loaded, { ...loaded, boundElements: [{ type: 'arrow', id: 'arr' }], version: 4, versionNonce: m.loaded.versionNonce, updated: 1000 });
  assert.equal(loaded.boundElements, null);
  assert.equal(r.elements[0].index, 'a5', 'complete element keeps its index');
});

test('index keys: new ones after the highest, array order (z-order) kept, labels last, nothing renumbered', () => {
  const els = [
    full('x', { index: 'a1' }),
    { id: 'p', type: 'rectangle', x: 0, y: 0, width: 10, height: 10, label: { text: 'P' } },
    full('y', { index: 'a2V' }),
    { id: 'q', type: 'ellipse', x: 0, y: 0, width: 10, height: 10 },
  ];
  const r = expand(els);
  assert.deepEqual(r.elements.map((e) => e.id), ['x', 'p', 'y', 'q', 'p-label'], 'order kept, labels last');
  const m = byId(r.elements);
  assert.equal(m.x.index, 'a1');
  assert.equal(m.y.index, 'a2V');
  const fresh = [m.p.index, m.q.index, m['p-label'].index];
  assert.deepEqual([...fresh].sort(), fresh, 'new keys ascending in array order');
  assert.ok(fresh.every((k) => k > 'a2V' && !k.endsWith('0')), fresh.join());
});

test('index keys when nothing has an index yet', () => {
  const r = expand([{ id: 'a', type: 'rectangle', x: 0, y: 0, width: 1, height: 1 }, { id: 'b', type: 'rectangle', x: 0, y: 0, width: 1, height: 1 }]);
  const keys = r.elements.map((e) => e.index);
  assert.ok(keys[0] < keys[1], keys.join());
  assert.match(keys[0], /^a0/);
});

test('many new elements keep ascending keys (fixed-width suffix)', () => {
  const els = Array.from({ length: 130 }, (_, i) => ({ id: `n${i}`, type: 'rectangle', x: i, y: 0, width: 1, height: 1 }));
  const keys = expand(els).elements.map((e) => e.index);
  assert.deepEqual([...keys].sort(), keys);
  assert.equal(new Set(keys).size, keys.length);
});

test('idempotent: expanding the result again changes nothing', () => {
  const first = expand([{ id: 'r', type: 'rectangle', x: 0, y: 0, width: 10, height: 10, label: { text: 'A' } }]).elements;
  const second = expand(first);
  assert.equal(second.changed, 0);
  assert.equal(JSON.stringify(second.elements), JSON.stringify(first));
});

test('label id collision gets a suffix', () => {
  const r = expand([full('r-label', { type: 'text', text: 'other', index: 'a0' }), { id: 'r', type: 'rectangle', x: 0, y: 0, width: 10, height: 10, label: { text: 'A' } }]);
  const m = byId(r.elements);
  assert.equal(m['r-label'].text, 'other');
  assert.equal(m['r-label-2'].text, 'A');
  assert.deepEqual(m.r.boundElements, [{ type: 'text', id: 'r-label-2' }]);
});

test('label on a container that already has bound text replaces that text', () => {
  const box = full('b', { boundElements: [{ type: 'text', id: 'b-t' }], label: { text: 'new' } });
  const txt = full('b-t', { type: 'text', text: 'old', originalText: 'old', containerId: 'b', index: 'a1' });
  const r = expand([box, txt]);
  assert.equal(r.elements.length, 2);
  const m = byId(r.elements);
  assert.equal(m['b-t'].text, 'new');
  assert.equal(m['b-t'].originalText, 'new');
  assert.equal('label' in m.b, false);
  assert.deepEqual(m.b.boundElements, [{ type: 'text', id: 'b-t' }]);
});

test('arrow to a missing element: binding dropped, no dangling reference', () => {
  const r = expand([{ id: 'a', type: 'arrow', x: 0, y: 0, points: [[0, 0], [10, 0]], start: { id: 'gone' }, end: {} }]);
  const [a] = r.elements;
  assert.equal(a.startBinding, null);
  assert.equal(a.endBinding, null);
  assert.equal('start' in a || 'end' in a, false);
});

test('text on a shape is dropped, as the tab drops it; free text gets text defaults and a size', () => {
  const r = expand([
    { id: 'e', type: 'ellipse', x: 0, y: 0, width: 10, height: 10, text: 'ignored' },
    { id: 't', type: 'text', x: 0, y: 0, text: 'free text\nline 2', fontSize: 16 },
  ]);
  const m = byId(r.elements);
  assert.equal('text' in m.e, false);
  assert.equal(r.elements.length, 2, 'no label from `text`');
  assert.equal(m.t.originalText, 'free text\nline 2');
  assert.equal(m.t.textAlign, 'left');
  assert.equal(m.t.containerId, null);
  assert.equal(m.t.height, 2 * 16 * 1.25);
  assert.ok(m.t.width > 0);
});

test('explicit values are kept, including null and the agent-given label style', () => {
  const r = expand([{ id: 'r', type: 'rectangle', x: 0, y: 0, width: 10, height: 10, strokeColor: '#08427b', roundness: { type: 3 }, label: { text: 'A', fontSize: 14, strokeColor: '#ffffff' } }]);
  const m = byId(r.elements);
  assert.equal(m.r.strokeColor, '#08427b');
  assert.deepEqual(m.r.roundness, { type: 3 });
  assert.equal(m['r-label'].fontSize, 14);
  assert.equal(m['r-label'].strokeColor, '#ffffff');
});

test('review fixes: complete un-indexed elements stay put and unkeyed; duplicate ids appear once', () => {
  const u = full('u'); delete u.index;
  const r = expand([full('a'), u, full('b', { index: 'a1' }), { id: 'g', type: 'rectangle', x: 0, y: 0 }]);
  assert.deepEqual(r.elements.map((e) => e.id), ['a', 'u', 'b', 'g']);
  assert.equal(r.elements[1], u, 'untouched, same object');
  assert.equal(byId(r.elements).g.width, 100, 'shape gets the default size');
  const d = expand([{ id: 'a', type: 'rectangle', x: 0, y: 0 }, full('a')]);
  assert.equal(d.elements.length, 1);
});

test('review fixes: a complete element we change gets a new version; start: null keeps a binding', () => {
  const shape = full('s', { version: 7 });
  const r = expand([shape, { id: 'ar', type: 'arrow', x: 0, y: 0, points: [[0, 0], [5, 0]], end: { id: 's' } }]);
  const m = byId(r.elements);
  assert.equal(m.s.version, 8);
  assert.equal(m.s.updated, 1000);
  const arrow = full('k', { type: 'arrow', points: [[0, 0], [5, 0]], startBinding: { elementId: 's', focus: 0, gap: 8 }, start: null });
  assert.deepEqual(byId(expand([shape, arrow]).elements).k.startBinding, { elementId: 's', focus: 0, gap: 8 });
});
