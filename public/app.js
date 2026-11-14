// Hub page: sidebar of projects/drawings, canvas iframe, save/revert/rename/delete/sync, unsaved badge.
const $ = (id) => document.getElementById(id);
let state = { projects: [], current: null, dirty: false, config: {} };

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

const isCurrent = (p, d) => state.current && state.current.project === p && state.current.file === d.file;
const currentDrawing = () => state.current && state.projects.find((p) => p.name === state.current.project)?.drawings.find((d) => d.file === state.current.file);

function render() {
  const box = $('projects');
  box.replaceChildren();
  if (!state.projects.length) box.textContent = 'No projects in the drawings folder.';
  for (const p of state.projects) {
    const det = document.createElement('details');
    det.open = true;
    det.dataset.project = p.name;
    const sum = document.createElement('summary');
    sum.append(Object.assign(document.createElement('span'), { className: 'name', textContent: `${p.name} (${p.drawings.length})` }));
    if (state.config.sync) {
      const sync = Object.assign(document.createElement('button'), { className: 'act', textContent: '⟳', title: `Commit ${p.name} to git (pushed only on ${state.config.syncBranch})` });
      sync.dataset.action = 'sync';
      sync.onclick = (ev) => { ev.preventDefault(); ev.stopPropagation(); syncProject(p.name); };
      sum.append(sync);
    }
    const ul = document.createElement('ul');
    for (const d of p.drawings) {
      const li = document.createElement('li');
      li.dataset.testid = 'drawing';
      li.dataset.file = d.file;
      if (isCurrent(p.name, d)) li.classList.add('active');
      const open = document.createElement('button');
      open.className = 'open';
      open.title = `Load ${p.name}/${d.file}`;
      open.textContent = d.base;
      open.onclick = () => load(p.name, d.file);
      li.append(open);
      if (d.latest) li.append(Object.assign(document.createElement('span'), { className: 'tag', textContent: 'latest' }));
      else if (d.version === null) li.append(Object.assign(document.createElement('span'), { className: 'tag plain', textContent: 'unversioned' }));
      const ren = Object.assign(document.createElement('button'), { className: 'act', textContent: '✎', title: 'Rename' });
      ren.dataset.action = 'rename';
      ren.onclick = () => rename(p.name, d);
      const del = Object.assign(document.createElement('button'), { className: 'act', textContent: '🗑', title: 'Delete' });
      del.dataset.action = 'delete';
      del.onclick = () => remove(p.name, d);
      li.append(ren, del);
      ul.append(li);
    }
    det.append(sum, ul);
    box.append(det);
  }
  $('project-names').replaceChildren(...state.projects.map((p) => Object.assign(document.createElement('option'), { value: p.name })));
  $('current').textContent = state.current ? `${state.current.project} / ${state.current.file}` : 'No drawing loaded';
  const loaded = currentDrawing();
  $('revert').disabled = !loaded?.backups;
  $('revert').title = loaded?.backups
    ? `Go back to the previous saved state of ${loaded.file} (${loaded.backups} kept)`
    : 'No earlier saved state of the loaded drawing';
}

async function refreshList() {
  state.projects = (await api('/api/projects')).projects;
  render();
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
async function load(project, file) {
  try {
    const res = await api('/api/load', { project, file });
    state.current = res.current;
    $('save-project').value = project;
    const a = res.autosaved;
    const note = !a ? '' : `. Your changes were saved to ${a.project}/${a.file} first${a.project === 'tmp' ? '' : ' (to undo: load it and press Revert)'}`;
    say(`Loaded ${project}/${file} (${res.elementCount} elements)${note}`);
    await refreshList();
    await refreshStatus();
  } catch (e) { fail('Load', e); }
}

async function save(ev) {
  ev.preventDefault();
  const project = $('save-project').value.trim();
  const versioned = ev.submitter?.dataset.action === 'version';
  try {
    const res = await api('/api/save', { project, label: $('save-label').value, versioned });
    state.current = res.current;
    $('save-label').value = '';
    say(`Saved ${res.current.project}/${res.current.file}${res.png ? ' and its .png' : ` (no .png: ${res.pngError})`}`, !res.png);
    await refreshList();
    await refreshStatus();
  } catch (e) { fail('Save', e); }
}

async function revert() {
  const d = currentDrawing();
  if (!d?.backups) return;
  const where = `${state.current.project}/${d.file}`;
  const note = state.dirty ? 'Your unsaved changes are dropped from the drawing (a copy is kept in the hub\'s backups folder).' : 'The current file is kept in the hub\'s backups folder.';
  if (!confirm(`Revert ${where} to its ${state.dirty ? 'last' : 'previous'} saved state?\n\n${note}`)) return;
  try {
    const res = await api('/api/revert', { project: state.current.project, file: d.file });
    const n = res.remaining;
    say(`Reverted ${res.current.project}/${res.current.file} (${n} earlier state${n === 1 ? '' : 's'} left)`);
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

async function rename(project, d) {
  const next = prompt(`Rename ${d.file} to (without .excalidraw):`, d.base);
  if (next === null || next.trim() === '' || next.trim() === d.base) return;
  try {
    const res = await api('/api/rename', { project, file: d.file, newBase: next.trim() });
    state.current = res.current;
    say(`Renamed to ${project}/${res.file}`);
    await refreshList();
  } catch (e) { say(`Rename failed: ${e.message}`, true); }
}

async function remove(project, d) {
  if (!confirm(`Delete ${project}/${d.file}${d.png ? ' and its .png' : ''}? Git history keeps committed versions.`)) return;
  try {
    const res = await api('/api/delete', { project, file: d.file });
    state.current = res.current;
    say(`Deleted ${project}/${d.file}`);
    await refreshList();
  } catch (e) { say(`Delete failed: ${e.message}`, true); }
}

window.addEventListener('beforeunload', (ev) => { if (state.dirty) { ev.preventDefault(); ev.returnValue = ''; } });
$('save-form').addEventListener('submit', save);
$('revert').addEventListener('click', revert);

state.config = await api('/api/config');
$('canvas').src = state.config.canvasUrl;
await refreshList();
await refreshStatus();
if (state.current) $('save-project').value = state.current.project;
setInterval(refreshStatus, 2000);
