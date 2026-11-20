// Hub page: VS Code-style explorer (roots, lazy folders, drag to move, resize/hide), canvas iframe, save/revert/rename/delete/sync, unsaved badge.
const $ = (id) => document.getElementById(id);
const state = { folders: [], trees: new Map(), current: null, dirty: false, config: {} };
const W_MIN = 180, W_DEFAULT = 280;

// View state (width, hidden, expanded folders, selected folder) lives in this browser only.
const VIEW_KEY = 'excalidraw-hub.view';
const view = (() => { try { return JSON.parse(localStorage.getItem(VIEW_KEY)) ?? {}; } catch { return {}; } })();
const saveView = () => { try { localStorage.setItem(VIEW_KEY, JSON.stringify({ ...view, expanded: view.expanded && [...view.expanded] })); } catch { /* private mode */ } };
view.expanded = Array.isArray(view.expanded) ? new Set(view.expanded) : null; // null: first visit, open every root

const key = (root, path) => `${root}:${path}`;
const dirname = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const basename = (p) => p.slice(p.lastIndexOf('/') + 1);
const join = (dir, name) => (dir ? `${dir}/${name}` : name);
const rootOf = (id) => state.folders.find((f) => f.id === id);
const where = (c, sep = '/') => [rootOf(c.root)?.name ?? c.root, ...c.path.split('/')].join(sep);
const el = (tag, className = '', text = '') => Object.assign(document.createElement(tag), { className, textContent: text });
const currentDrawing = () => state.current && state.trees.get(key(state.current.root, dirname(state.current.path)))?.drawings?.find((d) => d.path === state.current.path);

async function api(route, body) {
  const res = await fetch(route, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { status: res.status, data });
  return data;
}

function say(text, isError = false) {
  $('message').textContent = text;
  $('message').className = isError ? 'error' : '';
}

/** Errors go to the message line and to a popup, so a refused save cannot go unnoticed. */
function fail(what, e) {
  say(`${what} failed: ${e.message}`, true);
  alert(`${what} failed:\n\n${e.message}`);
}

// ---- Explorer ----------------------------------------------------------------------------------------------------

let dragged = null; // {root, path} of the drawing being dragged (dragover cannot read dataTransfer)

const select = (root, path) => { view.selected = { root, path }; saveView(); };
const isOpen = (root, path) => view.expanded.has(key(root, path));

async function toggle(root, path) {
  if (isOpen(root, path)) view.expanded.delete(key(root, path)); else view.expanded.add(key(root, path));
  saveView();
  renderTree();
  if (isOpen(root, path)) { await refreshTrees(); renderTree(); }
}

function actionButton(text, title, action, onclick) {
  const b = el('button', 'act', text);
  b.type = 'button';
  b.title = title;
  b.dataset.action = action;
  b.onclick = (ev) => { ev.preventDefault(); ev.stopPropagation(); onclick(); };
  return b;
}

/** Highlight and accept a drop of a drawing onto this folder, unless it is the drawing's own folder. */
function dropTarget(row, root, path) {
  const ok = () => dragged && !(dragged.root === root && dirname(dragged.path) === path);
  row.ondragover = (ev) => { if (!ok()) return; ev.preventDefault(); ev.dataTransfer.dropEffect = 'move'; row.classList.add('drop'); };
  row.ondragleave = () => row.classList.remove('drop');
  row.ondrop = (ev) => { ev.preventDefault(); row.classList.remove('drop'); if (ok()) move(dragged, { root, dir: path }); };
}

