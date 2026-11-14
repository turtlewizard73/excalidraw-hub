import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBackups } from '../src/backups.js';

test('keeps the newest N per drawing, newest() is the last saved, names stay distinct', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-bk-'));
  const b = createBackups(dir, 3);
  for (let i = 0; i < 5; i++) await b.save('p', 'p_v0.excalidraw', Buffer.from(`state ${i}`));
  assert.equal(await b.count('p', 'p_v0.excalidraw'), 3);
  assert.equal(String((await b.newest('p', 'p_v0.excalidraw')).bytes), 'state 4');
  assert.equal(await b.count('p', 'other.excalidraw'), 0);
  assert.equal(await b.newest('p', 'other.excalidraw'), null);
});

test('refuses unsafe names', async () => {
  const b = createBackups(await fs.mkdtemp(path.join(os.tmpdir(), 'hub-bk-')));
  await assert.rejects(b.save('..', 'x.excalidraw', Buffer.from('')));
  await assert.rejects(b.save('p', '../x.excalidraw', Buffer.from('')));
  await assert.rejects(b.save('p', 'x.png', Buffer.from('')));
});
