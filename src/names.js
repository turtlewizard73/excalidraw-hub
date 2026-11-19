// Pure naming rules: `<stem>_v<i>[_<label>].excalidraw`, families by stem per folder.
export const EXT = '.excalidraw';
export const MAX_NAME = 121;
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

/** A folder or file base name that is safe to join under the drawings root. */
export function isSafeName(name) {
  return typeof name === 'string' && SAFE.test(name) && !name.includes('..');
}

/** `<stem>[_<slug of label>].excalidraw`, with the slug cut to fit the name limit. */
function withLabel(stem, label) {
  const room = Math.min(60, MAX_NAME - stem.length - 1);
  const slug = room > 0 ? String(label ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, room).replace(/_+$/, '') : '';
  return `${stem}${slug ? `_${slug}` : ''}${EXT}`;
}

export function saveName(stem, version, label) {
  return withLabel(`${stem}_v${version}`, label);
}

/** A blank label, or one with something a file name can use (the slug keeps only a-z and 0-9). */
export const isUsableLabel = (label) => !String(label ?? '').trim() || /[A-Za-z0-9]/.test(String(label));

// Families by stem per folder (standalone plan, step 3). `<stem>_v<i>[_<label>].excalidraw`; the stem is parsed lazily, so
// `a_v1_b_v2` is stem `a`, version 1, label `b_v2`. A file without `_v<i>` is its own stem and unversioned. The folder name
// is only the default stem for a new drawing.
const STEM_RE = /^(.+?)_v(\d{1,9})(?:_(.+))?$/;

/** Parse a drawing file name into {file, base, stem, version, label}; null for non-.excalidraw files. */
export function parseStem(file) {
  if (!file.endsWith(EXT)) return null;
  const base = file.slice(0, -EXT.length);
  const m = STEM_RE.exec(base);
  return { file, base, stem: m ? m[1] : base, version: m ? Number(m[2]) : null, label: m ? (m[3] ?? null) : null };
}

/** Next version of the family `stem` among the files of one folder: highest + 1, or 0. */
export function nextVersionOf(stem, files) {
  const versions = files.map(parseStem).filter((d) => d && d.stem === stem && d.version !== null).map((d) => d.version);
  return versions.length ? Math.max(...versions) + 1 : 0;
}

/** The stem a save uses: the loaded drawing's (it must be in the folder being saved to), else the folder's name. */
export function saveStem(loadedFile, dirName) {
  return (loadedFile ? parseStem(loadedFile)?.stem : null) ?? dirName;
}

/** The longest stem that still leaves room for `_v<up to 9 digits>`. */
export const MAX_STEM = MAX_NAME - 11;

/** Target of a plain save in one folder. With no label and a drawing loaded from it: overwrite that drawing; else a new `<stem>[_<label>]` name. */
export function plainTargetIn(stem, label, loadedFile) {
  const file = withLabel(stem, label);
  if (file === `${stem}${EXT}` && loadedFile) return { file: loadedFile, overwrite: true };
  return { file, overwrite: false };
}

/** The drawings of one folder grouped into families: by stem, versions highest first, the highest of each stem marked latest; unversioned last in their stem. */
export function sortFamilies(files) {
  const parsed = files.map(parseStem).filter(Boolean);
  const sorted = parsed.sort((a, b) => a.stem.localeCompare(b.stem) || (a.version === null) - (b.version === null) || b.version - a.version || a.base.localeCompare(b.base));
  const seen = new Set();
  return sorted.map((d) => { const latest = d.version !== null && !seen.has(d.stem); if (d.version !== null) seen.add(d.stem); return { ...d, latest }; });
}
