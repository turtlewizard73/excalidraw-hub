// HTTP API and static page. Wires the store, the canvas client and the unsaved-changes baseline.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXT, MAX_NAME, isSafeName, nextVersion, saveName } from './names.js';
import { Baseline, buildDocument, hasShorthand } from './scene.js';
import { StoreError } from './store.js';

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
 * @param {{store, canvas, canvasPublicUrl: string, allowedHosts: string[]}} deps
 * allowedHosts: Host header values accepted (DNS-rebinding guard), e.g. ['127.0.0.1:3080', 'localhost:3080'].
 */
export function createServer({ store, canvas, canvasPublicUrl, allowedHosts }) {
  const baseline = new Baseline();
  // One state-changing request at a time: load/save/rename/delete share the baseline and the canvas.
  let queue = Promise.resolve();
  const serial = (fn) => (body) => { const run = queue.then(() => fn(body)); queue = run.catch(() => {}); return run; };
  let frameSrc = "'none'";
  try { frameSrc = new URL(canvasPublicUrl).origin; } catch { /* no canvas URL: nothing may be framed */ }
  const pageHeaders = {
    'x-frame-options': 'DENY',
    'content-security-policy': `default-src 'self'; frame-src ${frameSrc}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
  };
  const same = (a, b) => a && b && a.project === b.project && a.file === b.file;

  const routes = {
    'GET /api/config': async () => ({ canvasUrl: canvasPublicUrl }),
    'GET /api/projects': async () => ({ projects: await store.listProjects() }),

    'GET /api/status': async () => {
      try {
        const elements = await canvas.elements();
        return { current: baseline.current, dirty: baseline.isDirty(elements), canvas: 'ok', elementCount: elements.filter((e) => !e.isDeleted).length };
      } catch (e) {
        return { current: baseline.current, dirty: null, canvas: 'unreachable', error: e.message };
      }
    },

    'POST /api/load': serial(async ({ project, file, force }) => {
      const doc = await store.read(project, file);
      if (!force && baseline.isDirty(await canvas.elements())) throw new HttpError(409, 'the canvas has unsaved changes', { dirty: true });
      await canvas.load(doc);
      baseline.set({ project, file }, doc.elements, doc.appState);
      return { current: baseline.current, elementCount: doc.elements.filter((e) => !e.isDeleted).length };
    }),

    'POST /api/save': serial(async ({ project, label }) => {
      if (!isSafeName(project)) throw new HttpError(400, `invalid project name: ${JSON.stringify(project)}`);
      // Leave room for `_v<up to 9 digits>` within the name limit.
      if (project.length > MAX_NAME - 11) throw new HttpError(400, `project name too long to save into (max ${MAX_NAME - 11} characters)`);
      if (label !== undefined && typeof label !== 'string') throw new HttpError(400, 'label must be a string');
      const [elements, files] = await Promise.all([canvas.elements(), canvas.files()]);
      if (hasShorthand(elements)) throw new HttpError(409, 'the canvas has not synced from a browser tab yet; wait a second and retry');
      const doc = buildDocument(elements, files, baseline.appState);
      for (let attempt = 0; ; attempt++) {
        const file = saveName(project, nextVersion(project, await store.files(project)), label);
        try {
          await store.create(project, file, doc);
          baseline.set({ project, file }, doc.elements, doc.appState, elements);
          return { current: baseline.current, elementCount: doc.elements.length };
        } catch (e) {
          if (!(e instanceof StoreError && e.status === 409) || attempt >= 2) throw e;
        }
      }
    }),

    'POST /api/rename': serial(async ({ project, file, newBase }) => {
      if (typeof newBase !== 'string' || !isSafeName(newBase)) throw new HttpError(400, `invalid new name: ${JSON.stringify(newBase)}`);
      const newFile = newBase + EXT;
      await store.rename(project, file, newFile);
      if (same(baseline.current, { project, file })) baseline.current = { project, file: newFile };
      return { project, file: newFile, current: baseline.current };
    }),

    // Deleting the loaded drawing forgets the baseline: the canvas content now exists nowhere on disk, so it is unsaved.
    'POST /api/delete': serial(async ({ project, file }) => {
      await store.remove(project, file);
      if (same(baseline.current, { project, file })) baseline.reset();
      return { deleted: { project, file }, current: baseline.current };
    }),
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
      res.end(JSON.stringify({ error: status === 500 ? 'internal error' : e.message, ...(e.extra ?? {}) }));
    });
  });
}
