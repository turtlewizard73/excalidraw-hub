// Backups of the canvas taken before a forced load replaces unsaved work. Newest `keep` files are kept.
import fs from 'node:fs/promises';
import path from 'node:path';
import { EXT } from './names.js';

export function createAutosave(dir, keep = 50) {
  const root = path.resolve(dir);
  return {
    dir: root,

    /** Write `doc`; `current` is the drawing the canvas came from, if any. Returns the file name. */
    async write(doc, current) {
      await fs.mkdir(root, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const from = current ? current.file.slice(0, -EXT.length) : 'unsaved';
      let name = `${stamp}_${from}${EXT}`;
      for (let i = 2; await fs.lstat(path.join(root, name)).then(() => true, () => false); i++) name = `${stamp}_${from}_${i}${EXT}`;
      await fs.writeFile(path.join(root, name), JSON.stringify(doc, null, 2) + '\n', { flag: 'wx' });
      // Names start with an ISO timestamp, so name order is age order.
      const all = (await fs.readdir(root)).filter((f) => f.endsWith(EXT)).sort();
      for (const old of all.slice(0, Math.max(0, all.length - keep))) await fs.unlink(path.join(root, old)).catch(() => {});
      return name;
    },
  };
}
