// End-to-end: the real hub page, the real canvas in its iframe, a fixture copy on disk (read-only here, except where noted).
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { act, BACKUPS, canvasCount, DATA, drawRectangle, drawing, exists, folder, hubPage, loadDrawing, open, pick, readDoc, rootId } from './helpers.js';

const remoteDev = () => fs.readFileSync(path.join(process.env.REMOTE_DIR, 'refs/heads/dev'), 'utf8').trim();
const P = { v1: 'budgeting/budgeting_v1_plan_with_proposal.excalidraw', v0: 'budgeting/budgeting_v0_plan.excalidraw' };

test.describe.configure({ mode: 'serial' });
let page, root;

test.beforeAll(async ({ browser }) => {
  page = await hubPage(browser);
  root = await rootId();
});
test.afterAll(async () => { await page.close(); });

test('save buttons: Save and Save new version; Revert off with nothing loaded', async () => {
  await expect(page.getByTestId('save')).toHaveText('Save');
  await expect(page.getByTestId('save-version')).toHaveText('Save new version');
  await expect(page.getByTestId('revert')).toBeDisabled();
  await expect(page.locator('#save-versioned')).toHaveCount(0);
});

test('explorer: the attached folder is a root; folders list lazily; latest marked, off-scheme files listed plainly', async () => {
  expect(root).toMatch(/^f-[0-9a-f]{12}$/);
  await expect(folder(page, root)).toContainText('repo');
  await expect(folder(page, root)).toHaveAttribute('data-expanded', 'true');
  const paths = await page.locator(`[data-testid="folder"][data-root="${root}"]`).evaluateAll((els) => els.map((e) => e.dataset.path));
  expect(paths).toEqual(['', 'ai-map', 'budgeting', 'excalidraw-test', 'f1-title-2026', 'image-test', 'nested']);
  // Closed folders list nothing yet.
  await expect(page.locator('[data-testid="drawing"]')).toHaveCount(0);
  for (const dir of ['ai-map', 'budgeting', 'f1-title-2026', 'image-test']) await open(page, root, dir);
  await expect(page.locator('[data-testid="drawing"][data-path^="budgeting/"]').first()).toHaveAttribute('data-path', P.v1);
  await expect(drawing(page, root, P.v1).locator('.tag')).toHaveText('latest');
  await expect(drawing(page, root, P.v0).locator('.tag')).toHaveCount(0);
  await expect(drawing(page, root, 'ai-map/board-before-clear.excalidraw').locator('.tag')).toHaveText('unversioned');
  await expect(drawing(page, root, 'f1-title-2026/board-with-f1.excalidraw').locator('.tag')).toHaveText('unversioned');
});

test('load: drawing appears on the canvas, its folder is selected, the page is clean', async () => {
  await loadDrawing(page, root, P.v1);
  await expect(page.getByTestId('current')).toHaveText('repo / budgeting / budgeting_v1_plan_with_proposal.excalidraw');
  await expect(page.getByTestId('save-target')).toHaveText('Save into repo / budgeting');
  expect(await canvasCount()).toBe(readDoc(P.v1).elements.filter((e) => !e.isDeleted).length);
  await expect(page.getByTestId('dirty')).toHaveText('Saved');
  // A harmless interaction makes the tab re-sync and normalize the scene; still clean.
  await page.frameLocator('#canvas').locator('[data-testid="toolbar-hand"]').click({ force: true });
  await page.frameLocator('#canvas').locator('[data-testid="toolbar-selection"]').click({ force: true });
  await page.waitForTimeout(3500);
  await expect(page.getByTestId('dirty')).toHaveText('Saved');
});

test('unsaved: drawing in the canvas shows the indicator', async () => {
  await drawRectangle(page);
  await expect(page.getByTestId('dirty')).toHaveText('● Unsaved changes', { timeout: 8000 });
});

test('unsaved: leaving the page warns', async () => {
  // The handler cancels unload while dirty (that is what makes the browser show "Leave site?").
  const cancelled = await page.evaluate(() => { const ev = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(ev); return ev.defaultPrevented; });
  expect(cancelled).toBe(true);
  // And the real browser prompt: navigate away after a gesture on the top page.
  await page.getByTestId('current').click();
  const dialog = page.waitForEvent('dialog');
  const nav = page.evaluate(() => { location.href = '/api/config'; }).catch(() => {});
  const d = await dialog;
  expect(d.type()).toBe('beforeunload');
  await d.dismiss();
  await nav;
  await expect(page.getByTestId('dirty')).toHaveText('● Unsaved changes');
});

