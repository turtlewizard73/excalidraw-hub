// End-to-end: attach a second folder of projects, load and save there, detach. Runs after hub.spec.js.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const EXTRA = process.env.EXTRA_DIR; // FOLDERS_ROOT of the test hub; holds other-repo/docs/drawings
const OTHER = path.join(EXTRA, 'other-repo', 'docs', 'drawings');
const CANVAS = process.env.CANVAS_URL;
const canvasCount = async () => (await (await fetch(`${CANVAS}/api/elements`)).json()).elements.filter((e) => !e.isDeleted).length;
const otherDoc = () => JSON.parse(fs.readFileSync(path.join(OTHER, 'notes', 'notes_v0.excalidraw'), 'utf8'));

test.describe.configure({ mode: 'serial' });
let page;

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await page.goto('/');
  await expect(page.frameLocator('#canvas').getByText('Connected', { exact: true })).toBeVisible({ timeout: 20000 });
});
test.afterAll(async () => { await page.close(); });

test('attach: a second section, named after the repo, without sync', async () => {
  await expect(page.locator('section[data-folder]')).toHaveCount(1);
  await expect(page.getByTestId('save-folder')).toBeHidden();
  page.once('dialog', (d) => d.accept(OTHER));
  await page.getByTestId('add-folder').click();
  await expect(page.locator('section[data-folder]')).toHaveCount(2);
  const other = page.locator('section[data-folder]').nth(1);
  await expect(other.locator('h2 .name')).toHaveText('other-repo');
  await expect(other.locator('h2')).toHaveAttribute('title', OTHER);
  await expect(other.locator('details[data-project="notes"] li')).toHaveCount(1);
  await expect(other.locator('[data-action="sync"]')).toHaveCount(0);
  await expect(page.getByTestId('save-folder')).toBeVisible();
});

test('load and save in the attached folder write its files', async () => {
  const other = page.locator('section[data-folder]').nth(1);
  await other.locator('li[data-file="notes_v0.excalidraw"] button.open').click();
  await expect(page.getByTestId('current')).toHaveText('other-repo: notes / notes_v0.excalidraw');
  await expect(page.getByTestId('save-project')).toHaveValue('notes');
  const before = otherDoc().elements.length;
  const frame = page.frameLocator('#canvas');
  const n = await canvasCount();
  await frame.locator('[data-testid="toolbar-rectangle"]').click({ force: true });
  const box = await page.locator('#canvas').boundingBox();
  await page.mouse.move(box.x + box.width - 260, box.y + box.height - 220);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 120, box.y + box.height - 100, { steps: 8 });
  await page.mouse.up();
  await frame.locator('[data-testid="toolbar-selection"]').click({ force: true });
  await expect.poll(canvasCount, { timeout: 10000 }).toBe(n + 1);
  await page.getByTestId('save').click();
  await expect(page.getByTestId('message')).toHaveText('Saved other-repo: notes/notes_v0.excalidraw and its .png');
  expect(otherDoc().elements.length).toBe(before + 1);
  expect(fs.existsSync(path.join(OTHER, 'notes', 'notes_v0.png'))).toBe(true);
});

test('detach: refused while its drawing is loaded; after loading another, removes the section only', async () => {
  let alerted = '';
  page.once('dialog', (d) => { page.once('dialog', (a) => { alerted = a.message(); a.accept(); }); d.accept(); });
  await page.locator('section[data-folder]').nth(1).locator('[data-action="detach"]').click({ force: true });
  await expect.poll(() => alerted).toContain('load a drawing from another folder first');
  await expect(page.locator('section[data-folder]')).toHaveCount(2);

  await page.locator('section[data-folder]').first().locator('li[data-testid="drawing"] button.open').first().click();
  await expect(page.getByTestId('current')).not.toContainText('other-repo');
  page.once('dialog', (d) => d.accept());
  await page.locator('section[data-folder]').nth(1).locator('[data-action="detach"]').click({ force: true });
  await expect(page.locator('section[data-folder]')).toHaveCount(1);
  expect(fs.existsSync(path.join(OTHER, 'notes', 'notes_v0.excalidraw'))).toBe(true);
  await page.screenshot({ path: 'test-results/workspace-final.png' });
});
