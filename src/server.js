// HTTP API and static page. Wires the store, the canvas client and the unsaved-changes baseline.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXT, MAX_NAME, isSafeName, isUsableLabel, nextVersion, plainSaveTarget, saveName } from './names.js';
import { expandAgentElements, isAgentFormat } from './agent.js';
import { Baseline, buildDocument, missingFiles } from './scene.js';
import { GitError } from './git.js';
import { StoreError } from './store.js';

const TMP_PROJECT = 'tmp'; // where unsaved work goes when nothing is loaded and another drawing is opened

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

/**
 * @param {{store, canvas, backups, git?, canvasPublicUrl: string, allowedHosts: string[]}} deps
 * allowedHosts: Host header values accepted (DNS-rebinding guard), e.g. ['127.0.0.1:3080', 'localhost:3080'].
 * backups: copies of overwritten drawings, for Revert (src/backups.js). git: per-project sync (src/git.js); absent = off.
 */
export function createServer({ store, canvas, backups, git = null, canvasPublicUrl, allowedHosts }) {
  const baseline = new Baseline();
  // One state-changing request at a time: load/save/revert/rename/delete/commit share the baseline, canvas and files.
  let queue = Promise.resolve();
  const serial = (fn) => (body) => { const run = queue.then(() => fn(body)); queue = run.catch(() => {}); return run; };
  let frameSrc = "'none'";
  try { frameSrc = new URL(canvasPublicUrl).origin; } catch { /* no canvas URL: nothing may be framed */ }
  const pageHeaders = {
    'x-frame-options': 'DENY',
    'content-security-policy': `default-src 'self'; frame-src ${frameSrc}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
  };
  const same = (a, b) => a && b && a.project === b.project && a.file === b.file;
  const liveCount = (elements) => elements.filter((e) => !e.isDeleted).length;
  // Identifies a canvas state: every element's id and last server-side change.
  const fingerprint = (elements) => elements.map((e) => `${e.id}@${e.updatedAt ?? ''}@${e.version ?? ''}`).sort().join('|');
  const renderPng = async (project, file, result) => {
    // The PNG is a convenience: the drawing is already saved if rendering fails.
    try { await store.writePng(project, file, await canvas.exportPng()); result.png = true; } catch (e) { result.png = false; result.pngError = e.message; }
    return result;
  };

  /** Put `doc` (from project/file, stamped `stamp`) on the canvas and make it the baseline. */
  async function loadOntoCanvas(project, file, doc, stamp) {
    // If the load fails, the canvas may hold anything: forget the old drawing so no save can overwrite it.
    baseline.forget();
    await canvas.load(doc);
    baseline.set({ project, file }, doc.elements, doc.appState);
    baseline.stamp = stamp;
  }

  /** Save the canvas. Shared by POST /api/save and by a load that saves unsaved work first. */
  async function saveCanvas({ project, label, versioned }) {
    if (!isSafeName(project)) throw new HttpError(400, `invalid project name: ${JSON.stringify(project)}`);
    // Leave room for `_v<up to 9 digits>` within the name limit.
    if (project.length > MAX_NAME - 11) throw new HttpError(400, `project name too long to save into (max ${MAX_NAME - 11} characters)`);
    if (label !== undefined && typeof label !== 'string') throw new HttpError(400, 'label must be a string');
    // Required: a page loaded before this flag existed must not overwrite by default.
    if (typeof versioned !== 'boolean') throw new HttpError(400, 'this page is out of date; reload it and save again');
    const [read, files] = await Promise.all([canvas.elements(), canvas.files()]);
    // Agent-format elements are expanded in memory; the file gets the expanded scene.
    const expanded = expandAgentElements(read);
    const elements = expanded.elements;
    const doc = buildDocument(elements, files, baseline.appState);
    const saved = async (file) => {
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
      baseline.set({ project, file }, doc.elements, doc.appState, canvasNow);
      baseline.stamp = await store.stamp(project, file);
      return renderPng(project, file, { current: baseline.current, elementCount: doc.elements.length, expanded: expanded.changed, writtenBack });
    };
    // A new file must not inherit Revert backups of a deleted drawing that had the same name.
    const created = async (file) => { await backups.retire(project, file).catch(() => {}); return saved(file); };
    if (!versioned) {
      if (!isUsableLabel(label)) throw new HttpError(400, 'the label needs a letter or digit (a-z, 0-9) to use in the file name');
      const { file, overwrite } = plainSaveTarget(project, label, baseline.current);
      if (overwrite) {
        // Overwriting is the one way a save can lose data: refuse whenever the canvas or the file looks wrong.
        const refuse = (why) => new HttpError(409, `${file} not overwritten: ${why}. Use "Save new version" to save a copy.`);
        if (!doc.elements.length && baseline.elements?.some((e) => !e.isDeleted)) throw refuse('the canvas is empty (did it restart?)');
        const missing = missingFiles(elements, files);
        if (missing.length) throw refuse(`the canvas lost ${missing.length} image(s)`);
        const stamp = await store.stamp(project, file);
        if (stamp !== null && stamp !== baseline.stamp) throw refuse('the file changed on disk since it was loaded');
        // The old file goes to the backups first, for Revert. No backup, no overwrite.
        const old = await store.readBytes(project, file);
        if (old) {
          try { await backups.save(project, file, old); } catch (e) { throw new HttpError(500, `${file} not overwritten: could not back up the old file (${e.message})`); }
        }
        await store.overwrite(project, file, doc);
        return saved(file);
      }
      try {
        await store.create(project, file, doc);
      } catch (e) {
        if (e instanceof StoreError && e.status === 409) throw new HttpError(409, `${file} already exists; change the label or use "Save new version"`);
        throw e;
      }
      return created(file);
    }
    for (let attempt = 0; ; attempt++) {
      const version = nextVersion(project, await store.files(project));
      if (version > 999999999) throw new HttpError(400, `${project} has reached the highest version number (v999999999)`);
      const file = saveName(project, version, label);
      try {
        await store.create(project, file, doc);
      } catch (e) {
        if (!(e instanceof StoreError && e.status === 409) || attempt >= 2) throw e;
        continue;
      }
      return created(file);
    }
  }

  const routes = {
    'GET /api/config': async () => ({ canvasUrl: canvasPublicUrl, sync: !!git, syncBranch: git?.syncBranch ?? null }),
    'GET /api/projects': async () => {
      const projects = await store.listProjects();
      for (const p of projects) for (const d of p.drawings) d.backups = await backups.count(p.name, d.file);
      return { projects };
    },

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
    'POST /api/load': serial(async ({ project, file }) => {
      await store.read(project, file); // the target must exist before anything is saved for it
      const elements = await canvas.elements();
      let autosaved = null;
      if (baseline.isDirty(elements) && liveCount(elements) > 0) {
        const target = baseline.current ? { project: baseline.current.project, versioned: false } : { project: TMP_PROJECT, versioned: true };
        try { autosaved = (await saveCanvas(target)).current; } catch (e) {
          if (!(e instanceof HttpError)) throw e;
          throw new HttpError(e.status, `Your unsaved changes could not be saved, so ${file} was not loaded. ${e.message}`, { saveFailed: true });
        }
      }
      // Stamp and read only now: the save above may have just written this very file.
      const stamp = await store.stamp(project, file); // before reading: a change in between then counts as a change
      const doc = await store.read(project, file);
      await loadOntoCanvas(project, file, doc, stamp);
      return { current: baseline.current, elementCount: liveCount(doc.elements), autosaved };
    }),

    'POST /api/save': serial(saveCanvas),

    // Restore the newest backup over the file and load it. The replaced file is kept in _reverted, never lost.
    'POST /api/revert': serial(async ({ project, file }) => {
      if (!same(baseline.current, { project, file })) throw new HttpError(409, 'only the loaded drawing can be reverted; load it first');
      await store.read(project, file);
      // Unsaved canvas work is saved over the file first, so it is kept: the revert below moves it to _reverted and
      // restores the newest backup, which that save just made of the last saved state. Net: the edits are dropped
      // from the drawing but not lost.
      const elements = await canvas.elements();
      if (baseline.isDirty(elements) && liveCount(elements) > 0) {
        try { await saveCanvas({ project, versioned: false }); } catch (e) {
          if (!(e instanceof HttpError)) throw e;
          throw new HttpError(e.status, `Your unsaved changes could not be saved, so nothing was reverted. ${e.message}`);
        }
      }
      const backup = await backups.newest(project, file);
      if (!backup) throw new HttpError(404, `${file} has no earlier version to revert to`);
      let doc;
      try { doc = JSON.parse(backup.bytes.toString('utf8')); } catch { throw new HttpError(422, `the backup ${backup.name} is not valid JSON`); }
      const current = await store.readBytes(project, file);
      if (current) await backups.keepReverted(project, file, current);
      await store.overwrite(project, file, backup.bytes);
      await backups.remove(project, file, backup.name);
      await loadOntoCanvas(project, file, doc, await store.stamp(project, file));
      return renderPng(project, file, { current: baseline.current, restored: backup.name, remaining: await backups.count(project, file) });
    }),

    'POST /api/rename': serial(async ({ project, file, newBase }) => {
      if (typeof newBase !== 'string' || !isSafeName(newBase)) throw new HttpError(400, `invalid new name: ${JSON.stringify(newBase)}`);
      const newFile = newBase + EXT;
      await store.rename(project, file, newFile);
      if (same(baseline.current, { project, file })) baseline.current = { project, file: newFile };
      await backups.move(project, file, newFile).catch((e) => console.error('moving backups failed:', e.message));
      return { project, file: newFile, current: baseline.current };
    }),

    // Deleting the loaded drawing forgets the baseline: the canvas content now exists nowhere on disk, so it is unsaved.
    'POST /api/delete': serial(async ({ project, file }) => {
      await store.remove(project, file);
      if (same(baseline.current, { project, file })) baseline.forget(); // keeps appState for the next save
      await backups.retire(project, file).catch((e) => console.error('retiring backups failed:', e.message));
      return { deleted: { project, file }, current: baseline.current };
    }),

    // Commit in the queue (it reads the drawings), push outside it (network: must not stall loads and saves).
    'POST /api/sync': async ({ project, confirm }) => {
      if (!git) throw new HttpError(404, 'git sync is not configured (no REPO_DIR)');
      const answered = Array.isArray(confirm) ? confirm.filter((c) => c === 'branch') : [];
      let result;
      try { result = await serial(() => git.commit(project, answered))(); } catch (e) {
        if (e instanceof GitError) throw new HttpError(500, e.message);
        throw e;
      }
      if (!result.committed || !result.push) return { ...result, pushed: false };
      return { ...result, ...(await git.push(result)) };
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
    let body = {};
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
