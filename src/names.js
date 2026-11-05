// Pure naming rules for docs/drawings: <project>/<project>_v<i>[_<label>].excalidraw (parent repo CLAUDE.md, Drawings).
export const EXT = '.excalidraw';
export const MAX_NAME = 121;
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

/** A folder or file base name that is safe to join under the drawings root. */
export function isSafeName(name) {
  return typeof name === 'string' && SAFE.test(name) && !name.includes('..');
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Parse a drawing file name. Returns null for non-.excalidraw files; version/label are null off-scheme. */
export function parseDrawing(project, file) {
  if (!file.endsWith(EXT)) return null;
  const base = file.slice(0, -EXT.length);
  const m = new RegExp(`^${escapeRe(project)}_v(\\d{1,9})(?:_(.+))?$`).exec(base);
  return { file, base, version: m ? Number(m[1]) : null, label: m ? (m[2] ?? null) : null };
}

export function nextVersion(project, files) {
  const versions = files.map((f) => parseDrawing(project, f)?.version).filter((v) => v !== null && v !== undefined);
  return versions.length ? Math.max(...versions) + 1 : 0;
}

/** `<stem>[_<slug of label>].excalidraw`, with the slug cut to fit the name limit. */
function withLabel(stem, label) {
  const room = Math.min(60, MAX_NAME - stem.length - 1);
  const slug = room > 0 ? String(label ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, room).replace(/_+$/, '') : '';
  return `${stem}${slug ? `_${slug}` : ''}${EXT}`;
}

export function saveName(project, version, label) {
  return withLabel(`${project}_v${version}`, label);
}

/** Target of a save with versioning off: the loaded drawing, unless a label names another file. */
export function plainSaveName(project, label, current) {
  const name = withLabel(project, label);
  return name === `${project}${EXT}` && current?.project === project ? current.file : name;
}

/** Versioned drawings first (highest first, the highest marked latest), then off-scheme files by name. */
export function sortDrawings(project, files) {
  const parsed = files.map((f) => parseDrawing(project, f)).filter(Boolean);
  const versioned = parsed.filter((d) => d.version !== null).sort((a, b) => b.version - a.version || a.file.localeCompare(b.file));
  const plain = parsed.filter((d) => d.version === null).sort((a, b) => a.file.localeCompare(b.file));
  return [...versioned.map((d, i) => ({ ...d, latest: i === 0 })), ...plain.map((d) => ({ ...d, latest: false }))];
}
