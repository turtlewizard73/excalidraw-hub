import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';

let dir, store;
const write = async (rel, body = '{"elements":[]}') => { await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true }); await fs.writeFile(path.join(dir, rel), body); };
const ls = async (p) => (await fs.readdir(path.join(dir, p))).sort();
const status = (code) => (e) => e.status === code;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-store-'));
  store = createStore(dir);
  await write('ai-map/ai-map_v0.excalidraw'); await write('ai-map/ai-map_v0.png', 'png');
  await write('ai-map/board-before-clear.excalidraw'); await write('ai-map/notes.txt', 'x');
  await write('budgeting/budgeting_v0_plan.excalidraw'); await write('budgeting/budgeting_v1_plan_with_proposal.excalidraw');
  await write('.git/config', 'x'); await write('top-level.excalidraw');
});

test('listProjects lists folders with sorted drawings, latest and png flags', async () => {
  const projects = await store.listProjects();
  assert.deepEqual(projects.map((p) => p.name), ['ai-map', 'budgeting']);
  assert.deepEqual(projects[0].drawings.map((d) => [d.file, d.latest, d.png]), [['ai-map_v0.excalidraw', true, true], ['board-before-clear.excalidraw', false, false]]);
  assert.equal(projects[1].drawings[0].file, 'budgeting_v1_plan_with_proposal.excalidraw');
});

test('create writes a new file, creates the folder, and never overwrites', async () => {
  await store.create('budgeting', 'budgeting_v2.excalidraw', { a: 1 });
  assert.deepEqual(await store.read('budgeting', 'budgeting_v2.excalidraw'), { a: 1 });
  await assert.rejects(store.create('budgeting', 'budgeting_v2.excalidraw', { a: 2 }), status(409));
  assert.deepEqual(await store.read('budgeting', 'budgeting_v2.excalidraw'), { a: 1 });
  await store.create('new-project', 'new-project_v0.excalidraw', {});
  assert.deepEqual(await ls('new-project'), ['new-project_v0.excalidraw'], 'no temp files left');
  assert.deepEqual(await ls('budgeting'), ['budgeting_v0_plan.excalidraw', 'budgeting_v1_plan_with_proposal.excalidraw', 'budgeting_v2.excalidraw']);
});

test('rename moves the png along and refuses to overwrite', async () => {
  await store.rename('ai-map', 'ai-map_v0.excalidraw', 'ai-map_v0_first.excalidraw');
  assert.deepEqual(await ls('ai-map'), ['ai-map_v0_first.excalidraw', 'ai-map_v0_first.png', 'board-before-clear.excalidraw', 'notes.txt']);
  await assert.rejects(store.rename('ai-map', 'board-before-clear.excalidraw', 'ai-map_v0_first.excalidraw'), status(409));
  await assert.rejects(store.rename('ai-map', 'missing.excalidraw', 'x.excalidraw'), status(404));
});

test('remove deletes the drawing and its png only', async () => {
  await store.remove('ai-map', 'ai-map_v0.excalidraw');
  assert.deepEqual(await ls('ai-map'), ['board-before-clear.excalidraw', 'notes.txt']);
  await assert.rejects(store.remove('ai-map', 'ai-map_v0.excalidraw'), status(404));
});

test('path traversal, odd names and non-drawings are rejected', async () => {
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-outside-'));
  await fs.writeFile(path.join(outside, 'secret.excalidraw'), '{}');
  for (const [p, f] of [['..', 'x.excalidraw'], ['../' + path.basename(outside), 'secret.excalidraw'], ['ai-map', '../budgeting/budgeting_v0_plan.excalidraw'],
    ['ai-map', 'notes.txt'], ['ai-map', '.excalidraw'], ['/etc', 'passwd.excalidraw'], ['ai-map', 'a/b.excalidraw'], ['', 'x.excalidraw'], ['.git', 'config.excalidraw']]) {
    await assert.rejects(store.read(p, f), status(400), `${p} ${f}`);
    await assert.rejects(store.remove(p, f), status(400), `${p} ${f}`);
  }
  await assert.rejects(store.rename('ai-map', 'ai-map_v0.excalidraw', '../budgeting/x.excalidraw'), status(400));
  await assert.rejects(store.create('..', 'x.excalidraw', {}), status(400));
});

test('symlinked projects and files are rejected', async () => {
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-outside-'));
  await fs.writeFile(path.join(outside, 'secret.excalidraw'), '{}');
  await fs.symlink(outside, path.join(dir, 'linked'));
  await fs.symlink(path.join(outside, 'secret.excalidraw'), path.join(dir, 'ai-map', 'link.excalidraw'));
  await assert.rejects(store.read('linked', 'secret.excalidraw'), status(400));
  await assert.rejects(store.remove('linked', 'secret.excalidraw'), status(400));
  await assert.rejects(store.read('ai-map', 'link.excalidraw'), status(400));
  await assert.rejects(store.remove('ai-map', 'link.excalidraw'), status(400));
  await assert.rejects(store.create('linked', 'new.excalidraw', {}), status(400));
  assert.deepEqual(await fs.readdir(outside), ['secret.excalidraw']);
  assert.deepEqual((await store.listProjects()).map((p) => p.name), ['ai-map', 'budgeting'], 'symlinked folder not listed');
});
