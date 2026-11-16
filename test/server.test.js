import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createBackups } from '../src/backups.js';
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
    if (req.url === '/api/elements' && req.method === 'GET') {
      const reply = send({ success: true, elements: [...state.elements.values()] });
      state.afterGet?.(); // test hook: something changes the canvas right after a read
      return reply;
    }
    if (req.url === '/api/files' && req.method === 'GET') return send({ files: Object.fromEntries(state.files) });
    if (req.url === '/api/files' && req.method === 'POST') { for (const f of json.files) state.files.set(f.id, f); return send({ success: true }); }
    if (req.url === '/api/export/image') {
      if (state.failExport) { res.writeHead(500, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ success: false, error: 'render failed' })); }
      return send({ success: true, format: 'png', data: Buffer.from(`PNG of ${state.elements.size}`).toString('base64') });
    }
    if (req.url === '/api/elements/batch') {
      if (state.failBatch) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ success: false, error: 'rejected' })); }
      if (json.replace) state.elements.clear();
      for (const e of json.elements) state.elements.set(e.id, { ...e, createdAt: 'c', updatedAt: 'u', version: 1 });
      return send({ success: true });
    }
    res.writeHead(404); res.end('{}');
  });
  return { state, server };
}

let dir, backupsDir, canvas, hub, base;
const rect = (id, x = 0) => ({ id, type: 'rectangle', x, y: 0, width: 10, height: 10 });
const post = (route, body, headers = {}) => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const get = async (route) => (await fetch(base + route)).json();
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${s.address().port}`)));

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-api-'));
  backupsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-backups-'));
  await fs.mkdir(path.join(dir, 'budgeting'));
  await fs.writeFile(path.join(dir, 'budgeting', 'budgeting_v0_plan.excalidraw'), JSON.stringify({ elements: [rect('a'), rect('b')], appState: { viewBackgroundColor: '#fff9db' } }));
  await fs.writeFile(path.join(dir, 'budgeting', 'budgeting_v0_plan.png'), 'png');
  canvas = fakeCanvas();
  const canvasUrl = await listen(canvas.server);
  hub = createServer({ store: createStore(dir), canvas: createCanvas(canvasUrl), backups: createBackups(backupsDir), canvasPublicUrl: 'http://localhost:3000' });
  base = await listen(hub);
  const port = new URL(base).port;
  // Re-create with the Host guard on, as main.js configures it.
  await new Promise((r) => hub.close(r));
  hub = createServer({ store: createStore(dir), canvas: createCanvas(canvasUrl), backups: createBackups(backupsDir), canvasPublicUrl: 'http://localhost:3000', allowedHosts: [`127.0.0.1:${port}`] });
  await new Promise((r) => hub.listen(Number(port), '127.0.0.1', r));
});
afterEach(() => { canvas.server.close(); hub.close(); });

test('list → load → clean → edit → dirty → save new version → clean', async () => {
  const { projects } = (await get('/api/projects')).folders[0];
  assert.deepEqual(projects.map((p) => [p.name, p.drawings.map((d) => [d.file, d.latest, d.png])]), [['budgeting', [['budgeting_v0_plan.excalidraw', true, true]]]]);
  assert.equal((await get('/api/status')).dirty, false, 'empty canvas, nothing loaded');

  const load = await post('/api/load', { project: 'budgeting', file: 'budgeting_v0_plan.excalidraw' });
  assert.equal(load.status, 200);
  assert.deepEqual((await get('/api/status')), { current: { folder: 'main', project: 'budgeting', file: 'budgeting_v0_plan.excalidraw' }, dirty: false, canvas: 'ok', elementCount: 2, agentElements: 2 });

  canvas.state.elements.set('c', rect('c', 50));
  assert.equal((await get('/api/status')).dirty, true);

  const save = await (await post('/api/save', { project: 'budgeting', label: 'With C', versioned: true })).json();
  assert.deepEqual(save.current, { folder: 'main', project: 'budgeting', file: 'budgeting_v1_with_c.excalidraw' });
  const saved = JSON.parse(await fs.readFile(path.join(dir, 'budgeting', 'budgeting_v1_with_c.excalidraw'), 'utf8'));
  assert.deepEqual(saved.elements.map((e) => e.id).sort(), ['a', 'b', 'c']);
  assert.equal('createdAt' in saved.elements[0], false, 'server keys stripped');
  assert.deepEqual(saved.appState, { viewBackgroundColor: '#fff9db' }, 'appState carried from the loaded file');
  assert.equal((await get('/api/status')).dirty, false);
});

test('switching saves unsaved work into the loaded drawing first, backing up the old file', async () => {
  await post('/api/load', { project: 'budgeting', file: 'budgeting_v0_plan.excalidraw' });
  const original = await fs.readFile(path.join(dir, 'budgeting', 'budgeting_v0_plan.excalidraw'));
  await fs.writeFile(path.join(dir, 'budgeting', 'other.excalidraw'), JSON.stringify({ elements: [rect('o')] }));
  canvas.state.elements.set('x', rect('x'));
  const res = await post('/api/load', { project: 'budgeting', file: 'other.excalidraw' });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).autosaved, { folder: 'main', project: 'budgeting', file: 'budgeting_v0_plan.excalidraw' });
  const saved = JSON.parse(await fs.readFile(path.join(dir, 'budgeting', 'budgeting_v0_plan.excalidraw'), 'utf8'));
  assert.deepEqual(saved.elements.map((e) => e.id).sort(), ['a', 'b', 'x']);
  assert.deepEqual([...canvas.state.elements.keys()], ['o'], 'then the other drawing is loaded');
  const [backup] = await fs.readdir(path.join(backupsDir, 'budgeting', 'budgeting_v0_plan'));
  assert.deepEqual(await fs.readFile(path.join(backupsDir, 'budgeting', 'budgeting_v0_plan', backup)), original, 'the old file is kept byte for byte');
  const listed = (await get('/api/projects')).folders[0].projects[0].drawings.find((d) => d.file === 'budgeting_v0_plan.excalidraw');
  assert.equal(listed.backups, 1);
});

test('clicking the loaded drawing while dirty saves it and shows the saved state, not the old file', async () => {
  await post('/api/load', { project: 'budgeting', file: 'budgeting_v0_plan.excalidraw' });
  canvas.state.elements.set('x', rect('x'));
  assert.equal((await post('/api/load', { project: 'budgeting', file: 'budgeting_v0_plan.excalidraw' })).status, 200);
  assert.deepEqual([...canvas.state.elements.keys()].sort(), ['a', 'b', 'x']);
  assert.equal((await get('/api/status')).dirty, false);
  canvas.state.elements.set('y', rect('y'));
  assert.equal((await post('/api/save', { project: 'budgeting', versioned: false })).status, 200, 'the next Save is not refused as "changed on disk"');
});

test('switching with nothing loaded saves to tmp/; with an empty canvas there is nothing to save', async () => {
  canvas.state.elements.set('x', rect('x'));
  const res = await (await post('/api/load', { project: 'budgeting', file: 'budgeting_v0_plan.excalidraw' })).json();
  assert.deepEqual(res.autosaved, { folder: 'main', project: 'tmp', file: 'tmp_v0.excalidraw' });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'tmp', 'tmp_v0.excalidraw'), 'utf8')).elements.map((e) => e.id), ['x']);
  canvas.state.elements.clear(); // e.g. the canvas restarted: dirty, but nothing to lose
  const again = await (await post('/api/load', { project: 'budgeting', file: 'budgeting_v0_plan.excalidraw' })).json();
  assert.equal(again.autosaved, null);
});

test('a refused save stops the switch and says why', async () => {
  await post('/api/load', { project: 'budgeting', file: 'budgeting_v0_plan.excalidraw' });
  canvas.state.elements.set('x', rect('x'));
  await new Promise((r) => setTimeout(r, 20));
  await fs.writeFile(path.join(dir, 'budgeting', 'budgeting_v0_plan.excalidraw'), JSON.stringify({ elements: [rect('git-pulled')] }));
  await fs.writeFile(path.join(dir, 'budgeting', 'other.excalidraw'), JSON.stringify({ elements: [] }));
  const res = await post('/api/load', { project: 'budgeting', file: 'other.excalidraw' });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.saveFailed, true);
  assert.match(body.error, /could not be saved, so other\.excalidraw was not loaded.*changed on disk.*Save new version/);
  assert.ok(canvas.state.elements.has('x'), 'canvas untouched');
  assert.deepEqual((await get('/api/status')).current, { folder: 'main', project: 'budgeting', file: 'budgeting_v0_plan.excalidraw' });
  assert.equal((await post('/api/load', { project: 'budgeting', file: 'missing.excalidraw' })).status, 404, 'a missing target saves nothing');
});

test('revert restores the newest backup step by step and keeps what it replaced', async () => {
  const file = path.join(dir, 'budgeting', 'budgeting_v0_plan.excalidraw');
  await post('/api/load', { project: 'budgeting', file: 'budgeting_v0_plan.excalidraw' });
  const v1 = await fs.readFile(file);
  canvas.state.elements.set('c', rect('c'));
  await post('/api/save', { project: 'budgeting', versioned: false });
  const v2 = await fs.readFile(file);
  canvas.state.elements.set('d', rect('d'));
  await post('/api/save', { project: 'budgeting', versioned: false });
  const v3 = await fs.readFile(file);
  let res = await (await post('/api/revert', { project: 'budgeting', file: 'budgeting_v0_plan.excalidraw' })).json();
  assert.equal(res.remaining, 1);
  assert.equal(res.png, true);
  assert.deepEqual(await fs.readFile(file), v2);
  assert.deepEqual([...canvas.state.elements.keys()].sort(), ['a', 'b', 'c'], 'reverted state on the canvas');
  assert.equal((await get('/api/status')).dirty, false);
  await post('/api/revert', { project: 'budgeting', file: 'budgeting_v0_plan.excalidraw' });
  assert.deepEqual(await fs.readFile(file), v1);
  const none = await post('/api/revert', { project: 'budgeting', file: 'budgeting_v0_plan.excalidraw' });
  assert.equal(none.status, 404);
  const kept = await fs.readdir(path.join(backupsDir, '_reverted', 'budgeting', 'budgeting_v0_plan'));
  const keptBytes = await Promise.all(kept.map((n) => fs.readFile(path.join(backupsDir, '_reverted', 'budgeting', 'budgeting_v0_plan', n))));
  assert.deepEqual(keptBytes.map(String).sort(), [v2, v3].map(String).sort(), 'every replaced state is kept');
});

test('revert with unsaved edits restores the last saved state and keeps the edits; only the loaded drawing', async () => {
  const file = path.join(dir, 'budgeting', 'budgeting_v0_plan.excalidraw');
  await post('/api/load', { project: 'budgeting', file: 'budgeting_v0_plan.excalidraw' });
  canvas.state.elements.set('c', rect('c'));
  await post('/api/save', { project: 'budgeting', versioned: false });
  const lastSaved = await fs.readFile(file);
  canvas.state.elements.set('edit', rect('edit')); // unsaved
  const res = await post('/api/revert', { project: 'budgeting', file: 'budgeting_v0_plan.excalidraw' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).remaining, 1, 'the earlier backup is still there');
  assert.deepEqual(await fs.readFile(file), lastSaved);
  assert.deepEqual([...canvas.state.elements.keys()].sort(), ['a', 'b', 'c']);
  const dirR = path.join(backupsDir, '_reverted', 'budgeting', 'budgeting_v0_plan');
  const [kept] = await fs.readdir(dirR);
  assert.ok(JSON.parse(await fs.readFile(path.join(dirR, kept), 'utf8')).elements.some((e) => e.id === 'edit'), 'the unsaved edit is kept');
  await fs.writeFile(path.join(dir, 'budgeting', 'other.excalidraw'), JSON.stringify({ elements: [] }));
  assert.equal((await post('/api/revert', { project: 'budgeting', file: 'other.excalidraw' })).status, 409, 'not the loaded drawing');
});

test('sync: off without git; passes only known confirmations to git', async () => {
  assert.equal((await post('/api/sync', { project: 'budgeting' })).status, 404);
  const seen = [];
  const fakeGit = { syncBranch: 'dev', commit: async (p, c) => { seen.push(c); return { committed: true, push: true, message: 'm' }; }, push: async () => ({ pushed: true }) };
  const s = createServer({ store: createStore(dir), canvas: createCanvas('http://127.0.0.1:1'), backups: createBackups(backupsDir), git: fakeGit, canvasPublicUrl: '' });
  const url = await listen(s);
  const r = await (await fetch(`${url}/api/sync`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: 'budgeting', confirm: ['ahead', 'evil', 'branch'] }) })).json();
  assert.equal(r.pushed, true);
  assert.deepEqual(seen, [['branch']]);
  assert.deepEqual(await (await fetch(`${url}/api/config`)).json(), { canvasUrl: '', sync: true, syncBranch: 'dev', canAttach: false });
  s.close();
});

test('backups follow a rename; delete and a new file of the same name do not inherit them', async () => {
  await post('/api/load', { project: 'budgeting', file: 'budgeting_v0_plan.excalidraw' });
  canvas.state.elements.set('c', rect('c'));
  await post('/api/save', { project: 'budgeting', versioned: false });
  await post('/api/rename', { project: 'budgeting', file: 'budgeting_v0_plan.excalidraw', newBase: 'budgeting_v0_moved' });
  const drawings = async () => (await get('/api/projects')).folders[0].projects[0].drawings;
  assert.equal((await drawings()).find((d) => d.file === 'budgeting_v0_moved.excalidraw').backups, 1);
  await post('/api/delete', { project: 'budgeting', file: 'budgeting_v0_moved.excalidraw' });
  await fs.writeFile(path.join(dir, 'budgeting', 'x.excalidraw'), JSON.stringify({ elements: [] }));
  await post('/api/load', { project: 'budgeting', file: 'x.excalidraw' });
  canvas.state.elements.set('n', rect('n'));
  await post('/api/save', { project: 'budgeting', label: 'v0 moved', versioned: false });
  assert.equal((await drawings()).find((d) => d.file === 'budgeting_v0_moved.excalidraw').backups, 0);
  assert.equal((await fs.readdir(path.join(backupsDir, '_retired', 'budgeting'))).length, 1);
});

test('save expands agent shorthand with no tab, writes it back, and the canvas is clean right after', async () => {
  canvas.state.elements.set('s', { id: 's', type: 'rectangle', x: 0, y: 0, width: 100, height: 40, label: { text: 'hi' } });
  canvas.state.elements.set('t', { id: 't', type: 'rectangle', x: 300, y: 0, width: 100, height: 40 });
  canvas.state.elements.set('a', { id: 'a', type: 'arrow', x: 100, y: 20, points: [[0, 0], [200, 0]], start: { id: 's' }, end: { id: 't' } });
  assert.equal((await get('/api/status')).agentElements, 3);
  const res = await post('/api/save', { project: 'agents', versioned: true });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.expanded, 3);
  assert.equal(body.png, true);
  const saved = JSON.parse(await fs.readFile(path.join(dir, 'agents', 'agents_v0.excalidraw'), 'utf8'));
  const m = Object.fromEntries(saved.elements.map((e) => [e.id, e]));
  assert.equal(m['s-label'].containerId, 's');
  assert.equal(m['s-label'].text, 'hi');
  assert.deepEqual(m.a.startBinding, { elementId: 's', focus: 0, gap: 8 });
  assert.deepEqual(m.t.boundElements, [{ type: 'arrow', id: 'a' }]);
  assert.ok(saved.elements.every((e) => !('label' in e) && !('start' in e) && !('end' in e)));
  // Written back: the canvas holds the expanded scene, so status is clean at once and reports no agent elements.
  assert.equal(canvas.state.elements.get('s-label').containerId, 's');
  const s = await get('/api/status');
  assert.equal(s.dirty, false);
  assert.equal(s.agentElements, 0);
  assert.equal(await fs.readFile(path.join(dir, 'agents', 'agents_v0.png'), 'utf8'), 'PNG of 4');
});

test('a write landing during the save is not wiped: the file is saved, the canvas is left alone', async () => {
  canvas.state.elements.set('s', { id: 's', type: 'rectangle', x: 0, y: 0, width: 100, height: 40, label: { text: 'hi' } });
  canvas.state.afterGet = () => { canvas.state.afterGet = null; canvas.state.elements.set('late', { ...rect('late'), updatedAt: 'later' }); };
  const res = await post('/api/save', { project: 'agents', versioned: true });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.writtenBack, false);
  assert.ok(canvas.state.elements.has('late'), 'the late element survives');
  assert.ok('label' in canvas.state.elements.get('s'), 'canvas not replaced');
  const saved = JSON.parse(await fs.readFile(path.join(dir, 'agents', 'agents_v0.excalidraw'), 'utf8'));
  assert.deepEqual(saved.elements.map((e) => e.id), ['s', 's-label']);
  assert.equal((await get('/api/status')).dirty, true, 'the late element is unsaved');
});

test('a refused save leaves the canvas as it was', async () => {
  canvas.state.elements.set('s', { id: 's', type: 'rectangle', x: 0, y: 0, width: 100, height: 40, label: { text: 'hi' } });
  const res = await post('/api/save', { project: 'budgeting', label: 'v0 plan', versioned: false });
  assert.equal(res.status, 409, 'budgeting_v0_plan.excalidraw exists');
  assert.ok('label' in canvas.state.elements.get('s'), 'not rewritten');
  assert.equal(canvas.state.elements.has('s-label'), false);
});

test('save keeps files referenced only', async () => {
  canvas.state.elements.set('i', { id: 'i', type: 'image', fileId: 'f1', x: 0, y: 0 });
  canvas.state.files.set('f1', { id: 'f1', dataURL: 'data:1' }); canvas.state.files.set('old', { id: 'old', dataURL: 'data:2' });
  const save = await (await post('/api/save', { project: 'new-proj', versioned: true })).json();
  assert.equal(save.current.file, 'new-proj_v0.excalidraw');
  const saved = JSON.parse(await fs.readFile(path.join(dir, 'new-proj', 'new-proj_v0.excalidraw'), 'utf8'));
  assert.deepEqual(Object.keys(saved.files), ['f1']);
});

test('png: an overwrite regenerates it; a render failure still saves the drawing', async () => {
  await post('/api/load', { project: 'budgeting', file: 'budgeting_v0_plan.excalidraw' });
  canvas.state.elements.set('c', rect('c', 50));
  assert.equal((await (await post('/api/save', { project: 'budgeting', versioned: false })).json()).png, true);
  assert.equal(await fs.readFile(path.join(dir, 'budgeting', 'budgeting_v0_plan.png'), 'utf8'), 'PNG of 3', 'stale png replaced');
  canvas.state.failExport = true;
  canvas.state.elements.set('d', rect('d', 80));
  const res = await post('/api/save', { project: 'budgeting', versioned: true });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.png, false);
  assert.match(body.pngError, /render failed/);
  assert.ok((await fs.readdir(path.join(dir, 'budgeting'))).includes('budgeting_v1.excalidraw'));
  assert.equal((await fs.readdir(path.join(dir, 'budgeting'))).filter((f) => f.startsWith('.')).length, 0, 'no temp files left');
});

test('rename and delete follow the current drawing and its png', async () => {
  await post('/api/load', { project: 'budgeting', file: 'budgeting_v0_plan.excalidraw' });
  const r = await (await post('/api/rename', { project: 'budgeting', file: 'budgeting_v0_plan.excalidraw', newBase: 'budgeting_v0_first' })).json();
  assert.deepEqual(r.current, { folder: 'main', project: 'budgeting', file: 'budgeting_v0_first.excalidraw' });
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
  assert.equal((await post('/api/save', { project: '../etc', versioned: false })).status, 400);
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
  const res = await post('/api/load', { project: 'budgeting', file: 'other.excalidraw' });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).autosaved, { folder: 'main', project: 'tmp', file: 'tmp_v0.excalidraw' }, 'nothing loaded any more: the work went to tmp/');
});

test('same-origin posts pass, oversized bodies are refused', async () => {
  const res = await post('/api/save', { project: 'budgeting', versioned: false }, { origin: base });
  assert.equal(res.status, 200);
  const big = await post('/api/save', { project: 'budgeting', label: 'x'.repeat(70000), versioned: false });
  assert.equal(big.status, 413);
});

test('concurrent saves get distinct versions', async () => {
  canvas.state.elements.set('a', rect('a'));
  const results = await Promise.all([1, 2, 3].map(() => post('/api/save', { project: 'budgeting', versioned: true }).then((r) => r.json())));
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

test('save into a project name too long for a version suffix is a clear 400', async () => {
  canvas.state.elements.set('a', rect('a'));
  const ok = await post('/api/save', { project: 'p'.repeat(110), label: 'some label', versioned: true });
  assert.equal(ok.status, 200);
  const res = await post('/api/save', { project: 'p'.repeat(111), versioned: false });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /too long/);
});

test('version overflow is a clear 400, not a retry loop', async () => {
  await fs.writeFile(path.join(dir, 'budgeting', 'budgeting_v999999999.excalidraw'), JSON.stringify({ elements: [] }));
  const res = await post('/api/save', { project: 'budgeting', versioned: true });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /highest version/);
});

test('deleting the loaded drawing keeps its appState for the next save', async () => {
  await post('/api/load', { project: 'budgeting', file: 'budgeting_v0_plan.excalidraw' });
  await post('/api/delete', { project: 'budgeting', file: 'budgeting_v0_plan.excalidraw' });
  const save = await (await post('/api/save', { project: 'budgeting', versioned: false })).json();
  const saved = JSON.parse(await fs.readFile(path.join(dir, 'budgeting', save.current.file), 'utf8'));
  assert.deepEqual(saved.appState, { viewBackgroundColor: '#fff9db' });
});

test('versioning off: save overwrites the loaded drawing and becomes clean', async () => {
  const file = 'budgeting_v0_plan.excalidraw';
  await post('/api/load', { project: 'budgeting', file });
  canvas.state.elements.set('c', rect('c', 50));
  assert.equal((await get('/api/status')).dirty, true);
  const save = await (await post('/api/save', { project: 'budgeting', versioned: false })).json();
  assert.deepEqual(save.current, { folder: 'main', project: 'budgeting', file });
  const saved = JSON.parse(await fs.readFile(path.join(dir, 'budgeting', file), 'utf8'));
  assert.deepEqual(saved.elements.map((e) => e.id).sort(), ['a', 'b', 'c']);
  assert.deepEqual(saved.appState, { viewBackgroundColor: '#fff9db' });
  assert.equal((await get('/api/status')).dirty, false);
  assert.deepEqual((await fs.readdir(path.join(dir, 'budgeting'))).sort(), [file, 'budgeting_v0_plan.png'].sort(), 'no new file');
});

test('versioning off: a label or nothing loaded writes a plain name and never overwrites another file', async () => {
  const other = path.join(dir, 'budgeting', 'budgeting_v0_plan.excalidraw');
  const before = await fs.readFile(other, 'utf8');
  canvas.state.elements.set('a', rect('a'));
  const first = await (await post('/api/save', { project: 'budgeting', versioned: false })).json();
  assert.equal(first.current.file, 'budgeting.excalidraw', 'nothing loaded');

  const refused = await post('/api/save', { project: 'budgeting', label: 'v0 plan', versioned: false });
  assert.equal(refused.status, 409, 'the label names a file that is not the loaded drawing');
  assert.match((await refused.json()).error, /budgeting_v0_plan\.excalidraw already exists.*Save new version/);
  assert.equal(await fs.readFile(other, 'utf8'), before, 'other drawing untouched');
  assert.equal((await get('/api/status')).current.file, 'budgeting.excalidraw', 'current unchanged after refusal');

  const labelled = await (await post('/api/save', { project: 'budgeting', label: 'Second Idea', versioned: false })).json();
  assert.equal(labelled.current.file, 'budgeting_second_idea.excalidraw');
  const again = await post('/api/save', { project: 'budgeting', label: 'second idea', versioned: false });
  assert.equal(again.status, 409, 'a label never overwrites, even the loaded drawing');
});

test('a save without the flag (a tab from before the checkbox) writes nothing and asks to reload', async () => {
  await post('/api/load', { project: 'budgeting', file: 'budgeting_v0_plan.excalidraw' });
  const before = await fs.readFile(path.join(dir, 'budgeting', 'budgeting_v0_plan.excalidraw'), 'utf8');
  canvas.state.elements.set('c', rect('c', 50));
  for (const body of [{ project: 'budgeting', label: '' }, { project: 'budgeting', versioned: 'yes' }]) {
    const res = await post('/api/save', body);
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /reload/);
  }
  assert.equal(await fs.readFile(path.join(dir, 'budgeting', 'budgeting_v0_plan.excalidraw'), 'utf8'), before);
  assert.deepEqual((await fs.readdir(path.join(dir, 'budgeting'))).sort(), ['budgeting_v0_plan.excalidraw', 'budgeting_v0_plan.png']);
});

describe('guards on overwriting the loaded drawing', () => {
  const file = 'budgeting_v0_plan.excalidraw';
  const p = () => path.join(dir, 'budgeting', file);
  const saveInPlace = () => post('/api/save', { project: 'budgeting', versioned: false });
  beforeEach(async () => { await post('/api/load', { project: 'budgeting', file }); });

  async function refused(pattern) {
    const before = await fs.readFile(p(), 'utf8');
    const res = await saveInPlace();
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, pattern);
    assert.equal(await fs.readFile(p(), 'utf8'), before, 'file untouched');
    assert.deepEqual((await get('/api/status')).current, { folder: 'main', project: 'budgeting', file }, 'still loaded');
  }

  test('a canvas that restarted empty does not wipe the file; versioned still saves', async () => {
    canvas.state.elements.clear();
    await refused(/canvas is empty/);
    assert.equal((await post('/api/save', { project: 'budgeting', versioned: true })).status, 200);
  });

  test('a canvas that lost an image does not overwrite', async () => {
    canvas.state.elements.set('i', { id: 'i', type: 'image', fileId: 'gone', x: 0, y: 0 });
    await refused(/lost 1 image/);
  });

  test('a file changed on disk since load is not clobbered', async () => {
    await fs.writeFile(p(), JSON.stringify({ elements: [rect('from-git')] }));
    await refused(/changed on disk/);
  });

  test('repeat saves, and save after rename, keep working in place', async () => {
    canvas.state.elements.set('c', rect('c', 50));
    assert.equal((await saveInPlace()).status, 200);
    canvas.state.elements.set('d', rect('d', 60));
    assert.equal((await saveInPlace()).status, 200);
    await post('/api/rename', { project: 'budgeting', file, newBase: 'budgeting_v0_first' });
    canvas.state.elements.set('e', rect('e', 70));
    const save = await (await saveInPlace()).json();
    assert.equal(save.current.file, 'budgeting_v0_first.excalidraw');
    const saved = JSON.parse(await fs.readFile(path.join(dir, 'budgeting', save.current.file), 'utf8'));
    assert.deepEqual(saved.elements.map((e) => e.id).sort(), ['a', 'b', 'c', 'd', 'e']);
    assert.deepEqual((await fs.readdir(path.join(dir, 'budgeting'))).sort(), ['budgeting_v0_first.excalidraw', 'budgeting_v0_first.png']);
  });

  test('after a failed load, save cannot overwrite the previous drawing', async () => {
    await fs.writeFile(path.join(dir, 'budgeting', 'other.excalidraw'), JSON.stringify({ elements: [rect('o')] }));
    const before = await fs.readFile(p(), 'utf8');
    canvas.state.failBatch = true;
    assert.equal((await post('/api/load', { project: 'budgeting', file: 'other.excalidraw' })).status, 502);
    canvas.state.failBatch = false;
    const s = await get('/api/status');
    assert.equal(s.current, null);
    assert.equal(s.dirty, true);
    const save = await (await saveInPlace()).json();
    assert.equal(save.current.file, 'budgeting.excalidraw');
    assert.equal(await fs.readFile(p(), 'utf8'), before);
  });

  test('a label with nothing usable is refused, not treated as no label', async () => {
    const before = await fs.readFile(p(), 'utf8');
    const res = await post('/api/save', { project: 'budgeting', label: '日本語', versioned: false });
    assert.equal(res.status, 400);
    assert.equal(await fs.readFile(p(), 'utf8'), before);
  });

  test('saving into another project does not touch the loaded drawing', async () => {
    const before = await fs.readFile(p(), 'utf8');
    const save = await (await post('/api/save', { project: 'elsewhere', versioned: false })).json();
    assert.deepEqual(save.current, { folder: 'main', project: 'elsewhere', file: 'elsewhere.excalidraw' });
    assert.equal(await fs.readFile(p(), 'utf8'), before);
  });
});

describe('workspace folders', () => {
  let ws, home, other, wsHub, wbase;
  const wpost = (route, body) => fetch(wbase + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const wget = async (route) => (await fetch(wbase + route)).json();

  beforeEach(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hub-home-')));
    other = path.join(home, 'repo-b', 'docs', 'drawings');
    await fs.mkdir(path.join(other, 'budgeting'), { recursive: true });
    await fs.writeFile(path.join(other, 'budgeting', 'budgeting_v0.excalidraw'), JSON.stringify({ elements: [rect('other')] }));
    const { createWorkspace } = await import('../src/workspace.js');
    ws = await createWorkspace({ primary: { path: dir }, backupsDir, file: path.join(home, 'workspace.json'), foldersRoot: home, log: () => {} });
    wsHub = createServer({ workspace: ws, canvas: createCanvas(`http://127.0.0.1:${canvas.server.address().port}`), canvasPublicUrl: '' });
    wbase = await listen(wsHub);
  });
  afterEach(() => { wsHub.closeAllConnections(); wsHub.close(); });

  test('attach lists the folder; load and save there use its own files and backups; same project name in both', async () => {
    assert.equal((await wget('/api/config')).canAttach, true);
    const attach = await (await wpost('/api/folders/attach', { path: other })).json();
    const id = attach.folder.id;
    const { folders } = await wget('/api/projects');
    assert.deepEqual(folders.map((f) => [f.id, f.primary, f.sync, f.projects.map((p) => p.name)]), [['main', true, false, ['budgeting']], [id, false, false, ['budgeting']]]);

    const load = await (await wpost('/api/load', { folder: id, project: 'budgeting', file: 'budgeting_v0.excalidraw' })).json();
    assert.deepEqual(load.current, { folder: id, project: 'budgeting', file: 'budgeting_v0.excalidraw' });
    assert.deepEqual([...canvas.state.elements.keys()], ['other']);
    canvas.state.elements.set('z', rect('z'));
    const save = await (await wpost('/api/save', { folder: id, project: 'budgeting', versioned: false })).json();
    assert.deepEqual(save.current, { folder: id, project: 'budgeting', file: 'budgeting_v0.excalidraw' }, 'overwrites the loaded drawing in its folder');
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(other, 'budgeting', 'budgeting_v0.excalidraw'), 'utf8')).elements.map((e) => e.id).sort(), ['other', 'z']);
    assert.equal((await fs.readdir(path.join(backupsDir, '_folders', id, 'budgeting', 'budgeting_v0'))).length, 1);
    assert.deepEqual(await fs.readdir(path.join(dir, 'budgeting')), ['budgeting_v0_plan.excalidraw', 'budgeting_v0_plan.png'], 'primary untouched');

    // Same project name, other folder: a plain save there must not overwrite the loaded drawing's name.
    canvas.state.elements.set('w', rect('w'));
    const cross = await (await wpost('/api/save', { project: 'budgeting', versioned: false })).json();
    assert.deepEqual(cross.current, { folder: 'main', project: 'budgeting', file: 'budgeting.excalidraw' });

    const sync = await wpost('/api/sync', { folder: id, project: 'budgeting' });
    assert.equal(sync.status, 404);
  });

  test('detach: refused for the loaded drawing\'s folder, then removes it and the file reflects it; unknown folder is 404', async () => {
    const { folder } = await (await wpost('/api/folders/attach', { path: other })).json();
    await wpost('/api/load', { folder: folder.id, project: 'budgeting', file: 'budgeting_v0.excalidraw' });
    assert.equal((await wpost('/api/folders/detach', { id: folder.id })).status, 409);
    await wpost('/api/load', { project: 'budgeting', file: 'budgeting_v0_plan.excalidraw' });
    assert.equal((await wpost('/api/folders/detach', { id: folder.id })).status, 200);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(home, 'workspace.json'), 'utf8')).folders, []);
    assert.ok(await fs.stat(path.join(other, 'budgeting', 'budgeting_v0.excalidraw')), 'files stay on disk');
    assert.equal((await wpost('/api/load', { folder: folder.id, project: 'budgeting', file: 'budgeting_v0.excalidraw' })).status, 404);
    assert.equal((await wpost('/api/folders/attach', { path: '/etc' })).status, 403);
  });

  test('a folder that went missing is listed with its error; the others still list', async () => {
    const { folder } = await (await wpost('/api/folders/attach', { path: other })).json();
    await fs.rm(path.join(home, 'repo-b'), { recursive: true });
    const { folders } = await wget('/api/projects');
    assert.equal(folders[0].projects.length, 1);
    assert.equal(folders[1].id, folder.id);
    assert.match(folders[1].error, /cannot read .*ENOENT/);
  });
});
