import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSafeName, parseDrawing, nextVersion, saveName, sortDrawings } from '../src/names.js';

test('isSafeName accepts plain names and rejects traversal or odd characters', () => {
  for (const ok of ['ai-map', 'f1-title-2026', 'budgeting_v1_plan', 'a.b']) assert.equal(isSafeName(ok), true, ok);
  for (const bad of ['', '.', '..', '../x', 'a/b', 'a\\b', '.hidden', 'a..b', 'x y', 'a\0', '-x', 'é', 'a'.repeat(200), null, 3]) assert.equal(isSafeName(bad), false, String(bad));
});

test('parseDrawing reads version and label from the naming scheme', () => {
  assert.deepEqual(parseDrawing('budgeting', 'budgeting_v1_plan_with_proposal.excalidraw'), { file: 'budgeting_v1_plan_with_proposal.excalidraw', base: 'budgeting_v1_plan_with_proposal', version: 1, label: 'plan_with_proposal' });
  assert.deepEqual(parseDrawing('ai-map', 'ai-map_v0.excalidraw'), { file: 'ai-map_v0.excalidraw', base: 'ai-map_v0', version: 0, label: null });
  assert.deepEqual(parseDrawing('ai-map', 'board-before-clear.excalidraw'), { file: 'board-before-clear.excalidraw', base: 'board-before-clear', version: null, label: null });
  assert.equal(parseDrawing('ai-map', 'ai-map_v0.png'), null);
  assert.equal(parseDrawing('ai', 'ai-map_v3.excalidraw').version, null, 'prefix of another project is not a version');
});

test('nextVersion is max+1, or 0 when nothing follows the scheme', () => {
  assert.equal(nextVersion('budgeting', ['budgeting_v0_plan.excalidraw', 'budgeting_v1_plan_with_proposal.excalidraw']), 2);
  assert.equal(nextVersion('f1-title-2026', ['board-with-f1.excalidraw']), 0);
  assert.equal(nextVersion('x', []), 0);
  assert.equal(nextVersion('x', ['x_v2.excalidraw', 'x_v10_a.excalidraw', 'x_v3.png']), 11);
});

test('saveName builds a scheme name and slugs the label', () => {
  assert.equal(saveName('budgeting', 2, ''), 'budgeting_v2.excalidraw');
  assert.equal(saveName('budgeting', 2, '  New Idea / draft! '), 'budgeting_v2_new_idea_draft.excalidraw');
  assert.equal(saveName('budgeting', 2, '!!!'), 'budgeting_v2.excalidraw');
});

test('sortDrawings puts versions first, highest first, marks latest, then the rest by name', () => {
  const out = sortDrawings('ai-map', ['board-before-clear.excalidraw', 'ai-map_v0.excalidraw', 'ai-map_v2_x.excalidraw', 'board-before-ai-map.excalidraw']);
  assert.deepEqual(out.map((d) => [d.file, d.latest]), [
    ['ai-map_v2_x.excalidraw', true], ['ai-map_v0.excalidraw', false],
    ['board-before-ai-map.excalidraw', false], ['board-before-clear.excalidraw', false]]);
});

test('huge version numbers are not versions; long names still fit', () => {
  assert.equal(parseDrawing('p', 'p_v1000000000000000000000.excalidraw').version, null);
  assert.equal(nextVersion('p', ['p_v1000000000000000000000.excalidraw', 'p_v4.excalidraw']), 5);
  const project = 'p'.repeat(110);
  const name = saveName(project, 12, 'a long label that will not fit');
  assert.equal(isSafeName(name.slice(0, -'.excalidraw'.length)), true, name);
});
