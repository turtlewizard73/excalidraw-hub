// End-to-end: the real hub page, the real canvas in its iframe, a fixture copy on disk (read-only here).
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const DATA = process.env.DATA_DIR;
const BACKUPS = process.env.BACKUPS_DIR;
const remoteDev = () => fs.readFileSync(path.join(process.env.REMOTE_DIR, 'refs/heads/dev'), 'utf8').trim();
const CANVAS = process.env.CANVAS_URL;
const readDoc = (rel) => JSON.parse(fs.readFileSync(path.join(DATA, rel), 'utf8'));
const exists = (rel) => fs.existsSync(path.join(DATA, rel));
const canvasCount = async () => (await (await fetch(`${CANVAS}/api/elements`)).json()).elements.filter((e) => !e.isDeleted).length;
const drawing = (page, file) => page.locator(`li[data-testid="drawing"][data-file="${file}"]`);

test.describe.configure({ mode: 'serial' });
let page;

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await page.goto('/');
  await expect(page.frameLocator('#canvas').getByText('Connected', { exact: true })).toBeVisible({ timeout: 20000 });
});
test.afterAll(async () => { await page.close(); });

async function drawRectangle() {
  const before = await canvasCount();
  await drawRectangleOnly();
  // The badge can turn on before the tab has synced the new rectangle; wait for the canvas server to hold it.
  await expect.poll(canvasCount, { timeout: 10000 }).toBe(before + 1);
}

async function drawRectangleOnly() {
  const frame = page.frameLocator('#canvas');
  await frame.locator('[data-testid="toolbar-rectangle"]').click({ force: true });
  const box = await page.locator('#canvas').boundingBox();
  await page.mouse.move(box.x + box.width - 260, box.y + box.height - 220);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 120, box.y + box.height - 100, { steps: 8 });
  await page.mouse.up();
  await frame.locator('[data-testid="toolbar-selection"]').click({ force: true });
}

test('save buttons: Save and Save new version; Revert off with nothing loaded', async () => {
  await expect(page.getByTestId('save')).toHaveText('Save');
  await expect(page.getByTestId('save-version')).toHaveText('Save new version');
  await expect(page.getByTestId('revert')).toBeDisabled();
  await expect(page.locator('#save-versioned')).toHaveCount(0);
});

test('list: projects and versions, latest marked, off-scheme files listed plainly', async () => {
  await expect(page.locator('details[data-project]')).toHaveCount(5);
  const names = await page.locator('details[data-project]').evaluateAll((els) => els.map((e) => e.dataset.project));
  expect(names).toEqual(['ai-map', 'budgeting', 'excalidraw-test', 'f1-title-2026', 'image-test']);
  await expect(page.locator('details[data-project="budgeting"] li').first()).toHaveAttribute('data-file', 'budgeting_v1_plan_with_proposal.excalidraw');
  await expect(drawing(page, 'budgeting_v1_plan_with_proposal.excalidraw').locator('.tag')).toHaveText('latest');
  await expect(drawing(page, 'budgeting_v0_plan.excalidraw').locator('.tag')).toHaveCount(0);
  await expect(drawing(page, 'board-before-clear.excalidraw').locator('.tag')).toHaveText('unversioned');
  await expect(drawing(page, 'board-with-f1.excalidraw').locator('.tag')).toHaveText('unversioned');
});

test('load: drawing appears on the canvas and the page is clean', async () => {
  await drawing(page, 'budgeting_v1_plan_with_proposal.excalidraw').locator('button.open').click();
  await expect(page.getByTestId('current')).toHaveText('budgeting / budgeting_v1_plan_with_proposal.excalidraw');
  expect(await canvasCount()).toBe(readDoc('budgeting/budgeting_v1_plan_with_proposal.excalidraw').elements.filter((e) => !e.isDeleted).length);
  await expect(page.getByTestId('dirty')).toHaveText('Saved');
  // A harmless interaction makes the tab re-sync and normalize the scene; still clean.
  await page.frameLocator('#canvas').locator('[data-testid="toolbar-hand"]').click({ force: true });
  await page.frameLocator('#canvas').locator('[data-testid="toolbar-selection"]').click({ force: true });
  await page.waitForTimeout(3500);
  await expect(page.getByTestId('dirty')).toHaveText('Saved');
});

