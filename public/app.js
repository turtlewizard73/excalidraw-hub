// Hub page: sidebar of projects/drawings, canvas iframe, save/rename/delete, unsaved badge.
const $ = (id) => document.getElementById(id);
let state = { projects: [], current: null, dirty: false };

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

const isCurrent = (p, d) => state.current && state.current.project === p && state.current.file === d.file;

function render() {
  const box = $('projects');
  box.replaceChildren();
  if (!state.projects.length) box.textContent = 'No projects in the drawings folder.';
  for (const p of state.projects) {
    const det = document.createElement('details');
    det.open = true;
    det.dataset.project = p.name;
    const sum = document.createElement('summary');
    sum.textContent = `${p.name} (${p.drawings.length})`;
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

async function load(project, file) {
  try {
    let res;
    try { res = await api('/api/load', { project, file }); } catch (e) {
      if (e.status !== 409 || !e.data?.dirty) throw e;
      if (!confirm('The canvas has unsaved changes. Loading replaces them. Continue?')) return;
      res = await api('/api/load', { project, file, force: true });
    }
    state.current = res.current;
    $('save-project').value = project;
    say(`Loaded ${project}/${file} (${res.elementCount} elements)`);
    render();
    await refreshStatus();
  } catch (e) { say(`Load failed: ${e.message}`, true); }
}

async function save(ev) {
  ev.preventDefault();
  const project = $('save-project').value.trim();
  try {
    const res = await api('/api/save', { project, label: $('save-label').value, versioned: $('save-versioned').checked });
    state.current = res.current;
    $('save-label').value = '';
    say(`Saved ${res.current.project}/${res.current.file}`);
    await refreshList();
    await refreshStatus();
  } catch (e) { say(`Save failed: ${e.message}`, true); }
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
$('save-versioned').addEventListener('change', (ev) => { $('save-button').textContent = ev.target.checked ? 'Save new version' : 'Save'; });

const config = await api('/api/config');
$('canvas').src = config.canvasUrl;
await refreshList();
await refreshStatus();
if (state.current) $('save-project').value = state.current.project;
setInterval(refreshStatus, 2000);
