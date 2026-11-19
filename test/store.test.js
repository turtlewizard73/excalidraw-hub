import { test, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStore, moveAll, moveDrawing } from '../src/store.js';

let dir;
const write = async (rel, body = '{"elements":[]}') => { await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true }); await fs.writeFile(path.join(dir, rel), body); };
const ls = async (p) => (await fs.readdir(path.join(dir, p))).sort();
const status = (code) => (e) => e.status === code;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-store-'));
  await write('mindmap/mindmap_v0.excalidraw'); await write('mindmap/mindmap_v0.png', 'png');
  await write('mindmap/board-before-clear.excalidraw'); await write('mindmap/notes.txt', 'x');
  await write('roadmap/roadmap_v0_plan.excalidraw'); await write('roadmap/roadmap_v1_plan_with_proposal.excalidraw');
  await write('.git/config', 'x'); await write('top-level.excalidraw');
});

test('moveAll rolls back earlier links when a later one fails', async () => {
  const p = (f) => path.join(dir, 'roadmap', f);
  await write('roadmap/a.png', 'a');
  await write('roadmap/taken.png', 'keep');
  await assert.rejects(moveAll([[p('roadmap_v0_plan.excalidraw'), p('moved.excalidraw')], [p('a.png'), p('taken.png')]]), (e) => e.status === 409);
  assert.deepEqual(await ls('roadmap'), ['a.png', 'roadmap_v0_plan.excalidraw', 'roadmap_v1_plan_with_proposal.excalidraw', 'taken.png']);
  assert.equal(await fs.readFile(p('taken.png'), 'utf8'), 'keep');
});

