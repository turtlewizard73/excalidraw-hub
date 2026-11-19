// Real git against a temp repo and a bare remote. Needs git: run in the hub image (see README). Skips without it.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { commitMessage, createGit, drawingPathspecs, gitIgnored, gitRunner, repoTopLevel } from '../src/git.js';

const hasGit = (() => { try { execFileSync('git', ['--version']); return true; } catch { return false; } })();
Object.assign(process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' });

const F = 'docs/drawings/chartroom'; // the folder that gets synced
let tmp, repo, remote, git, sh;
const write = async (rel, body = '{}') => { await fs.mkdir(path.dirname(path.join(repo, rel)), { recursive: true }); await fs.writeFile(path.join(repo, rel), body); };
const rgit = (...a) => execFileSync('git', ['-C', remote, ...a]).toString();
const remoteHead = () => rgit('rev-parse', 'dev').trim();
/** Another person's clone: commit `files` ({rel: body}) and push to dev. */
const elsewhere = async (files, message = 'theirs') => {
  const other = path.join(tmp, 'other');
  await fs.rm(other, { recursive: true, force: true });
  execFileSync('git', ['clone', '-q', '-b', 'dev', remote, other]);
  for (const [rel, body] of Object.entries(files)) { await fs.mkdir(path.dirname(path.join(other, rel)), { recursive: true }); await fs.writeFile(path.join(other, rel), body); }
  execFileSync('git', ['-C', other, 'add', '-A']); execFileSync('git', ['-C', other, 'commit', '-qm', message]); execFileSync('git', ['-C', other, 'push', '-q']);
};

beforeEach(async () => {
  if (!hasGit) return;
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-git-'));
  remote = path.join(tmp, 'remote.git'); repo = path.join(tmp, 'repo');
  sh = (...args) => execFileSync('git', ['-C', repo, ...args]).toString();
  execFileSync('git', ['init', '-q', '--bare', '-b', 'dev', remote]);
  execFileSync('git', ['init', '-q', '-b', 'dev', repo]);
  await write(`${F}/chartroom_v0.excalidraw`); await write('README.md', 'x');
  sh('add', '-A'); sh('commit', '-qm', 'init'); sh('remote', 'add', 'origin', remote); sh('push', '-q', '-u', 'origin', 'dev');
  git = createGit({ run: gitRunner(repo) });
});

test('commitMessage: names without the folder prefix, png folded in, at most 5', () => {
  assert.equal(commitMessage('chartroom', [`${F}/chartroom_v2.excalidraw`, `${F}/chartroom_v2.png`]), 'chartroom v2 diagram update');
  assert.equal(commitMessage('p', ['p/board.excalidraw', 'p/p_v1_x.excalidraw']), 'p board, v1_x diagram update');
  assert.equal(commitMessage('p', ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((n) => `p/${n}.excalidraw`)), 'p a, b, c, d, e +2 more diagram update');
});

test('drawingPathspecs: directly in the folder and below, only drawings and pngs; glob characters are escaped', () => {
  assert.deepEqual(drawingPathspecs('a/b'), [':(glob)a/b/*.excalidraw', ':(glob)a/b/**/*.excalidraw', ':(glob)a/b/*.png', ':(glob)a/b/**/*.png']);
  assert.equal(drawingPathspecs('')[0], ':(glob)*.excalidraw');
  assert.equal(drawingPathspecs('we[ir]d*')[0], ':(glob)we\\[ir\\]d\\*/*.excalidraw');
});

test('on an auto branch, level with the remote: commits only drawings and pngs under the folder and pushes plainly', { skip: !hasGit }, async () => {
  await write(`${F}/chartroom_v1.excalidraw`); await write(`${F}/chartroom_v1.png`, 'png');
  await write(`${F}/sub/deep/new_v0.excalidraw`);
  await write(`${F}/notes.txt`, 'not a drawing'); await write(`${F}/.hidden/h.excalidraw`); await write(`${F}/node_modules/m.excalidraw`);
  await write('docs/drawings/other/o_v0.excalidraw'); // a sibling folder: not under the clicked one
  await write('README.md', 'staged elsewhere'); sh('add', 'README.md');
  const before = remoteHead();
  const r = await git.sync(F);
  assert.deepEqual([r.committed, r.pushed, r.branch], [true, true, 'dev']);
  assert.match(r.message, /^chartroom (v1, new_v0|new_v0, v1) diagram update$/);
  assert.deepEqual(sh('show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort(), [`${F}/chartroom_v1.excalidraw`, `${F}/chartroom_v1.png`, `${F}/sub/deep/new_v0.excalidraw`]);
  const status = sh('status', '--porcelain', '--untracked-files=all');
  assert.match(status, /^M {2}README\.md$/m, 'the other staged file stays staged and uncommitted');
  for (const left of [`${F}/notes.txt`, `${F}/.hidden/h.excalidraw`, `${F}/node_modules/m.excalidraw`, 'docs/drawings/other/o_v0.excalidraw']) assert.ok(status.includes(`?? ${left}`), `${left} left alone`);
  assert.notEqual(remoteHead(), before);
  assert.equal(remoteHead(), sh('rev-parse', 'HEAD').trim(), 'a plain push: remote equals local');
  assert.equal(r.fastForwarded, undefined);
});

test('works for a folder at depth 0 (the repo top) and for deleted drawings; nothing changed means no commit', { skip: !hasGit }, async () => {
  assert.deepEqual(await git.sync(F), { branch: 'dev', nothing: true });
  await fs.unlink(path.join(repo, F, 'chartroom_v0.excalidraw'));
  const r = await git.sync(F);
  assert.equal(r.committed, true);
  assert.match(sh('show', '--name-status', '--format=', 'HEAD'), /^D\tdocs\/drawings\/chartroom\/chartroom_v0\.excalidraw/m);
  await write('top_v0.excalidraw'); await write('deeper/x/y_v0.excalidraw');
  const top = await git.sync('');
  assert.equal(top.committed, true);
  assert.deepEqual(sh('show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort(), ['deeper/x/y_v0.excalidraw', 'top_v0.excalidraw']);
  assert.match(top.message, /^repo /, 'the repo folder\'s name labels a top-level sync');
});

test('behind the remote: the checkout is fast-forwarded first, then our commit goes up as a plain push', { skip: !hasGit }, async () => {
  await elsewhere({ 'docs/drawings/theirs/t_v0.excalidraw': '{"theirs":1}', 'README.md': 'new readme' });
  await write(`${F}/chartroom_v1.excalidraw`);
  const r = await git.sync(F);
  assert.deepEqual([r.committed, r.pushed, r.fastForwarded, r.onlyDrawings], [true, true, 1, undefined]);
  assert.equal(await fs.readFile(path.join(repo, 'README.md'), 'utf8'), 'new readme', 'the checkout has their change');
  await fs.access(path.join(repo, 'docs/drawings/theirs/t_v0.excalidraw'));
  assert.equal(remoteHead(), sh('rev-parse', 'HEAD').trim());
  assert.equal(sh('log', '--format=%s').trim().split('\n').length, 3);
});

test('nothing to commit but behind: still brings the checkout up to date', { skip: !hasGit }, async () => {
  await elsewhere({ 'README.md': 'newer' });
  assert.deepEqual(await git.sync(F), { branch: 'dev', fastForwarded: 1, nothing: true });
  assert.equal(await fs.readFile(path.join(repo, 'README.md'), 'utf8'), 'newer');
});

test('fast-forward refused by a local edit: the checkout is left, the drawings still go up on top of the remote', { skip: !hasGit }, async () => {
  await elsewhere({ 'README.md': 'theirs readme' });
  await write('README.md', 'my local edit'); // unstaged, outside the folder: ff would overwrite it
  await write(`${F}/chartroom_v1.excalidraw`, '{"ours":1}');
  const before = sh('rev-parse', 'HEAD').trim();
  const r = await git.sync(F);
  assert.match(r.notUpdated, /overwritten|local changes/);
  assert.deepEqual([r.committed, r.pushed, r.onlyDrawings, r.keptLocal], [true, true, true, 0]);
  assert.equal(await fs.readFile(path.join(repo, 'README.md'), 'utf8'), 'my local edit', 'the edit survives');
  assert.equal(sh('rev-parse', 'HEAD~1').trim(), before, 'checkout not moved: our commit sits on the old head');
  assert.equal(rgit('show', 'dev:README.md'), 'theirs readme');
  assert.equal(rgit('show', `dev:${F}/chartroom_v1.excalidraw`), '{"ours":1}');
});

test('own unpushed commits: the checkout is left as is and only the drawings go up; pull --rebase then leaves one copy', { skip: !hasGit }, async () => {
  await write('notes.md', 'wip'); sh('add', 'notes.md'); sh('commit', '-qm', 'wip');
  await write(`${F}/chartroom_v1.excalidraw`, '{"v":1}');
  const before = remoteHead();
  const r = await git.sync(F);
  assert.deepEqual([r.committed, r.pushed, r.onlyDrawings, r.keptLocal], [true, true, true, 1]);
  assert.match(r.note, /git pull --rebase/);
  assert.equal(rgit('rev-parse', 'dev^').trim(), before, 'the remote got exactly one new commit');
  assert.equal(rgit('show', `dev:${F}/chartroom_v1.excalidraw`), '{"v":1}');
  assert.throws(() => rgit('cat-file', '-e', 'dev:notes.md'), 'the wip commit stayed local');
  assert.equal(sh('log', '-1', '--format=%s').trim(), r.message, 'local branch untouched');
  sh('pull', '-q', '--rebase', 'origin', 'dev');
  assert.deepEqual(sh('log', '--format=%s', 'dev').trim().split('\n'), ['wip', r.message, 'init']);
});

test('the remote moves between the fetch and the push: the drawings are rebuilt on top of it', { skip: !hasGit }, async () => {
  const real = gitRunner(repo);
  let moved = false;
  const racing = createGit({ run: async (args) => {
    if (args[0] === 'push' && !moved) { moved = true; await elsewhere({ 'theirs.md': 'x' }); }
    return real(args);
  } });
  await write(`${F}/chartroom_v1.excalidraw`, '{"ours":1}');
  const r = await racing.sync(F);
  assert.deepEqual([r.pushed, r.onlyDrawings, r.keptLocal], [true, true, 0]);
  assert.equal(rgit('log', '-1', '--format=%s', 'dev^').trim(), 'theirs');
  assert.equal(rgit('show', `dev:${F}/chartroom_v1.excalidraw`), '{"ours":1}');
  assert.equal(sh('worktree', 'list').trim().split('\n').length, 1, 'temporary worktree removed');
});

test('no upstream: commits locally, says so, pushes nothing', { skip: !hasGit }, async () => {
  sh('branch', '--unset-upstream');
  await write(`${F}/chartroom_v1.excalidraw`);
  const before = remoteHead();
  const r = await git.sync(F);
  assert.deepEqual([r.committed, r.pushed, r.noUpstream], [true, false, true]);
  assert.match(r.note, /no upstream/);
  assert.equal(remoteHead(), before);
  assert.equal(sh('log', '-1', '--format=%s').trim(), r.message);
});

test('not on an auto branch: asks first and changes nothing; confirmed, it commits and pushes to that branch\'s own upstream', { skip: !hasGit }, async () => {
  sh('switch', '-qc', 'feat/x');
  await write(`${F}/chartroom_v1.excalidraw`);
  assert.deepEqual(await git.sync(F), { needsConfirm: 'branch', branch: 'feat/x' });
  assert.equal(sh('diff', '--cached', '--name-only').trim(), '', 'declining leaves nothing staged');
  const before = remoteHead();
  const r = await git.sync(F, { confirm: ['branch'] });
  assert.deepEqual([r.committed, r.pushed, r.noUpstream, r.branch], [true, false, true, 'feat/x']);
  assert.equal(remoteHead(), before, 'dev on the remote unchanged');
  sh('push', '-q', '-u', 'origin', 'feat/x');
  await write(`${F}/chartroom_v2.excalidraw`);
  const r2 = await git.sync(F, { confirm: ['branch'] });
  assert.equal(r2.pushed, true);
  assert.equal(rgit('rev-parse', 'feat/x').trim(), sh('rev-parse', 'HEAD').trim());
  assert.equal(remoteHead(), before);
  assert.deepEqual(await createGit({ run: gitRunner(repo), autoBranches: ['feat/x'] }).sync(F), { branch: 'feat/x', nothing: true });
});

test('on a non-auto branch with nothing to commit, no question and nothing touched', { skip: !hasGit }, async () => {
  sh('switch', '-qc', 'feat/x');
  assert.deepEqual(await git.sync(F), { nothing: true, branch: 'feat/x' });
});

test('an unreachable remote keeps the commit and reports git\'s error', { skip: !hasGit }, async () => {
  sh('remote', 'set-url', 'origin', path.join(tmp, 'nowhere.git'));
  await write(`${F}/chartroom_v1.excalidraw`);
  const r = await git.sync(F);
  assert.equal(r.committed, true);
  assert.equal(r.pushed, false);
  assert.match(r.pushError, /git fetch failed/);
  assert.equal(sh('log', '-1', '--format=%s').trim(), r.message);
});

test('a failed commit leaves nothing staged', { skip: !hasGit }, async () => {
  await write(`${F}/chartroom_v1.excalidraw`);
  const real = gitRunner(repo);
  const failing = createGit({ run: async (args) => { if (args[0] === 'commit') throw new Error('hook said no'); return real(args); } });
  await assert.rejects(failing.sync(F), /hook said no/);
  assert.equal(sh('diff', '--cached', '--name-only').trim(), '');
});

test('local steps run through the serial wrapper, network steps do not', { skip: !hasGit }, async () => {
  await elsewhere({ 'README.md': 'newer' });
  await write(`${F}/chartroom_v1.excalidraw`);
  const wrapped = [];
  const real = gitRunner(repo);
  const spy = createGit({ run: real });
  await spy.sync(F, { serial: async (fn) => { wrapped.push(1); return fn(); } });
  assert.equal(wrapped.length, 2, 'the fast-forward and the commit');
});

test('two syncs on one repo run one after the other', { skip: !hasGit }, async () => {
  await write(`${F}/chartroom_v1.excalidraw`);
  const [a, b] = await Promise.all([git.sync(F), git.sync(F)]);
  assert.deepEqual([a.committed, b.nothing], [true, true]);
});

test('both sides changed the same drawing: ours wins for that file only; repeated syncs then work', { skip: !hasGit }, async () => {
  await elsewhere({ [`${F}/chartroom_v0.excalidraw`]: 'theirs' });
  await write('notes.md', 'wip'); sh('add', 'notes.md'); sh('commit', '-qm', 'wip');
  await write(`${F}/chartroom_v0.excalidraw`, 'ours 1');
  assert.equal((await git.sync(F)).pushed, true);
  assert.equal(rgit('show', `dev:${F}/chartroom_v0.excalidraw`), 'ours 1');
  await write(`${F}/chartroom_v0.excalidraw`, 'ours 2');
  assert.equal((await git.sync(F)).pushed, true);
  assert.equal(rgit('show', `dev:${F}/chartroom_v0.excalidraw`), 'ours 2');
  assert.equal(sh('worktree', 'list').trim().split('\n').length, 1, 'no worktree left behind');
});

test('never unregisters the user\'s own worktrees', { skip: !hasGit }, async () => {
  const mine = path.join(tmp, 'mine');
  sh('worktree', 'add', '-q', '-b', 'mine', mine);
  await fs.rename(mine, `${mine}-hidden`); // the container's view: the worktree path does not exist there
  await write('notes.md', 'wip'); sh('add', 'notes.md'); sh('commit', '-qm', 'wip');
  await write(`${F}/chartroom_v1.excalidraw`);
  assert.equal((await git.sync(F)).onlyDrawings, true);
  await fs.rename(`${mine}-hidden`, mine);
  assert.match(sh('worktree', 'list'), /mine/);
});

test('refuses a detached HEAD and a merge in progress, touching nothing', { skip: !hasGit }, async () => {
  await write(`${F}/chartroom_v1.excalidraw`);
  sh('switch', '-q', '--detach');
  await assert.rejects(git.sync(F, { confirm: ['branch'] }), /detached HEAD/);
  sh('switch', '-q', 'dev');
  sh('switch', '-qc', 'side'); await write('README.md', 'side'); sh('commit', '-qam', 'side');
  sh('switch', '-q', 'dev'); await write('README.md', 'dev'); sh('commit', '-qam', 'dev');
  try { sh('merge', '-q', 'side'); } catch { /* conflict expected */ }
  await assert.rejects(git.sync(F, { confirm: ['branch'] }), /middle of a merge/);
  assert.match(sh('status', '--porcelain'), /^UU README\.md$/m, 'conflict state untouched');
});

test('repoTopLevel: the work tree containing a folder, or the reason (no repo)', { skip: !hasGit }, async () => {
  const top = await fs.realpath(repo);
  assert.deepEqual(await repoTopLevel(repo), { ok: true, top });
  assert.deepEqual(await repoTopLevel(path.join(repo, 'docs', 'drawings')), { ok: true, top }, 'a folder inside the repo reports the repo top');
  const plain = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-nogit-'));
  assert.match((await repoTopLevel(plain)).reason, /not a git repository/);
});

test('gitIgnored: asks git once; returns the ignored ones, nothing when git fails or none match', { skip: !hasGit }, async () => {
  await write('.gitignore', 'build/\n');
  await write('build/x'); await write('keep/x');
  assert.deepEqual([...await gitIgnored(repo, ['build/', 'keep/'])], ['build/']);
  assert.deepEqual([...await gitIgnored(repo, ['keep/'])], []);
  assert.deepEqual([...await gitIgnored(path.join(tmp, 'missing'), ['a/'])], []);
  assert.deepEqual([...await gitIgnored(repo, [])], []);
});