test('save: writes the next version into the selected folder with the edit and becomes clean', async () => {
  const before = readDoc(P.v1).elements.length;
  await page.getByTestId('save-label').fill('E2E edit');
  await page.getByTestId('save-version').click();
  await expect(page.getByTestId('message')).toHaveText('Saved repo/budgeting/budgeting_v2_e2e_edit.excalidraw and its .png');
  const saved = readDoc('budgeting/budgeting_v2_e2e_edit.excalidraw');
  expect(saved.elements.length).toBe(before + 1);
  expect(saved.elements.some((e) => 'syncedAt' in e || 'createdAt' in e)).toBe(false);
  expect(exists('budgeting/budgeting_v2_e2e_edit.png')).toBe(true);
  await expect(page.getByTestId('dirty')).toHaveText('Saved');
  await expect(drawing(page, root, 'budgeting/budgeting_v2_e2e_edit.excalidraw').locator('.tag')).toHaveText('latest');
  expect(readDoc(P.v1).elements.length).toBe(before);
});

test('save: image files, freedraw and appState survive load → edit → save', async () => {
  await loadDrawing(page, root, 'image-test/image-test_v0_red_png.excalidraw');
  await expect(page.getByTestId('current')).toHaveText('repo / image-test / image-test_v0_red_png.excalidraw');
  await drawRectangle(page);
  await expect(page.getByTestId('dirty')).toHaveText('● Unsaved changes', { timeout: 8000 });
  await page.getByTestId('save-version').click();
  await expect(page.getByTestId('message')).toHaveText('Saved repo/image-test/image-test_v1.excalidraw and its .png');
  const orig = readDoc('image-test/image-test_v0_red_png.excalidraw');
  const saved = readDoc('image-test/image-test_v1.excalidraw');
  expect(saved.files).toEqual(orig.files);
  expect(saved.appState).toEqual(orig.appState);
  expect(saved.elements.map((e) => e.type).sort()).toEqual(['freedraw', 'image', 'rectangle', 'rectangle']);
  const fd = saved.elements.find((e) => e.type === 'freedraw');
  expect(fd.points).toEqual(orig.elements.find((e) => e.type === 'freedraw').points);
});

test('Save: overwrites the loaded drawing, adds no file, refuses to overwrite another in a popup', async () => {
  const file = 'image-test/image-test_v1.excalidraw';
  const before = readDoc(file).elements.length;
  const listed = fs.readdirSync(path.join(DATA, 'image-test')).sort();
  await drawRectangle(page);
  await expect(page.getByTestId('dirty')).toHaveText('● Unsaved changes', { timeout: 8000 });
  await page.getByTestId('save').click();
  await expect(page.getByTestId('message')).toHaveText('Saved repo/image-test/image-test_v1.excalidraw and its .png');
  await expect(page.getByTestId('dirty')).toHaveText('Saved');
  expect(readDoc(file).elements.length).toBe(before + 1);
  expect(fs.readdirSync(path.join(DATA, 'image-test')).sort()).toEqual(listed);
  await page.getByTestId('save-label').fill('v0 red png');
  let popup = '';
  page.once('dialog', (d) => { popup = d.message(); d.accept(); });
  await page.getByTestId('save').click();
  await expect(page.getByTestId('message')).toContainText('already exists');
  await expect.poll(() => popup).toContain('image-test_v0_red_png.excalidraw already exists');
  expect(readDoc('image-test/image-test_v0_red_png.excalidraw').elements.length).toBe(3);
  await page.getByTestId('save-label').fill('');
});

test('Revert: brings back the state before the last Save, then is off again', async () => {
  const file = 'image-test/image-test_v1.excalidraw';
  const n = readDoc(file).elements.length; // after the overwrite in the previous test
  await expect(page.getByTestId('revert')).toBeEnabled();
  let popup = '';
  page.once('dialog', (d) => { popup = d.message(); d.accept(); });
  await page.getByTestId('revert').click();
  await expect(page.getByTestId('message')).toHaveText('Reverted repo/image-test/image-test_v1.excalidraw (0 earlier states left)');
  expect(popup).toContain('Revert repo/image-test/image-test_v1.excalidraw to its previous saved state?');
  expect(readDoc(file).elements.length).toBe(n - 1);
  expect(await canvasCount()).toBe(n - 1);
  await expect(page.getByTestId('revert')).toBeDisabled();
  await expect(page.getByTestId('dirty')).toHaveText('Saved');
});