function folderNode(f, path, name) {
  const isRoot = path === '';
  const open = isOpen(f.id, path);
  const node = el('div', 'node');
  const sel = view.selected?.root === f.id && view.selected.path === path;
  const row = el('div', `row folder${isRoot ? ' root' : ''}${sel ? ' selected' : ''}`);
  Object.assign(row.dataset, { testid: 'folder', root: f.id, path, expanded: String(open) });
  row.title = isRoot ? `${f.path}${f.sync ? '' : f.syncError ? `\nno git sync: ${f.syncError}` : ''}` : path;
  row.append(el('span', 'chev', open ? '▾' : '▸'), el('span', 'name', name));
  if (f.sync) row.append(actionButton('⟳', `Commit this folder's drawings to git and push`, 'sync', () => syncFolder(f, path)));
  row.append(actionButton('＋', 'New folder', 'mkdir', () => mkdir(f, path)));
  if (isRoot) row.append(actionButton('✕', `Detach ${f.path} (files stay on disk)`, 'detach', () => detach(f)));
  row.onclick = () => { select(f.id, path); toggle(f.id, path); };
  dropTarget(row, f.id, path);
  node.append(row);
  if (open) {
    const kids = el('div', 'children');
    const tree = state.trees.get(key(f.id, path));
    if (f.error && isRoot) kids.append(el('p', 'note error', f.error));
    else if (!tree) kids.append(el('p', 'note', 'Loading…'));
    else if (tree.error) kids.append(el('p', 'note error', tree.error));
    else {
      for (const d of tree.dirs) kids.append(folderNode(f, d.path, d.name));
      for (const d of tree.drawings) kids.append(drawingRow(f, d));
      if (!tree.dirs.length && !tree.drawings.length) kids.append(el('p', 'note', 'Empty folder.'));
    }
    node.append(kids);
  }
  return node;
}

