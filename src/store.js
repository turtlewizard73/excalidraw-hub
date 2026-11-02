// Drawing files under one root folder (the docs/drawings mount). Every path goes through `resolve`.
import fs from 'node:fs/promises';
import path from 'node:path';
import { EXT, isSafeName, sortDrawings } from './names.js';

export class StoreError extends Error {
  constructor(status, message) { super(message); this.status = status; }
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
  const pngOf = (p) => p.slice(0, -EXT.length) + '.png';

  /** Move src to dest without ever overwriting dest (link fails if dest exists). */
  async function moveExclusive(src, dest) {
    try { await fs.link(src, dest); } catch (e) {
      if (e.code === 'EEXIST') throw new StoreError(409, `${path.basename(dest)} already exists`);
      throw e;
    }
    await fs.unlink(src);
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
      const text = await fs.readFile(p, 'utf8').catch((e) => {
        if (e.code === 'ENOENT') throw new StoreError(404, `${project}/${file} not found`);
        throw e;
      });
      try { return JSON.parse(text); } catch { throw new StoreError(422, `${project}/${file} is not valid JSON`); }
    },

    /** Write a new file; never overwrites. Creates the project folder if needed. */
    async create(project, file, doc) {
      const p = await resolve(project, file);
      await fs.mkdir(path.dirname(p), { recursive: true });
      const tmp = path.join(path.dirname(p), `.${file}.${process.pid}.${Date.now()}.tmp`);
      await fs.writeFile(tmp, JSON.stringify(doc, null, 2) + '\n', { flag: 'wx' });
      try { await moveExclusive(tmp, p); } catch (e) { await fs.unlink(tmp).catch(() => {}); throw e; }
    },

    /** Rename within the project; the same-named .png moves along. */
    async rename(project, file, newFile) {
      const src = await resolve(project, file);
      const dest = await resolve(project, newFile);
      if (!(await exists(src))) throw new StoreError(404, `${project}/${file} not found`);
      if (src === dest) return;
      if (await exists(pngOf(src)) && await exists(pngOf(dest))) throw new StoreError(409, `${path.basename(pngOf(dest))} already exists`);
      await moveExclusive(src, dest);
      if (await exists(pngOf(src))) await moveExclusive(pngOf(src), pngOf(dest));
    },

    /** Delete a drawing and its same-named .png. */
    async remove(project, file) {
      const p = await resolve(project, file);
      await fs.unlink(p).catch((e) => {
        if (e.code === 'ENOENT') throw new StoreError(404, `${project}/${file} not found`);
        throw e;
      });
      await fs.unlink(pngOf(p)).catch((e) => { if (e.code !== 'ENOENT') throw e; });
    },
  };
}
