// Per-project sync of the drawings folder in its git repo (REPO_DIR): stage + commit only that folder, push only on
// the sync branch. Rules: docs/specs/2026-11-02-excalidraw-hub.md, "Sync a project to git".
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EXT, isSafeName } from './names.js';

export class GitError extends Error {}

/** `git -C repoDir ...args` with a timeout and no prompts; resolves stdout. */
export function gitRunner(repoDir, timeout = 60000) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' };
  return (args) => new Promise((resolve, reject) => {
    execFile('git', ['-C', repoDir, ...args], { env, timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new GitError(`git ${args[0]} failed: ${(stderr || err.message).trim()}`));
      else resolve(stdout);
    });
  });
}

/**
 * The git work tree that contains `dir` (spec: repo detection): {ok: true, top} with top the real path of its top level,
 * or {ok: false, reason}. Never throws. Not ok when git fails (not a repo, dubious ownership, ...) or the top is not visible to the hub.
 */
export async function repoTopLevel(dir, run = gitRunner(dir, 10000)) {
  let top;
  try { top = (await run(['rev-parse', '--show-toplevel'])).trim(); } catch (e) { return { ok: false, reason: `${dir}: ${e.message}` }; } // git's own words
  try { return { ok: true, top: await fs.realpath(top) }; } catch { return { ok: false, reason: `${dir} is in the git repository ${top}, which the hub cannot see` }; }
}

/** "<project> <names> diagram update": changed drawings without the `<project>_` prefix, at most 5. */
export function commitMessage(project, paths) {
  const bases = [];
  for (const p of paths) {
    const name = path.posix.basename(p).replace(/\.(excalidraw|png)$/, '');
    const short = name.startsWith(`${project}_`) ? name.slice(project.length + 1) : name;
    if (!bases.includes(short)) bases.push(short);
  }
  const shown = bases.slice(0, 5).join(', ') + (bases.length > 5 ? ` +${bases.length - 5} more` : '');
  return `${project} ${shown} diagram update`;
}

/**
 * @param {{run: (args: string[]) => Promise<string>, drawingsPath: string, branch?: string}} opts
 * drawingsPath: the drawings folder relative to the repo root, e.g. "docs/drawings".
 */
export function createGit({ run, drawingsPath, branch: syncBranch = 'dev' }) {
  const folderOf = (project) => {
    if (!isSafeName(project)) throw new GitError(`invalid project name: ${JSON.stringify(project)}`);
    return `${path.posix.join(drawingsPath.split(path.sep).join('/'), project)}/`;
  };
  // Pushes run one at a time (outside the hub's queue): two at once would race on the worktree and the remote ref.
  let lane = Promise.resolve();
  const oneAtATime = (fn) => { const r = lane.then(fn); lane = r.catch(() => {}); return r; };
  const count = (args) => run(args).then((s) => Number(s.trim()));

  /**
   * Publish only the drawing commit: cherry-pick it onto origin/<branch> in a throwaway worktree and push that.
   * Only this commit's change goes up, so changes made on origin meanwhile are kept. Where both changed the same
   * file, this commit's version of that file wins. Local unpushed commits stay local.
   */
  async function pushDrawingsOnly(sha) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-sync-'));
    const w = (args) => run(['-C', dir, ...args]); // a later absolute -C wins over the repo's
    let added = false;
    try {
      // No `worktree prune`: inside the container, the user's own worktrees look missing and would be unregistered.
      await run(['worktree', 'add', '-q', '--detach', dir, `origin/${syncBranch}`]);
      added = true;
      const picked = await w(['cherry-pick', '--allow-empty', '--keep-redundant-commits', sha]).then(() => true, () => false);
      if (!picked) {
        // Conflicts only in files both sides changed: take this commit's version of each, keep everything else.
        const conflicted = (await w(['diff', '--name-only', '-z', '--diff-filter=U'])).split('\0').filter(Boolean);
        if (!conflicted.length) throw new GitError('cherry-pick onto origin failed without conflicts');
        for (const f of conflicted) {
          const inOurs = await run(['cat-file', '-e', `${sha}:${f}`]).then(() => true, () => false);
          await w(inOurs ? ['checkout', sha, '--', f] : ['rm', '-q', '--', f]);
          if (inOurs) await w(['add', '--', f]);
        }
        await w(['-c', 'core.editor=true', 'cherry-pick', '--continue']);
      }
      if (await run(['-C', dir, 'diff', '--quiet', `origin/${syncBranch}`, 'HEAD']).then(() => true, () => false)) {
        return { pushed: true, alreadyUpstream: true };
      }
      await w(['push', '-q', 'origin', `HEAD:refs/heads/${syncBranch}`]);
      return { pushed: true, onlyDrawings: true };
    } finally {
      if (added) await run(['worktree', 'remove', '--force', dir]).catch(() => {});
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  return {
    syncBranch,

    /**
     * Stage and commit one project folder. Fast: run it in the hub's serial queue.
     * Asks first (returns needsConfirm, changes nothing) when not on the sync branch. `confirm` lists the questions
     * already answered yes (only 'branch').
     */
    async commit(project, confirm = []) {
      const folder = folderOf(project);
      const branch = (await run(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
      if (branch === 'HEAD') throw new GitError('the repo is on a detached HEAD; check out a branch first');
      for (const ref of ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) {
        const busy = await run(['rev-parse', '-q', '--verify', ref]).then(() => true, () => false);
        if (busy) throw new GitError(`the repo is in the middle of a ${ref.split('_')[0].toLowerCase().replace('cherry', 'cherry-pick')}; finish it first`);
      }
      if (!(await run(['status', '--porcelain', '--untracked-files=all', '--', folder])).trim()) return { nothing: true, branch };
      const onBranch = branch === syncBranch;
      if (!onBranch && !confirm.includes('branch')) return { needsConfirm: 'branch', branch, syncBranch };
      await run(['add', '-A', '--', folder]);
      try {
        const names = (await run(['diff', '--cached', '--name-only', '-z', '--', folder])).split('\0').filter(Boolean);
        const message = commitMessage(project, names.filter((n) => n.endsWith(EXT) || n.endsWith('.png')));
        await run(['commit', '-q', '-m', message, '--', folder]);
        const commit = (await run(['rev-parse', 'HEAD'])).trim();
        return { committed: true, branch, message, sha: commit.slice(0, 7), commit, push: onBranch };
      } catch (e) {
        await run(['reset', '-q', '--', folder]).catch(() => {}); // leave nothing staged behind
        throw e;
      }
    },

    /**
     * Publish the commit just made on the sync branch. Slow (network): run it outside the serial queue. Never throws.
     * Plain push when the branch is exactly one commit (ours) ahead of origin; otherwise only the drawings go up.
     */
    push({ commit }) {
      return oneAtATime(async () => {
        try {
          await run(['fetch', '-q', 'origin', syncBranch]);
          const upstream = `origin/${syncBranch}`;
          const ahead = await count(['rev-list', '--count', `${upstream}..${syncBranch}`]);
          const fastForward = await run(['merge-base', '--is-ancestor', upstream, syncBranch]).then(() => true, () => false);
          if (fastForward && ahead === 1) {
            await run(['push', '-q', 'origin', `${commit}:refs/heads/${syncBranch}`]); // exactly this commit
            return { pushed: true };
          }
          const r = await pushDrawingsOnly(commit);
          await run(['fetch', '-q', 'origin', syncBranch]).catch(() => {});
          return { ...r, keptLocal: Math.max(0, ahead - 1) };
        } catch (e) {
          return { pushed: false, pushError: e.message };
        }
      });
    },
  };
}