test('unsaved: drawing in the canvas shows the indicator', async () => {
  await drawRectangle();
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

test('save: writes the next version with the edit and becomes clean', async () => {
  const before = readDoc('budgeting/budgeting_v1_plan_with_proposal.excalidraw').elements.length;
  await page.getByTestId('save-project').fill('budgeting');
  await page.getByTestId('save-label').fill('E2E edit');
  await page.getByTestId('save-version').click();
  await expect(page.getByTestId('message')).toHaveText('Saved budgeting/budgeting_v2_e2e_edit.excalidraw and its .png');
  const saved = readDoc('budgeting/budgeting_v2_e2e_edit.excalidraw');
  expect(saved.elements.length).toBe(before + 1);
  expect(saved.elements.some((e) => 'syncedAt' in e || 'createdAt' in e)).toBe(false);
  await expect(page.getByTestId('dirty')).toHaveText('Saved');
  await expect(drawing(page, 'budgeting_v2_e2e_edit.excalidraw').locator('.tag')).toHaveText('latest');
  expect(readDoc('budgeting/budgeting_v1_plan_with_proposal.excalidraw').elements.length).toBe(before);
});

test('save: image files, freedraw and appState survive load → edit → save', async () => {
  await drawing(page, 'image-test_v0_red_png.excalidraw').locator('button.open').click();
  await expect(page.getByTestId('current')).toHaveText('image-test / image-test_v0_red_png.excalidraw');
  await drawRectangle();
  await expect(page.getByTestId('dirty')).toHaveText('● Unsaved changes', { timeout: 8000 });
  await page.getByTestId('save-version').click();
  await expect(page.getByTestId('message')).toHaveText('Saved image-test/image-test_v1.excalidraw and its .png');
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
  await drawRectangle();
  await expect(page.getByTestId('dirty')).toHaveText('● Unsaved changes', { timeout: 8000 });
  await page.getByTestId('save').click();
  await expect(page.getByTestId('message')).toHaveText('Saved image-test/image-test_v1.excalidraw and its .png');
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
  await expect(page.getByTestId('message')).toHaveText('Reverted image-test/image-test_v1.excalidraw (0 earlier states left)');
  expect(popup).toContain('Revert image-test/image-test_v1.excalidraw to its previous saved state?');
  expect(readDoc(file).elements.length).toBe(n - 1);
  expect(await canvasCount()).toBe(n - 1);
  await expect(page.getByTestId('revert')).toBeDisabled();
  await expect(page.getByTestId('dirty')).toHaveText('Saved');
});

test('switching drawings saves unsaved changes into the open file without asking', async () => {
  const file = 'image-test/image-test_v1.excalidraw';
  const n = readDoc(file).elements.length;
  await drawRectangle();
  await expect(page.getByTestId('dirty')).toHaveText('● Unsaved changes', { timeout: 8000 });
  let asked = false;
  page.once('dialog', (d) => { asked = true; d.dismiss(); });
  await drawing(page, 'budgeting_v0_plan.excalidraw').locator('button.open').click();
  await expect(page.getByTestId('current')).toHaveText('budgeting / budgeting_v0_plan.excalidraw');
  await expect(page.getByTestId('message')).toContainText('Your changes were saved to image-test/image-test_v1.excalidraw first (to undo: load it and press Revert)');
  expect(asked).toBe(false);
  expect(readDoc(file).elements.length).toBe(n + 1);
  expect(fs.readdirSync(path.join(BACKUPS, 'image-test', 'image-test_v1')).length).toBe(1);
  page.removeAllListeners('dialog');
});

test('rename: moves the file, keeps the current drawing in sync', async () => {
  await drawing(page, 'budgeting_v2_e2e_edit.excalidraw').locator('button.open').click();
  await expect(page.getByTestId('current')).toHaveText('budgeting / budgeting_v2_e2e_edit.excalidraw');
  page.once('dialog', (d) => d.accept('budgeting_v2_renamed'));
  await drawing(page, 'budgeting_v2_e2e_edit.excalidraw').locator('[data-action="rename"]').click({ force: true });
  await expect(drawing(page, 'budgeting_v2_renamed.excalidraw')).toBeVisible();
  expect(exists('budgeting/budgeting_v2_renamed.excalidraw')).toBe(true);
  expect(exists('budgeting/budgeting_v2_e2e_edit.excalidraw')).toBe(false);
  await expect(page.getByTestId('current')).toHaveText('budgeting / budgeting_v2_renamed.excalidraw');
});

test('rename: refuses traversal and existing names', async () => {
  page.once('dialog', (d) => d.accept('../ai-map/evil'));
  await drawing(page, 'budgeting_v2_renamed.excalidraw').locator('[data-action="rename"]').click({ force: true });
  await expect(page.getByTestId('message')).toContainText('Rename failed: invalid new name');
  page.once('dialog', (d) => d.accept('budgeting_v0_plan'));
  await drawing(page, 'budgeting_v2_renamed.excalidraw').locator('[data-action="rename"]').click({ force: true });
  await expect(page.getByTestId('message')).toContainText('already exists');
  expect(exists('budgeting/budgeting_v2_renamed.excalidraw')).toBe(true);
});

test('sync: on dev, commits the project folder and pushes; then nothing to sync', async () => {
  const before = remoteDev();
  await page.locator('details[data-project="budgeting"] summary [data-action="sync"]').click({ force: true });
  await expect(page.getByTestId('message')).toContainText('Synced: "budgeting ', { timeout: 30000 });
  await expect(page.getByTestId('message')).toContainText('diagram update"');
  await expect(page.getByTestId('message')).toContainText('pushed to dev');
  expect(remoteDev()).not.toBe(before);
  await page.locator('details[data-project="budgeting"] summary [data-action="sync"]').click({ force: true });
  await expect(page.getByTestId('message')).toHaveText('Nothing to sync in budgeting');
  await expect(page.locator('details[data-project="budgeting"]')).toHaveAttribute('open', '');
});

test('delete: cancel keeps the file, confirm removes it and its png', async () => {
  page.once('dialog', (d) => d.dismiss());
  await drawing(page, 'ai-map_v0.excalidraw').locator('[data-action="delete"]').click({ force: true });
  await page.waitForTimeout(500);
  expect(exists('ai-map/ai-map_v0.excalidraw')).toBe(true);
  let message = '';
  page.once('dialog', (d) => { message = d.message(); d.accept(); });
  await drawing(page, 'ai-map_v0.excalidraw').locator('[data-action="delete"]').click({ force: true });
  await expect(drawing(page, 'ai-map_v0.excalidraw')).toHaveCount(0);
  expect(message).toContain('and its .png');
  expect(exists('ai-map/ai-map_v0.excalidraw')).toBe(false);
  expect(exists('ai-map/ai-map_v0.png')).toBe(false);
  expect(exists('ai-map/board-before-clear.excalidraw')).toBe(true);
  await page.screenshot({ path: 'test-results/hub-final.png' });
});
