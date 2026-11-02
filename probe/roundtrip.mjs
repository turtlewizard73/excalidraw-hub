// Probe: import each fixture via the MCP's own scene-io, export, compare. Run inside the mcp image.
import fs from 'fs';
import path from 'path';
const { importScene, buildSceneFile } = await import('/app/dist/core/scene-io.js');
const dir = process.argv[2];
const VOLATILE = new Set(['version', 'versionNonce', 'updated', 'createdAt', 'updatedAt', 'syncedAt', 'source', 'syncTimestamp']);
const strip = (e) => Object.fromEntries(Object.entries(e).filter(([k]) => !VOLATILE.has(k)));
for (const f of fs.readdirSync(dir, { recursive: true }).filter((f) => f.endsWith('.excalidraw')).sort()) {
  const orig = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  await importScene({ filePath: path.join(dir, f), mode: 'replace' });
  const { scene } = await buildSceneFile();
  const byId = new Map(scene.elements.map((e) => [e.id, e]));
  const diffs = [];
  for (const o of orig.elements.filter((e) => !e.isDeleted)) {
    const n = byId.get(o.id);
    if (!n) { diffs.push(`missing ${o.id} ${o.type}`); continue; }
    const a = strip(o), b = strip(n);
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) diffs.push(`${o.type}.${k}: ${JSON.stringify(a[k])?.slice(0, 60)} -> ${JSON.stringify(b[k])?.slice(0, 60)}`);
    }
  }
  const extra = scene.elements.filter((e) => !orig.elements.some((o) => o.id === e.id)).length;
  const keyCount = (m) => Object.keys(m || {}).length;
  console.log(`\n== ${f}: elements ${orig.elements.length} -> ${scene.elements.length} (extra ${extra}), files ${keyCount(orig.files)} -> ${keyCount(scene.files)}`);
  console.log(`   appState in: ${JSON.stringify(orig.appState)?.slice(0, 150)}`);
  const counts = {};
  if (f.includes("v0_plan")) console.log(diffs.filter((d,i,a)=>a.findIndex(x=>x.split(":")[0]===d.split(":")[0])===i).join("\n"));
  for (const d of diffs) { const k = d.split(':')[0]; counts[k] = (counts[k] || 0) + 1; }
  console.log('   diffs by key:', JSON.stringify(counts));
  if (orig.files) for (const [id, fl] of Object.entries(orig.files)) console.log(`   file ${id} same dataURL: ${scene.files?.[id]?.dataURL === fl.dataURL}`);
}
