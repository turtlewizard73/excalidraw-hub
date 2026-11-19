import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_STEM, isSafeName, isUsableLabel, nextVersionOf, parseStem, plainTargetIn, saveName, saveStem, sortFamilies } from '../src/names.js';

test('isSafeName accepts plain names and rejects traversal or odd characters', () => {
  for (const ok of ['ai-map', 'f1-title-2026', 'budgeting_v1_plan', 'a.b']) assert.equal(isSafeName(ok), true, ok);
  for (const bad of ['', '.', '..', '../x', 'a/b', 'a\\b', '.hidden', 'a..b', 'x y', 'a\0', '-x', 'é', 'a'.repeat(200), null, 3]) assert.equal(isSafeName(bad), false, String(bad));
});

test('saveName builds a scheme name and slugs the label', () => {
  assert.equal(saveName('budgeting', 2, ''), 'budgeting_v2.excalidraw');
  assert.equal(saveName('budgeting', 2, '  New Idea / draft! '), 'budgeting_v2_new_idea_draft.excalidraw');
  assert.equal(saveName('budgeting', 2, '!!!'), 'budgeting_v2.excalidraw');
});

test('huge version numbers are not versions; long names still fit', () => {
  assert.equal(parseStem('p_v1000000000000000000000.excalidraw').version, null);
  assert.equal(nextVersionOf('p', ['p_v1000000000000000000000.excalidraw', 'p_v4.excalidraw']), 5);
  const project = 'p'.repeat(110);
  const name = saveName(project, 12, 'a long label that will not fit');
  assert.equal(isSafeName(name.slice(0, -'.excalidraw'.length)), true, name);
});

test('isUsableLabel: blank or containing a-z/0-9', () => {
  for (const ok of [undefined, '', '   ', 'x', 'v2 draft!']) assert.equal(isUsableLabel(ok), true, String(ok));
  for (const bad of ['!!!', '日本語', ' - ']) assert.equal(isUsableLabel(bad), false, bad);
});

test('parseStem: the stem is lazy; no _v<i> means the whole base is the stem', () => {
  assert.deepEqual(parseStem('a_v3_x.excalidraw'), { file: 'a_v3_x.excalidraw', base: 'a_v3_x', stem: 'a', version: 3, label: 'x' });
  assert.deepEqual(parseStem('a_v1_b_v2.excalidraw'), { file: 'a_v1_b_v2.excalidraw', base: 'a_v1_b_v2', stem: 'a', version: 1, label: 'b_v2' });
  assert.equal(parseStem('my_plan.excalidraw').stem, 'my_plan');
  assert.equal(parseStem('my_plan.excalidraw').version, null);
  assert.equal(parseStem('a_v1234567890.excalidraw').version, null, 'ten digits is not a version');
  assert.equal(parseStem('a.png'), null);
});

test('families: one per stem in a folder; latest per stem; unversioned listed after their stem\'s versions', () => {
  const list = sortFamilies(['b_v0.excalidraw', 'a_v1_x.excalidraw', 'a_v5.excalidraw', 'a.excalidraw', 'notes.excalidraw', 'a_v5_copy.excalidraw', 'x.png']);
  assert.deepEqual(list.map((d) => [d.file, d.latest]), [
    ['a_v5.excalidraw', true], ['a_v5_copy.excalidraw', false], ['a_v1_x.excalidraw', false], ['a.excalidraw', false],
    ['b_v0.excalidraw', true], ['notes.excalidraw', false],
  ]);
});

test('nextVersionOf counts only the family of the stem', () => {
  const files = ['a_v0.excalidraw', 'a_v4_x.excalidraw', 'b_v9.excalidraw', 'a.excalidraw', 'ab_v7.excalidraw'];
  assert.equal(nextVersionOf('a', files), 5);
  assert.equal(nextVersionOf('b', files), 10);
  assert.equal(nextVersionOf('new', files), 0);
});

test('saveStem: the loaded drawing\'s stem, else the folder name; plainTargetIn overwrites only the loaded drawing with no label', () => {
  assert.equal(saveStem('plan_v3_x.excalidraw', 'folder'), 'plan');
  assert.equal(saveStem('plain name.excalidraw', 'folder'), 'plain name');
  assert.equal(saveStem(null, 'folder'), 'folder');
  assert.deepEqual(plainTargetIn('plan', '', 'plan_v3_x.excalidraw'), { file: 'plan_v3_x.excalidraw', overwrite: true });
  assert.deepEqual(plainTargetIn('plan', 'Second Try', 'plan_v3_x.excalidraw'), { file: 'plan_second_try.excalidraw', overwrite: false });
  assert.deepEqual(plainTargetIn('folder', '', null), { file: 'folder.excalidraw', overwrite: false });
  assert.equal(MAX_STEM, 110);
});