function drawingRow(f, d) {
  const active = state.current?.root === f.id && state.current.path === d.path;
  const row = el('div', `row drawing${active ? ' active' : ''}`);
  Object.assign(row.dataset, { testid: 'drawing', root: f.id, path: d.path, file: d.file });
  row.draggable = true;
  row.ondragstart = (ev) => { dragged = { root: f.id, path: d.path }; document.body.classList.add('dragging'); ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', d.path); };
  row.ondragend = () => { dragged = null; document.body.classList.remove('dragging'); document.querySelectorAll('.drop').forEach((x) => x.classList.remove('drop')); };
  const open = el('button', 'open', d.base);
  open.type = 'button';
  open.title = `Load ${d.path} from ${f.path}`;
  open.onclick = () => load(f.id, d.path);
  row.append(open);
  if (d.latest) row.append(el('span', 'tag', 'latest'));
  else if (d.version === null) row.append(el('span', 'tag plain', 'unversioned'));
  row.append(actionButton('✎', 'Rename', 'rename', () => rename(f.id, d)), actionButton('🗑', 'Delete', 'delete', () => remove(f.id, d)));
  return row;
}

function renderTree() {
  const box = $('tree');
  box.replaceChildren();
  $('add-folder').hidden = !state.config.canAttach || !state.folders.length;
  if (!state.folders.length) {
    const empty = el('div');
    empty.id = 'empty';
    empty.append(el('p', '', 'No folders yet. Attach a folder that holds your drawings.'));
    if (state.config.canAttach) {
      const b = el('button', '', '+ Add folder');
      b.type = 'button';
      b.dataset.testid = 'add-folder';
      b.onclick = attachFolder;
      empty.append(b);
    }
    box.append(empty);
  }
  for (const f of state.folders) box.append(folderNode(f, '', f.name));
  renderHeader();
}

function renderHeader() {
  const sel = view.selected && rootOf(view.selected.root) ? view.selected : null;
  $('save-target').textContent = sel ? `Save into ${where({ root: sel.root, path: sel.path || '' }, ' / ').replace(/ \/ $/, '')}` : 'No folder selected';
  $('current').textContent = state.current ? where(state.current, ' / ') : 'No drawing loaded';
  const loaded = currentDrawing();
  $('revert').disabled = !loaded?.backups;
  $('revert').title = loaded?.backups
    ? `Go back to the previous saved state of ${loaded.file} (${loaded.backups} kept)`
    : 'No earlier saved state of the loaded drawing';
}

/** Fetch the roots, then every opened folder (and the loaded drawing's), so the tree is current. */
async function refreshTrees() {
  const wanted = new Set(view.expanded);
  if (state.current) wanted.add(key(state.current.root, dirname(state.current.path)));
  await Promise.all([...wanted].map(async (k) => {
    const i = k.indexOf(':');
    const root = k.slice(0, i), path = k.slice(i + 1);
    const f = rootOf(root);
    if (!f) return;
    try { state.trees.set(k, await api(`/api/tree?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`)); } catch (e) { state.trees.set(k, { error: e.message }); }
  }));
}

async function refreshList() {
  state.folders = await api('/api/folders');
  if (!view.expanded) view.expanded = new Set(state.folders.map((f) => key(f.id, '')));
  const known = new Set(state.folders.map((f) => f.id));
  view.expanded = new Set([...view.expanded].filter((k) => known.has(k.slice(0, k.indexOf(':')))));
  if (view.selected && !known.has(view.selected.root)) view.selected = null;
  if (!view.selected && state.current && known.has(state.current.root)) view.selected = { root: state.current.root, path: dirname(state.current.path) };
  if (!view.selected && state.folders.length) view.selected = { root: state.folders[0].id, path: '' };
  saveView();
  state.trees.clear();
  await refreshTrees();
  renderTree();
}

async function attachFolder() {
  const recent = state.config.recent ?? [];
  const list = recent.length ? `\n\nRecently detached (type its number to attach it again):\n${recent.map((p, i) => `${i + 1}. ${p}`).join('\n')}` : '';
  const answer = prompt(`Attach a folder (absolute path, e.g. /home/me/repo/docs/drawings):${list}`);
  if (answer === null || !answer.trim()) return;
  const picked = /^\d+$/.test(answer.trim()) ? recent[Number(answer.trim()) - 1] : undefined;
  try {
    const res = await api('/api/folders/attach', { path: picked ?? answer.trim() });
    state.config = await api('/api/config');
    view.expanded = new Set([...(view.expanded ?? []), key(res.folder.id, '')]);
    saveView();
    say(`Attached ${res.folder.path}`);
    await refreshList();
  } catch (e) { fail('Attach', e); }
}

async function detach(f) {
  if (!confirm(`Detach ${f.path} from the sidebar?\n\nIts files stay on disk; attach it again any time.`)) return;
  try {
    const res = await api('/api/folders/detach', { id: f.id });
    state.config.recent = res.recent;
    say(`Detached ${f.path}`);
    await refreshList();
  } catch (e) { fail('Detach', e); }
}

async function mkdir(f, path) {
  const name = prompt(`New folder in ${path || f.name}:`);
  if (name === null || !name.trim()) return;
  try {
    await api('/api/mkdir', { root: f.id, path: join(path, name.trim()) });
    view.expanded.add(key(f.id, path));
    say(`Created ${join(path, name.trim())}`);
    await refreshList();
  } catch (e) { say(`New folder failed: ${e.message}`, true); }
}

async function move(from, to) {
  try {
    const res = await api('/api/move', { from, to });
    if (!res.moved) return;
    state.current = res.current;
    view.expanded.add(key(to.root, to.dir));
    saveView();
    say(`Moved ${where(from)} to ${where({ root: res.root, path: res.path })}`);
    await refreshList();
  } catch (e) { say(`Move failed: ${e.message}`, true); }
}

// ---- Status, load, save, revert ----------------------------------------------------------------------------------

async function refreshStatus() {
  try {
    const s = await api('/api/status');
    const changed = JSON.stringify(s.current) !== JSON.stringify(state.current);
    state.current = s.current;
    state.dirty = s.dirty === true;
    const badge = $('dirty');
    if (s.canvas !== 'ok') { badge.textContent = 'Canvas offline'; badge.className = 'badge offline'; badge.title = s.error ?? ''; }
    else if (state.dirty) { badge.textContent = '● Unsaved changes'; badge.className = 'badge dirty'; badge.title = ''; }
    else { badge.textContent = 'Saved'; badge.className = 'badge clean'; badge.title = ''; }
    // A background PNG render failed: say so once per failure.
    const pngError = s.png?.error ? `No .png for ${where(s.png.error)}: ${s.png.error.error}` : null;
    if (pngError && pngError !== state.pngError) say(pngError, true);
    state.pngError = pngError;
    if (changed) { await refreshTrees(); renderTree(); }
  } catch (e) { say(`Status failed: ${e.message}`, true); }
}

// Unsaved changes are saved by the server first (into the loaded drawing, or tmp/); a refused save stops the load.
async function load(root, path) {
  try {
    const res = await api('/api/load', { root, path });
    state.current = res.current;
    select(root, dirname(path));
    const a = res.autosaved;
    const note = !a ? '' : `. Your changes were saved to ${where(a)} first${a.path.startsWith('tmp/') ? '' : ' (to undo: load it and press Revert)'}`;
    say(`Loaded ${where(res.current)} (${res.elementCount} elements)${note}`);
    await refreshList();
    await refreshStatus();
  } catch (e) { fail('Load', e); }
}

async function save(ev) {
  ev.preventDefault();
  const sel = view.selected;
  if (!sel || !rootOf(sel.root)) return say('Save failed: pick a folder in the sidebar first (or attach one)', true);
  const versioned = ev.submitter?.dataset.action === 'version';
  try {
    // The PNG renders after the response (docs/specs/2026-11-19-png-off-the-switch-path.md); a failure shows via status.
    const res = await api('/api/save', { root: sel.root, dir: sel.path, label: $('save-label').value, versioned, png: 'background' });
    state.current = res.current;
    $('save-label').value = '';
    view.expanded.add(key(sel.root, sel.path));
    await refreshList();
    const png = res.png === 'pending' ? ' (.png rendering)' : res.png ? ' and its .png' : ` (no .png: ${res.pngError})`;
    say(`Saved ${where(res.current)}${png}`, !res.png);
    await refreshStatus();
  } catch (e) { fail('Save', e); }
}

async function revert() {
  const d = currentDrawing();
  if (!d?.backups) return;
  const which = where(state.current);
  const note = state.dirty ? 'Your unsaved changes are dropped from the drawing (a copy is kept in the hub\'s backups folder).' : 'The current file is kept in the hub\'s backups folder.';
  if (!confirm(`Revert ${which} to its ${state.dirty ? 'last' : 'previous'} saved state?\n\n${note}`)) return;
  try {
    const res = await api('/api/revert', state.current);
    const n = res.remaining;
    say(`Reverted ${where(res.current)} (${n} earlier state${n === 1 ? '' : 's'} left)`);
    await refreshList();
    await refreshStatus();
  } catch (e) { fail('Revert', e); }
}

async function syncFolder(f, path, answered = []) {
  const label = path ? basename(path) : f.name;
  say(`Syncing ${label}…`);
  try {
    const res = await api('/api/sync', { root: f.id, path, confirm: answered });
    if (res.needsConfirm) {
      return confirm(`Commit and push ${label} on branch ${res.branch}?`) ? syncFolder(f, path, [...answered, res.needsConfirm]) : say(`Sync of ${label} cancelled; nothing changed`);
    }
    const notUpdated = res.notUpdated ? `; checkout not updated: ${res.notUpdated}` : '';
    if (res.nothing) { say(`Nothing to sync in ${label}${res.fastForwarded ? ` (checkout updated: ${res.fastForwarded} commit(s) pulled)` : ''}${notUpdated}`); return refreshList(); } // a fast-forward may have brought new files
    const pulled = res.fastForwarded ? `; checkout updated (${res.fastForwarded} commit(s) pulled)` : notUpdated;
    if (res.noUpstream) say(`Committed "${res.message}" on ${res.branch} (${res.sha}), no upstream branch: not pushed${pulled}`);
    else if (!res.pushed) fail('Push', new Error(`Committed "${res.message}" (${res.sha}), but the push failed${pulled}:\n${res.pushError}`));
    else {
      const extra = res.onlyDrawings ? `. Only the drawings went up${res.keptLocal ? `; your ${res.keptLocal} other local commit(s) stay unpushed` : ''}. Run "git pull --rebase" on ${res.branch} before you push it yourself.` : '';
      say(`Synced: "${res.message}" (${res.sha}) pushed to ${res.branch}${pulled}${extra}`);
    }
    await refreshList();
  } catch (e) { fail('Sync', e); }
}

async function rename(root, d) {
  const next = prompt(`Rename ${d.file} to (without .excalidraw):`, d.base);
  if (next === null || next.trim() === '' || next.trim() === d.base) return;
  try {
    const res = await api('/api/rename', { root, path: d.path, newBase: next.trim() });
    state.current = res.current;
    say(`Renamed to ${where(res)}`);
    await refreshList();
  } catch (e) { say(`Rename failed: ${e.message}`, true); }
}

async function remove(root, d) {
  const sync = rootOf(root)?.sync ? ' Git history keeps committed versions.' : '';
  if (!confirm(`Delete ${where({ root, path: d.path })} (and its .png, if there is one)?${sync}`)) return;
  try {
    const res = await api('/api/delete', { root, path: d.path });
    state.current = res.current;
    say(`Deleted ${where({ root, path: d.path })}`);
    await refreshList();
  } catch (e) { say(`Delete failed: ${e.message}`, true); }
}

// ---- Layout: resize, hide ----------------------------------------------------------------------------------------

const clampWidth = (w) => Math.max(W_MIN, Math.min(w, Math.max(W_MIN, window.innerWidth * 0.6)));
function applyLayout() {
  $('sidebar').style.width = `${clampWidth(Number(view.width) || W_DEFAULT)}px`;
  document.body.classList.toggle('sidebar-hidden', view.hidden === true);
}
const toggleSidebar = () => { view.hidden = !view.hidden; saveView(); applyLayout(); };

// The shield goes up on mousedown, so the iframe never swallows the drag. It also swallows the click, so a double-click on
// the handle is counted here: two releases without movement within 400 ms.
let lastClick = 0;
$('resizer').addEventListener('mousedown', (ev) => {
  ev.preventDefault();
  $('shield').hidden = false;
  $('resizer').classList.add('dragging');
  let moved = false;
  const move = (e) => { moved = true; view.width = clampWidth(e.clientX - $('sidebar').getBoundingClientRect().left); applyLayout(); };
  const stop = () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', stop);
    $('shield').hidden = true;
    $('resizer').classList.remove('dragging');
    if (!moved && Date.now() - lastClick < 400) view.width = W_DEFAULT;
    lastClick = moved ? 0 : Date.now();
    saveView();
    applyLayout();
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', stop);
});
$('toggle-sidebar').addEventListener('click', toggleSidebar);
document.addEventListener('keydown', (ev) => { if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && ev.key.toLowerCase() === 'b') { ev.preventDefault(); toggleSidebar(); } });
window.addEventListener('resize', applyLayout);

window.addEventListener('beforeunload', (ev) => { if (state.dirty) { ev.preventDefault(); ev.returnValue = ''; } });
$('save-form').addEventListener('submit', save);
$('revert').addEventListener('click', revert);
$('add-folder').addEventListener('click', attachFolder);
$('collapse-all').addEventListener('click', () => { view.expanded = new Set(); saveView(); renderTree(); });

applyLayout();
state.config = await api('/api/config');
$('canvas').src = state.config.canvasUrl;
state.current = (await api('/api/status')).current; // so the first list can select the loaded drawing's folder
await refreshList();
await refreshStatus();
setInterval(refreshStatus, 2000);
