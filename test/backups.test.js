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
  assert.deepEqual(await fs.readdir(path.join(d1, 'x', 'y', 'z', 'd_v0')).then((n) => n.length), 1);
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
