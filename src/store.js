// Drawing files under one root folder (the docs/drawings mount). Every path goes through `resolve`.
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { EXT, isSafeName, sortDrawings } from './names.js';

export class StoreError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** Link src to dest; never overwrites (link fails if dest exists). */
async function linkExclusive(src, dest) {
  try { await fs.link(src, dest); } catch (e) {
    if (e.code === 'EEXIST') throw new StoreError(409, `${path.basename(dest)} already exists`);
    throw e;
  }
}

/** Move several src->dest pairs all-or-nothing: link every dest first, then unlink the sources. */
export async function moveAll(pairs) {
  const done = [];
  try {
    for (const [src, dest] of pairs) { await linkExclusive(src, dest); done.push(dest); }
  } catch (e) {
    for (const dest of done) await fs.unlink(dest).catch(() => {});
    throw e;
  }
  for (const [src] of pairs) await fs.unlink(src);
}

export function createStore(rootDir) {
  const root = path.resolve(rootDir);

  /** Absolute path for project[/file], or a StoreError. Rejects unsafe names, escapes and symlinks. */
  async function resolve(project, file) {
    if (!isSafeName(project)) throw new StoreError(400, `invalid project name: ${JSON.stringify(project)}`);
    if (file !== undefined && (typeof file !== 'string' || !file.endsWith(EXT) || !isSafeName(file.slice(0, -EXT.length)))) {
      throw new StoreError(400, `invalid drawing name: ${JSON.stringify(file)}`);
    }
    const p = file === undefined ? path.join(root, project) : path.join(root, project, file);
    if (!p.startsWith(root + path.sep)) throw new StoreError(400, 'path escapes the drawings root');
    for (const part of file === undefined ? [p] : [path.dirname(p), p]) {
      const st = await fs.lstat(part).catch(() => null);
      if (st?.isSymbolicLink()) throw new StoreError(400, 'symlinks are not allowed');
    }
    return p;
  }

  const exists = (p) => fs.lstat(p).then(() => true, () => false);

  /** Write `doc` to a synced temp file beside `p`; removes it again on failure. */
  async function writeTemp(p, file, doc) {
    const tmp = path.join(path.dirname(p), `.${file}.${crypto.randomUUID()}.tmp`);
    try {
      const h = await fs.open(tmp, 'wx');
      try { await h.writeFile(JSON.stringify(doc, null, 2) + '\n'); await h.sync(); } finally { await h.close(); }
    } catch (e) { await fs.unlink(tmp).catch(() => {}); throw e; }
    return tmp;
  }
  const pngOf = (p) => p.slice(0, -EXT.length) + '.png';

  const isFile = (p) => fs.lstat(p).then((st) => st.isFile(), () => false);

  /** A regular file (not a dir, FIFO or symlink), or 404. */
  async function requireFile(p, label) {
    if (!(await isFile(p))) throw new StoreError(404, `${label} not found`);
  }

  return {
    root,

    async listProjects() {
      const entries = await fs.readdir(root, { withFileTypes: true });
      const projects = [];
      for (const d of entries.filter((e) => e.isDirectory() && isSafeName(e.name)).sort((a, b) => a.name.localeCompare(b.name))) {
        const files = (await fs.readdir(path.join(root, d.name), { withFileTypes: true })).filter((f) => f.isFile()).map((f) => f.name);
        const pngs = new Set(files.filter((f) => f.endsWith('.png')));
        const drawings = sortDrawings(d.name, files.filter((f) => isSafeName(f.slice(0, -EXT.length))))
          .map((x) => ({ ...x, png: pngs.has(`${x.base}.png`) }));
        projects.push({ name: d.name, drawings });
      }
      return projects;
    },

    async files(project) {
      const dir = await resolve(project);
      return fs.readdir(dir).catch((e) => { if (e.code === 'ENOENT') return []; throw e; });
    },

    async read(project, file) {
      const p = await resolve(project, file);
      await requireFile(p, `${project}/${file}`);
      let doc;
      try { doc = JSON.parse(await fs.readFile(p, 'utf8')); } catch { throw new StoreError(422, `${project}/${file} is not valid JSON`); }
      if (!doc || typeof doc !== 'object' || !Array.isArray(doc.elements)) throw new StoreError(422, `${project}/${file} has no elements array`);
      return doc;
    },

    /** Write a new file; never overwrites. Creates the project folder if needed. */
    async create(project, file, doc) {
      const p = await resolve(project, file);
      await fs.mkdir(path.dirname(p), { recursive: true });
      const tmp = await writeTemp(p, file, doc);
      try { await moveAll([[tmp, p]]); } catch (e) { await fs.unlink(tmp).catch(() => {}); throw e; }
    },

    /** Identifies this state of a file (null if missing), to notice changes made outside the hub. */
    async stamp(project, file) {
      const st = await fs.lstat(await resolve(project, file)).catch(() => null);
      return st ? `${st.mtimeMs}:${st.size}` : null;
    },

    /** Replace `file` atomically, or create it if missing. Only for the drawing the user has loaded. */
    async overwrite(project, file, doc) {
      const p = await resolve(project, file);
      if (await exists(p) && !(await isFile(p))) throw new StoreError(409, `${project}/${file} is not a regular file`);
      await fs.mkdir(path.dirname(p), { recursive: true });
      const tmp = await writeTemp(p, file, doc);
      try { await fs.rename(tmp, p); } catch (e) { await fs.unlink(tmp).catch(() => {}); throw e; }
    },

    /** Rename within the project; the same-named .png moves along. */
    async rename(project, file, newFile) {
      const src = await resolve(project, file);
      const dest = await resolve(project, newFile);
      await requireFile(src, `${project}/${file}`);
      if (src === dest) return;
      for (const p of [dest, pngOf(dest)]) if (await exists(p)) throw new StoreError(409, `${path.basename(p)} already exists`);
      const pngExists = await exists(pngOf(src));
      if (pngExists && !(await isFile(pngOf(src)))) throw new StoreError(409, `${path.basename(pngOf(src))} is not a regular file`);
      await moveAll(pngExists ? [[src, dest], [pngOf(src), pngOf(dest)]] : [[src, dest]]);
    },

    /** Delete a drawing and its same-named .png. */
    async remove(project, file) {
      const p = await resolve(project, file);
      await requireFile(p, `${project}/${file}`);
      await fs.unlink(p);
      if (await isFile(pngOf(p))) await fs.unlink(pngOf(p));
    },
  };
}
