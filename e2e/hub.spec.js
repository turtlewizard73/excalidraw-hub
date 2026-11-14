// End-to-end: the real hub page, the real canvas in its iframe, a fixture copy on disk (read-only here).
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const DATA = process.env.DATA_DIR;
const AUTOSAVE = process.env.AUTOSAVE_DIR;
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
  const frame = page.frameLocator('#canvas');
  await frame.locator('[data-testid="toolbar-rectangle"]').click({ force: true });
  const box = await page.locator('#canvas').boundingBox();
  await page.mouse.move(box.x + box.width - 260, box.y + box.height - 220);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 120, box.y + box.height - 100, { steps: 8 });
  await page.mouse.up();
  await frame.locator('[data-testid="toolbar-selection"]').click({ force: true });
}

test('versioning checkbox is off by default', async () => {
  await expect(page.getByTestId('save-versioned')).not.toBeChecked();
  await expect(page.getByTestId('save')).toHaveText('Save');
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

test('unsaved: drawing in the canvas shows the indicator, and loading asks first', async () => {
  await drawRectangle();
  await expect(page.getByTestId('dirty')).toHaveText('● Unsaved changes', { timeout: 8000 });
  let message = '';
  page.once('dialog', (d) => { message = d.message(); d.dismiss(); });
  await drawing(page, 'budgeting_v0_plan.excalidraw').locator('button.open').click();
  await expect.poll(() => message).toContain('unsaved changes');
  await expect(page.getByTestId('current')).toHaveText('budgeting / budgeting_v1_plan_with_proposal.excalidraw');
  await expect(page.getByTestId('dirty')).toHaveText('● Unsaved changes');
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
  await page.getByTestId('save-versioned').check();
  await expect(page.getByTestId('save')).toHaveText('Save new version');
  const before = readDoc('budgeting/budgeting_v1_plan_with_proposal.excalidraw').elements.length;
  await page.getByTestId('save-project').fill('budgeting');
  await page.getByTestId('save-label').fill('E2E edit');
  await page.getByTestId('save').click();
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
  await page.getByTestId('save-versioned').check();
  await page.getByTestId('save').click();
  await expect(page.getByTestId('message')).toHaveText('Saved image-test/image-test_v1.excalidraw and its .png');
  const orig = readDoc('image-test/image-test_v0_red_png.excalidraw');
  const saved = readDoc('image-test/image-test_v1.excalidraw');
  expect(saved.files).toEqual(orig.files);
  expect(saved.appState).toEqual(orig.appState);
  expect(saved.elements.map((e) => e.type).sort()).toEqual(['freedraw', 'image', 'rectangle', 'rectangle']);
  const fd = saved.elements.find((e) => e.type === 'freedraw');
  expect(fd.points).toEqual(orig.elements.find((e) => e.type === 'freedraw').points);
});

test('save with versioning off: overwrites the loaded drawing, adds no file, refuses to overwrite another', async () => {
  await page.getByTestId('save-versioned').uncheck();
  await expect(page.getByTestId('save')).toHaveText('Save');
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
  await page.getByTestId('save').click();
  await expect(page.getByTestId('message')).toContainText('already exists');
  expect(readDoc('image-test/image-test_v0_red_png.excalidraw').elements.length).toBe(3);
  await page.getByTestId('save-label').fill('');
});

test('unsaved: accepting a load backs the canvas up first and says where', async () => {
  const onCanvas = readDoc('image-test/image-test_v1.excalidraw').elements.length + 1;
  await drawRectangle();
  await expect(page.getByTestId('dirty')).toHaveText('● Unsaved changes', { timeout: 8000 });
  let message = '';
  page.once('dialog', (d) => { message = d.message(); d.accept(); });
  await drawing(page, 'budgeting_v0_plan.excalidraw').locator('button.open').click();
  await expect(page.getByTestId('current')).toHaveText('budgeting / budgeting_v0_plan.excalidraw');
  expect(message).toContain(`(${onCanvas} elements on it)`);
  expect(message).toContain('autosave folder');
  await expect(page.getByTestId('message')).toContainText('The previous canvas was backed up to autosave/');
  const name = (await page.getByTestId('message').textContent()).split('autosave/')[1];
  expect(name).toMatch(/_image-test_v1\.excalidraw$/);
  const backup = JSON.parse(fs.readFileSync(path.join(AUTOSAVE, name), 'utf8'));
  expect(backup.elements.length).toBe(onCanvas);
  expect(backup.files).toBeTruthy();
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
