import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';

test('config: defaults', () => {
  const c = loadConfig({});
  assert.equal(c.port, 3080);
  assert.equal(c.host, '127.0.0.1');
  assert.equal(c.canvasUrl, 'http://127.0.0.1:3000');
  assert.equal(c.canvasPublicUrl, c.canvasUrl);
  assert.equal(c.foldersRoot, path.resolve(os.homedir()));
  assert.equal(c.statePath, path.resolve('./config/hub.json'));
  assert.equal(c.backupsDir, path.resolve('./backups'));
  assert.deepEqual(c.autoSyncBranches, ['development', 'dev']);
  assert.equal(c.waitForMount, false);
  assert.deepEqual(c.allowedHosts, ['127.0.0.1:3080', 'localhost:3080']);
});

test('config: overrides', () => {
  const c = loadConfig({
    HUB_PORT: '4000', HUB_HOST: '0.0.0.0', CANVAS_URL: 'http://canvas:3000', CANVAS_PUBLIC_URL: 'http://localhost:3100',
    FOLDERS_ROOT: '/home/me', HUB_STATE: '/home/me/hub.json', BACKUPS_DIR: '/home/me/bk',
    HUB_AUTO_SYNC_BRANCHES: 'main, trunk', HUB_WAIT_FOR_MOUNT: '1', HUB_ALLOWED_HOSTS: 'a:1, b:2',
  });
  assert.equal(c.port, 4000);
  assert.equal(c.host, '0.0.0.0');
  assert.equal(c.canvasUrl, 'http://canvas:3000');
  assert.equal(c.canvasPublicUrl, 'http://localhost:3100');
  assert.equal(c.foldersRoot, '/home/me');
  assert.equal(c.statePath, '/home/me/hub.json');
  assert.equal(c.backupsDir, '/home/me/bk');
  assert.deepEqual(c.autoSyncBranches, ['main', 'trunk']);
  assert.equal(c.waitForMount, true);
  assert.deepEqual(c.allowedHosts, ['a:1', 'b:2']);
});

test('config: CANVAS_PORT shapes the default canvas URL; empty values fall back', () => {
  const c = loadConfig({ CANVAS_PORT: '3100', HUB_PORT: '', HUB_AUTO_SYNC_BRANCHES: '' });
  assert.equal(c.canvasUrl, 'http://127.0.0.1:3100');
  assert.equal(c.port, 3080);
  assert.deepEqual(c.autoSyncBranches, ['development', 'dev']);
  assert.equal(loadConfig({ HUB_WAIT_FOR_MOUNT: '0' }).waitForMount, false);
});
