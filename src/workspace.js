// The folders shown in the sidebar: all attached by the user and equal (no primary), remembered in the state file.
// Each root has its own store and backups, and git sync when it lies in a git repo. Spec: docs/specs/2026-11-19-standalone-workspace.md.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createBackups } from './backups.js';
import { createGit, gitRunner, repoTopLevel } from './git.js';
import { createStore } from './store.js';

export class WorkspaceError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const RECENT_MAX = 10;
const idOf = (p) => `f-${crypto.createHash('sha256').update(p).digest('hex').slice(0, 12)}`;
/** Sidebar label: the repo name for `<repo>/docs/drawings`, otherwise the folder's own name. */
const labelOf = (p) => {
  const parts = p.split(path.sep).filter(Boolean);
  if (parts.length > 2 && parts.at(-1) === 'drawings' && parts.at(-2) === 'docs') return parts.at(-3);
  return parts.at(-1) ?? p;
};
const inside = (root, p) => { const rel = path.relative(root, p); return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)); };

/**
 * @param {{backupsDir: string, foldersRoot: string, file?: string, autoSyncBranches?: string[], log?: (s: string) => void, repoTop?: Function}} opts
 * foldersRoot: attached folders must be inside it. file: the state file (absent = nothing is saved).
 * autoSyncBranches: branches where sync commits and pushes without asking. repoTop: repo detection, replaceable in tests.
 */
export async function createWorkspace({ backupsDir, foldersRoot, file = null, autoSyncBranches = ['development', 'dev'], log = console.error, repoTop = repoTopLevel }) {
  const root = await fs.realpath(foldersRoot).catch(() => path.resolve(foldersRoot));
  const roots = []; // in attach order
  let recent = [];
  const gits = new Map(); // repo top -> its one git client (one queue per repo)

  /** Sync is on when the folder is inside a git work tree whose top level the hub can see; else off with git's reason. */
  async function detect(p) {
    const r = await repoTop(p);
    if (!r.ok) return { git: null, repoDir: null, sync: false, syncError: r.reason };
    if (!gits.has(r.top)) gits.set(r.top, createGit({ run: gitRunner(r.top), autoBranches: autoSyncBranches }));
    return { git: gits.get(r.top), repoDir: r.top, sync: true };
  }
  const make = async (p) => ({ id: idOf(p), name: labelOf(p), path: p, store: createStore(p), backups: createBackups(path.join(backupsDir, idOf(p))), ...(await detect(p)) });
  const overlaps = (a, b) => inside(a, b) || inside(b, a);

  /** The real path of `p` if it may be attached, else a WorkspaceError. Used for attach and for every saved entry. */
  async function check(p) {
    if (typeof p !== 'string' || !path.isAbsolute(p.trim())) throw new WorkspaceError(400, `give an absolute path, e.g. /home/me/repo/docs/drawings (got ${JSON.stringify(p)})`);
    let real;
    try { real = await fs.realpath(p.trim()); } catch { throw new WorkspaceError(404, `${p.trim()} does not exist`); }
    const st = await fs.stat(real);
    if (!st.isDirectory()) throw new WorkspaceError(400, `${real} is not a folder`);
    if (!inside(root, real)) throw new WorkspaceError(403, `${real} is outside ${root}; only folders inside it can be attached (FOLDERS_ROOT)`);
    const clash = roots.find((f) => overlaps(f.path, real));
    if (clash) throw new WorkspaceError(409, clash.path === real ? `${real} is already attached` : `${real} overlaps the attached folder ${clash.path}`);
    return real;
  }

  let unreadable = false; // the file exists but could not be read: never write over it
  if (file) {
    let raw = null;
    try { raw = await fs.readFile(file, 'utf8'); } catch (e) {
      if (e.code !== 'ENOENT') { unreadable = true; log(`workspace: cannot read ${file}: ${e.message}; attach and detach are refused until it is fixed`); }
    }
    if (raw !== null) {
      let doc = null;
      try {
        const d = JSON.parse(raw);
        const strings = (a) => Array.isArray(a) && a.every((x) => typeof x === 'string');
        if (d?.version === 2 && Array.isArray(d.folders) && d.folders.every((f) => typeof f?.path === 'string') && (d.recent === undefined || strings(d.recent))) doc = d;
      } catch { /* below */ }
      if (!doc) {
        log(`workspace: ${file} is not a valid version 2 state file; kept as ${file}.bad, starting with no folders`);
        await fs.copyFile(file, `${file}.bad`).catch(() => {});
      } else {
        recent = (doc.recent ?? []).slice(0, RECENT_MAX);
        for (const { path: p } of doc.folders) {
          try { roots.push(await make(await check(p))); } catch (e) {
            // Missing now (unmounted, deleted): keep it listed with its error so it can be detached. Anything else is dropped.
            const normal = path.isAbsolute(p) ? path.normalize(p) : null;
            if (e.status === 404 && normal && inside(root, normal) && !roots.some((f) => overlaps(f.path, normal))) roots.push(await make(normal));
            else log(`workspace: not opening ${JSON.stringify(p)} from ${file}: ${e.message}`);
          }
        }
      }
    }
  }

  async function persist() {
    if (!file) return;
    if (unreadable) throw new Error(`${file} exists but could not be read at start; fix it and restart the hub`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      const h = await fs.open(tmp, 'wx');
      try { await h.writeFile(JSON.stringify({ version: 2, folders: roots.map((f) => ({ path: f.path })), recent }, null, 2) + '\n'); await h.sync(); } finally { await h.close(); }
      await fs.rename(tmp, file);
    } catch (e) { await fs.unlink(tmp).catch(() => {}); throw e; }
  }

  // One attach/detach at a time: both edit the list and the file.
  let lane = Promise.resolve();
  const oneAtATime = (fn) => { const r = lane.then(fn); lane = r.catch(() => {}); return r; };

  return {
    canAttach: true,
    folders: () => [...roots],
    recent: () => [...recent],
    get(id) {
      const f = roots.find((x) => x.id === id);
      if (!f) throw new WorkspaceError(404, `unknown folder: ${JSON.stringify(id)} (detached? reload the page)`);
      return f;
    },

    /** Add a folder by absolute path. Returns it. */
    attach: (p) => oneAtATime(async () => {
      const f = await make(await check(p));
      const before = recent;
      roots.push(f);
      recent = recent.filter((r) => r !== f.path);
      try { await persist(); } catch (e) { roots.pop(); recent = before; throw new WorkspaceError(500, `could not save the state file: ${e.message}`); }
      return f;
    }),

    /** Remove a folder from the workspace and remember its path in `recent`. Files on disk are not touched. */
    detach: (id) => oneAtATime(async () => {
      const i = roots.findIndex((f) => f.id === id);
      if (i < 0) throw new WorkspaceError(404, `unknown folder: ${JSON.stringify(id)}`);
      const before = recent;
      const [f] = roots.splice(i, 1);
      recent = [f.path, ...recent.filter((r) => r !== f.path)].slice(0, RECENT_MAX);
      try { await persist(); } catch (e) { roots.splice(i, 0, f); recent = before; throw new WorkspaceError(500, `could not save the state file: ${e.message}`); }
      return f;
    }),
  };
}
