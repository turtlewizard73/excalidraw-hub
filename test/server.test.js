import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createCanvas } from '../src/canvas.js';
import { createServer } from '../src/server.js';
import { createStore } from '../src/store.js';

// Fake canvas: the subset of yctimlin 2.1.2 routes the hub uses, with the same server-added keys.
function fakeCanvas() {
  const state = { elements: new Map(), files: new Map(), requests: [] };
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    const json = body ? JSON.parse(body) : undefined;
    state.requests.push(`${req.method} ${req.url}`);
    const send = (d) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(d)); };
    if (req.url === '/api/elements' && req.method === 'GET') return send({ success: true, elements: [...state.elements.values()] });
    if (req.url === '/api/files' && req.method === 'GET') return send({ files: Object.fromEntries(state.files) });
    if (req.url === '/api/files' && req.method === 'POST') { for (const f of json.files) state.files.set(f.id, f); return send({ success: true }); }
    if (req.url === '/api/elements/batch') {
      if (json.replace) state.elements.clear();
      for (const e of json.elements) state.elements.set(e.id, { ...e, createdAt: 'c', updatedAt: 'u', version: 1 });
      return send({ success: true });
    }
    res.writeHead(404); res.end('{}');
  });
  return { state, server };
}

let dir, canvas, hub, base;
const rect = (id, x = 0) => ({ id, type: 'rectangle', x, y: 0, width: 10, height: 10 });
const post = (route, body, headers = {}) => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const get = async (route) => (await fetch(base + route)).json();
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${s.address().port}`)));

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-api-'));
  await fs.mkdir(path.join(dir, 'budgeting'));
  await fs.writeFile(path.join(dir, 'budgeting', 'budgeting_v0_plan.excalidraw'), JSON.stringify({ elements: [rect('a'), rect('b')], appState: { viewBackgroundColor: '#fff9db' } }));
  await fs.writeFile(path.join(dir, 'budgeting', 'budgeting_v0_plan.png'), 'png');
  canvas = fakeCanvas();
  const canvasUrl = await listen(canvas.server);
  hub = createServer({ store: createStore(dir), canvas: createCanvas(canvasUrl), canvasPublicUrl: 'http://localhost:3000' });
  base = await listen(hub);
  const port = new URL(base).port;
  // Re-create with the Host guard on, as main.js configures it.
  hub.close();
  hub = createServer({ store: createStore(dir), canvas: createCanvas(canvasUrl), canvasPublicUrl: 'http://localhost:3000', allowedHosts: [`127.0.0.1:${port}`] });
  await new Promise((r) => hub.listen(Number(port), '127.0.0.1', r));
});
afterEach(() => { canvas.server.close(); hub.close(); });

test('list → load → clean → edit → dirty → save new version → clean', async () => {
  const { projects } = await get('/api/projects');
  assert.deepEqual(projects.map((p) => [p.name, p.drawings.map((d) => [d.file, d.latest, d.png])]), [['budgeting', [['budgeting_v0_plan.excalidraw', true, true]]]]);
  assert.equal((await get('/api/status')).dirty, false, 'empty canvas, nothing loaded');

  const load = await post('/api/load', { project: 'budgeting', file: 'budgeting_v0_plan.excalidraw' });
  assert.equal(load.status, 200);
  assert.deepEqual((await get('/api/status')), { current: { project: 'budgeting', file: 'budgeting_v0_plan.excalidraw' }, dirty: false, canvas: 'ok', elementCount: 2 });

  canvas.state.elements.set('c', rect('c', 50));
  assert.equal((await get('/api/status')).dirty, true);

  const save = await (await post('/api/save', { project: 'budgeting', label: 'With C' })).json();
  assert.deepEqual(save.current, { project: 'budgeting', file: 'budgeting_v1_with_c.excalidraw' });
  const saved = JSON.parse(await fs.readFile(path.join(dir, 'budgeting', 'budgeting_v1_with_c.excalidraw'), 'utf8'));
  assert.deepEqual(saved.elements.map((e) => e.id).sort(), ['a', 'b', 'c']);
  assert.equal('createdAt' in saved.elements[0], false, 'server keys stripped');
  assert.deepEqual(saved.appState, { viewBackgroundColor: '#fff9db' }, 'appState carried from the loaded file');
  assert.equal((await get('/api/status')).dirty, false);
});

test('load over unsaved work needs force', async () => {
  canvas.state.elements.set('x', rect('x'));
  const res = await post('/api/load', { project: 'budgeting', file: 'budgeting_v0_plan.excalidraw' });
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: 'the canvas has unsaved changes', dirty: true });
  assert.equal(canvas.state.elements.has('x'), true, 'canvas untouched');
  assert.equal((await post('/api/load', { project: 'budgeting', file: 'budgeting_v0_plan.excalidraw', force: true })).status, 200);
  assert.deepEqual([...canvas.state.elements.keys()], ['a', 'b']);
});

test('save refuses agent shorthand and keeps files referenced only', async () => {
  canvas.state.elements.set('s', { id: 's', type: 'rectangle', x: 0, y: 0, label: { text: 'hi' } });
  assert.equal((await post('/api/save', { project: 'budgeting' })).status, 409);
  canvas.state.elements.clear();
  canvas.state.elements.set('i', { id: 'i', type: 'image', fileId: 'f1', x: 0, y: 0 });
  canvas.state.files.set('f1', { id: 'f1', dataURL: 'data:1' }); canvas.state.files.set('old', { id: 'old', dataURL: 'data:2' });
  const save = await (await post('/api/save', { project: 'new-proj' })).json();
  assert.equal(save.current.file, 'new-proj_v0.excalidraw');
  const saved = JSON.parse(await fs.readFile(path.join(dir, 'new-proj', 'new-proj_v0.excalidraw'), 'utf8'));
  assert.deepEqual(Object.keys(saved.files), ['f1']);
});

test('rename and delete follow the current drawing and its png', async () => {
  await post('/api/load', { project: 'budgeting', file: 'budgeting_v0_plan.excalidraw' });
  const r = await (await post('/api/rename', { project: 'budgeting', file: 'budgeting_v0_plan.excalidraw', newBase: 'budgeting_v0_first' })).json();
  assert.deepEqual(r.current, { project: 'budgeting', file: 'budgeting_v0_first.excalidraw' });
  assert.deepEqual((await fs.readdir(path.join(dir, 'budgeting'))).sort(), ['budgeting_v0_first.excalidraw', 'budgeting_v0_first.png']);
  const d = await (await post('/api/delete', { project: 'budgeting', file: 'budgeting_v0_first.excalidraw' })).json();
  assert.equal(d.current, null);
  assert.deepEqual(await fs.readdir(path.join(dir, 'budgeting')), []);
});

test('guards: content type, origin, host, bad names, unknown routes', async () => {
  const body = JSON.stringify({ project: 'budgeting', file: 'budgeting_v0_plan.excalidraw' });
  assert.equal((await fetch(base + '/api/delete', { method: 'POST', body })).status, 415, 'form-style post');
  assert.equal((await post('/api/delete', JSON.parse(body), { origin: 'http://evil.example' })).status, 403);
  assert.equal((await post('/api/rename', { project: 'budgeting', file: 'budgeting_v0_plan.excalidraw', newBase: '../x' })).status, 400);
  assert.equal((await post('/api/delete', { project: '..', file: 'x.excalidraw' })).status, 400);
  assert.equal((await post('/api/save', { project: '../etc' })).status, 400);
  assert.equal((await fetch(base + '/api/nope')).status, 404);
  assert.equal((await fetch(base + '/../src/server.js')).status, 404);
  await fs.access(path.join(dir, 'budgeting', 'budgeting_v0_plan.excalidraw'));

  const guarded = createServer({ store: createStore(dir), canvas: createCanvas('http://127.0.0.1:1'), canvasPublicUrl: '', allowedHosts: ['127.0.0.1:9'] });
  const gbase = await listen(guarded);
  assert.equal((await fetch(gbase + '/api/projects')).status, 403, 'DNS-rebinding guard');
  guarded.close();
});

test('status reports an unreachable canvas', async () => {
  const lone = createServer({ store: createStore(dir), canvas: createCanvas('http://127.0.0.1:1'), canvasPublicUrl: '' });
  const lbase = await listen(lone);
  const s = await (await fetch(lbase + '/api/status')).json();
  assert.equal(s.canvas, 'unreachable');
  lone.close();
});

test('deleting the loaded drawing makes the canvas count as unsaved', async () => {
  await post('/api/load', { project: 'budgeting', file: 'budgeting_v0_plan.excalidraw' });
  assert.equal((await get('/api/status')).dirty, false);
  await post('/api/delete', { project: 'budgeting', file: 'budgeting_v0_plan.excalidraw' });
  const s = await get('/api/status');
  assert.equal(s.current, null);
  assert.equal(s.dirty, true);
  await fs.writeFile(path.join(dir, 'budgeting', 'other.excalidraw'), JSON.stringify({ elements: [] }));
  assert.equal((await post('/api/load', { project: 'budgeting', file: 'other.excalidraw' })).status, 409, 'load asks before wiping it');
});

test('same-origin posts pass, oversized bodies are refused', async () => {
  const res = await post('/api/save', { project: 'budgeting' }, { origin: base });
  assert.equal(res.status, 200);
  const big = await post('/api/save', { project: 'budgeting', label: 'x'.repeat(70000) });
  assert.equal(big.status, 413);
});

test('concurrent saves get distinct versions', async () => {
  canvas.state.elements.set('a', rect('a'));
  const results = await Promise.all([1, 2, 3].map(() => post('/api/save', { project: 'budgeting' }).then((r) => r.json())));
  assert.deepEqual(results.map((r) => r.current.file).sort(), ['budgeting_v1.excalidraw', 'budgeting_v2.excalidraw', 'budgeting_v3.excalidraw']);
});

test('after a browser sync the strict anchor is used through the API', async () => {
  await post('/api/load', { project: 'budgeting', file: 'budgeting_v0_plan.excalidraw' });
  for (const [id, e] of canvas.state.elements) canvas.state.elements.set(id, { ...e, source: 'frontend_sync', boundElements: [], width: 10 });
  assert.equal((await get('/api/status')).dirty, false, 'normalized sync is clean and anchors');
  const a = canvas.state.elements.get('a');
  canvas.state.elements.set('a', { ...a, boundElements: [{ id: 'z', type: 'arrow' }] });
  assert.equal((await get('/api/status')).dirty, true, 'strict compare now sees boundElements changes');
});

test('the page is not frameable and only frames the canvas', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(res.headers.get('content-security-policy'), /frame-src http:\/\/localhost:3000;/);
});
