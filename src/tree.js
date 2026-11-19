// One folder of the explorer, listed lazily when it is opened: subfolders and `.excalidraw` drawings, nothing else.
// Folders skipped: dot-folders, node_modules, and (when the root is in a git repo) anything git ignores.
import path from 'node:path';
import { gitIgnored } from './git.js';
import { sortFamilies } from './names.js';

const SKIP = new Set(['node_modules']);
const join = (rel, name) => (rel ? `${rel}/${name}` : name);

/**
 * @param {{store, backups, path: string, repoDir?: string|null}} folder a workspace root
 * @param {string} rel the folder to list, relative to the root ('' = the root)
 * @returns {Promise<{dirs: {name, path}[], drawings: {file, path, base, stem, version, label, latest, backups}[]}>}
 * `ignored` is replaceable for tests. A missing or unreadable folder throws (the caller reports it).
 */
export async function listDir(folder, rel = '', { ignored = gitIgnored } = {}) {
  const entries = await folder.store.entries(rel);
  let dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP.has(e.name)).map((e) => e.name).sort((a, b) => a.localeCompare(b));
  if (folder.repoDir && dirs.length) {
    const asked = new Map(dirs.map((n) => [`${path.relative(folder.repoDir, path.join(folder.path, ...join(rel, n).split('/'))).split(path.sep).join('/')}/`, n]));
    const hidden = await ignored(folder.repoDir, [...asked.keys()]);
    dirs = dirs.filter((n) => ![...hidden].some((h) => asked.get(h.endsWith('/') ? h : `${h}/`) === n));
  }
  const files = entries.filter((e) => e.isFile()).map((e) => e.name);
  const drawings = [];
  for (const d of sortFamilies(files)) {
    const p = join(rel, d.file);
    drawings.push({ file: d.file, path: p, base: d.base, stem: d.stem, version: d.version, label: d.label, latest: d.latest, backups: await folder.backups.count(p) });
  }
  return { dirs: dirs.map((name) => ({ name, path: join(rel, name) })), drawings };
}
