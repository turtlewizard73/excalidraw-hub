// End-to-end: the explorer's own behaviour: expand/collapse and selection that survive a reload, new folders, saving at depth 2,
// drag and drop inside a root, resize and hide. Runs after hub.spec.js and sync.spec.js, before workspace.spec.js.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { act, DATA, drawing, exists, folder, hubPage, loadDrawing, open, pick, rootId } from './helpers.js';

test.describe.configure({ mode: 'serial' });
let page, root;

test.beforeAll(async ({ browser }) => {
  page = await hubPage(browser);
  root = await rootId();
});
test.afterAll(async () => { await page.close(); });

const reload = async () => {
  await expect(page.getByTestId('dirty')).toHaveText('Saved'); // a dirty page would ask before leaving
  await page.reload();
  await expect(page.getByTestId('save-target')).toBeVisible();
};

test('expand, collapse and the selected folder survive a reload', async () => {
  await open(page, root, 'nested');
  await pick(page, root, 'nested/deep');
  await expect(drawing(page, root, 'nested/deep/deep_v0.excalidraw')).toBeVisible();
  await expect(page.getByTestId('save-target')).toHaveText('Save into repo / nested / deep');
  await reload();
  await expect(folder(page, root, 'nested/deep')).toHaveAttribute('data-expanded', 'true');
  await expect(drawing(page, root, 'nested/deep/deep_v0.excalidraw')).toBeVisible();
  await expect(page.getByTestId('save-target')).toHaveText('Save into repo / nested / deep');
  // Collapsing a parent hides its children; the child's own state is remembered.
  await folder(page, root, 'nested').click();
  await expect(folder(page, root, 'nested/deep')).toHaveCount(0);
  await reload();
  await expect(folder(page, root, 'nested')).toHaveAttribute('data-expanded', 'false');
  await expect(folder(page, root, 'nested/deep')).toHaveCount(0);
  await open(page, root, 'nested');
  await expect(drawing(page, root, 'nested/deep/deep_v0.excalidraw')).toBeVisible();
});

test('collapse all closes every folder, roots included, and stays closed after a reload', async () => {
  await page.getByTestId('collapse-all').click();
  await expect(page.locator('[data-testid="folder"]')).toHaveCount(1);
  await expect(folder(page, root)).toHaveAttribute('data-expanded', 'false');
  await reload();
  await expect(page.locator('[data-testid="folder"]')).toHaveCount(1);
  await open(page, root);
});

test('new folder, and saves at depth 2 name the drawing after its folder', async () => {
  await open(page, root, 'budgeting');
  await loadDrawing(page, root, 'budgeting/budgeting_v0_plan.excalidraw');
  await expect(page.getByTestId('dirty')).toHaveText('Saved');
  await open(page, root, 'nested');
  page.once('dialog', (d) => d.accept('fresh'));
  await act(folder(page, root, 'nested'), 'mkdir');
  await expect(folder(page, root, 'nested/fresh')).toBeVisible();
  expect(fs.statSync(path.join(DATA, 'nested', 'fresh')).isDirectory()).toBe(true);

  // Nothing loaded from this folder: the stem is the folder's name, in a folder with no family yet.
  await pick(page, root, 'nested/fresh');
  await page.getByTestId('save-version').click();
  await expect(page.getByTestId('message')).toHaveText('Saved repo/nested/fresh/fresh_v0.excalidraw and its .png');
  expect(exists('nested/fresh/fresh_v0.excalidraw')).toBe(true);
  expect(fs.readFileSync(path.join(DATA, 'nested/fresh/fresh_v0.png')).subarray(1, 4).toString()).toBe('PNG');

  // A family already there (deep_v0): the next version of the folder's name.
  await pick(page, root, 'nested/deep');
  await page.getByTestId('save-version').click();
  await expect(page.getByTestId('message')).toHaveText('Saved repo/nested/deep/deep_v1.excalidraw and its .png');
  expect(exists('nested/deep/deep_v1.excalidraw')).toBe(true);
  expect(fs.readFileSync(path.join(DATA, 'nested/deep/deep_v1.png')).subarray(1, 4).toString()).toBe('PNG');
  await expect(drawing(page, root, 'nested/deep/deep_v1.excalidraw').locator('.tag')).toHaveText('latest');
  await expect(drawing(page, root, 'nested/deep/deep_v0.excalidraw').locator('.tag')).toHaveCount(0);
});

