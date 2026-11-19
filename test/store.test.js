import { test, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRootStore, createStore, moveAll, moveDrawing } from '../src/store.js';

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
  await store.create('budgeting', 'budgeting_v2.excalidraw', { elements: [1] });
  assert.deepEqual(await store.read('budgeting', 'budgeting_v2.excalidraw'), { elements: [1] });
  await assert.rejects(store.create('budgeting', 'budgeting_v2.excalidraw', { elements: [2] }), status(409));
  assert.deepEqual(await store.read('budgeting', 'budgeting_v2.excalidraw'), { elements: [1] });
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

test('rename refuses an orphan png at the destination and changes nothing', async () => {
  await write('budgeting/budgeting_v1_final.png', 'orphan');
  await assert.rejects(store.rename('budgeting', 'budgeting_v1_plan_with_proposal.excalidraw', 'budgeting_v1_final.excalidraw'), status(409));
  assert.deepEqual(await ls('budgeting'), ['budgeting_v0_plan.excalidraw', 'budgeting_v1_final.png', 'budgeting_v1_plan_with_proposal.excalidraw']);
});

test('rename is all-or-nothing when the png cannot move', async () => {
  await fs.mkdir(path.join(dir, 'budgeting', 'budgeting_v0_plan.png'));
  await assert.rejects(store.rename('budgeting', 'budgeting_v0_plan.excalidraw', 'budgeting_v0_x.excalidraw'), status(409));
  assert.deepEqual(await ls('budgeting'), ['budgeting_v0_plan.excalidraw', 'budgeting_v0_plan.png', 'budgeting_v1_plan_with_proposal.excalidraw']);
});

test('non-regular files and bad shapes are refused cleanly', async () => {
  await fs.mkdir(path.join(dir, 'ai-map', 'dir.excalidraw'));
  await assert.rejects(store.read('ai-map', 'dir.excalidraw'), status(404));
  await assert.rejects(store.remove('ai-map', 'dir.excalidraw'), status(404));
  await write('ai-map/null.excalidraw', 'null');
  await assert.rejects(store.read('ai-map', 'null.excalidraw'), status(422));
  await write('ai-map/bad.excalidraw', '{not json');
  await assert.rejects(store.read('ai-map', 'bad.excalidraw'), status(422));
  await fs.mkdir(path.join(dir, 'ai-map', 'board-before-clear.png'));
  await store.remove('ai-map', 'board-before-clear.excalidraw');
  assert.equal((await fs.lstat(path.join(dir, 'ai-map', 'board-before-clear.png'))).isDirectory(), true, 'png dir left alone');
});

test('moveAll rolls back earlier links when a later one fails', async () => {
  const p = (f) => path.join(dir, 'budgeting', f);
  await write('budgeting/a.png', 'a');
  await write('budgeting/taken.png', 'keep');
  await assert.rejects(moveAll([[p('budgeting_v0_plan.excalidraw'), p('moved.excalidraw')], [p('a.png'), p('taken.png')]]), (e) => e.status === 409);
  assert.deepEqual(await ls('budgeting'), ['a.png', 'budgeting_v0_plan.excalidraw', 'budgeting_v1_plan_with_proposal.excalidraw', 'taken.png']);
  assert.equal(await fs.readFile(p('taken.png'), 'utf8'), 'keep');
});

test('overwrite replaces a file atomically, creates a missing one, and refuses non-files', async () => {
  await store.overwrite('budgeting', 'budgeting_v0_plan.excalidraw', { elements: [9] });
  assert.deepEqual(await store.read('budgeting', 'budgeting_v0_plan.excalidraw'), { elements: [9] });
  await store.overwrite('budgeting', 'gone.excalidraw', { elements: [] });
  assert.deepEqual(await ls('budgeting'), ['budgeting_v0_plan.excalidraw', 'budgeting_v1_plan_with_proposal.excalidraw', 'gone.excalidraw'], 'no temp files left');
  await fs.mkdir(path.join(dir, 'budgeting', 'dir.excalidraw'));
  await assert.rejects(store.overwrite('budgeting', 'dir.excalidraw', { elements: [] }), status(409));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-outside-'));
  await fs.writeFile(path.join(outside, 's.excalidraw'), 'keep');
  await fs.symlink(path.join(outside, 's.excalidraw'), path.join(dir, 'budgeting', 'link.excalidraw'));
  await assert.rejects(store.overwrite('budgeting', 'link.excalidraw', { elements: [] }), status(400));
  assert.equal(await fs.readFile(path.join(outside, 's.excalidraw'), 'utf8'), 'keep');
});

