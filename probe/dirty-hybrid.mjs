// Probe: hybrid unsaved detection. Tolerant compare across the browser's first normalization, then strict compare anchored on the synced state.
import fs from 'fs';
import { chromium } from 'playwright';
const CANVAS = 'http://127.0.0.1:3100';
const VOL = new Set(['version', 'versionNonce', 'updated', 'createdAt', 'updatedAt', 'syncedAt', 'source', 'syncTimestamp']);
const empty = (v) => v === null || v === undefined || v === false || (Array.isArray(v) && v.length === 0);
const canon = (v) => Array.isArray(v) ? v.map(canon) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().filter((k) => !empty(v[k])).map((k) => [k, canon(v[k])])) : (typeof v === 'number' ? Math.round(v * 100) / 100 : v);
const strictEl = (e) => { const o = {}; for (const [k, v] of Object.entries(e)) if (!VOL.has(k)) o[k] = v;
  if (Array.isArray(o.boundElements)) o.boundElements = [...o.boundElements].sort((a, b) => (a.id < b.id ? -1 : 1)); return canon(o); };
const tolerantEl = (e) => { const o = strictEl(e); delete o.boundElements; if (e.type === 'text') { delete o.width; delete o.height; if (e.containerId) { delete o.x; delete o.y; } } return o; };
const live = (els) => els.filter((e) => !e.isDeleted);
const strict = (els) => JSON.stringify(live(els).map(strictEl).sort((a, b) => (a.id < b.id ? -1 : 1)));
// tolerant: same ids; for each element, every key in current must equal baseline; keys only in baseline are ignored
const tolerantDiff = (base, cur) => { const b = new Map(live(base).map((e) => [e.id, tolerantEl(e)])); const c = live(cur).map(tolerantEl); const out = [];
  if (b.size !== c.length) out.push(`count ${b.size} vs ${c.length}`);
  for (const e of c) { const o = b.get(e.id); if (!o) { out.push(`new ${e.type}`); continue; }
    for (const k of Object.keys(e)) if (JSON.stringify(e[k]) !== JSON.stringify(o[k])) out.push(`${e.type}.${k}: ${JSON.stringify(o[k])?.slice(0, 60)} -> ${JSON.stringify(e[k])?.slice(0, 60)}`); }
  return out; };
const get = async (p) => (await fetch(CANVAS + p)).json();
const toggle = async (page) => { await page.locator('[data-testid="toolbar-hand"]').click({ force: true }); await page.waitForTimeout(300); await page.locator('[data-testid="toolbar-selection"]').click({ force: true }); await page.waitForTimeout(2500); };
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.goto(CANVAS); await page.waitForTimeout(2500);
for (const f of process.argv.slice(2)) {
  const orig = JSON.parse(fs.readFileSync(f, 'utf8'));
  await fetch(CANVAS + '/api/elements/batch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ elements: live(orig.elements), replace: true }) });
  await page.waitForTimeout(1500);
  const d0 = tolerantDiff(orig.elements, (await get('/api/elements')).elements);
  await toggle(page);
  const s1 = (await get('/api/elements')).elements;
  const d1 = tolerantDiff(orig.elements, s1);
  const anchor = strict(s1);
  await toggle(page);
  const s2 = (await get('/api/elements')).elements;
  const strictClean2 = strict(s2) === anchor;
  await page.locator('[data-testid="toolbar-rectangle"]').click({ force: true });
  await page.mouse.move(1150, 650); await page.mouse.down(); await page.mouse.move(1300, 800, { steps: 8 }); await page.mouse.up();
  await page.waitForTimeout(2500);
  const s3 = (await get('/api/elements')).elements;
  console.log(`== ${f.split('/').pop()}: tolerantCleanRaw=${d0.length === 0} synced=${s1.every((e) => e.source === 'frontend_sync')} tolerantCleanSynced=${d1.length === 0} strictCleanSecondSync=${strictClean2} dirtyAfterEdit=${strict(s3) !== anchor}`);
  for (const d of [...d0, ...d1].slice(0, 4)) console.log('   ', d);
}
await browser.close();