describe('store: any depth, paths relative to the root', () => {
  let rs;
  beforeEach(() => { rs = createStore(dir); });
  const doc = { elements: [{ id: 'a' }] };

  test('works at depth 0, 1 and 3: create (exclusive), read, stamp, overwrite, png, remove', async () => {
    await fs.mkdir(path.join(dir, 'x', 'y', 'z'), { recursive: true });
    for (const rel of ['top_v0.excalidraw', 'roadmap/new_v0.excalidraw', 'x/y/z/deep_v0.excalidraw']) {
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
    assert.ok((await rs.entries('')).some((e) => e.name === 'roadmap' && e.isDirectory()));
    assert.deepEqual((await rs.files('roadmap')).sort(), ['roadmap_v0_plan.excalidraw', 'roadmap_v1_plan_with_proposal.excalidraw']);
    assert.deepEqual(await rs.files('nope'), []);
  });

  test('bad paths are 400: .., empty segments, backslash, NUL, non-drawings', async () => {
    for (const rel of ['../x.excalidraw', 'roadmap/../../x.excalidraw', '/abs.excalidraw', 'roadmap//a.excalidraw', 'a\\b.excalidraw', 'a\0b.excalidraw', './a.excalidraw']) {
      await assert.rejects(rs.read(rel), status(400), JSON.stringify(rel));
    }
    await assert.rejects(rs.read('mindmap/notes.txt'), status(400));
    await assert.rejects(rs.entries('..'), status(400));
    await assert.rejects(rs.create('roadmap/bad name.excalidraw', doc), status(400), 'new names must be safe');
  });

  test('a drawing with an unsafe name can still be read, overwritten, renamed to a safe name and removed', async () => {
    await write('roadmap/My Plan.excalidraw');
    assert.deepEqual((await rs.read('roadmap/My Plan.excalidraw')).elements, []);
    await rs.overwrite('roadmap/My Plan.excalidraw', doc);
    await rs.rename('roadmap/My Plan.excalidraw', 'roadmap/my_plan.excalidraw');
    await rs.remove('roadmap/my_plan.excalidraw');
  });

  test('symlinks: one leading out of the root (or dangling) is refused at any depth; one staying inside is fine', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-outside-'));
    await fs.writeFile(path.join(outside, 'secret.excalidraw'), '{"elements":[]}');
    await fs.symlink(outside, path.join(dir, 'roadmap', 'escape'));
    await fs.symlink(path.join(outside, 'nothing.excalidraw'), path.join(dir, 'roadmap', 'dangling.excalidraw'));
    await fs.symlink(path.join(dir, 'mindmap'), path.join(dir, 'inside'));
    await assert.rejects(rs.read('roadmap/escape/secret.excalidraw'), status(400));
    await assert.rejects(rs.entries('roadmap/escape'), status(400));
    await assert.rejects(rs.create('roadmap/escape/new_v0.excalidraw', doc), status(400));
    await assert.rejects(rs.overwrite('roadmap/dangling.excalidraw', doc), status(400));
    assert.equal((await rs.read('inside/mindmap_v0.excalidraw')).elements.length, 0);
    await assert.rejects(fs.access(path.join(outside, 'new_v0.excalidraw')));
  });

  test('mkdir: needs an existing parent and a safe new name; an existing folder is 409', async () => {
    await rs.mkdir('roadmap/sub');
    await rs.mkdir('roadmap/sub/deeper');
    await assert.rejects(rs.mkdir('roadmap/sub'), status(409));
    await assert.rejects(rs.mkdir('roadmap/new folder'), status(400));
    await assert.rejects(rs.mkdir('roadmap/_hidden'), status(400));
    await assert.rejects(rs.mkdir('nope/sub'), status(404));
    await assert.rejects(rs.mkdir(''), status(400));
  });

  test('move: within a root, the png goes along; a clash on the file or its png is 409 and changes nothing', async () => {
    await fs.mkdir(path.join(dir, 'x', 'y'), { recursive: true });
    await rs.rename('mindmap/mindmap_v0.excalidraw', 'x/y/mindmap_v0.excalidraw');
    assert.deepEqual(await ls('x/y'), ['mindmap_v0.excalidraw', 'mindmap_v0.png']);
    assert.deepEqual((await ls('mindmap')).filter((f) => f.startsWith('mindmap_v0')), []);
    await write('roadmap/orphan.png', 'p');
    await assert.rejects(rs.rename('top-level.excalidraw', 'x/y/mindmap_v0.excalidraw'), status(409));
    await write('top-level.png', 'p');
    await write('roadmap/top-level.png', 'other');
    await assert.rejects(rs.rename('top-level.excalidraw', 'roadmap/top-level.excalidraw'), status(409), 'a png at the target blocks it');
    assert.equal(await fs.readFile(path.join(dir, 'roadmap', 'top-level.png'), 'utf8'), 'other');
    await fs.access(path.join(dir, 'top-level.excalidraw'));
    await assert.rejects(rs.rename('top-level.excalidraw', 'nope/top-level.excalidraw'), status(404));
    await assert.rejects(rs.rename('ghost.excalidraw', 'x/ghost.excalidraw'), status(404));
  });

  test('move across roots and across drives (EXDEV, simulated through an injected rename)', async () => {
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-store2-'));
    const os2 = createStore(other);
    await fs.mkdir(path.join(other, 'in'));
    await moveDrawing(rs, 'mindmap/mindmap_v0.excalidraw', os2, 'in/moved_v0.excalidraw');
    assert.deepEqual(await fs.readdir(path.join(other, 'in')).then((n) => n.sort()), ['moved_v0.excalidraw', 'moved_v0.png']);

    let calls = 0;
    const exdev = async () => { calls++; throw Object.assign(new Error('cross-device'), { code: 'EXDEV' }); };
    await write('mindmap/copy_v0.excalidraw', '{"elements":[1]}'); await write('mindmap/copy_v0.png', 'pngbytes');
    await moveDrawing(rs, 'mindmap/copy_v0.excalidraw', os2, 'in/copy_v0.excalidraw', { rename: exdev });
    assert.equal(calls, 2, 'drawing and png both took the copy path');
    assert.equal(await fs.readFile(path.join(other, 'in', 'copy_v0.png'), 'utf8'), 'pngbytes');
    assert.deepEqual(await ls('mindmap').then((n) => n.filter((f) => f.startsWith('copy'))), []);
  });

  test('a failed png move puts the drawing back', async () => {
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-store2-'));
    const os2 = createStore(other);
    let n = 0;
    const failSecond = async (a, b) => { if (++n === 2) throw new Error('disk full'); return fs.rename(a, b); };
    await assert.rejects(moveDrawing(rs, 'mindmap/mindmap_v0.excalidraw', os2, 'mindmap_v0.excalidraw', { rename: failSecond }), /disk full/);
    assert.deepEqual(await ls('mindmap').then((f) => f.filter((x) => x.startsWith('mindmap_v0'))), ['mindmap_v0.excalidraw', 'mindmap_v0.png']);
    assert.deepEqual(await fs.readdir(other), []);
  });

  test('non-regular files and bad shapes are refused cleanly', async () => {
    await fs.mkdir(path.join(dir, 'mindmap', 'dir.excalidraw'));
    await assert.rejects(rs.read('mindmap/dir.excalidraw'), status(404));
    await assert.rejects(rs.remove('mindmap/dir.excalidraw'), status(404));
    await write('mindmap/null.excalidraw', 'null');
    await assert.rejects(rs.read('mindmap/null.excalidraw'), status(422));
    await write('mindmap/bad.excalidraw', '{not json');
    await assert.rejects(rs.read('mindmap/bad.excalidraw'), status(422));
    await fs.mkdir(path.join(dir, 'mindmap', 'board-before-clear.png'));
    await rs.remove('mindmap/board-before-clear.excalidraw');
    assert.equal((await fs.lstat(path.join(dir, 'mindmap', 'board-before-clear.png'))).isDirectory(), true, 'png dir left alone');
  });

  test('a move is all-or-nothing when the png cannot move', async () => {
    await fs.mkdir(path.join(dir, 'roadmap', 'roadmap_v0_plan.png'));
    await assert.rejects(rs.rename('roadmap/roadmap_v0_plan.excalidraw', 'roadmap/roadmap_v0_x.excalidraw'), status(409));
    assert.deepEqual(await ls('roadmap'), ['roadmap_v0_plan.excalidraw', 'roadmap_v0_plan.png', 'roadmap_v1_plan_with_proposal.excalidraw']);
  });

  test('overwrite replaces a file atomically, creates a missing one, and refuses non-files and links out', async () => {
    await rs.overwrite('roadmap/roadmap_v0_plan.excalidraw', { elements: [9] });
    assert.deepEqual(await rs.read('roadmap/roadmap_v0_plan.excalidraw'), { elements: [9] });
    await rs.overwrite('roadmap/gone.excalidraw', { elements: [] });
    assert.deepEqual(await ls('roadmap'), ['gone.excalidraw', 'roadmap_v0_plan.excalidraw', 'roadmap_v1_plan_with_proposal.excalidraw'], 'no temp files left');
    await fs.mkdir(path.join(dir, 'roadmap', 'dir.excalidraw'));
    await assert.rejects(rs.overwrite('roadmap/dir.excalidraw', { elements: [] }), status(409));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-outside-'));
    await fs.writeFile(path.join(outside, 's.excalidraw'), 'keep');
    await fs.symlink(path.join(outside, 's.excalidraw'), path.join(dir, 'roadmap', 'link.excalidraw'));
    await assert.rejects(rs.overwrite('roadmap/link.excalidraw', { elements: [] }), status(400));
    assert.equal(await fs.readFile(path.join(outside, 's.excalidraw'), 'utf8'), 'keep');
  });

  test('writePng replaces the png atomically and refuses a non-file at its name', async () => {
    await rs.writePng('mindmap/mindmap_v0.excalidraw', Buffer.from('new'));
    assert.equal(await fs.readFile(path.join(dir, 'mindmap', 'mindmap_v0.png'), 'utf8'), 'new');
    await fs.mkdir(path.join(dir, 'mindmap', 'board-before-clear.png'));
    await assert.rejects(rs.writePng('mindmap/board-before-clear.excalidraw', Buffer.from('x')), status(409));
    assert.deepEqual((await ls('mindmap')).filter((f) => f.startsWith('.')), [], 'no temp files left');
  });
});
