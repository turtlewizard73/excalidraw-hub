import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBackups } from '../src/backups.js';

const tmpdir = () => fs.mkdtemp(path.join(os.tmpdir(), 'hub-bk-'));

test('keeps the newest N per drawing, newest() is the last saved, names stay distinct', async () => {
  const b = createBackups(await tmpdir(), 3);
  for (let i = 0; i < 5; i++) await b.save('p/p_v0.excalidraw', Buffer.from(`state ${i}`));
  assert.equal(await b.count('p/p_v0.excalidraw'), 3);
  assert.equal(String((await b.newest('p/p_v0.excalidraw')).bytes), 'state 4');
  assert.equal(await b.count('p/other.excalidraw'), 0);
  assert.equal(await b.newest('p/other.excalidraw'), null);
});

test('refuses traversal, empty segments, non-drawings and reserved folders; odd but harmless folder names are fine', async () => {
  const dir = await tmpdir();
  const b = createBackups(dir);
  for (const bad of ['../x.excalidraw', 'p/../x.excalidraw', '/x.excalidraw', 'p//x.excalidraw', 'x.png', '.excalidraw', '_reverted/x.excalidraw', '_retired/a/x.excalidraw']) {
    await assert.rejects(b.save(bad, Buffer.from('')), /invalid backup name|reserved/, bad);
  }
  await b.save('My Drawings/a b/x.excalidraw', Buffer.from('ok'));
  assert.equal(await b.count('My Drawings/a b/x.excalidraw'), 1);
});

test('paths at any depth keep their folders; move follows a drawing within and across backups; retire hides the history', async () => {
  const [d1, d2] = [await tmpdir(), await tmpdir()];
  const a = createBackups(d1); const other = createBackups(d2);
  await a.save('x/y/z/d_v0.excalidraw', Buffer.from('1'));
  assert.deepEqual(await fs.readdir(path.join(d1, 'x', 'y', 'z', 'd_v0.excalidraw')).then((n) => n.length), 1);
  await a.move('x/y/z/d_v0.excalidraw', 'x/d_v0.excalidraw');
  assert.equal(await a.count('x/y/z/d_v0.excalidraw'), 0);
  assert.equal(await a.count('x/d_v0.excalidraw'), 1);
  await a.move('x/d_v0.excalidraw', 'k/e.excalidraw', other);
  assert.equal(await a.count('x/d_v0.excalidraw'), 0);
  assert.equal(await other.count('k/e.excalidraw'), 1);
  await other.save('k/f.excalidraw', Buffer.from('old'));
  await a.save('m/f.excalidraw', Buffer.from('new'));
  await a.move('m/f.excalidraw', 'k/f.excalidraw', other);
  assert.equal(String((await other.newest('k/f.excalidraw')).bytes), 'new', 'the history of the file that was there is retired, not mixed in');
  assert.equal(await other.count('k/f.excalidraw'), 1);
  assert.equal((await fs.readdir(path.join(d2, '_retired', 'k'))).length, 1);
});

test('a drawing x.excalidraw and a folder x/ keep separate histories: save, retire, delete', async () => {
  const dir = await tmpdir();
  const b = createBackups(dir);
  await b.save('x/y.excalidraw', Buffer.from('in folder'));
  await b.save('x.excalidraw', Buffer.from('file'));
  assert.deepEqual(await fs.readdir(path.join(dir, 'x.excalidraw')).then((n) => n.length), 1);
  assert.equal(await b.count('x/y.excalidraw'), 1);
  await b.retire('x.excalidraw'); // the drawing is deleted or created anew
  assert.equal(await b.count('x.excalidraw'), 0);
  assert.equal(await b.count('x/y.excalidraw'), 1, 'the folder\'s history is untouched');
  assert.equal(String((await b.newest('x/y.excalidraw')).bytes), 'in folder');
});

