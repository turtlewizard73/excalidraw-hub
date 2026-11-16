// The folders shown in the sidebar: the primary drawings folder (from the environment, with git sync) plus folders
// the user attached, saved in a config file. Each folder has its own store and backups. Spec: docs/specs/2026-11-16-workspace-folders.md.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createBackups } from './backups.js';
import { createStore } from './store.js';

export const PRIMARY = 'main';

export class WorkspaceError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const idOf = (p) => `f-${crypto.createHash('sha256').update(p).digest('hex').slice(0, 12)}`;
/** Sidebar label: the repo name for `<repo>/docs/drawings`, otherwise the folder's own name. */
const labelOf = (p) => {
  const parts = p.split(path.sep).filter(Boolean);
  if (parts.length > 2 && parts.at(-1) === 'drawings' && parts.at(-2) === 'docs') return parts.at(-3);
  return parts.at(-1) ?? p;
};
const inside = (root, p) => { const rel = path.relative(root, p); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };

/** A workspace of one folder, for callers that pass store/backups/git directly. */
export function fixedWorkspace({ store, backups, git = null }) {
  const folder = { id: PRIMARY, name: 'drawings', path: store.root, primary: true, store, backups, git };
  return {
    canAttach: false,
    folders: () => [folder],
    get(id = PRIMARY) { if (id !== PRIMARY) throw new WorkspaceError(404, `unknown folder: ${JSON.stringify(id)}`); return folder; },
    attach: async () => { throw new WorkspaceError(403, 'attaching folders is off (FOLDERS_ROOT not set)'); },
    detach: async () => { throw new WorkspaceError(400, 'the primary folder cannot be detached'); },
  };
}

/**
 * @param {{primary: {path: string, git?: object}, backupsDir: string, file?: string, foldersRoot?: string, log?: (s: string) => void}} opts
 * file: the config file (absent = nothing is saved). foldersRoot: attached folders must be inside it (absent = attaching off).
 */
export async function createWorkspace({ primary, backupsDir, file = null, foldersRoot = null, log = console.error }) {
  const main = { id: PRIMARY, name: labelOf(path.resolve(primary.path)), path: path.resolve(primary.path), primary: true,
    store: createStore(primary.path), backups: createBackups(backupsDir), git: primary.git ?? null };
  const root = foldersRoot ? await fs.realpath(foldersRoot).catch(() => path.resolve(foldersRoot)) : null;
  const attached = []; // in attach order
  const make = (p) => ({ id: idOf(p), name: labelOf(p), path: p, primary: false, store: createStore(p),
    backups: createBackups(path.join(backupsDir, '_folders', idOf(p))), git: null });

  const mainStat = await fs.stat(main.path).catch(() => null);
  const mainReal = await fs.realpath(main.path).catch(() => main.path);
  const overlaps = (a, b) => inside(a, b) || inside(b, a);

  /** The real path of `p` if it may be attached, else a WorkspaceError. Used for attach and for every saved entry. */
  async function check(p) {
    if (!root) throw new WorkspaceError(403, 'attaching folders is off (FOLDERS_ROOT not set)');
    if (typeof p !== 'string' || !path.isAbsolute(p.trim())) throw new WorkspaceError(400, `give an absolute path, e.g. /home/me/repo/docs/drawings (got ${JSON.stringify(p)})`);
    let real;
    try { real = await fs.realpath(p.trim()); } catch { throw new WorkspaceError(404, `${p.trim()} does not exist`); }
    const st = await fs.stat(real);
    if (!st.isDirectory()) throw new WorkspaceError(400, `${real} is not a folder`);
    if (!inside(root, real)) throw new WorkspaceError(403, `${real} is outside ${root}; only folders inside it can be attached (FOLDERS_ROOT)`);
    // Same folder by identity, not path: under Docker the primary is /repo/docs/drawings and also visible under $HOME.
    if ((mainStat && st.dev === mainStat.dev && st.ino === mainStat.ino) || overlaps(real, mainReal)) {
      throw new WorkspaceError(409, `${real} is the primary drawings folder (or inside it, or contains it), already shown`);
    }
    const clash = attached.find((f) => overlaps(f.path, real));
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
      let list = null;
      try { const doc = JSON.parse(raw); if (Array.isArray(doc?.folders) && doc.folders.every((f) => typeof f === 'string')) list = doc.folders; } catch { /* below */ }
      if (!list) {
        log(`workspace: ${file} is not a valid workspace file; kept as ${file}.bad, starting with no attached folders`);
        await fs.copyFile(file, `${file}.bad`).catch(() => {});
      } else if (!root) {
        if (list.length) log(`workspace: FOLDERS_ROOT not set, so the ${list.length} folder(s) in ${file} are not opened`);
      } else {
        for (const p of list) {
          try { attached.push(make(await check(p))); } catch (e) {
            // Missing now (unmounted, deleted): keep it listed with its error so it can be detached. Anything else is dropped.
            const normal = typeof p === 'string' && path.isAbsolute(p) ? path.normalize(p) : null;
            if (e.status === 404 && normal && inside(root, normal) && !attached.some((f) => overlaps(f.path, normal))) attached.push(make(normal));
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
      try { await h.writeFile(JSON.stringify({ version: 1, folders: attached.map((f) => f.path) }, null, 2) + '\n'); await h.sync(); } finally { await h.close(); }
      await fs.rename(tmp, file);
    } catch (e) { await fs.unlink(tmp).catch(() => {}); throw e; }
  }

  // One attach/detach at a time: both edit the list and the file.
  let lane = Promise.resolve();
  const oneAtATime = (fn) => { const r = lane.then(fn); lane = r.catch(() => {}); return r; };

  return {
    canAttach: !!root,
    folders: () => [main, ...attached],
    get(id = PRIMARY) {
      const f = id === PRIMARY ? main : attached.find((x) => x.id === id);
      if (!f) throw new WorkspaceError(404, `unknown folder: ${JSON.stringify(id)} (detached? reload the page)`);
      return f;
    },

    /** Add a folder by absolute path. Returns it. */
    attach: (p) => oneAtATime(async () => {
      const f = make(await check(p));
      attached.push(f);
      try { await persist(); } catch (e) { attached.pop(); throw new WorkspaceError(500, `could not save the workspace file: ${e.message}`); }
      return f;
    }),

    /** Remove a folder from the workspace. Files on disk are not touched. */
    detach: (id) => oneAtATime(async () => {
      if (id === PRIMARY) throw new WorkspaceError(400, 'the primary folder cannot be detached');
      const i = attached.findIndex((f) => f.id === id);
      if (i < 0) throw new WorkspaceError(404, `unknown folder: ${JSON.stringify(id)}`);
      const [f] = attached.splice(i, 1);
      try { await persist(); } catch (e) { attached.splice(i, 0, f); throw new WorkspaceError(500, `could not save the workspace file: ${e.message}`); }
      return f;
    }),
  };
}
