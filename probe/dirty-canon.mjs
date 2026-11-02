// Probe: does a normalization-tolerant canonical form survive the browser's re-sync, and still catch a real edit?
import fs from 'fs';
import { chromium } from 'playwright';
const CANVAS = 'http://127.0.0.1:3100';
const VOL = new Set(['version', 'versionNonce', 'updated', 'createdAt', 'updatedAt', 'syncedAt', 'source', 'syncTimestamp']);
const empty = (v) => v === null || v === undefined || v === false || (Array.isArray(v) && v.length === 0);
const canon = (v) => Array.isArray(v) ? v.map(canon) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().filter((k) => !empty(v[k])).map((k) => [k, canon(v[k])])) : (typeof v === 'number' ? Math.round(v * 100) / 100 : v);
const element = (e) => { const o = {}; for (const [k, v] of Object.entries(e)) if (!VOL.has(k)) o[k] = v;
  if (Array.isArray(o.boundElements)) o.boundElements = [...o.boundElements].sort((a, b) => (a.id < b.id ? -1 : 1));
  if (e.type === 'text') { delete o.width; delete o.height; if (e.containerId) { delete o.x; delete o.y; } }
  return canon(o); };
const scene = (els) => JSON.stringify(els.filter((e) => !e.isDeleted).map(element).sort((a, b) => (a.id < b.id ? -1 : 1)));
const get = async (p) => (await fetch(CANVAS + p)).json();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.goto(CANVAS); await page.waitForTimeout(2500);
for (const f of process.argv.slice(2)) {
  const orig = JSON.parse(fs.readFileSync(f, 'utf8'));
  const live = orig.elements.filter((e) => !e.isDeleted);
  await fetch(CANVAS + '/api/elements/batch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ elements: live, replace: true }) });
  await page.waitForTimeout(1500);
  const base = scene(live);
  await page.locator('[data-testid="toolbar-hand"]').click({ force: true }); await page.waitForTimeout(300); await page.locator('[data-testid="toolbar-selection"]').click({ force: true }); await page.waitForTimeout(2500); // harmless interaction -> browser re-sync
  const s1 = (await get('/api/elements')).elements;
  const synced = s1.some((e) => e.source === 'frontend_sync');
  const same = scene(s1) === base;
  if (!same) { const a = JSON.parse(base), b = JSON.parse(scene(s1)); let n = 0;
    for (let i = 0; i < a.length && n < 4; i++) for (const k of new Set([...Object.keys(a[i]), ...Object.keys(b[i] || {})])) if (JSON.stringify(a[i][k]) !== JSON.stringify(b[i]?.[k]) && n++ < 4) console.log(`   ${a[i].type}.${k}: ${JSON.stringify(a[i][k])?.slice(0, 80)} -> ${JSON.stringify(b[i]?.[k])?.slice(0, 80)}`); }
  await page.locator('[data-testid="toolbar-rectangle"]').click({ force: true });
  await page.mouse.move(1150, 650); await page.mouse.down(); await page.mouse.move(1300, 800, { steps: 8 }); await page.mouse.up();
  await page.waitForTimeout(2500);
  const s2 = (await get('/api/elements')).elements;
  console.log(`== ${f.split('/').pop()}: synced=${synced} cleanAfterInteraction=${same} count ${live.length}->${s2.length} dirtyAfterEdit=${scene(s2) !== base}`);
}
await browser.close();
