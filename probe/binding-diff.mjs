// Probe: raw batch import, then show full binding/boundElements diffs with sorted keys.
import fs from 'fs';
const CANVAS = 'http://127.0.0.1:3100';
const canon = (v) => Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v;
for (const f of process.argv.slice(2)) {
  const orig = JSON.parse(fs.readFileSync(f, 'utf8'));
  const live = orig.elements.filter((e) => !e.isDeleted);
  await fetch(CANVAS + '/api/elements/batch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ elements: live, replace: true }) });
  const after = (await (await fetch(CANVAS + '/api/elements')).json()).elements;
  const byId = new Map(after.map((e) => [e.id, e]));
  let n = 0; const keys = {};
  for (const o of live) for (const k of ['startBinding', 'endBinding', 'boundElements', 'points', 'x', 'y', 'width', 'height']) {
    const a = JSON.stringify(canon(o[k])), b = JSON.stringify(canon(byId.get(o.id)[k]));
    if (a !== b) { keys[k] = (keys[k] || 0) + 1; if (n++ < 4) console.log(`${o.type}.${k}\n  ${a}\n  ${b}`); }
  }
  console.log(f, 'real diffs:', JSON.stringify(keys));
}
