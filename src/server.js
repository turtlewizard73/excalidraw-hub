// HTTP API and static page. Wires the store, the canvas client and the unsaved-changes baseline.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXT, MAX_STEM, isSafeName, isUsableLabel, nextVersionOf, plainTargetIn, saveName, saveStem } from './names.js';
import { expandAgentElements, isAgentFormat } from './agent.js';
import { Baseline, buildDocument, missingFiles } from './scene.js';
import { GitError } from './git.js';
import { StoreError, moveDrawing } from './store.js';
import { listDir } from './tree.js';
import { WorkspaceError } from './workspace.js';

const TMP_DIR = 'tmp'; // in the root of the drawing being opened: where unsaved work goes when nothing is loaded

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const STATIC = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
const MAX_BODY = 64 * 1024;

class HttpError extends Error { constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; } }

async function readJson(req) {
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'expected application/json');
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > MAX_BODY) throw new HttpError(413, 'request body too large'); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw new HttpError(400, 'invalid JSON'); }
}

const dirname = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const basename = (p) => p.slice(p.lastIndexOf('/') + 1);
const join = (dir, name) => (dir ? `${dir}/${name}` : name);
const fsError = (e) => {
  if (e instanceof StoreError || e instanceof WorkspaceError) return new HttpError(e.status, e.message);
  if (e?.code === 'ENOENT' || e?.code === 'ENOTDIR') return new HttpError(404, 'folder not found');
  if (e?.code === 'EACCES' || e?.code === 'EPERM') return new HttpError(403, `cannot read it: ${e.code}`);
  return e;
};

/**
 * @param {{workspace, canvas, canvasPublicUrl: string, allowedHosts?: string[]}} deps
 * workspace: the sidebar's roots (src/workspace.js), each with its own store, backups and git. A drawing is named by
 * {root, path}: the root's id and the file's path relative to it. allowedHosts: Host header values accepted
 * (DNS-rebinding guard), e.g. ['127.0.0.1:3080', 'localhost:3080'].
 */
