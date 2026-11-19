import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkDrawingsDir } from '../src/mounts.js';

test('mounts: a folder with entries is ready', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-mounts-'));
  await fs.mkdir(path.join(dir, 'project'));
  assert.equal(await checkDrawingsDir(dir), null);
});

test('mounts: an empty folder is not ready', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-mounts-'));
  assert.match(await checkDrawingsDir(dir), /FOLDERS_ROOT .* is empty/);
});

test('mounts: a missing folder is not ready', async () => {
  assert.match(await checkDrawingsDir(path.join(os.tmpdir(), 'hub-mounts-missing-x')), /cannot read/);
});

test('mounts: an empty setting is not ready', async () => {
  assert.match(await checkDrawingsDir(''), /not set/);
  assert.match(await checkDrawingsDir(undefined), /not set/);
});

test('mounts: a file instead of a folder is not ready', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-mounts-'));
  const file = path.join(dir, 'f');
  await fs.writeFile(file, 'x');
  assert.match(await checkDrawingsDir(file), /cannot read/);
});