test('writePng replaces the png atomically and refuses a non-file at its name', async () => {
  await store.writePng('ai-map', 'ai-map_v0.excalidraw', Buffer.from('new'));
  assert.equal(await fs.readFile(path.join(dir, 'ai-map', 'ai-map_v0.png'), 'utf8'), 'new');
  await fs.mkdir(path.join(dir, 'ai-map', 'board-before-clear.png'));
  await assert.rejects(store.writePng('ai-map', 'board-before-clear.excalidraw', Buffer.from('x')), status(409));
  assert.deepEqual((await ls('ai-map')).filter((f) => f.startsWith('.')), [], 'no temp files left');
});

describe('createRootStore: any depth, paths relative to the root', () => {
  let rs;
  beforeEach(() => { rs = createRootStore(dir); });
  const doc = { elements: [{ id: 'a' }] };

  test('works at depth 0, 1 and 3: create (exclusive), read, stamp, overwrite, png, remove', async () => {
    await fs.mkdir(path.join(dir, 'x', 'y', 'z'), { recursive: true });
    for (const rel of ['top_v0.excalidraw', 'budgeting/new_v0.excalidraw', 'x/y/z/deep_v0.excalidraw']) {
      await rs.create(rel, doc);
      assert.deepEqual(await rs.read(rel), doc);
      await assert.rejects(rs.create(rel, doc), status(409));
      assert.match(await rs.stamp(rel), /^\d/);
      await rs.overwrite(rel, { elements: [] });
      assert.deepEqual((await rs.read(rel)).elements, []);
      await rs.writePng(rel, Buffer.from('png'));
      await rs.remove(rel);
      assert.equal(await rs.stamp(rel), null);
      await assert.rejects(fs.access(path.join(dir, rel.replace('.excalidraw', '.png'))));
    }
    await assert.rejects(rs.create('missing/dir/a_v0.excalidraw', doc), status(404), 'no silent mkdir -p');
  });

  test('entries and files list one folder', async () => {
    assert.ok((await rs.entries('')).some((e) => e.name === 'budgeting' && e.isDirectory()));
    assert.deepEqual((await rs.files('budgeting')).sort(), ['budgeting_v0_plan.excalidraw', 'budgeting_v1_plan_with_proposal.excalidraw']);
    assert.deepEqual(await rs.files('nope'), []);
  });

  test('bad paths are 400: .., empty segments, backslash, NUL, non-drawings', async () => {
    for (const rel of ['../x.excalidraw', 'budgeting/../../x.excalidraw', '/abs.excalidraw', 'budgeting//a.excalidraw', 'a\\b.excalidraw', 'a\0b.excalidraw', './a.excalidraw']) {
      await assert.rejects(rs.read(rel), status(400), JSON.stringify(rel));
    }
    await assert.rejects(rs.read('ai-map/notes.txt'), status(400));
    await assert.rejects(rs.entries('..'), status(400));
    await assert.rejects(rs.create('budgeting/bad name.excalidraw', doc), status(400), 'new names must be safe');
  });

  test('a drawing with an unsafe name can still be read, overwritten, renamed to a safe name and removed', async () => {
    await write('budgeting/My Plan.excalidraw');
    assert.deepEqual((await rs.read('budgeting/My Plan.excalidraw')).elements, []);
    await rs.overwrite('budgeting/My Plan.excalidraw', doc);
    await rs.rename('budgeting/My Plan.excalidraw', 'budgeting/my_plan.excalidraw');
    await rs.remove('budgeting/my_plan.excalidraw');
  });

  test('symlinks: one leading out of the root (or dangling) is refused at any depth; one staying inside is fine', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-outside-'));
    await fs.writeFile(path.join(outside, 'secret.excalidraw'), '{"elements":[]}');
    await fs.symlink(outside, path.join(dir, 'budgeting', 'escape'));
    await fs.symlink(path.join(outside, 'nothing.excalidraw'), path.join(dir, 'budgeting', 'dangling.excalidraw'));
    await fs.symlink(path.join(dir, 'ai-map'), path.join(dir, 'inside'));
    await assert.rejects(rs.read('budgeting/escape/secret.excalidraw'), status(400));
    await assert.rejects(rs.entries('budgeting/escape'), status(400));
    await assert.rejects(rs.create('budgeting/escape/new_v0.excalidraw', doc), status(400));
    await assert.rejects(rs.overwrite('budgeting/dangling.excalidraw', doc), status(400));
    assert.equal((await rs.read('inside/ai-map_v0.excalidraw')).elements.length, 0);
    await assert.rejects(fs.access(path.join(outside, 'new_v0.excalidraw')));
  });

  test('mkdir: needs an existing parent and a safe new name; an existing folder is 409', async () => {
    await rs.mkdir('budgeting/sub');
    await rs.mkdir('budgeting/sub/deeper');
    await assert.rejects(rs.mkdir('budgeting/sub'), status(409));
    await assert.rejects(rs.mkdir('budgeting/new folder'), status(400));
    await assert.rejects(rs.mkdir('budgeting/_hidden'), status(400));
    await assert.rejects(rs.mkdir('nope/sub'), status(404));
    await assert.rejects(rs.mkdir(''), status(400));
  });

  test('move: within a root, the png goes along; a clash on the file or its png is 409 and changes nothing', async () => {
    await fs.mkdir(path.join(dir, 'x', 'y'), { recursive: true });
    await rs.rename('ai-map/ai-map_v0.excalidraw', 'x/y/ai-map_v0.excalidraw');
    assert.deepEqual(await ls('x/y'), ['ai-map_v0.excalidraw', 'ai-map_v0.png']);
    assert.deepEqual((await ls('ai-map')).filter((f) => f.startsWith('ai-map_v0')), []);
    await write('budgeting/orphan.png', 'p');
    await assert.rejects(rs.rename('top-level.excalidraw', 'x/y/ai-map_v0.excalidraw'), status(409));
    await write('top-level.png', 'p');
    await write('budgeting/top-level.png', 'other');
    await assert.rejects(rs.rename('top-level.excalidraw', 'budgeting/top-level.excalidraw'), status(409), 'a png at the target blocks it');
    assert.equal(await fs.readFile(path.join(dir, 'budgeting', 'top-level.png'), 'utf8'), 'other');
    await fs.access(path.join(dir, 'top-level.excalidraw'));
    await assert.rejects(rs.rename('top-level.excalidraw', 'nope/top-level.excalidraw'), status(404));
    await assert.rejects(rs.rename('ghost.excalidraw', 'x/ghost.excalidraw'), status(404));
  });

  test('move across roots and across drives (EXDEV, simulated through an injected rename)', async () => {
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-store2-'));
    const os2 = createRootStore(other);
    await fs.mkdir(path.join(other, 'in'));
    await moveDrawing(rs, 'ai-map/ai-map_v0.excalidraw', os2, 'in/moved_v0.excalidraw');
    assert.deepEqual(await fs.readdir(path.join(other, 'in')).then((n) => n.sort()), ['moved_v0.excalidraw', 'moved_v0.png']);

    let calls = 0;
    const exdev = async () => { calls++; throw Object.assign(new Error('cross-device'), { code: 'EXDEV' }); };
    await write('ai-map/copy_v0.excalidraw', '{"elements":[1]}'); await write('ai-map/copy_v0.png', 'pngbytes');
    await moveDrawing(rs, 'ai-map/copy_v0.excalidraw', os2, 'in/copy_v0.excalidraw', { rename: exdev });
    assert.equal(calls, 2, 'drawing and png both took the copy path');
    assert.equal(await fs.readFile(path.join(other, 'in', 'copy_v0.png'), 'utf8'), 'pngbytes');
    assert.deepEqual(await ls('ai-map').then((n) => n.filter((f) => f.startsWith('copy'))), []);
  });

  test('a failed png move puts the drawing back', async () => {
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-store2-'));
    const os2 = createRootStore(other);
    let n = 0;
    const failSecond = async (a, b) => { if (++n === 2) throw new Error('disk full'); return fs.rename(a, b); };
    await assert.rejects(moveDrawing(rs, 'ai-map/ai-map_v0.excalidraw', os2, 'ai-map_v0.excalidraw', { rename: failSecond }), /disk full/);
    assert.deepEqual(await ls('ai-map').then((f) => f.filter((x) => x.startsWith('ai-map_v0'))), ['ai-map_v0.excalidraw', 'ai-map_v0.png']);
    assert.deepEqual(await fs.readdir(other), []);
  });
});