export function createServer({ workspace, canvas, canvasPublicUrl, allowedHosts }) {
  /** The root a request names. */
  const folderOf = (id) => {
    if (typeof id !== 'string') throw new HttpError(400, 'root must be a string');
    try { return workspace.get(id); } catch (e) { throw fsError(e); }
  };
  const str = (v, what) => { if (typeof v !== 'string') throw new HttpError(400, `${what} must be a string`); return v; };
  const baseline = new Baseline();
  // One state-changing request at a time: load/save/revert/rename/move/delete/mkdir/sync's local steps share the baseline, canvas and files.
  let queue = Promise.resolve();
  const serialRun = (fn) => { const run = queue.then(fn); queue = run.catch(() => {}); return run; };
  const serial = (fn) => (body) => serialRun(() => fn(body));
  let frameSrc = "'none'";
  try { frameSrc = new URL(canvasPublicUrl).origin; } catch { /* no canvas URL: nothing may be framed */ }
  const pageHeaders = {
    'x-frame-options': 'DENY',
    'content-security-policy': `default-src 'self'; frame-src ${frameSrc}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
  };
  const same = (a, b) => a && b && a.root === b.root && a.path === b.path;
  const liveCount = (elements) => elements.filter((e) => !e.isDeleted).length;
  // Identifies a canvas state: every element's id and last server-side change.
  const fingerprint = (elements) => elements.map((e) => `${e.id}@${e.updatedAt ?? ''}@${e.version ?? ''}`).sort().join('|');
  const renderPng = async (store, rel, result) => {
    // The PNG is a convenience: the drawing is already saved if rendering fails.
    try { await store.writePng(rel, await canvas.exportPng()); result.png = true; } catch (e) { result.png = false; result.pngError = e.message; }
    return result;
  };

  /** Put `doc` (the drawing `current`, stamped `stamp`) on the canvas and make it the baseline. */
  async function loadOntoCanvas(current, doc, stamp) {
    // If the load fails, the canvas may hold anything: forget the old drawing so no save can overwrite it.
    baseline.forget();
    await canvas.load(doc);
    baseline.set(current, doc.elements, doc.appState);
    baseline.stamp = stamp;
  }

  /** Save the canvas into folder `dir` of root `root`. Shared by POST /api/save and by a load that saves unsaved work first. */
  async function saveCanvas({ root, dir = '', label, versioned }) {
    const folder = folderOf(root);
    const { store, backups } = folder;
    str(dir, 'dir');
    if (label !== undefined && typeof label !== 'string') throw new HttpError(400, 'label must be a string');
    // Required: a page loaded before this flag existed must not overwrite by default.
    if (typeof versioned !== 'boolean') throw new HttpError(400, 'this page is out of date; reload it and save again');
    let names;
    try { await store.entries(dir); names = await store.files(dir); } catch (e) { throw fsError(e); }
    // The stem: the loaded drawing's if it is in this folder, else the folder's own name.
    const cur = baseline.current;
    const loadedFile = cur && cur.root === root && dirname(cur.path) === dir ? basename(cur.path) : null;
    const stem = saveStem(loadedFile, dir ? basename(dir) : basename(folder.path));
    if (!isSafeName(stem) || stem.length > MAX_STEM) throw new HttpError(400, `cannot build a file name from ${JSON.stringify(stem)}: pick a label-free name: rename the folder or the drawing`);
    const [read, files] = await Promise.all([canvas.elements(), canvas.files()]);
    // Agent-format elements are expanded in memory; the file gets the expanded scene.
    const expanded = expandAgentElements(read);
    const elements = expanded.elements;
    const doc = buildDocument(elements, files, baseline.appState);
    const saved = async (rel) => {
      // After the file is safe, put the expanded scene on the canvas too, so it matches the file. Only if the
      // canvas is unchanged since it was read: a replace would wipe anything added in between.
      let canvasNow = elements;
      let writtenBack = false;
      if (expanded.changed) {
        const now = await canvas.elements();
        if (fingerprint(now) === fingerprint(read)) {
          await canvas.load({ elements });
          canvasNow = await canvas.elements();
          writtenBack = true;
        } else {
          canvasNow = now; // the canvas moved on: it stays as it is and status shows it as unsaved
        }
      }
      baseline.set({ root, path: rel }, doc.elements, doc.appState, canvasNow);
      baseline.stamp = await store.stamp(rel);
      return renderPng(store, rel, { current: baseline.current, elementCount: doc.elements.length, expanded: expanded.changed, writtenBack });
    };
    // A new file must not inherit Revert backups of a deleted drawing that had the same name.
    const created = async (rel) => { await backups.retire(rel).catch(() => {}); return saved(rel); };
    if (!versioned) {
      if (!isUsableLabel(label)) throw new HttpError(400, 'the label needs a letter or digit (a-z, 0-9) to use in the file name');
      const { file, overwrite } = plainTargetIn(stem, label, loadedFile);
      const rel = join(dir, file);
      if (overwrite) {
        // Overwriting is the one way a save can lose data: refuse whenever the canvas or the file looks wrong.
        const refuse = (why) => new HttpError(409, `${file} not overwritten: ${why}. Use "Save new version" to save a copy.`);
        if (!doc.elements.length && baseline.elements?.some((e) => !e.isDeleted)) throw refuse('the canvas is empty (did it restart?)');
        const missing = missingFiles(elements, files);
        if (missing.length) throw refuse(`the canvas lost ${missing.length} image(s)`);
        const stamp = await store.stamp(rel);
        if (stamp !== null && stamp !== baseline.stamp) throw refuse('the file changed on disk since it was loaded');
        // The old file goes to the backups first, for Revert. No backup, no overwrite.
        const old = await store.readBytes(rel);
        if (old) {
          try { await backups.save(rel, old); } catch (e) { throw new HttpError(500, `${file} not overwritten: could not back up the old file (${e.message})`); }
        }
        await store.overwrite(rel, doc);
        return saved(rel);
      }
      try {
        await store.create(rel, doc);
      } catch (e) {
        if (e instanceof StoreError && e.status === 409) throw new HttpError(409, `${file} already exists; change the label or use "Save new version"`);
        throw fsError(e);
      }
      return created(rel);
    }
    for (let attempt = 0; ; attempt++) {
      const version = nextVersionOf(stem, attempt === 0 ? names : await store.files(dir));
      if (version > 999999999) throw new HttpError(400, `${stem} has reached the highest version number (v999999999)`);
      const rel = join(dir, saveName(stem, version, label));
      try {
        await store.create(rel, doc);
      } catch (e) {
        if (!(e instanceof StoreError && e.status === 409) || attempt >= 2) throw fsError(e);
        continue;
      }
      return created(rel);
    }
  }

  const routes = {
    'GET /api/config': async () => ({ canvasUrl: canvasPublicUrl, canAttach: workspace.canAttach, recent: workspace.recent() }),

    // One entry per root. A root that cannot be read (gone, unmounted) is listed with its error, so it can be detached.
    'GET /api/folders': async () => {
      const out = [];
      for (const f of workspace.folders()) {
        const entry = { id: f.id, name: f.name, path: f.path, sync: f.sync };
        if (!f.sync && f.syncError) entry.syncError = f.syncError;
        try { if (!(await fs.stat(f.path)).isDirectory()) throw Object.assign(new Error('not a folder'), { code: 'ENOTDIR' }); } catch (e) { entry.error = `cannot read ${f.path}: ${e.code ?? e.message}`; }
        out.push(entry);
      }
      return out;
    },

    // One folder's subfolders and drawings, listed when it is opened.
    'GET /api/tree': async ({ root, path: rel = '' }) => {
      const folder = folderOf(root);
      try { return await listDir(folder, str(rel, 'path')); } catch (e) { throw fsError(e); }
    },

    'POST /api/folders/attach': serial(async ({ path: p }) => {
      try { const f = await workspace.attach(p); return { folder: { id: f.id, name: f.name, path: f.path, sync: f.sync, ...(f.syncError ? { syncError: f.syncError } : {}) } }; } catch (e) { throw fsError(e); }
    }),

    // In the queue: a load or save into this root must not run while it is being detached.
    'POST /api/folders/detach': serial(async ({ id }) => {
      if (baseline.current?.root === id) throw new HttpError(409, 'the loaded drawing is in this folder; load a drawing from another folder first');
      try { const f = await workspace.detach(id); return { detached: { id: f.id, path: f.path }, recent: workspace.recent() }; } catch (e) { throw fsError(e); }
    }),

    'POST /api/mkdir': serial(async ({ root, path: rel }) => {
      const { store } = folderOf(root);
      try { await store.mkdir(str(rel, 'path')); } catch (e) { throw fsError(e); }
      return { root, path: rel };
    }),

    'GET /api/status': async () => {
      try {
        const elements = await canvas.elements();
        return {
          current: baseline.current, dirty: baseline.isDirty(elements), canvas: 'ok',
          elementCount: liveCount(elements), agentElements: elements.filter(isAgentFormat).length,
        };
      } catch (e) {
        return { current: baseline.current, dirty: null, canvas: 'unreachable', error: e.message };
      }
    },

    // Unsaved changes are saved first, no question: into the loaded drawing, or as tmp/tmp_v<n> when none is loaded.
    'POST /api/load': serial(async ({ root, path: rel }) => {
      const { store } = folderOf(root);
      try { await store.read(str(rel, 'path')); } catch (e) { throw fsError(e); } // the target must exist before anything is saved for it
      const elements = await canvas.elements();
      let autosaved = null;
      if (baseline.isDirty(elements) && liveCount(elements) > 0) {
        try {
          let target;
          if (baseline.current) target = { root: baseline.current.root, dir: dirname(baseline.current.path), versioned: false };
          else {
            await store.mkdir(TMP_DIR).catch((e) => { if (e.status !== 409) throw e; });
            target = { root, dir: TMP_DIR, versioned: true };
          }
          autosaved = (await saveCanvas(target)).current;
        } catch (e) {
          const err = fsError(e);
          if (!(err instanceof HttpError)) throw err;
          throw new HttpError(err.status, `Your unsaved changes could not be saved, so ${basename(rel)} was not loaded. ${err.message}`, { saveFailed: true });
        }
      }
      // Stamp and read only now: the save above may have just written this very file.
      const stamp = await store.stamp(rel); // before reading: a change in between then counts as a change
      const doc = await store.read(rel);
      await loadOntoCanvas({ root, path: rel }, doc, stamp);
      return { current: baseline.current, elementCount: liveCount(doc.elements), autosaved };
    }),

    'POST /api/save': serial(saveCanvas),

    // Restore the newest backup over the file and load it. The replaced file is kept in _reverted, never lost.
    'POST /api/revert': serial(async ({ root, path: rel }) => {
      const { store, backups } = folderOf(root);
      if (!same(baseline.current, { root, path: str(rel, 'path') })) throw new HttpError(409, 'only the loaded drawing can be reverted; load it first');
      await store.read(rel).catch((e) => { throw fsError(e); });
      // Unsaved canvas work is saved over the file first, so it is kept: the revert below moves it to _reverted and
      // restores the newest backup, which that save just made of the last saved state. Net: the edits are dropped
      // from the drawing but not lost.
      const elements = await canvas.elements();
      if (baseline.isDirty(elements) && liveCount(elements) > 0) {
        try { await saveCanvas({ root, dir: dirname(rel), versioned: false }); } catch (e) {
          if (!(e instanceof HttpError)) throw e;
          throw new HttpError(e.status, `Your unsaved changes could not be saved, so nothing was reverted. ${e.message}`);
        }
      }
      const backup = await backups.newest(rel);
      if (!backup) throw new HttpError(404, `${basename(rel)} has no earlier version to revert to`);
      let doc;
      try { doc = JSON.parse(backup.bytes.toString('utf8')); } catch { throw new HttpError(422, `the backup ${backup.name} is not valid JSON`); }
      const current = await store.readBytes(rel);
      if (current) await backups.keepReverted(rel, current);
      await store.overwrite(rel, backup.bytes);
      await backups.remove(rel, backup.name);
      await loadOntoCanvas({ root, path: rel }, doc, await store.stamp(rel));
      return renderPng(store, rel, { current: baseline.current, restored: backup.name, remaining: await backups.count(rel) });
    }),

    'POST /api/rename': serial(async ({ root, path: rel, newBase }) => {
      const { store, backups } = folderOf(root);
      if (typeof newBase !== 'string' || !isSafeName(newBase)) throw new HttpError(400, `invalid new name: ${JSON.stringify(newBase)}`);
      const newRel = join(dirname(str(rel, 'path')), newBase + EXT);
      try { await store.rename(rel, newRel); } catch (e) { throw fsError(e); }
      if (same(baseline.current, { root, path: rel })) baseline.current = { root, path: newRel };
      await backups.move(rel, newRel).catch((e) => console.error('moving backups failed:', e.message));
      return { root, path: newRel, current: baseline.current };
    }),

    // Drag and drop: the file keeps its name; its png and its backups go with it, also into another root.
    'POST /api/move': serial(async ({ from, to }) => {
      if (!from || typeof from !== 'object' || !to || typeof to !== 'object') throw new HttpError(400, 'expected {from: {root, path}, to: {root, dir}}');
      const src = folderOf(from.root);
      const dest = folderOf(to.root);
      const rel = str(from.path, 'from.path');
      const newRel = join(str(to.dir ?? '', 'to.dir'), basename(rel));
      if (src === dest && newRel === rel) return { moved: false, root: to.root, path: rel, current: baseline.current };
      try { await moveDrawing(src.store, rel, dest.store, newRel); } catch (e) { throw fsError(e); }
      await src.backups.move(rel, newRel, dest.backups).catch((e) => console.error('moving backups failed:', e.message));
      if (same(baseline.current, { root: from.root, path: rel })) {
        baseline.current = { root: to.root, path: newRel };
        baseline.stamp = await dest.store.stamp(newRel); // a move across drives is a copy: its time differs
      }
      return { moved: true, root: to.root, path: newRel, current: baseline.current };
    }),

    // Deleting the loaded drawing forgets the baseline: the canvas content now exists nowhere on disk, so it is unsaved.
    'POST /api/delete': serial(async ({ root, path: rel }) => {
      const { store, backups } = folderOf(root);
      try { await store.remove(str(rel, 'path')); } catch (e) { throw fsError(e); }
      if (same(baseline.current, { root, path: rel })) baseline.forget(); // keeps appState for the next save
      await backups.retire(rel).catch((e) => console.error('retiring backups failed:', e.message));
      return { deleted: { root, path: rel }, current: baseline.current };
    }),

    // Local steps (fast-forward, commit) run in the queue; fetch and push (network) must not stall loads and saves.
    'POST /api/sync': async ({ root, path: rel = '', confirm }) => {
      const folder = folderOf(root);
      if (!folder.git) throw new HttpError(404, `git sync is off for this folder: ${folder.syncError ?? 'not in a git repository'}`);
      try { await folder.store.resolve(str(rel, 'path')); } catch (e) { throw fsError(e); }
      const dir = path.relative(folder.repoDir, path.join(folder.path, ...(rel ? rel.split('/') : []))).split(path.sep).join('/');
      if (dir === '..' || dir.startsWith('../')) throw new HttpError(400, 'the folder is outside its repository');
      const answered = Array.isArray(confirm) ? confirm.filter((c) => c === 'branch') : [];
      try { return await folder.git.sync(dir, { confirm: answered, serial: serialRun }); } catch (e) {
        if (e instanceof GitError) throw new HttpError(500, e.message);
        throw e;
      }
    },
  };

  async function handle(req, res) {
    const url = new URL(req.url, 'http://hub');
    if (allowedHosts && !allowedHosts.includes(req.headers.host)) throw new HttpError(403, 'unexpected Host header');
    if (req.method === 'GET' && STATIC[url.pathname]) {
      const [name, type] = STATIC[url.pathname];
      const content = await fs.readFile(path.join(PUBLIC, name));
      res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-cache', ...pageHeaders });
      return res.end(content);
    }
    const route = routes[`${req.method} ${url.pathname}`];
    if (!route) throw new HttpError(404, 'not found');
    let body = req.method === 'GET' ? Object.fromEntries(url.searchParams) : {};
    if (req.method !== 'GET') {
      const origin = req.headers.origin;
      if (origin && origin !== `http://${req.headers.host}`) throw new HttpError(403, 'cross-origin request refused');
      body = await readJson(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'expected a JSON object');
    }
    return route(body);
  }

  return http.createServer((req, res) => {
    handle(req, res).then((data) => {
      if (res.headersSent) return;
      res.writeHead(200, { 'content-type': 'application/json', 'x-frame-options': 'DENY' });
      res.end(JSON.stringify(data));
    }, (e) => {
      const status = e.status ?? 500;
      if (status === 500) console.error(e);
      if (res.headersSent) return res.end();
      res.writeHead(status, { 'content-type': 'application/json' });
      const hidden = status === 500 && !(e instanceof HttpError);
      res.end(JSON.stringify({ error: hidden ? 'internal error' : e.message, ...(e.extra ?? {}) }));
    });
  });
}
