// End-to-end: page startup survives a failed request (hub restarting, Docker Desktop start). Before the fix one failed
// request left the sidebar on "Loading…" until a manual reload.
import { test, expect } from '@playwright/test';
import { folder, rootId } from './helpers.js';

for (const route of ['/api/config', '/api/folders']) {
  test(`first ${route} fails: the page says so, retries and shows the tree`, async ({ browser }) => {
    const root = await rootId();
    const page = await browser.newPage();
    let failed = 0;
    await page.route(`**${route}`, (r) => (failed++ === 0 ? r.abort() : r.continue()));
    await page.goto('/');
    await expect(page.locator('#tree')).toContainText('Hub not reachable');
    await expect(folder(page, root)).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#tree')).not.toContainText('Hub not reachable');
    expect(failed).toBeGreaterThan(1);
    await page.close();
  });
}

test('first /api/folders never answers: the page gives up on it, retries and shows the tree', async ({ browser }) => {
  const root = await rootId();
  const page = await browser.newPage();
  let calls = 0;
  await page.route('**/api/folders', (r) => (calls++ === 0 ? undefined : r.continue())); // first one hangs
  await page.goto('/');
  await expect(folder(page, root)).toBeVisible({ timeout: 20000 });
  expect(calls).toBeGreaterThan(1);
  await page.close();
});

test('first /api/tree fails: the folder heals without a reload', async ({ browser }) => {
  const root = await rootId();
  const page = await browser.newPage();
  let failed = 0;
  await page.route('**/api/tree?*', (r) => (failed++ === 0 ? r.abort() : r.continue()));
  await page.goto('/');
  await expect(folder(page, root)).toBeVisible({ timeout: 10000 });
  await expect(folder(page, root, 'board')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#tree .note.error')).toHaveCount(0);
  expect(failed).toBeGreaterThan(1);
  await page.close();
});
