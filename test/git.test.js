// Real git against a temp repo and a bare remote. Needs git: run in the hub image (see README). Skips without it.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { commitMessage, createGit, gitRunner, repoTopLevel } from '../src/git.js';

const hasGit = (() => { try { execFileSync('git', ['--version']); return true; } catch { return false; } })();
Object.assign(process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' });

let repo, remote, git, sh;
const write = async (rel, body = '{}') => { await fs.mkdir(path.dirname(path.join(repo, rel)), { recursive: true }); await fs.writeFile(path.join(repo, rel), body); };
const remoteHead = () => execFileSync('git', ['-C', remote, 'rev-parse', 'dev']).toString().trim();

beforeEach(async () => {
  if (!hasGit) return;
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-git-'));
  remote = path.join(tmp, 'remote.git'); repo = path.join(tmp, 'repo');
  sh = (...args) => execFileSync('git', ['-C', repo, ...args]).toString();
  execFileSync('git', ['init', '-q', '--bare', '-b', 'dev', remote]);
  execFileSync('git', ['init', '-q', '-b', 'dev', repo]);
  await write('docs/drawings/chartroom/chartroom_v0.excalidraw'); await write('README.md', 'x');
  sh('add', '-A'); sh('commit', '-qm', 'init'); sh('remote', 'add', 'origin', remote); sh('push', '-q', 'origin', 'dev');
  git = createGit({ run: gitRunner(repo), drawingsPath: 'docs/drawings', branch: 'dev' });
});

test('commitMessage: names without the project prefix, png folded in, at most 5', () => {
  assert.equal(commitMessage('chartroom', ['docs/drawings/chartroom/chartroom_v2.excalidraw', 'docs/drawings/chartroom/chartroom_v2.png']), 'chartroom v2 diagram update');
  assert.equal(commitMessage('p', ['p/board.excalidraw', 'p/p_v1_x.excalidraw']), 'p board, v1_x diagram update');
  assert.equal(commitMessage('p', ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((n) => `p/${n}.excalidraw`)), 'p a, b, c, d, e +2 more diagram update');
});

test('on dev: commits only the project folder (new untracked folder too) and pushes', { skip: !hasGit }, async () => {
  await write('docs/drawings/chartroom/chartroom_v1.excalidraw'); await write('docs/drawings/chartroom/chartroom_v1.png', 'png');
  await write('docs/drawings/newproj/newproj_v0.excalidraw');
  await write('README.md', 'staged elsewhere'); sh('add', 'README.md');
  const before = remoteHead();
  const r = await git.commit('chartroom');
  assert.deepEqual([r.committed, r.push, r.message], [true, true, 'chartroom v1 diagram update']);
  assert.deepEqual(sh('show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort(), ['docs/drawings/chartroom/chartroom_v1.excalidraw', 'docs/drawings/chartroom/chartroom_v1.png']);
  assert.match(sh('status', '--porcelain'), /^M  README\.md$/m, 'the other staged file stays staged and uncommitted');
  const p = await git.push(r);
  assert.deepEqual(p, { pushed: true }, 'nothing else unpushed: a plain push');
  assert.notEqual(remoteHead(), before);
  assert.equal(remoteHead(), sh('rev-parse', 'HEAD').trim());
  assert.equal((await git.commit('newproj')).message, 'newproj v0 diagram update', 'an all-new folder works');
});

test('deletions are committed; nothing changed means no commit', { skip: !hasGit }, async () => {
  assert.deepEqual(await git.commit('chartroom'), { nothing: true, branch: 'dev' });
  await fs.unlink(path.join(repo, 'docs/drawings/chartroom/chartroom_v0.excalidraw'));
  const r = await git.commit('chartroom');
  assert.equal(r.committed, true);
  assert.match(sh('show', '--name-status', '--format=', 'HEAD'), /^D\tdocs\/drawings\/chartroom\/chartroom_v0\.excalidraw/m);
});

test('not on dev: asks first and stages nothing; confirmed commits locally without pushing', { skip: !hasGit }, async () => {
  sh('switch', '-qc', 'feat/x');
  await write('docs/drawings/chartroom/chartroom_v1.excalidraw');
  assert.deepEqual(await git.commit('chartroom'), { needsConfirm: 'branch', branch: 'feat/x', syncBranch: 'dev' });
  assert.equal(sh('diff', '--cached', '--name-only').trim(), '', 'declining leaves nothing staged');
  const before = remoteHead();
  const r = await git.commit('chartroom', ['branch']);
  assert.deepEqual([r.committed, r.push, r.branch], [true, false, 'feat/x']);
  assert.equal(remoteHead(), before, 'remote unchanged');
});

test('a failed push keeps the commit and reports git\'s error', { skip: !hasGit }, async () => {
  sh('remote', 'set-url', 'origin', path.join(path.dirname(remote), 'nowhere.git'));
  await write('docs/drawings/chartroom/chartroom_v1.excalidraw');
  const r = await git.commit('chartroom');
  const p = await git.push(r);
  assert.equal(p.pushed, false);
  assert.match(p.pushError, /git (push|fetch) failed/);
  assert.equal(sh('log', '-1', '--format=%s').trim(), r.message);
});

test('a failed commit leaves nothing staged; bad project names are refused', { skip: !hasGit }, async () => {
  await write('docs/drawings/chartroom/chartroom_v1.excalidraw');
  const failing = createGit({ run: async (args) => { if (args[0] === 'commit') throw new Error('hook said no'); return gitRunner(repo)(args); }, drawingsPath: 'docs/drawings' });
  await assert.rejects(failing.commit('chartroom'), /hook said no/);
  assert.equal(sh('diff', '--cached', '--name-only').trim(), '');
  await assert.rejects(git.commit('../..'), /invalid project name/);
});

test('on dev with other unpushed commits: pushes only the drawings, no question; pull --rebase then leaves one copy', { skip: !hasGit }, async () => {
  await write('notes.md', 'wip'); sh('add', 'notes.md'); sh('commit', '-qm', 'wip');
  await write('docs/drawings/chartroom/chartroom_v1.excalidraw', '{"v":1}');
  const before = remoteHead();
  const r = await git.commit('chartroom');
  assert.equal(r.committed, true, 'no confirmation needed');
  const p = await git.push(r);
  assert.deepEqual(p, { pushed: true, onlyDrawings: true, keptLocal: 1 });
  const rgit = (...a) => execFileSync('git', ['-C', remote, ...a]).toString();
  assert.equal(rgit('rev-parse', 'dev^').trim(), before, 'the remote got exactly one new commit');
  assert.equal(rgit('log', '-1', '--format=%s', 'dev').trim(), 'chartroom v1 diagram update');
  assert.equal(rgit('show', 'dev:docs/drawings/chartroom/chartroom_v1.excalidraw'), '{"v":1}');
  assert.throws(() => rgit('cat-file', '-e', 'dev:notes.md'), 'the wip commit stayed local');
  assert.equal(sh('log', '-1', '--format=%s').trim(), 'chartroom v1 diagram update', 'local branch untouched');
  // What the user runs before pushing dev themselves: the local copy of the drawing commit is dropped.
  sh('pull', '-q', '--rebase', 'origin', 'dev');
  assert.deepEqual(sh('log', '--format=%s', 'dev').trim().split('\n'), ['wip', 'chartroom v1 diagram update', 'init']);
  sh('push', '-q', 'origin', 'dev');
});

test('remote moved on (someone else pushed): the drawings go on top of it', { skip: !hasGit }, async () => {
  const other = path.join(path.dirname(repo), 'other');
  execFileSync('git', ['clone', '-q', '-b', 'dev', remote, other]);
  await fs.writeFile(path.join(other, 'theirs.md'), 'x');
  execFileSync('git', ['-C', other, 'add', '-A']); execFileSync('git', ['-C', other, 'commit', '-qm', 'theirs']); execFileSync('git', ['-C', other, 'push', '-q']);
  await write('docs/drawings/chartroom/chartroom_v0.excalidraw', '{"changed":true}');
  const p = await git.push(await git.commit('chartroom'));
  assert.deepEqual(p, { pushed: true, onlyDrawings: true, keptLocal: 0 });
  assert.equal(execFileSync('git', ['-C', remote, 'log', '-1', '--format=%s', 'dev^']).toString().trim(), 'theirs');
  assert.equal(sh('worktree', 'list').trim().split('\n').length, 1, 'temporary worktree removed');
});

test('drawings-only push keeps changes made on origin, also inside the folder', { skip: !hasGit }, async () => {
  const other = path.join(path.dirname(repo), 'other');
  execFileSync('git', ['clone', '-q', '-b', 'dev', remote, other]);
  await fs.writeFile(path.join(other, 'docs/drawings/chartroom/from-elsewhere.excalidraw'), 'theirs');
  execFileSync('git', ['-C', other, 'add', '-A']); execFileSync('git', ['-C', other, 'commit', '-qm', 'theirs']); execFileSync('git', ['-C', other, 'push', '-q']);
  await write('notes.md', 'wip'); sh('add', 'notes.md'); sh('commit', '-qm', 'wip');
  await write('docs/drawings/chartroom/chartroom_v1.excalidraw', 'ours');
  const p = await git.push(await git.commit('chartroom'));
  assert.deepEqual(p, { pushed: true, onlyDrawings: true, keptLocal: 1 });
  const show = (f) => execFileSync('git', ['-C', remote, 'show', `dev:${f}`]).toString();
  assert.equal(show('docs/drawings/chartroom/from-elsewhere.excalidraw'), 'theirs', 'remote-only drawing kept');
  assert.equal(show('docs/drawings/chartroom/chartroom_v1.excalidraw'), 'ours');
});

test('both sides changed the same drawing: ours wins for that file only; repeated syncs then rebase cleanly', { skip: !hasGit }, async () => {
  const other = path.join(path.dirname(repo), 'other');
  execFileSync('git', ['clone', '-q', '-b', 'dev', remote, other]);
  await fs.writeFile(path.join(other, 'docs/drawings/chartroom/chartroom_v0.excalidraw'), 'theirs');
  execFileSync('git', ['-C', other, 'commit', '-qam', 'theirs']); execFileSync('git', ['-C', other, 'push', '-q']);
  await write('notes.md', 'wip'); sh('add', 'notes.md'); sh('commit', '-qm', 'wip');
  await write('docs/drawings/chartroom/chartroom_v0.excalidraw', 'ours 1');
  assert.equal((await git.push(await git.commit('chartroom'))).pushed, true);
  assert.equal(execFileSync('git', ['-C', remote, 'show', 'dev:docs/drawings/chartroom/chartroom_v0.excalidraw']).toString(), 'ours 1');
  await write('docs/drawings/chartroom/chartroom_v0.excalidraw', 'ours 2'); // a second sync while the first copy is still local
  assert.equal((await git.push(await git.commit('chartroom'))).pushed, true);
  assert.equal(execFileSync('git', ['-C', remote, 'show', 'dev:docs/drawings/chartroom/chartroom_v0.excalidraw']).toString(), 'ours 2');
  assert.equal(sh('worktree', 'list').trim().split('\n').length, 1, 'no worktree left behind');
});

test('never unregisters the user\'s own worktrees', { skip: !hasGit }, async () => {
  const mine = path.join(path.dirname(repo), 'mine');
  sh('worktree', 'add', '-q', '-b', 'mine', mine);
  // Simulate the container's view: the worktree path does not exist there.
  await fs.rename(mine, `${mine}-hidden`);
  await write('notes.md', 'wip'); sh('add', 'notes.md'); sh('commit', '-qm', 'wip');
  await write('docs/drawings/chartroom/chartroom_v1.excalidraw');
  assert.equal((await git.push(await git.commit('chartroom'))).onlyDrawings, true);
  await fs.rename(`${mine}-hidden`, mine);
  assert.match(sh('worktree', 'list'), /mine/);
});

test('refuses a detached HEAD and a merge in progress, touching nothing', { skip: !hasGit }, async () => {
  await write('docs/drawings/chartroom/chartroom_v1.excalidraw');
  sh('switch', '-q', '--detach');
  await assert.rejects(git.commit('chartroom', ['branch']), /detached HEAD/);
  sh('switch', '-q', 'dev');
  sh('switch', '-qc', 'side'); await write('README.md', 'side'); sh('commit', '-qam', 'side');
  sh('switch', '-q', 'dev'); await write('README.md', 'dev'); sh('commit', '-qam', 'dev');
  try { sh('merge', '-q', 'side'); } catch { /* conflict expected */ }
  await assert.rejects(git.commit('chartroom', ['branch']), /middle of a merge/);
  assert.match(sh('status', '--porcelain'), /^UU README\.md$/m, 'conflict state untouched');
});

test('repoTopLevel: the work tree containing a folder, or the reason (no repo)', { skip: !hasGit }, async () => {
  const top = await fs.realpath(repo);
  assert.deepEqual(await repoTopLevel(repo), { ok: true, top });
  assert.deepEqual(await repoTopLevel(path.join(repo, 'docs', 'drawings')), { ok: true, top }, 'a folder inside the repo reports the repo top');
  const plain = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-nogit-'));
  assert.match((await repoTopLevel(plain)).reason, /not a git repository/);
  // A drawings folder that is the repo itself (HUB_DRAWINGS_SUBDIR=.) syncs with an empty drawings path.
  const flat = createGit({ run: gitRunner(repo), drawingsPath: '', branch: 'dev' });
  await write('chartroom2/chartroom2_v0.excalidraw');
  const res = await flat.commit('chartroom2');
  assert.equal(res.committed, true);
  assert.deepEqual(sh('show', '--name-only', '--format=', 'HEAD').trim().split('\n'), ['chartroom2/chartroom2_v0.excalidraw']);
});