test('switching drawings saves unsaved changes into the open file without asking', async () => {
  const file = 'image-test/image-test_v1.excalidraw';
  const n = readDoc(file).elements.length;
  await drawRectangle(page);
  await expect(page.getByTestId('dirty')).toHaveText('● Unsaved changes', { timeout: 8000 });
  let asked = false;
  page.once('dialog', (d) => { asked = true; d.dismiss(); });
  await loadDrawing(page, root, P.v0);
  await expect(page.getByTestId('current')).toHaveText('repo / budgeting / budgeting_v0_plan.excalidraw');
  await expect(page.getByTestId('message')).toContainText('Your changes were saved to repo/image-test/image-test_v1.excalidraw first (to undo: load it and press Revert)');
  expect(asked).toBe(false);
  expect(readDoc(file).elements.length).toBe(n + 1);
  expect(fs.readdirSync(path.join(BACKUPS, root, 'image-test', 'image-test_v1')).length).toBe(1);
  page.removeAllListeners('dialog');
});

test('rename: moves the file, keeps the current drawing in sync', async () => {
  await loadDrawing(page, root, 'budgeting/budgeting_v2_e2e_edit.excalidraw');
  await expect(page.getByTestId('current')).toHaveText('repo / budgeting / budgeting_v2_e2e_edit.excalidraw');
  page.once('dialog', (d) => d.accept('budgeting_v2_renamed'));
  await act(drawing(page, root, 'budgeting/budgeting_v2_e2e_edit.excalidraw'), 'rename');
  await expect(drawing(page, root, 'budgeting/budgeting_v2_renamed.excalidraw')).toBeVisible();
  expect(exists('budgeting/budgeting_v2_renamed.excalidraw')).toBe(true);
  expect(exists('budgeting/budgeting_v2_e2e_edit.excalidraw')).toBe(false);
  expect(exists('budgeting/budgeting_v2_renamed.png')).toBe(true);
  await expect(page.getByTestId('current')).toHaveText('repo / budgeting / budgeting_v2_renamed.excalidraw');
});

test('rename: refuses traversal and existing names', async () => {
  const row = drawing(page, root, 'budgeting/budgeting_v2_renamed.excalidraw');
  page.once('dialog', (d) => d.accept('../ai-map/evil'));
  await act(row, 'rename');
  await expect(page.getByTestId('message')).toContainText('Rename failed: invalid new name');
  page.once('dialog', (d) => d.accept('budgeting_v0_plan'));
  await act(row, 'rename');
  await expect(page.getByTestId('message')).toContainText('already exists');
  expect(exists('budgeting/budgeting_v2_renamed.excalidraw')).toBe(true);
});

test('sync: on dev, commits the folder and pushes without asking; then nothing to sync', async () => {
  const before = remoteDev();
  const budgeting = folder(page, root, 'budgeting');
  await act(budgeting, 'sync');
  await expect(page.getByTestId('message')).toContainText('Synced: "budgeting ', { timeout: 30000 });
  await expect(page.getByTestId('message')).toContainText('diagram update"');
  await expect(page.getByTestId('message')).toContainText('pushed to dev');
  expect(remoteDev()).not.toBe(before);
  await act(budgeting, 'sync');
  await expect(page.getByTestId('message')).toHaveText('Nothing to sync in budgeting');
  await expect(folder(page, root, 'budgeting')).toHaveAttribute('data-expanded', 'true');
});

test('delete: cancel keeps the file, confirm removes it and its png', async () => {
  await pick(page, root, 'ai-map');
  const row = drawing(page, root, 'ai-map/ai-map_v0.excalidraw');
  page.once('dialog', (d) => d.dismiss());
  await act(row, 'delete');
  await page.waitForTimeout(500);
  expect(exists('ai-map/ai-map_v0.excalidraw')).toBe(true);
  let message = '';
  page.once('dialog', (d) => { message = d.message(); d.accept(); });
  await act(row, 'delete');
  await expect(row).toHaveCount(0);
  expect(message).toContain('and its .png');
  expect(exists('ai-map/ai-map_v0.excalidraw')).toBe(false);
  expect(exists('ai-map/ai-map_v0.png')).toBe(false);
  expect(exists('ai-map/board-before-clear.excalidraw')).toBe(true);
  await page.screenshot({ path: 'test-results/hub-final.png' });
});
