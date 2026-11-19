// Drawing files under one root folder. createRootStore (any depth, paths relative to the root) is the model; createStore (project/file,
// one level) is legacy until step 6 of the standalone plan. Every path goes through `resolve`.
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
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

const exists = (p) => fs.lstat(p).then(() => true, () => false);

/** Write `doc` (an object as JSON, or bytes) to a synced temp file beside `p`; removes it again on failure. */
async function writeTemp(p, file, doc) {
  const tmp = path.join(path.dirname(p), `.${file}.${crypto.randomUUID()}.tmp`);
  try {
    const h = await fs.open(tmp, 'wx');
    try { await h.writeFile(Buffer.isBuffer(doc) ? doc : JSON.stringify(doc, null, 2) + '\n'); await h.sync(); } finally { await h.close(); }
  } catch (e) { await fs.unlink(tmp).catch(() => {}); throw e; }
  return tmp;
}
export const pngOf = (p) => p.slice(0, -EXT.length) + '.png';

const isFile = (p) => fs.lstat(p).then((st) => st.isFile(), () => false);

/** A regular file (not a dir, FIFO or symlink), or 404. */
async function requireFile(p, label) {
  if (!(await isFile(p))) throw new StoreError(404, `${label} not found`);
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

    /** The file's bytes, or null if it does not exist. */
    async readBytes(project, file) {
      const p = await resolve(project, file);
      if (!(await isFile(p))) return null;
      return fs.readFile(p);
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

    /** Replace the drawing's same-named .png atomically. Refuses if that name is not a regular file. */
    async writePng(project, file, bytes) {
      const png = pngOf(await resolve(project, file));
      if (await exists(png) && !(await isFile(png))) throw new StoreError(409, `${path.basename(png)} is not a regular file`);
      const tmp = await writeTemp(png, path.basename(png), bytes);
      try { await fs.rename(tmp, png); } catch (e) { await fs.unlink(tmp).catch(() => {}); throw e; }
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

const insideDir = (dir, p) => { const rel = path.relative(dir, p); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };
const badSegment = (s) => s === '' || s === '.' || s === '..' || /[\\\0]/.test(s);
const hasExt = (rel) => typeof rel === 'string' && rel.endsWith(EXT) && rel.split('/').at(-1).length > EXT.length;

/** Rename `a` to `b`; across drives (EXDEV) copy, fsync and unlink instead. Never overwrites an existing `b` on the copy path. */
async function moveFile(a, b, rename) {
  try { await rename(a, b); return; } catch (e) { if (e.code !== 'EXDEV') throw e; }
  try {
    await fs.copyFile(a, b, fsConstants.COPYFILE_EXCL);
    const h = await fs.open(b, 'r+');
    try { await h.sync(); } finally { await h.close(); }
  } catch (e) { await fs.unlink(b).catch(() => {}); throw e; }
  await fs.unlink(a);
}

/**
 * Move a drawing and its .png from store `src` (path `rel`) to store `dest` (path `newRel`), which may be another root.
 * Refuses (409) if the target holds the file or its .png. All or nothing: a failed .png move puts the drawing back.
 * `rename` is replaceable for tests (to simulate EXDEV).
 */
export async function moveDrawing(src, rel, dest, newRel, { rename = fs.rename } = {}) {
  if (!hasExt(rel) || !hasExt(newRel)) throw new StoreError(400, 'not a drawing path');
  const from = await src.resolve(rel);
  const to = await dest.resolve(newRel);
  if (!(await isFile(from))) throw new StoreError(404, `${rel} not found`);
  if (from === to) return;
  const toDir = await fs.lstat(path.dirname(to)).catch(() => null);
  if (!toDir?.isDirectory()) throw new StoreError(404, `the target folder of ${newRel} does not exist`);
  const pairs = [[from, to]];
  if (await exists(pngOf(from))) {
    if (!(await isFile(pngOf(from)))) throw new StoreError(409, `${path.basename(pngOf(from))} is not a regular file`);
    pairs.push([pngOf(from), pngOf(to)]);
  }
  for (const p of [to, pngOf(to)]) if (await exists(p)) throw new StoreError(409, `${path.basename(p)} already exists`);
  const done = [];
  try {
    for (const [a, b] of pairs) { await moveFile(a, b, rename); done.push([a, b]); }
  } catch (e) {
    for (const [a, b] of done.reverse()) await moveFile(b, a, fs.rename).catch(() => {});
    throw e;
  }
}

/**
 * The files of one root folder, at any depth. Paths are relative to the root, POSIX separators ('' is the root itself).
 * Every path is checked: no empty, '.' or '..' segments, and no symlink may lead out of the root (400).
 */
export function createRootStore(rootDir, { rename = fs.rename } = {}) {
  const root = path.resolve(rootDir);

  async function resolve(rel = '') {
    if (typeof rel !== 'string') throw new StoreError(400, 'path must be a string');
    const segs = rel === '' ? [] : rel.split('/');
    if (segs.some(badSegment)) throw new StoreError(400, `invalid path: ${JSON.stringify(rel)}`);
    let realRoot;
    try { realRoot = await fs.realpath(root); } catch { throw new StoreError(404, `${root} cannot be read`); }
    let cur = root;
    for (const seg of segs) {
      cur = path.join(cur, seg);
      const st = await fs.lstat(cur).catch(() => null);
      if (!st) break; // nothing below exists yet
      if (st.isSymbolicLink()) {
        const real = await fs.realpath(cur).catch(() => null); // null: dangling, so it could be written through
        if (!real || !insideDir(realRoot, real)) throw new StoreError(400, 'path escapes the root through a symlink');
      }
    }
    return path.join(root, ...segs);
  }
  const drawing = async (rel) => { if (!hasExt(rel)) throw new StoreError(400, `invalid drawing path: ${JSON.stringify(rel)}`); return resolve(rel); };

  const api = {
    root,
    resolve,

    /** Directory entries (fs.Dirent) of folder `rel`; a missing or unreadable folder throws. */
    async entries(rel = '') { return fs.readdir(await resolve(rel), { withFileTypes: true }); },

    /** File names directly in folder `rel`; empty if it does not exist. */
    async files(rel = '') {
      return fs.readdir(await resolve(rel)).catch((e) => { if (e.code === 'ENOENT') return []; throw e; });
    },

    /** Create folder `rel` inside an existing parent. The new name must be safe; refuses an existing one (409). */
    async mkdir(rel) {
      const p = await resolve(rel);
      if (rel === '' || !isSafeName(rel.split('/').at(-1))) throw new StoreError(400, `invalid folder name: ${JSON.stringify(rel.split('/').at(-1) ?? rel)}`);
      const parent = await fs.lstat(path.dirname(p)).catch(() => null);
      if (!parent?.isDirectory()) throw new StoreError(404, `the parent folder of ${rel} does not exist`);
      try { await fs.mkdir(p); } catch (e) { if (e.code === 'EEXIST') throw new StoreError(409, `${rel} already exists`); throw e; }
    },

    async read(rel) {
      const p = await drawing(rel);
      await requireFile(p, rel);
      let doc;
      try { doc = JSON.parse(await fs.readFile(p, 'utf8')); } catch { throw new StoreError(422, `${rel} is not valid JSON`); }
      if (!doc || typeof doc !== 'object' || !Array.isArray(doc.elements)) throw new StoreError(422, `${rel} has no elements array`);
      return doc;
    },

    /** The file's bytes, or null if it does not exist. */
    async readBytes(rel) {
      const p = await drawing(rel);
      return (await isFile(p)) ? fs.readFile(p) : null;
    },

    /** Write a new file (safe name); never overwrites. */
    async create(rel, doc) {
      const p = await drawing(rel);
      if (!isSafeName(rel.split('/').at(-1).slice(0, -EXT.length))) throw new StoreError(400, `invalid drawing name: ${JSON.stringify(path.basename(rel))}`);
      const dir = await fs.lstat(path.dirname(p)).catch(() => null);
      if (!dir?.isDirectory()) throw new StoreError(404, `the folder of ${rel} does not exist`);
      const tmp = await writeTemp(p, path.basename(p), doc);
      try { await moveAll([[tmp, p]]); } catch (e) { await fs.unlink(tmp).catch(() => {}); throw (e instanceof StoreError ? new StoreError(409, `${rel} already exists`) : e); }
    },

    /** Identifies this state of a file (null if missing), to notice changes made outside the hub. */
    async stamp(rel) {
      const st = await fs.lstat(await drawing(rel)).catch(() => null);
      return st ? `${st.mtimeMs}:${st.size}` : null;
    },

    /** Replace `rel` atomically, or create it if missing. Only for the drawing the user has loaded. */
    async overwrite(rel, doc) {
      const p = await drawing(rel);
      if (await exists(p) && !(await isFile(p))) throw new StoreError(409, `${rel} is not a regular file`);
      const tmp = await writeTemp(p, path.basename(p), doc);
      try { await fs.rename(tmp, p); } catch (e) { await fs.unlink(tmp).catch(() => {}); throw e; }
    },

    /** Replace the drawing's same-named .png atomically. Refuses if that name is not a regular file. */
    async writePng(rel, bytes) {
      const png = pngOf(await drawing(rel));
      if (await exists(png) && !(await isFile(png))) throw new StoreError(409, `${path.basename(png)} is not a regular file`);
      const tmp = await writeTemp(png, path.basename(png), bytes);
      try { await fs.rename(tmp, png); } catch (e) { await fs.unlink(tmp).catch(() => {}); throw e; }
    },

    /** Rename or move within this root; the .png moves along. */
    rename: (rel, newRel) => moveDrawing(api, rel, api, newRel, { rename }),

    /** Delete a drawing and its same-named .png. */
    async remove(rel) {
      const p = await drawing(rel);
      await requireFile(p, rel);
      await fs.unlink(p);
      if (await isFile(pngOf(p))) await fs.unlink(pngOf(p));
    },
  };
  return api;
}
