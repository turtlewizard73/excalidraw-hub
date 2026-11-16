import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWorkspace } from '../src/workspace.js';

let tmp, home, primary, file;
const quiet = () => {};
const make = (extra = {}) => createWorkspace({ primary: { path: primary }, backupsDir: path.join(tmp, 'backups'), file, foldersRoot: home, log: quiet, ...extra });

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hub-ws-')));
  home = path.join(tmp, 'home');
  primary = path.join(home, 'parent', 'docs', 'drawings');
  for (const d of [primary, path.join(home, 'a', 'docs', 'drawings'), path.join(home, 'b', 'docs', 'drawings'), path.join(tmp, 'outside')]) await fs.mkdir(d, { recursive: true });
  file = path.join(tmp, 'ws', 'workspace.json');
});

test('attach saves to the file; a new workspace reopens the same folders in order; detach removes', async () => {
  const ws = await make();
  assert.deepEqual(ws.folders().map((f) => f.id), ['main']);
  const a = await ws.attach(path.join(home, 'a', 'docs', 'drawings'));
  const b = await ws.attach(path.join(home, 'b', 'docs', 'drawings') + '/');
  assert.match(a.id, /^f-[0-9a-f]{12}$/);
  assert.equal(a.name, 'a', 'named after the repo of <repo>/docs/drawings');
  assert.equal(ws.get('main').name, 'parent');
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { version: 1, folders: [a.path, b.path] });

  const again = await make();
  assert.deepEqual(again.folders().map((f) => f.id), ['main', a.id, b.id], 'same ids after a restart');
  await again.detach(a.id);
  assert.deepEqual((await make()).folders().map((f) => f.id), ['main', b.id]);
  assert.equal(again.get(b.id).path, b.path);
  assert.throws(() => again.get(a.id), /unknown folder/);
});

test('attach refuses: relative, missing, a file, outside the root, the primary, a duplicate (also via symlink)', async () => {
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
  await refused(primary, 409, /primary/);
  await ws.attach(path.join(home, 'a'));
  await refused(path.join(home, 'link'), 409, /already attached/);
  await assert.rejects(ws.detach('main'), /cannot be detached/);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')).folders, [path.join(home, 'a')]);
});

test('no FOLDERS_ROOT: attaching is off', async () => {
  const ws = await make({ foldersRoot: null });
  assert.equal(ws.canAttach, false);
  await assert.rejects(ws.attach(path.join(home, 'a')), (e) => e.status === 403);
});

test('a broken file is kept as .bad and the hub starts with no attached folders; a missing folder stays listed', async () => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, '{not json');
  assert.deepEqual((await make()).folders().map((f) => f.id), ['main']);
  assert.equal(await fs.readFile(`${file}.bad`, 'utf8'), '{not json');

  await fs.writeFile(file, JSON.stringify({ version: 1, folders: [path.join(home, 'gone'), 'relative', path.join(home, 'gone')] }));
  const ws = await make();
  assert.deepEqual(ws.folders().map((f) => f.path), [primary, path.join(home, 'gone')], 'relative and duplicate entries are skipped');
});

test('attached folders have their own backups under _folders/<id>', async () => {
  const ws = await make();
  const a = await ws.attach(path.join(home, 'a'));
  assert.equal(a.backups.root, path.join(tmp, 'backups', '_folders', a.id));
  assert.equal(ws.get('main').backups.root, path.join(tmp, 'backups'));
  assert.equal(a.git, null);
});

test('saved entries get the same checks as attach: outside the root, the primary, nested, or no root are not opened', async () => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const a = path.join(home, 'a');
  await fs.writeFile(file, JSON.stringify({ version: 1, folders: [path.join(tmp, 'outside'), primary, a, path.join(a, 'docs'), path.join(home, 'gone')] }));
  const ws = await make();
  assert.deepEqual(ws.folders().map((f) => f.path), [primary, a, path.join(home, 'gone')]);
  assert.deepEqual((await make({ foldersRoot: null })).folders().map((f) => f.id), ['main'], 'narrowed to nothing: nothing opened');
});

test('the primary is recognised by identity (Docker: same folder at another path) and nesting is refused', async () => {
  // A bind mount looks like this to the hub: the same directory at a second path. A hard link to a dir is impossible,
  // so simulate it by making the primary a path that resolves elsewhere while FOLDERS_ROOT sees the real folder.
  const real = path.join(home, 'parent', 'docs', 'drawings');
  const mountPoint = path.join(tmp, 'repo');
  await fs.symlink(path.join(home, 'parent'), mountPoint);
  const ws = await make({ primary: { path: path.join(mountPoint, 'docs', 'drawings') } });
  await assert.rejects(ws.attach(real), (e) => e.status === 409 && /primary/.test(e.message));
  await assert.rejects(ws.attach(path.join(home, 'parent')), (e) => e.status === 409 && /primary/.test(e.message), 'contains the primary');
  await ws.attach(path.join(home, 'a'));
  await assert.rejects(ws.attach(path.join(home, 'a', 'docs')), (e) => e.status === 409 && /overlaps/.test(e.message));
});

test('a workspace file that exists but cannot be read is never written over', async () => {
  if (process.getuid?.() === 0) return; // root reads anything; covered where tests run as a user
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ version: 1, folders: [path.join(home, 'a')] }));
  await fs.chmod(file, 0o000);
  const ws = await make();
  await assert.rejects(ws.attach(path.join(home, 'b')), (e) => e.status === 500);
  await fs.chmod(file, 0o600);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')).folders, [path.join(home, 'a')]);
});
