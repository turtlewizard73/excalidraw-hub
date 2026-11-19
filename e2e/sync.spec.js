// End-to-end: ⟳ on a folder of a repo root when the checkout is behind its remote (spec: "Updating the local checkout").
// Runs after hub.spec.js, whose sync test already pushed once. A second clone plays "another machine".
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { act, DATA, drawing, exists, folder, hubPage, open, rootId } from './helpers.js';

const REMOTE = process.env.REMOTE_DIR;
const REPO = process.env.GIT_REPO_DIR;
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
const remoteHead = () => execFileSync('git', ['--git-dir', REMOTE, 'rev-parse', 'dev'], { encoding: 'utf8' }).trim();
const remoteFiles = () => execFileSync('git', ['--git-dir', REMOTE, 'ls-tree', '-r', '--name-only', 'dev'], { encoding: 'utf8' }).split('\n');
const SOURCE = path.join(DATA, 'roadmap', 'roadmap_v0_plan.excalidraw');

/** Another clone commits a drawing into roadmap/ and pushes it to the remote's dev. */
function pushFromElsewhere(name) {
  const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'second-clone-'));
  try {
    execFileSync('git', ['clone', '-q', '-b', 'dev', REMOTE, clone]);
    fs.copyFileSync(SOURCE, path.join(clone, 'docs/drawings/roadmap', name));
    git(clone, 'add', '-A');
    git(clone, 'commit', '-q', '-m', `add ${name}`);
    git(clone, 'push', '-q', 'origin', 'dev');
  } finally { fs.rmSync(clone, { recursive: true, force: true }); }
}

test.describe.configure({ mode: 'serial' });
let page, root;

test.beforeAll(async ({ browser }) => {
  page = await hubPage(browser);
  root = await rootId();
  await open(page, root, 'roadmap');
});
test.afterAll(async () => { await page.close(); });

test('sync: checkout behind the remote and a local drawing: pulled, committed, pushed as a plain push', async () => {
  pushFromElsewhere('roadmap_v7_from_remote.excalidraw');
  fs.copyFileSync(SOURCE, path.join(DATA, 'roadmap', 'roadmap_v8_local.excalidraw'));
  expect(exists('roadmap/roadmap_v7_from_remote.excalidraw')).toBe(false); // the checkout is behind
  await act(folder(page, root, 'roadmap'), 'sync');
  const message = page.getByTestId('message');
  await expect(message).toContainText('Synced: "roadmap ', { timeout: 30000 });
  await expect(message).toContainText('pushed to dev');
  await expect(message).toContainText('checkout updated (1 commit(s) pulled)');
  await expect(message).not.toContainText('Only the drawings');
  expect(exists('roadmap/roadmap_v7_from_remote.excalidraw')).toBe(true);
  expect(remoteFiles()).toEqual(expect.arrayContaining(['docs/drawings/roadmap/roadmap_v7_from_remote.excalidraw', 'docs/drawings/roadmap/roadmap_v8_local.excalidraw']));
  expect(git(REPO, 'rev-parse', 'HEAD')).toBe(remoteHead()); // plain push: the checkout and the remote are the same commit
  await expect(drawing(page, root, 'roadmap/roadmap_v7_from_remote.excalidraw')).toBeVisible();
});

test('sync: only behind: nothing to commit, the checkout is still brought up to date', async () => {
  pushFromElsewhere('roadmap_v9_remote_only.excalidraw');
  await act(folder(page, root, 'roadmap'), 'sync');
  await expect(page.getByTestId('message')).toHaveText('Nothing to sync in roadmap (checkout updated: 1 commit(s) pulled)', { timeout: 30000 });
  expect(exists('roadmap/roadmap_v9_remote_only.excalidraw')).toBe(true);
  await expect(drawing(page, root, 'roadmap/roadmap_v9_remote_only.excalidraw')).toBeVisible();
});
