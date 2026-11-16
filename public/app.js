// Hub page: sidebar of folders/projects/drawings (attach, detach), canvas iframe, save/revert/rename/delete/sync, unsaved badge.
const $ = (id) => document.getElementById(id);
let state = { folders: [], current: null, dirty: false, config: {} };

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

const isCurrent = (f, p, d) => state.current && state.current.folder === f && state.current.project === p && state.current.file === d.file;
const folderById = (id) => state.folders.find((f) => f.id === id);
const currentDrawing = () => state.current && folderById(state.current.folder)?.projects.find((p) => p.name === state.current.project)?.drawings.find((d) => d.file === state.current.file);
/** "project/file", prefixed with the folder name when it is not the primary folder. */
const where = (folder, project, file, sep = '/') => `${folderById(folder)?.primary === false ? `${folderById(folder).name}: ` : ''}${project}${sep}${file}`;
const button = (className, textContent, title, action, onclick) => {
  const b = Object.assign(document.createElement('button'), { className, textContent, title });
  b.dataset.action = action;
  b.onclick = (ev) => { ev.preventDefault(); ev.stopPropagation(); onclick(); };
  return b;
};

function render() {
  const box = $('projects');
  box.replaceChildren();
  $('add-folder').hidden = !state.config.canAttach;
  for (const f of state.folders) {
    const sec = document.createElement('section');
    sec.className = 'folder';
    sec.dataset.folder = f.id;
    const head = document.createElement('h2');
    head.title = f.path;
    head.append(Object.assign(document.createElement('span'), { className: 'name', textContent: f.primary ? `${f.name} (primary)` : f.name }));
    if (!f.primary) head.append(button('act', '✕', `Detach ${f.path} (files stay on disk)`, 'detach', () => detach(f)));
    sec.append(head);
    if (f.error) sec.append(Object.assign(document.createElement('p'), { className: 'error', textContent: f.error }));
    else if (!f.projects.length) sec.append(Object.assign(document.createElement('p'), { className: 'empty', textContent: 'No projects in this folder yet.' }));
    renderProjects(sec, f);
    box.append(sec);
  }
  const opts = state.folders.map((f) => Object.assign(document.createElement('option'), { value: f.id, textContent: f.name, title: f.path }));
  const chosen = $('save-folder').value;
  $('save-folder').replaceChildren(...opts);
  $('save-folder').value = folderById(chosen) ? chosen : 'main';
  $('save-folder').hidden = state.folders.length < 2;
  updateProjectNames();
  $('current').textContent = state.current ? where(state.current.folder, state.current.project, state.current.file, ' / ') : 'No drawing loaded';
  const loaded = currentDrawing();
  $('revert').disabled = !loaded?.backups;
  $('revert').title = loaded?.backups
    ? `Go back to the previous saved state of ${loaded.file} (${loaded.backups} kept)`
    : 'No earlier saved state of the loaded drawing';
}

/** Project suggestions for the save form: those of the folder it saves into. */
function updateProjectNames() {
  const f = folderById($('save-folder').value);
  $('project-names').replaceChildren(...(f?.projects ?? []).map((p) => Object.assign(document.createElement('option'), { value: p.name })));
}

function renderProjects(box, f) {
  for (const p of f.projects) {
    const det = document.createElement('details');
    det.open = true;
    det.dataset.project = p.name;
    const sum = document.createElement('summary');
    sum.append(Object.assign(document.createElement('span'), { className: 'name', textContent: `${p.name} (${p.drawings.length})` }));
    if (f.sync) sum.append(button('act', '⟳', `Commit ${p.name} to git (pushed only on ${state.config.syncBranch})`, 'sync', () => syncProject(p.name)));
    const ul = document.createElement('ul');
    for (const d of p.drawings) {
      const li = document.createElement('li');
      li.dataset.testid = 'drawing';
      li.dataset.file = d.file;
      if (isCurrent(f.id, p.name, d)) li.classList.add('active');
      const open = document.createElement('button');
      open.className = 'open';
      open.title = `Load ${p.name}/${d.file} from ${f.path}`;
      open.textContent = d.base;
      open.onclick = () => load(f.id, p.name, d.file);
      li.append(open);
      if (d.latest) li.append(Object.assign(document.createElement('span'), { className: 'tag', textContent: 'latest' }));
      else if (d.version === null) li.append(Object.assign(document.createElement('span'), { className: 'tag plain', textContent: 'unversioned' }));
      const ren = Object.assign(document.createElement('button'), { className: 'act', textContent: '✎', title: 'Rename' });
      ren.dataset.action = 'rename';
      ren.onclick = () => rename(f.id, p.name, d);
      const del = Object.assign(document.createElement('button'), { className: 'act', textContent: '🗑', title: 'Delete' });
      del.dataset.action = 'delete';
      del.onclick = () => remove(f.id, p.name, d);
      li.append(ren, del);
      ul.append(li);
    }
    det.append(sum, ul);
    box.append(det);
  }
}

async function refreshList() {
  state.folders = (await api('/api/projects')).folders;
  render();
}

async function attachFolder() {
  const p = prompt('Attach a folder that holds project folders (absolute path, e.g. /home/me/repo/docs/drawings):');
  if (p === null || !p.trim()) return;
  try {
    const res = await api('/api/folders/attach', { path: p.trim() });
    say(`Attached ${res.folder.path}`);
    await refreshList();
  } catch (e) { fail('Attach', e); }
}

