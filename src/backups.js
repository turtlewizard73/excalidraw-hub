// Copies of drawings taken before they are overwritten, for Revert. Outside the drawings folder, which may be git-tracked.
// A drawing is named by its path relative to its root ("a/b/x.excalidraw"). Layout: <root>/<dir>/<base>/<timestamp>.excalidraw,
// so a drawing's history follows the same folders. <root>/_reverted and <root>/_retired hold copies Revert never reads:
// _reverted (the file a revert replaced) and _retired (backups of deleted drawings, or of a name created anew).
// A drawing directly in a folder named _reverted or _retired of the drawings root has no backups (the name is reserved).
import fs from 'node:fs/promises';
import path from 'node:path';
import { EXT } from './names.js';

const RESERVED = new Set(['_reverted', '_retired']);
const badSegment = (s) => s === '' || s === '.' || s === '..' || /[\\\0]/.test(s);

export function createBackups(dir, keep = 20) {
  const root = path.resolve(dir);
  const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

  /** The backups folder of drawing `rel` ("dir/x.excalidraw", POSIX), optionally in an area (_reverted, _retired). */
  function folder(rel, area = '') {
    const segs = typeof rel === 'string' ? rel.split('/') : [];
    const file = segs.pop() ?? '';
    if (!file.endsWith(EXT) || file === EXT || badSegment(file) || segs.some(badSegment)) throw new Error(`invalid backup name ${JSON.stringify(rel)}`);
    if (!area && RESERVED.has(segs[0] ?? file.slice(0, -EXT.length))) throw new Error(`${segs[0] ?? file} is a reserved folder name for backups`);
    return path.join(root, area, ...segs, file.slice(0, -EXT.length));
  }
  const exists = (p) => fs.lstat(p).then(() => true, () => false);

  async function list(rel) {
    const names = await fs.readdir(folder(rel)).catch((e) => { if (e.code === 'ENOENT') return []; throw e; });
    return names.filter((n) => n.endsWith(EXT)).sort(); // timestamp names: oldest first
  }

  async function write(dirPath, bytes, limit) {
    await fs.mkdir(dirPath, { recursive: true });
    const t = stamp();
    let name = `${t}${EXT}`;
    for (let i = 2; await exists(path.join(dirPath, name)); i++) name = `${t}_${i}${EXT}`;
    await fs.writeFile(path.join(dirPath, name), bytes, { flag: 'wx' });
    if (limit) {
      const all = (await fs.readdir(dirPath)).filter((n) => n.endsWith(EXT)).sort();
      for (const old of all.slice(0, Math.max(0, all.length - limit))) await fs.unlink(path.join(dirPath, old)).catch(() => {});
    }
    return name;
  }

  /** Move a drawing's backups out of Revert's reach (into _retired). */
  async function retire(rel) {
    const src = folder(rel);
    if (!(await exists(src))) return;
    const dest = folder(rel, '_retired') + `-${stamp()}`;
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
      const src = folder(rel);
      if (!(await exists(src))) return;
      await to.retire(newRel);
      const dest = to.folderOf(newRel);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.rename(src, dest);
    },

    /** Where the backups of `rel` live (used by move). */
    folderOf: (rel) => folder(rel),
  };
}
