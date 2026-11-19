// After scripts/e2e.sh restarted the hub: what workspace.spec.js attached is still there (state file), and it works.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { DATA, drawing, folder, hubGet, hubPage, loadDrawing, open, rootId } from './helpers.js';

const OTHER = path.join(process.env.EXTRA_DIR, 'other-repo', 'docs', 'drawings');

test('@restart attached folders survive a hub restart', async ({ browser }) => {
  const saved = JSON.parse(fs.readFileSync(process.env.STATE_FILE, 'utf8'));
  expect(saved.version).toBe(2);
  expect(saved.folders.map((f) => f.path)).toEqual([DATA, OTHER]);
  expect((await hubGet('/api/folders')).map((f) => f.path)).toEqual([DATA, OTHER]);
  expect((await hubGet('/api/status')).current).toBeNull(); // a fresh process: nothing loaded

  const page = await hubPage(browser);
  const other = await rootId(OTHER);
  await expect(page.locator('[data-testid="folder"][data-path=""]')).toHaveCount(2);
  await expect(folder(page, other)).toContainText('other-repo');
  await open(page, other, 'notes');
  const main = await rootId();
  await open(page, main, 'budgeting');
  await loadDrawing(page, main, 'budgeting/budgeting_v0_plan.excalidraw');
  await expect(page.getByTestId('current')).toHaveText('repo / budgeting / budgeting_v0_plan.excalidraw');
  await expect(page.getByTestId('dirty')).toHaveText('Saved');
  await expect(drawing(page, main, 'budgeting/budgeting_v0_plan.excalidraw')).toBeVisible();
  await page.close();
});