async function detach(f) {
  if (!confirm(`Detach ${f.path} from the sidebar?\n\nIts files stay on disk; attach it again any time.`)) return;
  try {
    await api('/api/folders/detach', { id: f.id });
    say(`Detached ${f.path}`);
    await refreshList();
  } catch (e) { fail('Detach', e); }
}

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
    if (changed) render();
  } catch (e) { say(`Status failed: ${e.message}`, true); }
}

// Unsaved changes are saved by the server first (into the loaded drawing, or tmp/); a refused save stops the load.
async function load(folder, project, file) {
  try {
    const res = await api('/api/load', { folder, project, file });
    state.current = res.current;
    $('save-folder').value = folder;
    $('save-project').value = project;
    const a = res.autosaved;
    const note = !a ? '' : `. Your changes were saved to ${where(a.folder, a.project, a.file)} first${a.project === 'tmp' && a.folder === 'main' ? '' : ' (to undo: load it and press Revert)'}`;
    say(`Loaded ${where(folder, project, file)} (${res.elementCount} elements)${note}`);
    await refreshList();
    await refreshStatus();
  } catch (e) { fail('Load', e); }
}

async function save(ev) {
  ev.preventDefault();
  const project = $('save-project').value.trim();
  const versioned = ev.submitter?.dataset.action === 'version';
  try {
    const res = await api('/api/save', { folder: $('save-folder').value, project, label: $('save-label').value, versioned });
    state.current = res.current;
    $('save-label').value = '';
    await refreshList();
    say(`Saved ${where(res.current.folder, res.current.project, res.current.file)}${res.png ? ' and its .png' : ` (no .png: ${res.pngError})`}`, !res.png);
    await refreshStatus();
  } catch (e) { fail('Save', e); }
}

async function revert() {
  const d = currentDrawing();
  if (!d?.backups) return;
  const which = where(state.current.folder, state.current.project, d.file);
  const note = state.dirty ? 'Your unsaved changes are dropped from the drawing (a copy is kept in the hub\'s backups folder).' : 'The current file is kept in the hub\'s backups folder.';
  if (!confirm(`Revert ${which} to its ${state.dirty ? 'last' : 'previous'} saved state?\n\n${note}`)) return;
  try {
    const res = await api('/api/revert', { folder: state.current.folder, project: state.current.project, file: d.file });
    const n = res.remaining;
    say(`Reverted ${where(res.current.folder, res.current.project, res.current.file)} (${n} earlier state${n === 1 ? '' : 's'} left)`);
    await refreshList();
    await refreshStatus();
  } catch (e) { fail('Revert', e); }
}

async function syncProject(project, answered = []) {
  say(`Syncing ${project}…`);
  try {
    const res = await api('/api/sync', { project, confirm: answered });
    if (res.needsConfirm) {
      const question = `parent repo is on branch "${res.branch}", not "${res.syncBranch}".\n\nCommit ${project} on "${res.branch}" anyway? It will not be pushed.`;
      return confirm(question) ? syncProject(project, [...answered, res.needsConfirm]) : say(`Sync of ${project} cancelled; nothing changed`);
    }
    if (res.nothing) return say(`Nothing to sync in ${project}`);
    if (!res.push) return say(`Committed "${res.message}" on ${res.branch} (${res.sha}), not pushed`);
    if (!res.pushed) return fail('Push', new Error(`Committed "${res.message}" (${res.sha}), but the push failed:\n${res.pushError}`));
    const kept = res.keptLocal ? `; your ${res.keptLocal} other local commit(s) stay unpushed` : '';
    const extra = res.onlyDrawings
      ? `. Only the drawings went up${kept}. Run "git pull --rebase" on ${res.branch} before you push it yourself.`
      : '';
    say(`Synced: "${res.message}" (${res.sha}) pushed to ${res.branch}${extra}`);
  } catch (e) { fail('Sync', e); }
}

async function rename(folder, project, d) {
  const next = prompt(`Rename ${d.file} to (without .excalidraw):`, d.base);
  if (next === null || next.trim() === '' || next.trim() === d.base) return;
  try {
    const res = await api('/api/rename', { folder, project, file: d.file, newBase: next.trim() });
    state.current = res.current;
    say(`Renamed to ${where(folder, project, res.file)}`);
    await refreshList();
  } catch (e) { say(`Rename failed: ${e.message}`, true); }
}

async function remove(folder, project, d) {
  if (!confirm(`Delete ${where(folder, project, d.file)}${d.png ? ' and its .png' : ''}?${folderById(folder)?.sync ? ' Git history keeps committed versions.' : ''}`)) return;
  try {
    const res = await api('/api/delete', { folder, project, file: d.file });
    state.current = res.current;
    say(`Deleted ${where(folder, project, d.file)}`);
    await refreshList();
  } catch (e) { say(`Delete failed: ${e.message}`, true); }
}

window.addEventListener('beforeunload', (ev) => { if (state.dirty) { ev.preventDefault(); ev.returnValue = ''; } });
$('save-form').addEventListener('submit', save);
$('revert').addEventListener('click', revert);
$('add-folder').addEventListener('click', attachFolder);
$('save-folder').addEventListener('change', updateProjectNames);

state.config = await api('/api/config');
$('canvas').src = state.config.canvasUrl;
await refreshList();
await refreshStatus();
if (state.current) { $('save-folder').value = state.current.folder; $('save-project').value = state.current.project; updateProjectNames(); }
setInterval(refreshStatus, 2000);