test('move a.excalidraw into a/ and back up; moving onto itself changes nothing', async () => {
  const dir = await tmpdir();
  const b = createBackups(dir);
  await b.save('a.excalidraw', Buffer.from('1'));
  await b.move('a.excalidraw', 'a/a.excalidraw');
  assert.equal(await b.count('a.excalidraw'), 0);
  assert.equal(await b.count('a/a.excalidraw'), 1);
  await b.move('a/a.excalidraw', 'a.excalidraw');
  assert.equal(await b.count('a.excalidraw'), 1);
  assert.equal(await b.count('a/a.excalidraw'), 0);
  await b.move('a.excalidraw', 'a.excalidraw');
  assert.equal(await b.count('a.excalidraw'), 1, 'same name: history kept');
  await assert.rejects(fs.access(path.join(dir, '_retired')));
});

test('layout: <root>/<dir>/<file name>/<timestamp>.excalidraw, retired and reverted under the same shape', async () => {
  const dir = await tmpdir();
  const b = createBackups(dir);
  await b.save('x_v0.excalidraw', Buffer.from('1'));
  await b.save('a/b/y_v1.excalidraw', Buffer.from('2'));
  await b.keepReverted('a/b/y_v1.excalidraw', Buffer.from('3'));
  await b.retire('x_v0.excalidraw');
  const all = (await fs.readdir(dir, { recursive: true })).map((p) => p.replace(/\d{4}-[\dT-]+Z(_\d+)?/g, '<ts>')).sort();
  assert.ok(all.includes('a/b/y_v1.excalidraw/<ts>.excalidraw'));
  assert.ok(all.includes('_reverted/a/b/y_v1.excalidraw/<ts>.excalidraw'));
  assert.ok(all.some((p) => /^_retired\/x_v0\.excalidraw-<ts>\/<ts>\.excalidraw$/.test(p)), all.join(' '));
});

test('two retires of one name in the same millisecond both survive (suffix _2)', async () => {
  const dir = await tmpdir();
  const frozen = () => new Date('2026-01-01T00:00:00.000Z');
  const b = createBackups(dir, 20, frozen);
  await b.save('x.excalidraw', Buffer.from('1'));
  await b.retire('x.excalidraw');
  await b.save('x.excalidraw', Buffer.from('2'));
  await b.retire('x.excalidraw');
  assert.equal(await b.count('x.excalidraw'), 0, 'nothing left under the live key');
  assert.deepEqual((await fs.readdir(path.join(dir, '_retired'))).sort(), ['x.excalidraw-2026-01-01T00-00-00-000Z', 'x.excalidraw-2026-01-01T00-00-00-000Z_2']);
});

test('reserved folders have no backups: count, list, newest, retire and move are quiet no-ops; save is refused', async () => {
  const dir = await tmpdir();
  const b = createBackups(dir);
  await b.save('a.excalidraw', Buffer.from('1'));
  for (const rel of ['_retired/x.excalidraw', '_reverted/a/y.excalidraw']) {
    assert.equal(await b.count(rel), 0);
    assert.equal(await b.newest(rel), null);
    await b.retire(rel);
    await assert.rejects(b.save(rel, Buffer.from('')), /reserved/);
    assert.equal(b.isReserved(rel), true);
  }
  assert.equal(b.isReserved('_retired.excalidraw'), false, 'a drawing at the top is not in a reserved folder');
  await b.move('a.excalidraw', '_retired/a.excalidraw');
  await b.move('_retired/a.excalidraw', 'a.excalidraw');
  assert.equal(await b.count('a.excalidraw'), 1, 'history untouched');
});

test('a folder inside a backup folder is not a backup', async () => {
  const dir = await tmpdir();
  const b = createBackups(dir, 2);
  await b.save('x.excalidraw', Buffer.from('real'));
  await fs.mkdir(path.join(dir, 'x.excalidraw', 'zzz.excalidraw'));
  assert.equal(await b.count('x.excalidraw'), 1);
  assert.equal(String((await b.newest('x.excalidraw')).bytes), 'real');
  for (let i = 0; i < 3; i++) await b.save('x.excalidraw', Buffer.from(`n${i}`));
  await fs.access(path.join(dir, 'x.excalidraw', 'zzz.excalidraw'));
});
