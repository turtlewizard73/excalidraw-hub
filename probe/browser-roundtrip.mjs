// Probe: raw-import a fixture into the canvas (hub-style, no MCP expansion) with a real browser tab open,
// let the browser auto-sync, then compare canvas elements/files with the file.
import fs from 'fs';
import { chromium } from 'playwright';
const CANVAS = process.env.CANVAS_URL || 'http://127.0.0.1:3100';
const VOLATILE = new Set(['version', 'versionNonce', 'updated', 'createdAt', 'updatedAt', 'syncedAt', 'source', 'syncTimestamp']);
const strip = (e) => Object.fromEntries(Object.entries(e).filter(([k]) => !VOLATILE.has(k)));
const api = async (method, p, body) => (await fetch(CANVAS + p, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) })).json();
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(CANVAS);
await page.waitForTimeout(3000);
for (const f of process.argv.slice(2)) {
  const orig = JSON.parse(fs.readFileSync(f, 'utf8'));
  const live = orig.elements.filter((e) => !e.isDeleted);
  if (orig.files) await api('POST', '/api/files', { files: Object.values(orig.files) });
  await api('POST', '/api/elements/batch', { elements: live, replace: true });
  const before = (await api('GET', '/api/elements')).elements;
  await page.waitForTimeout(4000);
  const after = (await api('GET', '/api/elements')).elements;
  const synced = after.some((e) => e.source === 'frontend_sync');
  const byId = new Map(after.map((e) => [e.id, e]));
  const diffs = {};
  for (const o of live) {
    const n = byId.get(o.id);
    if (!n) { diffs.missing = (diffs.missing || 0) + 1; continue; }
    const a = strip(o), b = strip(n);
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) {
      const key = `${o.type}.${k}`; if (!diffs[key]) diffs[key] = `${JSON.stringify(a[k])?.slice(0, 50)} -> ${JSON.stringify(b[k])?.slice(0, 50)}`;
    }
  }
  const files = (await api('GET', '/api/files')).files;
  const fileOk = Object.entries(orig.files || {}).map(([id, fl]) => files[id]?.dataURL === fl.dataURL);
  console.log(`\n== ${f}: ${live.length} -> before ${before.length} / after ${after.length}, browserSynced=${synced}, files ok=${JSON.stringify(fileOk)}`);
  for (const [k, v] of Object.entries(diffs)) console.log(`   ${k}: ${v}`);
}
await page.screenshot({ path: '/out/probe-last.png' });
await browser.close();
