// End-to-end: attach a second folder, load and save there, drag a drawing across roots (png and Revert history follow),
// detach, attach again from the recent list. Runs after hub.spec.js. Leaves the second folder attached for restart.spec.js.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { act, BACKUPS, DATA, drawing, drawRectangle, exists, folder, hubPage, loadDrawing, open, readDoc, rootId } from './helpers.js';

const OTHER = path.join(process.env.EXTRA_DIR, 'other-repo', 'docs', 'drawings');
const NOTE = 'notes/notes_v0.excalidraw';

test.describe.configure({ mode: 'serial' });
let page, main, other;

test.beforeAll(async ({ browser }) => {
  page = await hubPage(browser);
  main = await rootId();
});
test.afterAll(async () => { await page.close(); });

const attach = async (answer) => {
  let prompted = '';
  page.once('dialog', (d) => { prompted = d.message(); d.accept(answer); });
  await page.getByTestId('add-folder').click();
  await expect.poll(() => prompted).not.toBe('');
  return prompted;
};
const roots = () => page.locator('[data-testid="folder"][data-path=""]');

test('attach: a second root named after the repo, opened, without sync', async () => {
  await expect(roots()).toHaveCount(1);
  expect(await attach(OTHER)).not.toContain('Recently');
  await expect(roots()).toHaveCount(2);
  other = await rootId(OTHER);
  expect(other).toMatch(/^f-[0-9a-f]{12}$/);
  await expect(folder(page, other)).toContainText('other-repo');
  await expect(folder(page, other)).toHaveAttribute('title', new RegExp(OTHER));
  await expect(folder(page, other)).toHaveAttribute('data-expanded', 'true');
  await open(page, other, 'notes');
  await expect(drawing(page, other, NOTE)).toBeVisible();
  await expect(page.locator(`[data-root="${other}"] [data-action="sync"]`)).toHaveCount(0);
  await expect(page.locator(`[data-root="${main}"] [data-action="sync"]`).first()).toHaveCount(1);
});

test('load and save in the attached folder write its files', async () => {
  await loadDrawing(page, other, NOTE);
  await expect(page.getByTestId('current')).toHaveText('other-repo / notes / notes_v0.excalidraw');
  await expect(page.getByTestId('save-target')).toHaveText('Save into other-repo / notes');
  const before = readDoc(NOTE, OTHER).elements.length;
  await drawRectangle(page);
  await page.getByTestId('save').click();
  await expect(page.getByTestId('message')).toHaveText('Saved other-repo/notes/notes_v0.excalidraw (.png rendering)');
  expect(readDoc(NOTE, OTHER).elements.length).toBe(before + 1);
  await expect.poll(() => exists('notes/notes_v0.png', OTHER)).toBe(true); // rendered after the save returns
});

test('detach: refused while its drawing is loaded', async () => {
  let alerted = '';
  page.once('dialog', (d) => { page.once('dialog', (a) => { alerted = a.message(); a.accept(); }); d.accept(); });
  await act(folder(page, other), 'detach');
  await expect.poll(() => alerted).toContain('load a drawing from another folder first');
  await expect(roots()).toHaveCount(2);
});

test('drag across roots: the drawing, its png and its Revert history move; Revert still works', async () => {
  const hist = path.join(BACKUPS, other, 'notes', 'notes_v0.excalidraw');
  expect(fs.readdirSync(hist)).toHaveLength(1); // the overwrite above kept the old file
  // The highlight, with synthetic drag events (Playwright's real drag does not leave the pointer over a target to look at).
  const src = drawing(page, other, NOTE);
  const target = folder(page, main, 'mindmap');
  const dt = await page.evaluateHandle(() => new DataTransfer());
  await src.dispatchEvent('dragstart', { dataTransfer: dt });
  await target.dispatchEvent('dragover', { dataTransfer: dt });
  await expect(target).toHaveClass(/drop/);
  await target.dispatchEvent('dragleave', { dataTransfer: dt });
  await expect(target).not.toHaveClass(/drop/);
  await folder(page, other, 'notes').dispatchEvent('dragover', { dataTransfer: dt }); // the drawing's own folder: no target
  await expect(folder(page, other, 'notes')).not.toHaveClass(/drop/);
  await src.dispatchEvent('dragend', { dataTransfer: dt });
  // The real drag and drop.
  await src.dragTo(target);
  await expect(page.getByTestId('message')).toHaveText('Moved other-repo/notes/notes_v0.excalidraw to repo/mindmap/notes_v0.excalidraw');
  await expect(folder(page, main, 'mindmap')).not.toHaveClass(/drop/);
  expect(exists('mindmap/notes_v0.excalidraw')).toBe(true);
  expect(exists('mindmap/notes_v0.png')).toBe(true);
  expect(exists(NOTE, OTHER)).toBe(false);
  expect(exists('notes/notes_v0.png', OTHER)).toBe(false);
  expect(fs.readdirSync(path.join(BACKUPS, main, 'mindmap', 'notes_v0.excalidraw'))).toHaveLength(1);
  expect(fs.existsSync(hist)).toBe(false);
  await expect(page.getByTestId('current')).toHaveText('repo / mindmap / notes_v0.excalidraw');
  await expect(drawing(page, main, 'mindmap/notes_v0.excalidraw')).toBeVisible();

  await expect(page.getByTestId('revert')).toBeEnabled();
  page.once('dialog', (d) => d.accept());
  await page.getByTestId('revert').click();
  await expect(page.getByTestId('message')).toHaveText('Reverted repo/mindmap/notes_v0.excalidraw (0 earlier states left)');
  expect(readDoc('mindmap/notes_v0.excalidraw').elements).toHaveLength(1); // the state before the rectangle
  await expect(page.getByTestId('revert')).toBeDisabled();
});

test('detach: removes the root only; attach again by its number in the recent list', async () => {
  page.once('dialog', (d) => d.accept());
  await act(folder(page, other), 'detach');
  await expect(roots()).toHaveCount(1);
  expect(await rootId(OTHER)).toBeUndefined();
  expect(fs.existsSync(path.join(OTHER, 'notes'))).toBe(true); // files stay on disk

  const prompted = await attach('1');
  expect(prompted).toContain(`1. ${OTHER}`);
  await expect(roots()).toHaveCount(2);
  expect(await rootId(OTHER)).toBe(other); // same folder, same id
  await page.screenshot({ path: 'test-results/workspace-final.png' });
});
