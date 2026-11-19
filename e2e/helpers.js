// Shared by the specs: paths from the environment, hub and canvas calls, locators for the explorer.
import { expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

export const DATA = process.env.DATA_DIR; // the attached drawings folder of the throwaway repo
export const BACKUPS = process.env.BACKUPS_DIR;
export const HUB = process.env.HUB_URL;
export const CANVAS = process.env.CANVAS_URL;
export const json = (r) => r.json();
export const hubGet = (p) => fetch(HUB + p).then(json);
export const hubPost = (p, body) => fetch(HUB + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
/** The root id of the attached folder at `dir`. */
export const rootId = async (dir = DATA) => (await hubGet('/api/folders')).find((f) => f.path === dir)?.id;
export const readDoc = (rel, base = DATA) => JSON.parse(fs.readFileSync(path.join(base, rel), 'utf8'));
export const exists = (rel, base = DATA) => fs.existsSync(path.join(base, rel));
export const canvasCount = async () => (await (await fetch(`${CANVAS}/api/elements`)).json()).elements.filter((e) => !e.isDeleted).length;

export const folder = (page, root, p = '') => page.locator(`[data-testid="folder"][data-root="${root}"][data-path="${p}"]`);
export const drawing = (page, root, p) => page.locator(`[data-testid="drawing"][data-root="${root}"][data-path="${p}"]`);
export const loadDrawing = (page, root, p) => drawing(page, root, p).locator('button.open').click();

/** Open a folder row if it is closed (a click on an open one would close it). */
export async function open(page, root, p = '') {
  const row = folder(page, root, p);
  await expect(row).toBeVisible();
  if ((await row.getAttribute('data-expanded')) === 'false') await row.click();
  await expect(row).toHaveAttribute('data-expanded', 'true');
}
/** Select a folder as the save target and leave it open. */
export async function pick(page, root, p = '') {
  await folder(page, root, p).click();
  await open(page, root, p);
}

/** A page on the hub with the canvas connected. */
export async function hubPage(browser) {
  const page = await browser.newPage();
  await page.goto('/');
  await expect(page.frameLocator('#canvas').getByText('Connected', { exact: true })).toBeVisible({ timeout: 20000 });
  return page;
}

/** Draw a rectangle on the canvas and wait until the canvas server holds it. */
export async function drawRectangle(page) {
  const before = await canvasCount();
  const frame = page.frameLocator('#canvas');
  await frame.locator('[data-testid="toolbar-rectangle"]').click({ force: true });
  const box = await page.locator('#canvas').boundingBox();
  await page.mouse.move(box.x + box.width - 260, box.y + box.height - 220);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 120, box.y + box.height - 100, { steps: 8 });
  await page.mouse.up();
  await frame.locator('[data-testid="toolbar-selection"]').click({ force: true });
  // The badge can turn on before the tab has synced the new rectangle; wait for the canvas server to hold it.
  await expect.poll(canvasCount, { timeout: 10000 }).toBe(before + 1);
}

/** Click a hover-only action button (rename, delete, sync, ...) of an explorer row: hover first so it is visible. */
export async function act(row, action) {
  await row.hover();
  await row.locator(`[data-action="${action}"]`).click();
}
