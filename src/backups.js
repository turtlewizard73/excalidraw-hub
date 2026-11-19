// Copies of drawings taken before they are overwritten, for Revert. Outside the drawings folder, which may be git-tracked.
// A drawing is named by its path relative to its root ("a/b/x.excalidraw"). Layout: <root>/<dir>/<file name>/<timestamp>.excalidraw,
// e.g. a/b/x.excalidraw/2026-01-01T00-00-00-000Z.excalidraw. The folder keeps the full file name, because a file and a folder of the
// same name cannot sit in one directory: a drawing x.excalidraw never shares its backup key with a folder x/ that holds drawings. <root>/_reverted and <root>/_retired hold copies Revert never reads:
// _reverted (the file a revert replaced) and _retired (backups of deleted drawings, or of a name created anew).
// A drawing inside a top-level folder named _reverted or _retired of the drawings root has no backups (the name is reserved).
import fs from 'node:fs/promises';
import path from 'node:path';
import { EXT } from './names.js';

const RESERVED = new Set(['_reverted', '_retired']);
const badSegment = (s) => s === '' || s === '.' || s === '..' || /[\\\0]/.test(s);

/** `now` is replaceable for tests (a frozen clock). */
export function createBackups(dir, keep = 20, now = () => new Date()) {
  const root = path.resolve(dir);
  const stamp = () => now().toISOString().replace(/[:.]/g, '-');
  /** Drawings inside a top-level _reverted or _retired folder have no backups (the names are reserved). */
  const reserved = (rel) => typeof rel === 'string' && rel.includes('/') && RESERVED.has(rel.split('/')[0]);

  /** The backups folder of drawing `rel` ("dir/x.excalidraw", POSIX), optionally in an area (_reverted, _retired). */
  function folder(rel, area = '') {
    const segs = typeof rel === 'string' ? rel.split('/') : [];
    const file = segs.pop() ?? '';
    if (!file.endsWith(EXT) || file === EXT || badSegment(file) || segs.some(badSegment)) throw new Error(`invalid backup name ${JSON.stringify(rel)}`);
    if (!area && RESERVED.has(segs[0])) throw new Error(`${segs[0]} is a reserved folder name for backups`);
    return path.join(root, area, ...segs, file);
  }
  const exists = (p) => fs.lstat(p).then(() => true, () => false);

  async function list(rel) {
    if (reserved(rel)) return [];
    const entries = await fs.readdir(folder(rel), { withFileTypes: true }).catch((e) => { if (e.code === 'ENOENT') return []; throw e; });
    return entries.filter((e) => e.isFile() && e.name.endsWith(EXT)).map((e) => e.name).sort(); // timestamp names: oldest first
  }

  async function write(dirPath, bytes, limit) {
    await fs.mkdir(dirPath, { recursive: true });
    const t = stamp();
    let name = `${t}${EXT}`;
    for (let i = 2; await exists(path.join(dirPath, name)); i++) name = `${t}_${i}${EXT}`;
    await fs.writeFile(path.join(dirPath, name), bytes, { flag: 'wx' });
    if (limit) {
      const all = (await fs.readdir(dirPath, { withFileTypes: true })).filter((e) => e.isFile() && e.name.endsWith(EXT)).map((e) => e.name).sort();
      for (const old of all.slice(0, Math.max(0, all.length - limit))) await fs.unlink(path.join(dirPath, old)).catch(() => {});
    }
    return name;
  }

  /** Move a drawing's backups out of Revert's reach (into _retired). */
  async function retire(rel) {
    if (reserved(rel)) return;
    const src = folder(rel);
    if (!(await exists(src))) return;
    const base = folder(rel, '_retired') + `-${stamp()}`;
    let dest = base;
    for (let i = 2; await exists(dest); i++) dest = `${base}_${i}`; // two retires in one millisecond
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.rename(src, dest);
  }

  return {
    root,
    list,
    count: async (rel) => (await list(rel)).length,

    /** Keep `bytes` (the file about to be overwritten). Returns the backup name. */
    save: async (rel, bytes) => write(folder(rel), bytes, keep),

    /** Keep the file a revert is about to replace, where Revert never looks. */
    keepReverted: async (rel, bytes) => write(folder(rel, '_reverted'), bytes, keep),

    /** The newest backup, or null. Not removed: call remove() once it is restored. */
    async newest(rel) {
      const names = await list(rel);
      if (!names.length) return null;
      const name = names.at(-1);
      return { name, bytes: await fs.readFile(path.join(folder(rel), name)) };
    },

    remove: async (rel, name) => fs.unlink(path.join(folder(rel), path.basename(name))),

    retire,

    /** Backups follow a renamed or moved drawing, also into another root's backups (`to`). Anything already at the new name is retired first. */
    async move(rel, newRel, to = this) {
      if (reserved(rel) || to.isReserved(newRel)) return; // no backups there
      const src = folder(rel);
      const dest = to.folderOf(newRel);
      if (src === dest || !(await exists(src))) return; // same place: nothing to do, and never retire our own history
      await to.retire(newRel);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.rename(src, dest);
    },

    isReserved: reserved,

    /** Where the backups of `rel` live (used by move). */
    folderOf: (rel) => folder(rel),
  };
}
