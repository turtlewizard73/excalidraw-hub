// Probe: after a REST load, draw a rectangle in the real browser tab; does the server receive it, unchanged otherwise?
import fs from 'fs';
import { chromium } from 'playwright';
const CANVAS = 'http://127.0.0.1:3100';
const canon = (v) => Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v;
const VOL = new Set(['version', 'versionNonce', 'updated', 'createdAt', 'updatedAt', 'syncedAt', 'source', 'syncTimestamp']);
const strip = (e) => canon(Object.fromEntries(Object.entries(e).filter(([k]) => !VOL.has(k))));
const get = async (p) => (await fetch(CANVAS + p)).json();
const orig = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const live = orig.elements.filter((e) => !e.isDeleted);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('console', (m) => { if (/sync/i.test(m.text())) console.log('  [console]', m.text().slice(0, 120)); });
await page.goto(CANVAS); await page.waitForTimeout(2500);
if (orig.files) for (const f of Object.values(orig.files)) await fetch(CANVAS + '/api/files', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ files: [f] }) });
await fetch(CANVAS + '/api/elements/batch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ elements: live, replace: true }) });
await page.waitForTimeout(3000);
console.log('after load, server count', (await get('/api/elements')).count);
await page.keyboard.press('r');
await page.mouse.move(1200, 700); await page.mouse.down(); await page.mouse.move(1300, 800, { steps: 5 }); await page.mouse.up();
await page.waitForTimeout(3500);
const after = (await get('/api/elements')).elements;
const byId = new Map(after.map((e) => [e.id, e]));
const changed = live.filter((o) => !byId.has(o.id) || JSON.stringify(strip(o)) !== JSON.stringify(strip(byId.get(o.id))));
console.log('after edit, server count', after.length, 'synced', after.filter((e) => e.source === 'frontend_sync').length, 'changed originals', changed.length);
for (const o of changed.slice(0, 3)) { const n = byId.get(o.id); if (!n) { console.log('  missing', o.type); continue; }
  const a = strip(o), b = strip(n); for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) console.log(`  ${o.type}.${k}: ${JSON.stringify(a[k])?.slice(0, 70)} -> ${JSON.stringify(b[k])?.slice(0, 70)}`); }
const keysAdded = {}; for (const o of live) { const n = byId.get(o.id); if (n) for (const k of Object.keys(n)) if (!(k in o) && !VOL.has(k)) keysAdded[k] = (keysAdded[k] || 0) + 1; }
console.log('keys added by browser:', JSON.stringify(keysAdded));
const files = (await get('/api/files')).files; console.log('files on server', Object.keys(files));
await page.screenshot({ path: '/out/' + process.argv[2].split('/').pop() + '.png' });
await browser.close();
