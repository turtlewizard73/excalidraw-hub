// E1 regression: an agent saves with no browser tab open. Must run before hub.spec.js opens the page
// (files run alphabetically on one worker); the first assertion checks that no tab is connected.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const DATA = process.env.DATA_DIR;
const CANVAS = process.env.CANVAS_URL;
const HUB = process.env.HUB_URL;
const json = (r) => r.json();
const canvasGet = (p) => fetch(CANVAS + p).then(json);
const hubPost = (p, body) => fetch(HUB + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const status = () => fetch(`${HUB}/api/status`).then(json);
const FILE = 'ai-map/ai-map_v1_agent.excalidraw';

test('agent save with no tab: expands shorthand, writes PNG, stays clean when a tab opens later', async ({ browser }) => {
  expect((await canvasGet('/api/sync/status')).websocketClients).toBe(0);
  await fetch(`${CANVAS}/api/elements/clear`, { method: 'DELETE' });
  const created = await fetch(`${CANVAS}/api/elements/batch`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ elements: [
      { id: 'hub', type: 'rectangle', x: 0, y: 0, width: 180, height: 70, label: { text: 'Hub server' } },
      { id: 'cv', type: 'rectangle', x: 400, y: 0, width: 180, height: 70, backgroundColor: '#a5d8ff', label: { text: 'Canvas' } },
      { id: 'call', type: 'arrow', x: 180, y: 35, points: [[0, 0], [220, 0]], start: { id: 'hub' }, end: { id: 'cv' }, label: { text: 'REST' } },
      { id: 'note', type: 'text', x: 0, y: 150, text: 'no tab was open', fontSize: 16 },
    ] }),
  });
  expect(created.ok).toBe(true);
  expect((await status()).agentElements).toBe(4);

  const res = await hubPost('/api/save', { project: 'ai-map', label: 'agent', versioned: true });
  const body = await res.json();
  expect(res.status, JSON.stringify(body)).toBe(200);
  expect(body.current.file).toBe('ai-map_v1_agent.excalidraw');
  expect(body.png, body.pngError).toBe(true);
  const after = await status();
  expect(after.dirty).toBe(false);
  expect(after.agentElements).toBe(0);

  const saved = JSON.parse(fs.readFileSync(path.join(DATA, FILE), 'utf8'));
  const m = Object.fromEntries(saved.elements.map((e) => [e.id, e]));
  expect(Object.keys(m).sort()).toEqual(['call', 'call-label', 'cv', 'cv-label', 'hub', 'hub-label', 'note']);
  expect(m['hub-label']).toMatchObject({ type: 'text', containerId: 'hub', text: 'Hub server' });
  expect(m.call.startBinding.elementId).toBe('hub');
  expect(m.call.endBinding.elementId).toBe('cv');
  expect(m.cv.boundElements).toEqual(expect.arrayContaining([{ type: 'text', id: 'cv-label' }, { type: 'arrow', id: 'call' }]));
  const png = fs.readFileSync(path.join(DATA, 'ai-map/ai-map_v1_agent.png'));
  expect(png.subarray(1, 4).toString()).toBe('PNG');

  // A tab opened later normalizes the scene on its first change: no new labels, still clean.
  const page = await browser.newPage();
  await page.goto(CANVAS);
  await expect(page.getByText('Connected', { exact: true })).toBeVisible({ timeout: 20000 });
  await page.locator('[data-testid="toolbar-hand"]').click({ force: true });
  await page.locator('[data-testid="toolbar-selection"]').click({ force: true });
  await expect.poll(async () => (await canvasGet('/api/elements')).elements.every((e) => e.source === 'frontend_sync'), { timeout: 10000 }).toBe(true);
  const synced = (await canvasGet('/api/elements')).elements;
  expect(synced.map((e) => e.id).sort()).toEqual(Object.keys(m).sort());
  const s = await status();
  expect(s.dirty).toBe(false);
  await page.screenshot({ path: 'test-results/agent-save-tab.png' });
  await page.close();

  // Leave the stack as hub.spec.js expects it: fixture files only, empty canvas.
  expect((await hubPost('/api/delete', { project: 'ai-map', file: 'ai-map_v1_agent.excalidraw' })).ok).toBe(true);
  await fetch(`${CANVAS}/api/elements/clear`, { method: 'DELETE' });
  expect(fs.existsSync(path.join(DATA, 'ai-map/ai-map_v1_agent.png'))).toBe(false);
});
