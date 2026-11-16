// Copies of drawings taken before they are overwritten, for Revert. Outside the drawings folder, which may be git-tracked.
// Layout: <root>/<project>/<base>/<timestamp>.excalidraw. Folders starting with "_" hold copies Revert never reads:
// _reverted (the file a revert replaced) and _retired (backups of deleted drawings, or of a name created anew).
import fs from 'node:fs/promises';
import path from 'node:path';
import { EXT, isSafeName } from './names.js';

export function createBackups(dir, keep = 20) {
  const root = path.resolve(dir);
  const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

  function folder(project, file, area = '') {
    const base = typeof file === 'string' && file.endsWith(EXT) ? file.slice(0, -EXT.length) : '';
    if (!isSafeName(project) || !isSafeName(base)) throw new Error(`invalid backup name ${project}/${file}`);
    return path.join(root, area, project, base);
  }
  const exists = (p) => fs.lstat(p).then(() => true, () => false);

  async function list(project, file) {
    const names = await fs.readdir(folder(project, file)).catch((e) => { if (e.code === 'ENOENT') return []; throw e; });
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
  async function retire(project, file) {
    const src = folder(project, file);
    if (!(await exists(src))) return;
    const dest = folder(project, file, '_retired') + `-${stamp()}`;
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.rename(src, dest);
  }

  return {
    root,
    list,
    count: async (project, file) => (await list(project, file)).length,

    /** Keep `bytes` (the file about to be overwritten). Returns the backup name. */
    save: async (project, file, bytes) => write(folder(project, file), bytes, keep),

    /** Keep the file a revert is about to replace, where Revert never looks. */
    keepReverted: async (project, file, bytes) => write(folder(project, file, '_reverted'), bytes, keep),

    /** The newest backup, or null. Not removed: call remove() once it is restored. */
    async newest(project, file) {
      const names = await list(project, file);
      if (!names.length) return null;
      const name = names.at(-1);
      return { name, bytes: await fs.readFile(path.join(folder(project, file), name)) };
    },

    remove: async (project, file, name) => fs.unlink(path.join(folder(project, file), path.basename(name))),

    retire,

    /** Backups follow a renamed drawing. Anything already at the new name is retired first. */
    async move(project, file, newFile) {
      const src = folder(project, file);
      if (!(await exists(src))) return;
      await retire(project, newFile);
      await fs.mkdir(path.dirname(folder(project, newFile)), { recursive: true });
      await fs.rename(src, folder(project, newFile));
    },
  };
}
