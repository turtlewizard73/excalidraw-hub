import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWorkspace } from '../src/workspace.js';

let tmp, home, file;
const quiet = () => {};
const make = (extra = {}) => createWorkspace({ backupsDir: path.join(tmp, 'backups'), file, foldersRoot: home, log: quiet, ...extra });
const state = async () => JSON.parse(await fs.readFile(file, 'utf8'));
const initRepo = (dir) => execFileSync('git', ['init', '-q', '-b', 'dev', dir]);

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hub-ws-')));
  home = path.join(tmp, 'home');
  for (const d of [path.join(home, 'a', 'docs', 'drawings'), path.join(home, 'b', 'docs', 'drawings'), path.join(tmp, 'outside')]) await fs.mkdir(d, { recursive: true });
  file = path.join(tmp, 'ws', 'hub.json');
});

test('no primary: a fresh workspace has zero roots and that is valid', async () => {
  const ws = await make();
  assert.deepEqual(ws.folders(), []);
  assert.deepEqual(ws.recent(), []);
  assert.equal(ws.canAttach, true);
  assert.throws(() => ws.get('main'), /unknown folder/);
});

test('attach saves a v2 state file; a new workspace reopens the same roots in order; detach removes and fills recent', async () => {
  const ws = await make();
  const a = await ws.attach(path.join(home, 'a', 'docs', 'drawings'));
  const b = await ws.attach(path.join(home, 'b', 'docs', 'drawings') + '/');
  assert.match(a.id, /^f-[0-9a-f]{12}$/);
  assert.equal(a.name, 'a', 'named after the repo of <repo>/docs/drawings');
  assert.deepEqual(await state(), { version: 2, folders: [{ path: a.path }, { path: b.path }], recent: [] });

  const again = await make();
  assert.deepEqual(again.folders().map((f) => f.id), [a.id, b.id], 'same ids after a restart');
  await again.detach(a.id);
  assert.deepEqual(again.recent(), [a.path]);
  assert.deepEqual(await state(), { version: 2, folders: [{ path: b.path }], recent: [a.path] });
  const third = await make();
  assert.deepEqual(third.folders().map((f) => f.id), [b.id]);
  assert.deepEqual(third.recent(), [a.path], 'recent survives a restart');
  assert.throws(() => again.get(a.id), /unknown folder/);
  await assert.rejects(again.detach(a.id), (e) => e.status === 404);
});

test('recent: newest first, no duplicates, at most 10; attaching a path takes it off the list', async () => {
  const dirs = [];
  for (let i = 0; i < 12; i++) { const d = path.join(home, `r${i}`); await fs.mkdir(d); dirs.push(d); }
  const ws = await make();
  for (const d of dirs) await ws.detach((await ws.attach(d)).id);
  assert.deepEqual(ws.recent(), dirs.slice(2).reverse());
  const f = await ws.attach(dirs[5]);
  assert.ok(!ws.recent().includes(dirs[5]));
  await ws.detach(f.id);
  await ws.detach((await ws.attach(dirs[6])).id);
  assert.equal(ws.recent()[0], dirs[6]);
  assert.equal(new Set(ws.recent()).size, ws.recent().length);
});

test('attach refuses: relative, missing, a file, outside the root, a duplicate (also via symlink), overlaps', async () => {
  const ws = await make();
  await fs.writeFile(path.join(home, 'plain.txt'), 'x');
  await fs.symlink(path.join(home, 'a'), path.join(home, 'link'));
  await fs.symlink(path.join(tmp, 'outside'), path.join(home, 'escape'));
  const refused = async (p, status, re) => assert.rejects(ws.attach(p), (e) => e.status === status && re.test(e.message));
  await refused('a/docs', 400, /absolute path/);
  await refused(path.join(home, 'nope'), 404, /does not exist/);
  await refused(path.join(home, 'plain.txt'), 400, /not a folder/);
  await refused(path.join(tmp, 'outside'), 403, /outside/);
  await refused(path.join(home, 'escape'), 403, /outside/);
  await ws.attach(path.join(home, 'a', 'docs'));
  await refused(path.join(home, 'link', 'docs'), 409, /already attached/);
  await refused(path.join(home, 'a', 'docs', 'drawings'), 409, /overlaps/);
  await refused(path.join(home, 'a'), 409, /overlaps/);
  assert.deepEqual((await state()).folders, [{ path: path.join(home, 'a', 'docs') }]);
});

