import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createCanvas } from '../src/canvas.js';
import { createServer } from '../src/server.js';
import { createStore } from '../src/store.js';
import { createWorkspace } from '../src/workspace.js';
import { execFileSync } from 'node:child_process';

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
      state.exports = (state.exports ?? 0) + 1;
      const n = json.elements ? json.elements.length : state.elements.size; // a given scene, else the live canvas
      const ids = json.elements && state.showIds ? json.elements.map((e) => e.id).sort().join(',') : '';
      if (state.holdExport) await state.holdExport; // test hook: a slow render
      if (state.failExport) { res.writeHead(500, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ success: false, error: 'render failed' })); }
      return send({ success: true, format: 'png', data: Buffer.from(`PNG of ${n}${ids ? ` [${ids}]` : ''}`).toString('base64') });
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

let home, dir, backupsDir, canvas, canvasUrl, hub, base, ws, rid;
const rect = (id, x = 0) => ({ id, type: 'rectangle', x, y: 0, width: 10, height: 10 });
const post = (route, body, headers = {}) => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const get = async (route) => (await fetch(base + route)).json();
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${s.address().port}`)));
const mkWorkspace = () => createWorkspace({ backupsDir, foldersRoot: home, file: path.join(home, 'hub.json'), log: () => {} });
const BP = 'roadmap/roadmap_v0_plan.excalidraw'; // the seeded drawing, as a path inside the root
const at = (p) => ({ root: rid, path: p });
const readDoc = async (rel) => JSON.parse(await fs.readFile(path.join(dir, rel), 'utf8'));
const current = (p) => ({ root: rid, path: p });

beforeEach(async () => {
  home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hub-api-')));
  dir = path.join(home, 'drawings');
  backupsDir = path.join(home, 'backups');
  for (const d of ['roadmap', 'agents', 'new-proj', 'elsewhere', 'tmpdir']) await fs.mkdir(path.join(dir, d), { recursive: true });
  await fs.writeFile(path.join(dir, BP), JSON.stringify({ elements: [rect('a'), rect('b')], appState: { viewBackgroundColor: '#fff9db' } }));
  await fs.writeFile(path.join(dir, 'roadmap', 'roadmap_v0_plan.png'), 'png');
  canvas = fakeCanvas();
  canvasUrl = await listen(canvas.server);
  ws = await mkWorkspace();
  rid = (await ws.attach(dir)).id;
  hub = createServer({ workspace: ws, canvas: createCanvas(canvasUrl), canvasPublicUrl: 'http://localhost:3000' });
  base = await listen(hub);
  const port = new URL(base).port;
  // Re-create with the Host guard on, as main.js configures it.
  await new Promise((r) => hub.close(r));
  hub = createServer({ workspace: ws, canvas: createCanvas(canvasUrl), canvasPublicUrl: 'http://localhost:3000', allowedHosts: [`127.0.0.1:${port}`] });
  await new Promise((r) => hub.listen(Number(port), '127.0.0.1', r));
});
afterEach(() => { canvas.server.close(); hub.closeAllConnections?.(); hub.close(); });

test('tree → load → clean → edit → dirty → save new version → clean', async () => {
  const folders = await get('/api/folders');
  assert.deepEqual(folders, [{ id: rid, name: 'drawings', path: dir, sync: false, syncError: folders[0].syncError }]);
  assert.match(folders[0].syncError, /not a git repository/);
  const top = await get(`/api/tree?root=${rid}`);
  assert.deepEqual(top.dirs.map((d) => d.path), ['agents', 'elsewhere', 'new-proj', 'roadmap', 'tmpdir']);
  const tree = await get(`/api/tree?root=${rid}&path=roadmap`);
  assert.deepEqual(tree.drawings.map((d) => [d.file, d.path, d.latest, d.backups]), [['roadmap_v0_plan.excalidraw', BP, true, 0]]);
  assert.equal((await get('/api/status')).dirty, false, 'empty canvas, nothing loaded');

  const load = await post('/api/load', at(BP));
  assert.equal(load.status, 200);
  assert.deepEqual((await get('/api/status')), { current: current(BP), dirty: false, canvas: 'ok', elementCount: 2, agentElements: 2, png: { pending: 0, error: null } });

  canvas.state.elements.set('c', rect('c', 50));
  assert.equal((await get('/api/status')).dirty, true);

  const save = await (await post('/api/save', { root: rid, dir: 'roadmap', label: 'With C', versioned: true })).json();
  assert.deepEqual(save.current, current('roadmap/roadmap_v1_with_c.excalidraw'));
  const saved = await readDoc('roadmap/roadmap_v1_with_c.excalidraw');
  assert.deepEqual(saved.elements.map((e) => e.id).sort(), ['a', 'b', 'c']);
  assert.equal('createdAt' in saved.elements[0], false, 'server keys stripped');
  assert.deepEqual(saved.appState, { viewBackgroundColor: '#fff9db' }, 'appState carried from the loaded file');
  assert.equal((await get('/api/status')).dirty, false);
});

test('switching saves unsaved work into the loaded drawing first, backing up the old file', async () => {
  await post('/api/load', at(BP));
  const original = await fs.readFile(path.join(dir, BP));
  await fs.writeFile(path.join(dir, 'roadmap', 'other.excalidraw'), JSON.stringify({ elements: [rect('o')] }));
  canvas.state.elements.set('x', rect('x'));
  const res = await post('/api/load', at('roadmap/other.excalidraw'));
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).autosaved, current(BP));
  const saved = await readDoc(BP);
  assert.deepEqual(saved.elements.map((e) => e.id).sort(), ['a', 'b', 'x']);
  assert.deepEqual([...canvas.state.elements.keys()], ['o'], 'then the other drawing is loaded');
  const bdir = path.join(backupsDir, rid, 'roadmap', 'roadmap_v0_plan.excalidraw');
  const [backup] = await fs.readdir(bdir);
  assert.deepEqual(await fs.readFile(path.join(bdir, backup)), original, 'the old file is kept byte for byte');
  const listed = (await get(`/api/tree?root=${rid}&path=roadmap`)).drawings.find((d) => d.file === 'roadmap_v0_plan.excalidraw');
  assert.equal(listed.backups, 1);
});

test('clicking the loaded drawing while dirty saves it and shows the saved state, not the old file', async () => {
  await post('/api/load', at(BP));
  canvas.state.elements.set('x', rect('x'));
  assert.equal((await post('/api/load', at(BP))).status, 200);
  assert.deepEqual([...canvas.state.elements.keys()].sort(), ['a', 'b', 'x']);
  assert.equal((await get('/api/status')).dirty, false);
  canvas.state.elements.set('y', rect('y'));
  assert.equal((await post('/api/save', { root: rid, dir: 'roadmap', versioned: false })).status, 200, 'the next Save is not refused as "changed on disk"');
});

test('switching with nothing loaded saves to tmp/ in the root of the drawing being opened; with an empty canvas there is nothing to save', async () => {
  canvas.state.elements.set('x', rect('x'));
  const res = await (await post('/api/load', at(BP))).json();
  assert.deepEqual(res.autosaved, current('tmp/tmp_v0.excalidraw'));
  assert.deepEqual((await readDoc('tmp/tmp_v0.excalidraw')).elements.map((e) => e.id), ['x']);
  canvas.state.elements.clear(); // e.g. the canvas restarted: dirty, but nothing to lose
  await post('/api/folders/detach', { id: rid });
  const other = path.join(home, 'second');
  await fs.mkdir(other);
  await fs.writeFile(path.join(other, 'two_v0.excalidraw'), JSON.stringify({ elements: [] }));
  const second = (await (await post('/api/folders/attach', { path: other })).json()).folder.id;
  assert.equal((await (await post('/api/load', { root: second, path: 'two_v0.excalidraw' })).json()).autosaved, null);
  canvas.state.elements.set('y', rect('y'));
  await post('/api/delete', { root: second, path: 'two_v0.excalidraw' }); // nothing loaded again
  await fs.writeFile(path.join(other, 'three_v0.excalidraw'), JSON.stringify({ elements: [] }));
  const again = await (await post('/api/load', { root: second, path: 'three_v0.excalidraw' })).json();
  assert.deepEqual(again.autosaved, { root: second, path: 'tmp/tmp_v0.excalidraw' }, 'tmp/ of that root');
});

test('a refused save stops the switch and says why', async () => {
  await post('/api/load', at(BP));
  canvas.state.elements.set('x', rect('x'));
  await new Promise((r) => setTimeout(r, 20));
  await fs.writeFile(path.join(dir, BP), JSON.stringify({ elements: [rect('git-pulled')] }));
  await fs.writeFile(path.join(dir, 'roadmap', 'other.excalidraw'), JSON.stringify({ elements: [] }));
  const res = await post('/api/load', at('roadmap/other.excalidraw'));
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.saveFailed, true);
  assert.match(body.error, /could not be saved, so other\.excalidraw was not loaded.*changed on disk.*Save new version/);
  assert.ok(canvas.state.elements.has('x'), 'canvas untouched');
  assert.deepEqual((await get('/api/status')).current, current(BP));
  assert.equal((await post('/api/load', at('roadmap/missing.excalidraw'))).status, 404, 'a missing target saves nothing');
});

test('revert restores the newest backup step by step and keeps what it replaced', async () => {
  const file = path.join(dir, BP);
  await post('/api/load', at(BP));
  const v1 = await fs.readFile(file);
  canvas.state.elements.set('c', rect('c'));
  await post('/api/save', { root: rid, dir: 'roadmap', versioned: false });
  const v2 = await fs.readFile(file);
  canvas.state.elements.set('d', rect('d'));
  await post('/api/save', { root: rid, dir: 'roadmap', versioned: false });
  const v3 = await fs.readFile(file);
  const res = await (await post('/api/revert', at(BP))).json();
  assert.equal(res.remaining, 1);
  assert.equal(res.png, true);
  assert.deepEqual(await fs.readFile(file), v2);
  assert.deepEqual([...canvas.state.elements.keys()].sort(), ['a', 'b', 'c'], 'reverted state on the canvas');
  assert.equal((await get('/api/status')).dirty, false);
  await post('/api/revert', at(BP));
  assert.deepEqual(await fs.readFile(file), v1);
  const none = await post('/api/revert', at(BP));
  assert.equal(none.status, 404);
  const kdir = path.join(backupsDir, rid, '_reverted', 'roadmap', 'roadmap_v0_plan.excalidraw');
  const kept = await fs.readdir(kdir);
  const keptBytes = await Promise.all(kept.map((n) => fs.readFile(path.join(kdir, n))));
  assert.deepEqual(keptBytes.map(String).sort(), [v2, v3].map(String).sort(), 'every replaced state is kept');
});

test('revert with unsaved edits restores the last saved state and keeps the edits; only the loaded drawing', async () => {
  const file = path.join(dir, BP);
  await post('/api/load', at(BP));
  canvas.state.elements.set('c', rect('c'));
  await post('/api/save', { root: rid, dir: 'roadmap', versioned: false });
  const lastSaved = await fs.readFile(file);
  canvas.state.elements.set('edit', rect('edit')); // unsaved
  const res = await post('/api/revert', at(BP));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).remaining, 1, 'the earlier backup is still there');
  assert.deepEqual(await fs.readFile(file), lastSaved);
  assert.deepEqual([...canvas.state.elements.keys()].sort(), ['a', 'b', 'c']);
  const dirR = path.join(backupsDir, rid, '_reverted', 'roadmap', 'roadmap_v0_plan.excalidraw');
  const [kept] = await fs.readdir(dirR);
  assert.ok(JSON.parse(await fs.readFile(path.join(dirR, kept), 'utf8')).elements.some((e) => e.id === 'edit'), 'the unsaved edit is kept');
  await fs.writeFile(path.join(dir, 'roadmap', 'other.excalidraw'), JSON.stringify({ elements: [] }));
  assert.equal((await post('/api/revert', at('roadmap/other.excalidraw'))).status, 409, 'not the loaded drawing');
});

test('sync: off outside a repo with git\'s reason; passes the repo-relative folder and only known confirmations to git', async () => {
  const off = await post('/api/sync', { root: rid, path: 'roadmap' });
  assert.equal(off.status, 404);
  assert.match((await off.json()).error, /sync is off.*not a git repository/);

  const seen = [];
  const fakeFolder = { id: 'f-fake', name: 'fake', path: path.join(dir, 'roadmap'), store: createStore(path.join(dir, 'roadmap')), repoDir: dir, sync: true,
    git: { sync: async (d, o) => { seen.push([d, o.confirm, typeof o.serial]); return { committed: true, pushed: true, message: 'm' }; } } };
  const fakeWs = { canAttach: false, recent: () => [], folders: () => [fakeFolder], get: () => fakeFolder };
  const s = createServer({ workspace: fakeWs, canvas: createCanvas('http://127.0.0.1:1'), canvasPublicUrl: '' });
  const url = await listen(s);
  const sync = (body) => fetch(`${url}/api/sync`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const r = await (await sync({ root: 'f-fake', path: '', confirm: ['ahead', 'evil', 'branch'] })).json();
  assert.equal(r.pushed, true);
  assert.deepEqual(seen, [['roadmap', ['branch'], 'function']], 'folder relative to the repo top, not to the root');
  assert.equal((await sync({ root: 'f-fake', path: '../x' })).status, 400);
  assert.deepEqual(await (await fetch(`${url}/api/config`)).json(), { canvasUrl: '', canAttach: false, recent: [] });
  s.close();
});

test('sync with real git: a root inside a repo commits its drawings; the folder is relative to the repo top', async () => {
  execFileSync('git', ['init', '-q', '-b', 'dev', home]);
  Object.assign(process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' });
  execFileSync('git', ['-C', home, 'commit', '-q', '--allow-empty', '-m', 'init']);
  const ws2 = await mkWorkspace();
  const id2 = ws2.folders()[0].id;
  assert.equal(ws2.folders()[0].sync, true);
  const s = createServer({ workspace: ws2, canvas: createCanvas('http://127.0.0.1:1'), canvasPublicUrl: '' });
  const url = await listen(s);
  const res = await (await fetch(`${url}/api/sync`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ root: id2, path: 'roadmap' }) })).json();
  assert.deepEqual([res.committed, res.pushed, res.noUpstream], [true, false, true]);
  assert.match(execFileSync('git', ['-C', home, 'show', '--name-only', '--format=', 'HEAD']).toString(), /^drawings\/roadmap\/roadmap_v0_plan\.excalidraw$/m);
  s.close();
});

test('backups follow a rename; delete and a new file of the same name do not inherit them', async () => {
  await post('/api/load', at(BP));
  canvas.state.elements.set('c', rect('c'));
  await post('/api/save', { root: rid, dir: 'roadmap', versioned: false });
  await post('/api/rename', { ...at(BP), newBase: 'roadmap_v0_moved' });
  const drawings = async () => (await get(`/api/tree?root=${rid}&path=roadmap`)).drawings;
  assert.equal((await drawings()).find((d) => d.file === 'roadmap_v0_moved.excalidraw').backups, 1);
  await post('/api/delete', at('roadmap/roadmap_v0_moved.excalidraw'));
  canvas.state.elements.set('n', rect('n')); // nothing is loaded any more: the stem is the folder's
  assert.equal((await post('/api/save', { root: rid, dir: 'roadmap', label: 'v0 moved', versioned: false })).status, 200);
  assert.equal((await drawings()).find((d) => d.file === 'roadmap_v0_moved.excalidraw').backups, 0);
  assert.equal((await fs.readdir(path.join(backupsDir, rid, '_retired', 'roadmap'))).length, 1);
});

test('save expands agent shorthand with no tab, writes it back, and the canvas is clean right after', async () => {
  canvas.state.elements.set('s', { id: 's', type: 'rectangle', x: 0, y: 0, width: 100, height: 40, label: { text: 'hi' } });
  canvas.state.elements.set('t', { id: 't', type: 'rectangle', x: 300, y: 0, width: 100, height: 40 });
  canvas.state.elements.set('a', { id: 'a', type: 'arrow', x: 100, y: 20, points: [[0, 0], [200, 0]], start: { id: 's' }, end: { id: 't' } });
  assert.equal((await get('/api/status')).agentElements, 3);
  const res = await post('/api/save', { root: rid, dir: 'agents', versioned: true });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.expanded, 3);
  assert.equal(body.png, true);
  const saved = await readDoc('agents/agents_v0.excalidraw');
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
  const res = await post('/api/save', { root: rid, dir: 'agents', versioned: true });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.writtenBack, false);
  assert.ok(canvas.state.elements.has('late'), 'the late element survives');
  assert.ok('label' in canvas.state.elements.get('s'), 'canvas not replaced');
  const saved = await readDoc('agents/agents_v0.excalidraw');
  assert.deepEqual(saved.elements.map((e) => e.id), ['s', 's-label']);
  assert.equal((await get('/api/status')).dirty, true, 'the late element is unsaved');
});

test('a refused save leaves the canvas as it was', async () => {
  canvas.state.elements.set('s', { id: 's', type: 'rectangle', x: 0, y: 0, width: 100, height: 40, label: { text: 'hi' } });
  const res = await post('/api/save', { root: rid, dir: 'roadmap', label: 'v0 plan', versioned: false });
  assert.equal(res.status, 409, 'roadmap_v0_plan.excalidraw exists');
  assert.ok('label' in canvas.state.elements.get('s'), 'not rewritten');
  assert.equal(canvas.state.elements.has('s-label'), false);
});

test('save keeps files referenced only', async () => {
  canvas.state.elements.set('i', { id: 'i', type: 'image', fileId: 'f1', x: 0, y: 0 });
  canvas.state.files.set('f1', { id: 'f1', dataURL: 'data:1' }); canvas.state.files.set('old', { id: 'old', dataURL: 'data:2' });
  const save = await (await post('/api/save', { root: rid, dir: 'new-proj', versioned: true })).json();
  assert.equal(save.current.path, 'new-proj/new-proj_v0.excalidraw');
  assert.deepEqual(Object.keys((await readDoc(save.current.path)).files), ['f1']);
});

test('png: an overwrite regenerates it; a render failure still saves the drawing', async () => {
  await post('/api/load', at(BP));
  canvas.state.elements.set('c', rect('c', 50));
  assert.equal((await (await post('/api/save', { root: rid, dir: 'roadmap', versioned: false })).json()).png, true);
  assert.equal(await fs.readFile(path.join(dir, 'roadmap', 'roadmap_v0_plan.png'), 'utf8'), 'PNG of 3', 'stale png replaced');
  canvas.state.failExport = true;
  canvas.state.elements.set('d', rect('d', 80));
  const res = await post('/api/save', { root: rid, dir: 'roadmap', versioned: true });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.png, false);
  assert.match(body.pngError, /render failed/);
  assert.ok((await fs.readdir(path.join(dir, 'roadmap'))).includes('roadmap_v1.excalidraw'));
  assert.equal((await fs.readdir(path.join(dir, 'roadmap'))).filter((f) => f.startsWith('.')).length, 0, 'no temp files left');
});

test('rename and delete follow the current drawing and its png', async () => {
  await post('/api/load', at(BP));
  const r = await (await post('/api/rename', { ...at(BP), newBase: 'roadmap_v0_first' })).json();
  assert.deepEqual(r.current, current('roadmap/roadmap_v0_first.excalidraw'));
  assert.deepEqual((await fs.readdir(path.join(dir, 'roadmap'))).sort(), ['roadmap_v0_first.excalidraw', 'roadmap_v0_first.png']);
  const d = await (await post('/api/delete', at('roadmap/roadmap_v0_first.excalidraw'))).json();
  assert.equal(d.current, null);
  assert.deepEqual(await fs.readdir(path.join(dir, 'roadmap')), []);
});

test('guards: content type, origin, host, bad paths, unknown routes and roots', async () => {
  const body = JSON.stringify(at(BP));
  assert.equal((await fetch(base + '/api/delete', { method: 'POST', body })).status, 415, 'form-style post');
  assert.equal((await post('/api/delete', JSON.parse(body), { origin: 'http://evil.example' })).status, 403);
  assert.equal((await post('/api/rename', { ...at(BP), newBase: '../x' })).status, 400);
  assert.equal((await post('/api/delete', at('../x.excalidraw'))).status, 400);
  assert.equal((await post('/api/delete', at('roadmap/../../x.excalidraw'))).status, 400);
  assert.equal((await post('/api/load', at('/etc/passwd'))).status, 400);
  assert.equal((await post('/api/save', { root: rid, dir: '../etc', versioned: false })).status, 400);
  assert.equal((await post('/api/save', { root: rid, dir: 'missing', versioned: false })).status, 404);
  assert.equal((await post('/api/load', { root: 'f-nope', path: BP })).status, 404, 'unknown root');
  assert.equal((await post('/api/load', { path: BP })).status, 400, 'no root');
  assert.equal((await fetch(base + `/api/tree?root=${rid}&path=..`)).status, 400);
  assert.equal((await fetch(base + `/api/tree?root=${rid}&path=nope`)).status, 404);
  assert.equal((await fetch(base + '/api/projects')).status, 404, 'the old route is gone');
  assert.equal((await fetch(base + '/api/nope')).status, 404);
  assert.equal((await fetch(base + '/../src/server.js')).status, 404);
  await fs.access(path.join(dir, BP));

  const guarded = createServer({ workspace: ws, canvas: createCanvas('http://127.0.0.1:1'), canvasPublicUrl: '', allowedHosts: ['127.0.0.1:9'] });
  const gbase = await listen(guarded);
  assert.equal((await fetch(gbase + '/api/folders')).status, 403, 'DNS-rebinding guard');
  guarded.close();
});

test('a symlink inside a root that leads out is refused by tree, load and save', async () => {
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-outside-'));
  await fs.writeFile(path.join(outside, 'secret_v0.excalidraw'), JSON.stringify({ elements: [] }));
  await fs.symlink(outside, path.join(dir, 'escape'));
  assert.equal((await fetch(base + `/api/tree?root=${rid}&path=escape`)).status, 400);
  assert.equal((await post('/api/load', at('escape/secret_v0.excalidraw'))).status, 400);
  canvas.state.elements.set('a', rect('a'));
  assert.equal((await post('/api/save', { root: rid, dir: 'escape', versioned: true })).status, 400);
  assert.deepEqual(await fs.readdir(outside), ['secret_v0.excalidraw']);
});

test('status reports an unreachable canvas', async () => {
  const lone = createServer({ workspace: ws, canvas: createCanvas('http://127.0.0.1:1'), canvasPublicUrl: '' });
  const lbase = await listen(lone);
  const s = await (await fetch(lbase + '/api/status')).json();
  assert.equal(s.canvas, 'unreachable');
  lone.close();
});

test('deleting the loaded drawing makes the canvas count as unsaved', async () => {
  await post('/api/load', at(BP));
  assert.equal((await get('/api/status')).dirty, false);
  await post('/api/delete', at(BP));
  const s = await get('/api/status');
  assert.equal(s.current, null);
  assert.equal(s.dirty, true);
  await fs.writeFile(path.join(dir, 'roadmap', 'other.excalidraw'), JSON.stringify({ elements: [] }));
  const res = await post('/api/load', at('roadmap/other.excalidraw'));
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).autosaved, current('tmp/tmp_v0.excalidraw'), 'nothing loaded any more: the work went to tmp/');
});

test('same-origin posts pass, oversized bodies are refused', async () => {
  const res = await post('/api/save', { root: rid, dir: 'roadmap', versioned: false }, { origin: base });
  assert.equal(res.status, 200);
  const big = await post('/api/save', { root: rid, dir: 'roadmap', label: 'x'.repeat(70000), versioned: false });
  assert.equal(big.status, 413);
});

test('concurrent saves get distinct versions', async () => {
  canvas.state.elements.set('a', rect('a'));
  const results = await Promise.all([1, 2, 3].map(() => post('/api/save', { root: rid, dir: 'roadmap', versioned: true }).then((r) => r.json())));
  assert.deepEqual(results.map((r) => r.current.path).sort(), ['roadmap_v1', 'roadmap_v2', 'roadmap_v3'].map((n) => `roadmap/${n}.excalidraw`));
});

test('after a browser sync the strict anchor is used through the API', async () => {
  await post('/api/load', at(BP));
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

test('a folder or drawing whose name cannot make a safe file name is refused with the way out; a long stem still fits', async () => {
  canvas.state.elements.set('a', rect('a'));
  await fs.mkdir(path.join(dir, 'p'.repeat(110)));
  await fs.mkdir(path.join(dir, 'p'.repeat(111)));
  await fs.mkdir(path.join(dir, 'My Drawings'));
  const ok = await post('/api/save', { root: rid, dir: 'p'.repeat(110), label: 'some label', versioned: true });
  assert.equal(ok.status, 200);
  for (const d of ['p'.repeat(111), 'My Drawings']) {
    const res = await post('/api/save', { root: rid, dir: d, versioned: false });
    assert.equal(res.status, 400, d);
    assert.match((await res.json()).error, /pick a label-free name: rename the folder or the drawing/);
  }
  // Loading from such a folder still works.
  await fs.writeFile(path.join(dir, 'My Drawings', 'My Plan.excalidraw'), JSON.stringify({ elements: [rect('m')] }));
  assert.deepEqual((await get(`/api/tree?root=${rid}&path=My%20Drawings`)).drawings.map((d) => d.file), ['My Plan.excalidraw']);
  assert.equal((await post('/api/load', at('My Drawings/My Plan.excalidraw'))).status, 200);
});

test('version overflow is a clear 400, not a retry loop', async () => {
  await fs.writeFile(path.join(dir, 'roadmap', 'roadmap_v999999999.excalidraw'), JSON.stringify({ elements: [] }));
  const res = await post('/api/save', { root: rid, dir: 'roadmap', versioned: true });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /highest version/);
});

test('deleting the loaded drawing keeps its appState for the next save', async () => {
  await post('/api/load', at(BP));
  await post('/api/delete', at(BP));
  const save = await (await post('/api/save', { root: rid, dir: 'roadmap', versioned: false })).json();
  assert.deepEqual((await readDoc(save.current.path)).appState, { viewBackgroundColor: '#fff9db' });
});

test('versioning off: save overwrites the loaded drawing and becomes clean', async () => {
  await post('/api/load', at(BP));
  canvas.state.elements.set('c', rect('c', 50));
  assert.equal((await get('/api/status')).dirty, true);
  const save = await (await post('/api/save', { root: rid, dir: 'roadmap', versioned: false })).json();
  assert.deepEqual(save.current, current(BP));
  const saved = await readDoc(BP);
  assert.deepEqual(saved.elements.map((e) => e.id).sort(), ['a', 'b', 'c']);
  assert.deepEqual(saved.appState, { viewBackgroundColor: '#fff9db' });
  assert.equal((await get('/api/status')).dirty, false);
  assert.deepEqual((await fs.readdir(path.join(dir, 'roadmap'))).sort(), ['roadmap_v0_plan.excalidraw', 'roadmap_v0_plan.png'], 'no new file');
});

test('versioning off: a label or nothing loaded writes a plain name and never overwrites another file', async () => {
  const before = await fs.readFile(path.join(dir, BP), 'utf8');
  canvas.state.elements.set('a', rect('a'));
  const first = await (await post('/api/save', { root: rid, dir: 'roadmap', versioned: false })).json();
  assert.equal(first.current.path, 'roadmap/roadmap.excalidraw', 'nothing loaded');

  const refused = await post('/api/save', { root: rid, dir: 'roadmap', label: 'v0 plan', versioned: false });
  assert.equal(refused.status, 409, 'the label names a file that is not the loaded drawing');
  assert.match((await refused.json()).error, /roadmap_v0_plan\.excalidraw already exists.*Save new version/);
  assert.equal(await fs.readFile(path.join(dir, BP), 'utf8'), before, 'other drawing untouched');
  assert.equal((await get('/api/status')).current.path, 'roadmap/roadmap.excalidraw', 'current unchanged after refusal');

  const labelled = await (await post('/api/save', { root: rid, dir: 'roadmap', label: 'Second Idea', versioned: false })).json();
  assert.equal(labelled.current.path, 'roadmap/roadmap_second_idea.excalidraw');
  assert.equal(await fs.readFile(path.join(dir, BP), 'utf8'), before);
});

test('a save without the flag (a tab from before the checkbox) writes nothing and asks to reload', async () => {
  await post('/api/load', at(BP));
  const before = await fs.readFile(path.join(dir, BP), 'utf8');
  canvas.state.elements.set('c', rect('c', 50));
  for (const body of [{ root: rid, dir: 'roadmap', label: '' }, { root: rid, dir: 'roadmap', versioned: 'yes' }]) {
    const res = await post('/api/save', body);
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /reload/);
  }
  assert.equal(await fs.readFile(path.join(dir, BP), 'utf8'), before);
  assert.deepEqual((await fs.readdir(path.join(dir, 'roadmap'))).sort(), ['roadmap_v0_plan.excalidraw', 'roadmap_v0_plan.png']);
});

test('families: a folder with several stems versions each by its own stem; a loaded drawing\'s stem is used in its folder, the folder name elsewhere', async () => {
  for (const f of ['notes_v0.excalidraw', 'notes_v3_x.excalidraw']) await fs.writeFile(path.join(dir, 'roadmap', f), JSON.stringify({ elements: [rect('n')] }));
  await post('/api/load', at('roadmap/notes_v3_x.excalidraw'));
  canvas.state.elements.set('c', rect('c', 50));
  const v = await (await post('/api/save', { root: rid, dir: 'roadmap', versioned: true })).json();
  assert.equal(v.current.path, 'roadmap/notes_v4.excalidraw', 'the loaded drawing\'s family, next version');
  const other = await (await post('/api/save', { root: rid, dir: 'elsewhere', versioned: true })).json();
  assert.equal(other.current.path, 'elsewhere/elsewhere_v0.excalidraw', 'another folder: that folder\'s name');
  await post('/api/load', at(BP));
  canvas.state.elements.set('d', rect('d', 70));
  const plain = await (await post('/api/save', { root: rid, dir: 'roadmap', label: 'copy', versioned: false })).json();
  assert.equal(plain.current.path, 'roadmap/roadmap_copy.excalidraw');
  const latest = (await get(`/api/tree?root=${rid}&path=roadmap`)).drawings.filter((d) => d.latest).map((d) => d.file).sort();
  assert.deepEqual(latest, ['notes_v4.excalidraw', 'roadmap_v0_plan.excalidraw']);
});

test('save at the root level and at depth 3 uses the folder\'s name as the stem', async () => {
  canvas.state.elements.set('a', rect('a'));
  const top = await (await post('/api/save', { root: rid, dir: '', versioned: true })).json();
  assert.equal(top.current.path, 'drawings_v0.excalidraw', 'the root folder\'s own name');
  for (const m of ['a', 'a/b', 'a/b/deep']) await post('/api/mkdir', { root: rid, path: m });
  const deep = await (await post('/api/save', { root: rid, dir: 'a/b/deep', versioned: true })).json();
  assert.equal(deep.current.path, 'a/b/deep/deep_v0.excalidraw');
  assert.equal(await fs.readFile(path.join(dir, 'a/b/deep/deep_v0.png'), 'utf8'), 'PNG of 1');
  assert.deepEqual((await get(`/api/tree?root=${rid}&path=a/b`)).dirs, [{ name: 'deep', path: 'a/b/deep' }]);
});

describe('guards on overwriting the loaded drawing', () => {
  const file = 'roadmap_v0_plan.excalidraw';
  const p = () => path.join(dir, BP);
  const saveInPlace = () => post('/api/save', { root: rid, dir: 'roadmap', versioned: false });
  beforeEach(async () => { await post('/api/load', at(BP)); });

  async function refused(pattern) {
    const before = await fs.readFile(p(), 'utf8');
    const res = await saveInPlace();
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, pattern);
    assert.equal(await fs.readFile(p(), 'utf8'), before, 'file untouched');
    assert.deepEqual((await get('/api/status')).current, current(BP), 'still loaded');
  }

  test('a canvas that restarted empty does not wipe the file; versioned still saves', async () => {
    canvas.state.elements.clear();
    await refused(/canvas is empty/);
    assert.equal((await post('/api/save', { root: rid, dir: 'roadmap', versioned: true })).status, 200);
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
    await post('/api/rename', { ...at(BP), newBase: 'roadmap_v0_first' });
    canvas.state.elements.set('e', rect('e', 70));
    const save = await (await saveInPlace()).json();
    assert.equal(save.current.path, 'roadmap/roadmap_v0_first.excalidraw');
    assert.deepEqual((await readDoc(save.current.path)).elements.map((e) => e.id).sort(), ['a', 'b', 'c', 'd', 'e']);
    assert.deepEqual((await fs.readdir(path.join(dir, 'roadmap'))).sort(), ['roadmap_v0_first.excalidraw', 'roadmap_v0_first.png']);
    void file;
  });

  test('after a failed load, save cannot overwrite the previous drawing', async () => {
    await fs.writeFile(path.join(dir, 'roadmap', 'other.excalidraw'), JSON.stringify({ elements: [rect('o')] }));
    const before = await fs.readFile(p(), 'utf8');
    canvas.state.failBatch = true;
    assert.equal((await post('/api/load', at('roadmap/other.excalidraw'))).status, 502);
    canvas.state.failBatch = false;
    const s = await get('/api/status');
    assert.equal(s.current, null);
    assert.equal(s.dirty, true);
    const save = await (await saveInPlace()).json();
    assert.equal(save.current.path, 'roadmap/roadmap.excalidraw');
    assert.equal(await fs.readFile(p(), 'utf8'), before);
  });

  test('a label with nothing usable is refused, not treated as no label', async () => {
    const before = await fs.readFile(p(), 'utf8');
    const res = await post('/api/save', { root: rid, dir: 'roadmap', label: '日本語', versioned: false });
    assert.equal(res.status, 400);
    assert.equal(await fs.readFile(p(), 'utf8'), before);
  });

  test('saving into another folder does not touch the loaded drawing', async () => {
    const before = await fs.readFile(p(), 'utf8');
    const save = await (await post('/api/save', { root: rid, dir: 'elsewhere', versioned: false })).json();
    assert.deepEqual(save.current, current('elsewhere/elsewhere.excalidraw'));
    assert.equal(await fs.readFile(p(), 'utf8'), before);
  });
});

describe('folders, mkdir and move', () => {
  let other, otherId;
  beforeEach(async () => {
    other = path.join(home, 'repo-b', 'docs', 'drawings');
    await fs.mkdir(path.join(other, 'roadmap'), { recursive: true });
    await fs.writeFile(path.join(other, 'roadmap', 'roadmap_v0.excalidraw'), JSON.stringify({ elements: [rect('other')] }));
    otherId = (await (await post('/api/folders/attach', { path: other })).json()).folder.id;
  });

  test('attach lists the folder (and a recent entry after detach); load and save there use its own files and backups', async () => {
    assert.deepEqual((await get('/api/folders')).map((f) => f.id), [rid, otherId]);
    assert.deepEqual(await get('/api/config'), { canvasUrl: 'http://localhost:3000', canAttach: true, recent: [] });
    const OP = 'roadmap/roadmap_v0.excalidraw';
    const load = await (await post('/api/load', { root: otherId, path: OP })).json();
    assert.deepEqual(load.current, { root: otherId, path: OP });
    canvas.state.elements.set('z', rect('z'));
    const save = await (await post('/api/save', { root: otherId, dir: 'roadmap', versioned: false })).json();
    assert.deepEqual(save.current, { root: otherId, path: OP }, 'overwrites the loaded drawing in its root');
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(other, OP), 'utf8')).elements.map((e) => e.id).sort(), ['other', 'z']);
    assert.equal((await fs.readdir(path.join(backupsDir, otherId, 'roadmap', 'roadmap_v0.excalidraw'))).length, 1);
    assert.deepEqual((await fs.readdir(path.join(dir, 'roadmap'))).sort(), ['roadmap_v0_plan.excalidraw', 'roadmap_v0_plan.png'], 'the first root is untouched');
    canvas.state.elements.set('w', rect('w'));
    const cross = await (await post('/api/save', { root: rid, dir: 'roadmap', versioned: false })).json();
    assert.deepEqual(cross.current, current('roadmap/roadmap.excalidraw'), 'same folder name in another root: its own file');
    const sync = await post('/api/sync', { root: otherId, path: 'roadmap' });
    assert.equal(sync.status, 404);
  });

  test('detach: refused for the loaded drawing\'s root, then removes it, fills recent and the state file; unknown root is 404', async () => {
    await post('/api/load', { root: otherId, path: 'roadmap/roadmap_v0.excalidraw' });
    assert.equal((await post('/api/folders/detach', { id: otherId })).status, 409);
    await post('/api/load', at(BP));
    const done = await (await post('/api/folders/detach', { id: otherId })).json();
    assert.deepEqual(done, { detached: { id: otherId, path: other }, recent: [other] });
    assert.deepEqual((await get('/api/config')).recent, [other]);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(home, 'hub.json'), 'utf8')), { version: 2, folders: [{ path: dir }], recent: [other] });
    assert.ok(await fs.stat(path.join(other, 'roadmap', 'roadmap_v0.excalidraw')), 'files stay on disk');
    assert.equal((await post('/api/load', { root: otherId, path: 'roadmap/roadmap_v0.excalidraw' })).status, 404);
    assert.equal((await post('/api/folders/attach', { path: '/etc' })).status, 403);
  });

  test('a root that went missing is listed with its error; the others still list', async () => {
    await fs.rm(path.join(home, 'repo-b'), { recursive: true });
    const folders = await get('/api/folders');
    assert.equal(folders[0].error, undefined);
    assert.equal(folders[1].id, otherId);
    assert.match(folders[1].error, /cannot read .*ENOENT/);
    assert.equal((await fetch(base + `/api/tree?root=${otherId}`)).status, 404);
  });

  test('mkdir creates a folder inside a root; unsafe names, duplicates and missing parents are refused', async () => {
    assert.deepEqual(await (await post('/api/mkdir', { root: rid, path: 'roadmap/new' })).json(), { root: rid, path: 'roadmap/new' });
    assert.deepEqual((await get(`/api/tree?root=${rid}&path=roadmap`)).dirs, [{ name: 'new', path: 'roadmap/new' }]);
    assert.equal((await post('/api/mkdir', { root: rid, path: 'roadmap/new' })).status, 409);
    assert.equal((await post('/api/mkdir', { root: rid, path: 'roadmap/bad name' })).status, 400);
    assert.equal((await post('/api/mkdir', { root: rid, path: '../up' })).status, 400);
    assert.equal((await post('/api/mkdir', { root: rid, path: 'nope/sub' })).status, 404);
  });

  test('move: into a folder of the same root and across roots, with the png, the backups and the loaded drawing following', async () => {
    await post('/api/load', at(BP));
    canvas.state.elements.set('c', rect('c'));
    await post('/api/save', { root: rid, dir: 'roadmap', versioned: false }); // a backup exists
    const inRoot = await (await post('/api/move', { from: at(BP), to: { root: rid, dir: 'elsewhere' } })).json();
    assert.deepEqual(inRoot, { moved: true, root: rid, path: 'elsewhere/roadmap_v0_plan.excalidraw', current: current('elsewhere/roadmap_v0_plan.excalidraw') });
    assert.deepEqual((await fs.readdir(path.join(dir, 'elsewhere'))).sort(), ['roadmap_v0_plan.excalidraw', 'roadmap_v0_plan.png']);
    assert.deepEqual(await fs.readdir(path.join(dir, 'roadmap')), []);
    assert.equal((await get('/api/status')).dirty, false);

    const across = await (await post('/api/move', { from: current('elsewhere/roadmap_v0_plan.excalidraw'), to: { root: otherId, dir: 'roadmap' } })).json();
    assert.deepEqual(across.current, { root: otherId, path: 'roadmap/roadmap_v0_plan.excalidraw' });
    assert.deepEqual((await fs.readdir(path.join(other, 'roadmap'))).sort(), ['roadmap_v0.excalidraw', 'roadmap_v0_plan.excalidraw', 'roadmap_v0_plan.png']);
    const tree = await get(`/api/tree?root=${otherId}&path=roadmap`);
    assert.equal(tree.drawings.find((d) => d.file === 'roadmap_v0_plan.excalidraw').backups, 1, 'Revert history followed');
    canvas.state.elements.set('d', rect('d'));
    assert.equal((await post('/api/save', { root: otherId, dir: 'roadmap', versioned: false })).status, 200, 'the loaded drawing is still saveable after the move');
    const rev = await post('/api/revert', { root: otherId, path: 'roadmap/roadmap_v0_plan.excalidraw' });
    assert.equal(rev.status, 200);
  });

  test('move refuses a clash (409, also on the png), a missing target or root, and a drop on its own folder does nothing', async () => {
    await fs.writeFile(path.join(dir, 'elsewhere', 'roadmap_v0_plan.png'), 'orphan');
    assert.equal((await post('/api/move', { from: at(BP), to: { root: rid, dir: 'elsewhere' } })).status, 409);
    await fs.rm(path.join(dir, 'elsewhere', 'roadmap_v0_plan.png'));
    await fs.writeFile(path.join(dir, 'elsewhere', 'roadmap_v0_plan.excalidraw'), '{"elements":[]}');
    assert.equal((await post('/api/move', { from: at(BP), to: { root: rid, dir: 'elsewhere' } })).status, 409);
    assert.equal((await post('/api/move', { from: at(BP), to: { root: rid, dir: 'nope' } })).status, 404);
    assert.equal((await post('/api/move', { from: at(BP), to: { root: 'f-nope', dir: '' } })).status, 404);
    assert.equal((await post('/api/move', { from: at(BP), to: { root: rid, dir: '../x' } })).status, 400);
    assert.equal((await post('/api/move', { from: at('../x.excalidraw'), to: { root: rid, dir: 'elsewhere' } })).status, 400);
    assert.equal((await post('/api/move', { from: at(BP) })).status, 400);
    const noop = await (await post('/api/move', { from: at(BP), to: { root: rid, dir: 'roadmap' } })).json();
    assert.equal(noop.moved, false);
    await fs.access(path.join(dir, BP));
    await fs.access(path.join(dir, 'roadmap', 'roadmap_v0_plan.png'));
  });
});

test('a drawing and a folder of the same base name keep separate Revert history; a same-name rename keeps its own', async () => {
  await fs.mkdir(path.join(dir, 'roadmap', 'roadmap_v0_plan'));
  await fs.writeFile(path.join(dir, 'roadmap', 'roadmap_v0_plan', 'inner_v0.excalidraw'), JSON.stringify({ elements: [rect('i')] }));
  const inner = 'roadmap/roadmap_v0_plan/inner_v0.excalidraw';
  await post('/api/load', at(inner));
  canvas.state.elements.set('c', rect('c'));
  await post('/api/save', { root: rid, dir: 'roadmap/roadmap_v0_plan', versioned: false });
  const count = async (d, f) => (await get(`/api/tree?root=${rid}&path=${d}`)).drawings.find((x) => x.file === f).backups;
  assert.equal(await count('roadmap/roadmap_v0_plan', 'inner_v0.excalidraw'), 1);
  await post('/api/load', at(BP));
  canvas.state.elements.set('d', rect('d'));
  await post('/api/save', { root: rid, dir: 'roadmap', versioned: false });
  assert.equal(await count('roadmap', 'roadmap_v0_plan.excalidraw'), 1);
  const same = await post('/api/rename', { ...at(BP), newBase: 'roadmap_v0_plan' });
  assert.equal(same.status, 200);
  assert.equal(await count('roadmap', 'roadmap_v0_plan.excalidraw'), 1, 'same-name rename keeps the history');
  await post('/api/delete', at(BP));
  assert.equal(await count('roadmap/roadmap_v0_plan', 'inner_v0.excalidraw'), 1, 'deleting the drawing leaves the folder\'s history');
});

test('mkdir and move targets inside hidden (dot) folders are refused', async () => {
  await fs.mkdir(path.join(dir, '.hid'));
  assert.equal((await post('/api/mkdir', { root: rid, path: '.hid/x' })).status, 400);
  assert.equal((await post('/api/mkdir', { root: rid, path: '.newhid' })).status, 400);
  assert.equal((await post('/api/move', { from: at(BP), to: { root: rid, dir: '.hid' } })).status, 400);
  await fs.access(path.join(dir, BP));
  assert.deepEqual(await fs.readdir(path.join(dir, '.hid')), []);
});

test('a folder named ..cache is not "outside"; a sibling like ..x does not overlap a root', async () => {
  await fs.mkdir(path.join(dir, '..cache'));
  await fs.writeFile(path.join(dir, '..cache', 'c_v0.excalidraw'), JSON.stringify({ elements: [] }));
  assert.equal((await post('/api/load', at('..cache/c_v0.excalidraw'))).status, 200);
  const r = path.join(home, 'r'); await fs.mkdir(path.join(r, 'sub'), { recursive: true }); await fs.mkdir(path.join(home, 'r', '..x'));
  assert.equal((await post('/api/folders/attach', { path: path.join(r, 'sub') })).status, 200);
  assert.equal((await post('/api/folders/attach', { path: path.join(r, '..x') })).status, 200, 'not an overlap');
});

test('a root-level _retired folder lists fine; moving a drawing into it is refused and nothing moves', async () => {
  await fs.mkdir(path.join(dir, '_retired'));
  await fs.writeFile(path.join(dir, '_retired', 'old_v0.excalidraw'), JSON.stringify({ elements: [] }));
  const tree = await get(`/api/tree?root=${rid}&path=_retired`);
  assert.deepEqual(tree.drawings.map((d) => [d.file, d.backups]), [['old_v0.excalidraw', 0]]);
  const res = await post('/api/move', { from: at(BP), to: { root: rid, dir: '_retired' } });
  assert.equal(res.status, 400);
  await fs.access(path.join(dir, BP));
});

// Background PNG renders (docs/specs/2026-11-19-png-off-the-switch-path.md).
const held = () => { let release; const p = new Promise((r) => { release = r; }); return { p, release }; };
const pngOf = (rel) => fs.readFile(path.join(dir, rel.replace(/\.excalidraw$/, '.png')), 'utf8').catch(() => null);
const showIds = () => { canvas.state.showIds = true; };
const until = async (fn, ms = 3000) => { const t = Date.now(); while (!(await fn())) { if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)); } };

test('png background: the save returns before the render; the PNG shows the saved scene, not the canvas after it', async () => {
  showIds();
  await post('/api/load', at(BP));
  canvas.state.elements.set('c', rect('c', 50));
  const h = held(); canvas.state.holdExport = h.p;
  const save = await (await post('/api/save', { root: rid, dir: 'roadmap', versioned: false, png: 'background' })).json();
  assert.equal(save.png, 'pending');
  assert.equal((await get('/api/status')).png.pending, 1);
  canvas.state.elements.clear(); // the canvas moves on (e.g. the next load) while the render runs
  h.release();
  await until(async () => (await get('/api/status')).png.pending === 0);
  assert.equal(await pngOf(BP), 'PNG of 3 [a,b,c]');
});

test('png background: a dirty switch loads at once; the old drawing still gets its PNG', async () => {
  showIds();
  await post('/api/load', at(BP));
  canvas.state.elements.set('c', rect('c', 50));
  const h = held(); canvas.state.holdExport = h.p;
  await fs.writeFile(path.join(dir, 'agents', 'agents_v0.excalidraw'), JSON.stringify({ elements: [rect('z')] }));
  const load = await post('/api/load', at('agents/agents_v0.excalidraw'));
  assert.equal(load.status, 200, 'the load does not wait for the render');
  assert.deepEqual((await load.json()).autosaved, current(BP));
  assert.deepEqual([...canvas.state.elements.keys()], ['z']);
  h.release();
  await until(async () => (await get('/api/status')).png.pending === 0);
  assert.equal(await pngOf(BP), 'PNG of 3 [a,b,c]');
});

test('png background: only the newest render of a file writes it', async () => {
  showIds();
  await post('/api/load', at(BP));
  canvas.state.elements.set('c', rect('c', 50));
  const first = held(); canvas.state.holdExport = first.p;
  await post('/api/save', { root: rid, dir: 'roadmap', versioned: false, png: 'background' });
  await until(() => canvas.state.exports === 1);
  canvas.state.holdExport = null;
  canvas.state.elements.set('d', rect('d', 80));
  await post('/api/save', { root: rid, dir: 'roadmap', versioned: false, png: 'background' });
  await until(async () => (await pngOf(BP)) === 'PNG of 4 [a,b,c,d]');
  first.release(); // the older render finishes last
  await until(async () => (await get('/api/status')).png.pending === 0);
  assert.equal(await pngOf(BP), 'PNG of 4 [a,b,c,d]');
});

test('png background: delete waits for a pending render, so no PNG comes back', async () => {
  await post('/api/load', at(BP));
  canvas.state.elements.set('c', rect('c', 50));
  const h = held(); canvas.state.holdExport = h.p;
  await post('/api/save', { root: rid, dir: 'roadmap', versioned: false, png: 'background' });
  let deleted = false;
  const del = post('/api/delete', at(BP)).then((r) => { deleted = true; return r; });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(deleted, false, 'delete waits');
  h.release();
  assert.equal((await del).status, 200);
  assert.deepEqual((await fs.readdir(path.join(dir, 'roadmap'))).sort(), []);
});

test('png background: a failed render shows in status until the next render of that file succeeds', async () => {
  await post('/api/load', at(BP));
  canvas.state.elements.set('c', rect('c', 50));
  canvas.state.failExport = true;
  assert.equal((await (await post('/api/save', { root: rid, dir: 'roadmap', versioned: false, png: 'background' })).json()).png, 'pending');
  await until(async () => (await get('/api/status')).png.error !== null);
  const { error } = (await get('/api/status')).png;
  assert.deepEqual({ root: error.root, path: error.path }, current(BP));
  assert.match(error.error, /render failed/);
  canvas.state.failExport = false;
  await post('/api/save', { root: rid, dir: 'roadmap', versioned: false, png: 'background' });
  await until(async () => (await get('/api/status')).png.pending === 0);
  assert.equal((await get('/api/status')).png.error, null);
});

test('png: an unknown png mode is refused', async () => {
  assert.equal((await post('/api/save', { root: rid, dir: 'roadmap', versioned: true, png: 'later' })).status, 400);
});

test('png background: deleting a drawing whose render failed clears the error', async () => {
  await post('/api/load', at(BP));
  canvas.state.elements.set('c', rect('c', 50));
  canvas.state.failExport = true;
  await post('/api/save', { root: rid, dir: 'roadmap', versioned: false, png: 'background' });
  await until(async () => (await get('/api/status')).png.error !== null);
  await post('/api/delete', at(BP));
  assert.equal((await get('/api/status')).png.error, null);
});
