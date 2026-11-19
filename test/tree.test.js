import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBackups } from '../src/backups.js';
import { createStore } from '../src/store.js';
import { listDir } from '../src/tree.js';

let tmp, root, folder;
const write = async (rel, body = '{"elements":[]}') => { await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true }); await fs.writeFile(path.join(root, rel), body); };
const mkFolder = (extra = {}) => ({ path: root, store: createStore(root), backups: createBackups(path.join(tmp, 'bk')), repoDir: null, ...extra });

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hub-tree-')));
  root = path.join(tmp, 'root');
  await write('top_v0.excalidraw'); await write('top_v1_x.excalidraw'); await write('top_v1_x.png', 'png'); await write('loose.excalidraw'); await write('notes.txt', 'x');
  await write('sub/a/deep_v0.excalidraw'); await write('.hidden/h.excalidraw'); await write('node_modules/m/m.excalidraw'); await write('Beta/b.excalidraw');
  folder = mkFolder();
});

test('lists subfolders and drawings of one folder only, lazily; no dot-folders, node_modules, other files or pngs', async () => {
  const top = await listDir(folder, '');
  assert.deepEqual(top.dirs, [{ name: 'Beta', path: 'Beta' }, { name: 'sub', path: 'sub' }]);
  assert.deepEqual(top.drawings.map((d) => [d.file, d.path, d.version, d.label, d.latest]), [
    ['loose.excalidraw', 'loose.excalidraw', null, null, false],
    ['top_v1_x.excalidraw', 'top_v1_x.excalidraw', 1, 'x', true],
    ['top_v0.excalidraw', 'top_v0.excalidraw', 0, null, false],
  ]);
  const sub = await listDir(folder, 'sub');
  assert.deepEqual(sub.dirs, [{ name: 'a', path: 'sub/a' }]);
  assert.deepEqual(sub.drawings, []);
  assert.deepEqual((await listDir(folder, 'sub/a')).drawings.map((d) => d.path), ['sub/a/deep_v0.excalidraw']);
});

test('several families in one folder each get their own latest; backup counts are per drawing', async () => {
  await write('two/a_v0.excalidraw'); await write('two/a_v2.excalidraw'); await write('two/b_v0.excalidraw');
  await folder.backups.save('two/a_v2.excalidraw', Buffer.from('1'));
  await folder.backups.save('two/a_v2.excalidraw', Buffer.from('2'));
  const { drawings } = await listDir(folder, 'two');
  assert.deepEqual(drawings.map((d) => [d.file, d.latest, d.backups]), [['a_v2.excalidraw', true, 2], ['a_v0.excalidraw', false, 0], ['b_v0.excalidraw', true, 0]]);
});

test('a missing folder and a path escape throw', async () => {
  await assert.rejects(listDir(folder, 'nope'), { code: 'ENOENT' });
  await assert.rejects(listDir(folder, '../x'), { status: 400 });
});

test('in a git repo, ignored folders are hidden (one check-ignore call); tracked or unignored ones stay; non-repo roots only use the fixed list', async () => {
  execFileSync('git', ['init', '-q', '-b', 'dev', root]);
  await write('.gitignore', 'build/\nsub/a/\n');
  await write('build/x.excalidraw'); await write('keep/k.excalidraw');
  const repoFolder = mkFolder({ repoDir: root });
  assert.deepEqual((await listDir(repoFolder, '')).dirs.map((d) => d.name), ['Beta', 'keep', 'sub']);
  assert.deepEqual((await listDir(repoFolder, 'sub')).dirs, [], 'a nested ignored path is found with its repo-relative name');

  let calls = 0;
  const spy = async (...a) => { calls++; return new Set(); };
  await listDir(repoFolder, '', { ignored: spy });
  assert.equal(calls, 1);
  assert.deepEqual((await listDir(folder, '')).dirs.map((d) => d.name), ['Beta', 'build', 'keep', 'sub'], 'repoDir null: the fixed list only');
});

test('a root below the repo top asks git with repo-relative paths', async () => {
  execFileSync('git', ['init', '-q', '-b', 'dev', tmp]);
  await fs.writeFile(path.join(tmp, '.gitignore'), 'root/sub/\n');
  const f = mkFolder({ repoDir: tmp });
  assert.deepEqual((await listDir(f, '')).dirs.map((d) => d.name), ['Beta']);
});