test('a v1 file, a broken file or a bad shape is kept as .bad and the hub starts empty; a missing folder stays listed', async () => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  for (const bad of ['{not json', JSON.stringify({ version: 1, folders: [path.join(home, 'a')] }), JSON.stringify({ version: 2, folders: ['/x'] })]) {
    await fs.writeFile(file, bad);
    assert.deepEqual((await make()).folders(), []);
    assert.equal(await fs.readFile(`${file}.bad`, 'utf8'), bad);
  }
  const gone = path.join(home, 'gone');
  await fs.writeFile(file, JSON.stringify({ version: 2, folders: [{ path: gone }, { path: 'relative' }, { path: gone }], recent: ['/r'] }));
  const ws = await make();
  assert.deepEqual(ws.folders().map((f) => f.path), [gone], 'relative and duplicate entries are skipped');
  assert.equal(ws.folders()[0].sync, false);
  assert.deepEqual(ws.recent(), ['/r']);
});

test('backups live under BACKUPS_DIR/<id>', async () => {
  const ws = await make();
  const a = await ws.attach(path.join(home, 'a'));
  assert.equal(a.backups.root, path.join(tmp, 'backups', a.id));
});

test('saved entries get the same checks as attach: outside the root, nested, or duplicate are not opened', async () => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const a = path.join(home, 'a');
  await fs.writeFile(file, JSON.stringify({ version: 2, folders: [path.join(tmp, 'outside'), a, path.join(a, 'docs'), path.join(home, 'gone')].map((p) => ({ path: p })), recent: [] }));
  assert.deepEqual((await make()).folders().map((f) => f.path), [a, path.join(home, 'gone')]);
});

test('repo detection: a root in a repo gets sync, another root in the same repo shares its git client, a plain root has sync off with git\'s reason', async () => {
  initRepo(path.join(home, 'a'));
  await fs.mkdir(path.join(home, 'a', 'other'));
  const ws = await make();
  const r1 = await ws.attach(path.join(home, 'a', 'docs', 'drawings'));
  const r2 = await ws.attach(path.join(home, 'a', 'other'));
  const plain = await ws.attach(path.join(home, 'b'));
  assert.deepEqual([r1.sync, r2.sync, plain.sync], [true, true, false]);
  assert.equal(r1.repoDir, path.join(home, 'a'));
  assert.equal(r1.git, r2.git, 'one client, one queue per repo');
  assert.equal(plain.git, null);
  assert.match(plain.syncError, /not a git repository/);
  assert.equal(r1.syncError, undefined);
  assert.equal((await make()).folders().find((f) => f.id === r1.id).sync, true, 'detected again at start');
});

test('a root that is itself a repo top level syncs; a repoTop that cannot see the repo turns sync off with its reason', async () => {
  initRepo(path.join(home, 'b'));
  const ws = await make();
  assert.equal((await ws.attach(path.join(home, 'b'))).sync, true);
  const blind = await make({ repoTop: async () => ({ ok: false, reason: 'cannot see it' }), file: null });
  const f = await blind.attach(path.join(home, 'a'));
  assert.deepEqual([f.sync, f.syncError], [false, 'cannot see it']);
});

test('a state file that exists but cannot be read is never written over', async () => {
  if (process.getuid?.() === 0) return; // root reads anything; covered where tests run as a user
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ version: 2, folders: [{ path: path.join(home, 'a') }], recent: [] }));
  await fs.chmod(file, 0o000);
  const ws = await make();
  await assert.rejects(ws.attach(path.join(home, 'b')), (e) => e.status === 500);
  await fs.chmod(file, 0o600);
  assert.deepEqual((await state()).folders, [{ path: path.join(home, 'a') }]);
});
