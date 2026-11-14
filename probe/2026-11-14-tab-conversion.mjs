// Probe: what does an open canvas tab turn agent-format elements into? Ground truth for the server-side expander.
// Run in the e2e image on the test stack network (see docs/plans/2026-11-14-hub-errors.md). Prints raw vs synced elements.
import { chromium } from 'playwright';
const CANVAS = process.env.CANVAS_URL ?? 'http://canvas:3000';
const post = (p, b) => fetch(CANVAS + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
const get = async () => (await (await fetch(CANVAS + '/api/elements')).json()).elements;
await post('/api/elements/batch', { replace: true, elements: [
  { id: 'r', type: 'rectangle', x: 0, y: 0, width: 160, height: 60, label: { text: 'Hub server' } },
  { id: 'e', type: 'ellipse', x: 300, y: 0, width: 120, height: 80, text: 'via text key', strokeColor: '#08427b', backgroundColor: '#a5d8ff' },
  { id: 'a', type: 'arrow', x: 160, y: 30, points: [[0, 0], [140, 10]], start: { id: 'r' }, end: { id: 'e' }, label: { text: 'calls' } },
  { id: 'plain', type: 'rectangle', x: 0, y: 200, width: 80, height: 40 },
  { id: 't', type: 'text', x: 0, y: 300, text: 'free text\nline 2', fontSize: 16 },
] });
console.log('RAW', JSON.stringify(await get()));
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(CANVAS);
await page.waitForTimeout(4000);
// The tab syncs on its next onChange only: a harmless tool toggle triggers it.
await page.locator('[data-testid="toolbar-hand"]').click({ force: true });
await page.waitForTimeout(300);
await page.locator('[data-testid="toolbar-selection"]').click({ force: true });
await page.waitForTimeout(3000);
console.log('SYNCED', JSON.stringify(await get()));
await browser.close();