test('drag a drawing onto its own folder: nothing happens; onto another folder of the root: it moves with its png', async () => {
  const src = 'nested/deep/deep_v1.excalidraw';
  await loadDrawing(page, root, src);
  await expect(page.getByTestId('current')).toHaveText('repo / nested / deep / deep_v1.excalidraw');
  const before = page.getByTestId('message');
  await expect(before).toHaveText(/^Loaded /);
  await drawing(page, root, src).dragTo(folder(page, root, 'nested/deep'));
  await page.waitForTimeout(500);
  await expect(before).toHaveText(/^Loaded /);
  expect(exists(src)).toBe(true);

  await drawing(page, root, src).dragTo(folder(page, root, 'nested/fresh'));
  await expect(page.getByTestId('message')).toHaveText('Moved repo/nested/deep/deep_v1.excalidraw to repo/nested/fresh/deep_v1.excalidraw');
  expect(exists(src)).toBe(false);
  expect(exists('nested/deep/deep_v1.png')).toBe(false);
  expect(exists('nested/fresh/deep_v1.excalidraw')).toBe(true);
  expect(exists('nested/fresh/deep_v1.png')).toBe(true);
  await expect(drawing(page, root, 'nested/fresh/deep_v1.excalidraw')).toBeVisible();
  await expect(drawing(page, root, src)).toHaveCount(0);
  await expect(page.getByTestId('current')).toHaveText('repo / nested / fresh / deep_v1.excalidraw'); // the loaded drawing followed
});

const width = () => page.locator('#sidebar').evaluate((e) => Math.round(e.getBoundingClientRect().width));
async function dragHandle(toX) {
  const h = await page.locator('#resizer').boundingBox();
  await page.mouse.move(h.x + h.width / 2, 400);
  await page.mouse.down();
  await page.mouse.move(toX, 400, { steps: 8 });
  await expect(page.locator('#shield')).toBeVisible(); // covers the canvas iframe while dragging
  await page.mouse.up();
  await expect(page.locator('#shield')).toBeHidden();
}

test('resize: drag the right edge, clamped to 180 px .. 60 % of the window, double-click resets; survives a reload', async () => {
  expect(await width()).toBe(280);
  await dragHandle(402);
  expect(await width()).toBeGreaterThan(395);
  expect(await width()).toBeLessThan(410);
  const w = await width();
  await reload();
  expect(await width()).toBe(w);
  await dragHandle(1450);
  expect(await width()).toBe(900); // 60 % of the 1500 px viewport
  await dragHandle(5);
  expect(await width()).toBe(180);
  await page.locator('#resizer').dblclick();
  expect(await width()).toBe(280);
  await dragHandle(350);
  await reload();
  expect(await width()).toBeGreaterThan(340);
  await page.locator('#resizer').dblclick();
});

test('hide: the ☰ button and Ctrl+B toggle the sidebar; the choice survives a reload', async () => {
  await expect(page.locator('#sidebar')).toBeVisible();
  await page.getByTestId('toggle-sidebar').click();
  await expect(page.locator('#sidebar')).toBeHidden();
  await reload();
  await expect(page.locator('#sidebar')).toBeHidden();
  await page.getByTestId('current').click(); // focus on the hub page, not the canvas
  await page.keyboard.press('Control+b');
  await expect(page.locator('#sidebar')).toBeVisible();
  await reload();
  await expect(page.locator('#sidebar')).toBeVisible();
  await page.keyboard.press('Control+b');
  await expect(page.locator('#sidebar')).toBeHidden();
  await page.getByTestId('toggle-sidebar').click();
  await expect(page.locator('#sidebar')).toBeVisible();
});
