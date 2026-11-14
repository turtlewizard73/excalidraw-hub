import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Baseline, buildDocument, strictForm, tolerantlyEqual } from '../src/scene.js';

const rect = (over = {}) => ({ id: 'r1', type: 'rectangle', x: 10, y: 20, width: 100, height: 50, roundness: null, boundElements: null, version: 3, versionNonce: 9, ...over });
const label = (over = {}) => ({ id: 't1', type: 'text', text: 'hi', x: 15, y: 25, width: 40.86, height: 25, containerId: 'r1', ...over });
// What the canvas holds after the open tab re-syncs (spec: normalization by the browser)
const synced = (e, over = {}) => ({ ...e, version: 1, source: 'frontend_sync', syncedAt: 'x', syncTimestamp: 'y', ...over });

test('strictForm ignores volatile keys, key order, empty values and deleted elements', () => {
  const a = [rect(), label()];
  const b = [{ ...label(), version: 7 }, { boundElements: [], ...rect(), roundness: undefined, updated: 5 }, { id: 'gone', type: 'line', isDeleted: true }];
  assert.equal(strictForm(a), strictForm(b));
  assert.notEqual(strictForm(a), strictForm([rect({ x: 11 }), label()]));
});

test('tolerantlyEqual accepts browser normalization but not real edits', () => {
  const file = [rect({ fontSize: 20, boundElements: [{ id: 'stale', type: 'arrow' }] }), label()];
  const browser = [synced(rect(), { boundElements: [{ id: 't1', type: 'text' }] }), synced(label(), { width: 39, x: 16 })];
  assert.equal(tolerantlyEqual(file, browser), true);
  assert.equal(tolerantlyEqual(file, [synced(rect({ x: 99 })), synced(label())]), false, 'moved');
  assert.equal(tolerantlyEqual(file, [synced(rect()), synced(label({ text: 'bye' }))]), false, 'text edit');
  assert.equal(tolerantlyEqual(file, [synced(rect())]), false, 'deleted element');
  assert.equal(tolerantlyEqual(file, [...file, rect({ id: 'r2' })]), false, 'new element');
});

test('Baseline: clean after load, anchors on first sync, then strict', () => {
  const b = new Baseline();
  assert.equal(b.isDirty([]), false, 'nothing loaded, empty canvas');
  assert.equal(b.isDirty([rect()]), true, 'nothing loaded, canvas has work');
  const file = [rect(), label()];
  b.set({ project: 'p', file: 'p_v0.excalidraw' }, file, { viewBackgroundColor: '#fff' });
  assert.equal(b.isDirty(file), false, 'raw state right after load');
  const s1 = [synced(rect()), synced(label({ width: 39 }))];
  assert.equal(b.isDirty(s1), false, 'first browser sync');
  assert.notEqual(b.anchor, null);
  assert.equal(b.isDirty(s1.map((e) => ({ ...e, syncedAt: 'later' }))), false, 'second sync, same content');
  assert.equal(b.isDirty([...s1, synced(rect({ id: 'r2' }))]), true, 'drew a rectangle');
  assert.equal(b.isDirty([synced(rect()), synced(label({ width: 80 }))]), true, 'after anchoring, strict sees text resize');
});

test('Baseline: a dirty first sync does not anchor', () => {
  const b = new Baseline();
  b.set(null, [rect()], null);
  assert.equal(b.isDirty([synced(rect({ x: 50 }))]), true);
  assert.equal(b.anchor, null);
  assert.deepEqual(b.appState, { viewBackgroundColor: '#ffffff', gridSize: null });
});

test('Baseline: save from a synced canvas anchors immediately', () => {
  const b = new Baseline();
  const s = [synced(rect())];
  b.set({ project: 'p', file: 'p_v1.excalidraw' }, s, null, s);
  assert.equal(b.anchor, strictForm(s));
  assert.equal(b.isDirty(s), false);
});

test('buildDocument strips server keys, deleted elements and unreferenced files; keeps appState', () => {
  const img = { id: 'i1', type: 'image', fileId: 'f1', x: 0, y: 0, version: 1, source: 'frontend_sync', createdAt: 'c', updatedAt: 'u', syncedAt: 's', syncTimestamp: 't' };
  const doc = buildDocument([img, { id: 'd', type: 'line', isDeleted: true }], { f1: { id: 'f1', dataURL: 'data:a' }, old: { id: 'old', dataURL: 'data:b' } }, { viewBackgroundColor: '#fff9db' });
  assert.deepEqual(doc, {
    type: 'excalidraw', version: 2, source: 'excalidraw-hub',
    elements: [{ id: 'i1', type: 'image', fileId: 'f1', x: 0, y: 0, version: 1 }],
    appState: { viewBackgroundColor: '#fff9db' },
    files: { f1: { id: 'f1', dataURL: 'data:a' } },
  });
  assert.equal('files' in buildDocument([rect()], { old: {} }, null), false);
  assert.deepEqual(buildDocument([], {}, null).appState, { viewBackgroundColor: '#ffffff', gridSize: null });
});

