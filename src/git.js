// Sync of one folder of a git repo: update the checkout when it is strictly behind, commit the folder's drawings and PNGs,
// push to the branch's upstream. Rules: docs/specs/2026-11-19-standalone-workspace.md, "Sync".
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
 * Which of `paths` (relative to `repoDir`; give directories a trailing slash) git ignores, in one `check-ignore --stdin` call.
 * Never throws: if git fails, nothing counts as ignored.
 */
export function gitIgnored(repoDir, paths, timeout = 10000) {
  if (!paths.length) return Promise.resolve(new Set());
  return new Promise((resolve) => {
    const child = execFile('git', ['-C', repoDir, 'check-ignore', '-z', '--stdin'], { timeout, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (err, stdout) => {
      // exit 1 = nothing ignored; anything else (not a repo, timeout) is treated the same
      resolve(err ? new Set() : new Set(stdout.split('\0').filter(Boolean)));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(paths.join('\0') + '\0');
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

/** "<folder> <names> diagram update": changed drawings without the `<folder>_` prefix, at most 5. */
export function commitMessage(label, paths) {
  const bases = [];
  for (const p of paths) {
    const name = path.posix.basename(p).replace(/\.(excalidraw|png)$/, '');
    const short = name.startsWith(`${label}_`) ? name.slice(label.length + 1) : name;
    if (!bases.includes(short)) bases.push(short);
  }
  const shown = bases.slice(0, 5).join(', ') + (bases.length > 5 ? ` +${bases.length - 5} more` : '');
  return `${label} ${shown} diagram update`;
}

const LITERAL = ['--literal-pathspecs'];
const escapeGlob = (s) => s.replace(/[\\*?[\]]/g, '\\$&');
/** Pathspecs for the drawings and PNGs under `dir` (relative to the repo top, '' = the top), directly in it and at any depth. */
export function drawingPathspecs(dir) {
  const base = dir ? `${escapeGlob(dir)}/` : '';
  return ['excalidraw', 'png'].flatMap((ext) => [`:(glob)${base}*.${ext}`, `:(glob)${base}**/*.${ext}`]);
}

/** Files git reports changed under the pathspecs (`status --porcelain -z`), renames as both paths. Hidden folders and node_modules are not drawings the explorer shows. */
async function changedFiles(run, dir, specs) {
  const parts = (await run(['status', '--porcelain', '-z', '--untracked-files=all', '--', ...specs])).split('\0');
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry) continue;
    files.push(entry.slice(3));
    if (entry[0] === 'R' || entry[0] === 'C') files.push(parts[++i]);
  }
  const inside = (f) => (dir ? f.slice(dir.length + 1) : f).split('/').slice(0, -1);
  return files.filter((f) => !inside(f).some((seg) => seg.startsWith('.') || seg === 'node_modules'));
}

/**
 * One git client per repo top level: everything on it runs one at a time (a second sync would race on the worktree and the remote ref).
 * @param {{run: (args: string[]) => Promise<string>, autoBranches?: string[]}} opts
 * autoBranches: branches where sync commits and pushes without asking.
 */
export function createGit({ run, autoBranches = ['development', 'dev'] }) {
  let lane = Promise.resolve();
  const oneAtATime = (fn) => { const r = lane.then(fn); lane = r.catch(() => {}); return r; };
  const ok = (args) => run(args).then(() => true, () => false);
  const count = (args) => run(args).then((s) => Number(s.trim()));

  /**
   * Publish only the drawing commit: cherry-pick it onto the upstream in a throwaway worktree and push that.
   * Only this commit's change goes up, so changes made on the remote meanwhile are kept. Where both changed the same
   * file, this commit's version of that file wins. Local unpushed commits stay local.
   */
  async function pushDrawingsOnly(sha, remote, rbranch) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-sync-'));
    const w = (args) => run(['-C', dir, ...args]); // a later absolute -C wins over the repo's
    let added = false;
    try {
      // No `worktree prune`: inside the container, the user's own worktrees look missing and would be unregistered.
      await run(['worktree', 'add', '-q', '--detach', dir, `${remote}/${rbranch}`]);
      added = true;
      const picked = await w(['cherry-pick', '--allow-empty', '--keep-redundant-commits', sha]).then(() => true, () => false);
      if (!picked) {
        // Conflicts only in files both sides changed: take this commit's version of each, keep everything else.
        const conflicted = (await w(['diff', '--name-only', '-z', '--diff-filter=U'])).split('\0').filter(Boolean);
        if (!conflicted.length) throw new GitError('cherry-pick onto the remote failed without conflicts');
        for (const f of conflicted) {
          const inOurs = await ok(['cat-file', '-e', `${sha}:${f}`]);
          await w(inOurs ? ['checkout', sha, '--', f] : ['rm', '-q', '--', f]);
          if (inOurs) await w(['add', '--', f]);
        }
        await w(['-c', 'core.editor=true', 'cherry-pick', '--continue']);
      }
      if (await ok(['-C', dir, 'diff', '--quiet', `${remote}/${rbranch}`, 'HEAD'])) return { pushed: true, alreadyUpstream: true };
      await w(['push', '-q', remote, `HEAD:refs/heads/${rbranch}`]);
      return { pushed: true, onlyDrawings: true };
    } finally {
      if (added) await run(['worktree', 'remove', '--force', dir]).catch(() => {});
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** Publish `commit`: a plain push when the branch is exactly upstream + that commit, else only the drawings. Never throws. */
  async function publish(commit, remote, rbranch) {
    try {
      const upstream = `${remote}/${rbranch}`;
      const ahead = await count(['rev-list', '--count', `${upstream}..HEAD`]);
      if (ahead === 1 && await ok(['merge-base', '--is-ancestor', upstream, 'HEAD'])) {
        try { await run(['push', '-q', remote, `${commit}:refs/heads/${rbranch}`]); return { pushed: true }; } catch { /* the remote moved since the fetch: below */ }
        await run(['fetch', '-q', remote, rbranch]);
        const r = await pushDrawingsOnly(commit, remote, rbranch);
        await run(['fetch', '-q', remote, rbranch]).catch(() => {});
        return { ...r, keptLocal: 0, note: 'the remote moved meanwhile; only the drawings went up (git pull --rebase when ready)' };
      }
      const r = await pushDrawingsOnly(commit, remote, rbranch);
      await run(['fetch', '-q', remote, rbranch]).catch(() => {});
      return { ...r, keptLocal: Math.max(0, ahead - 1), note: 'other unpushed commits stayed local; only the drawings went up (git pull --rebase when ready)' };
    } catch (e) {
      return { pushed: false, pushError: e.message };
    }
  }

  return {
    autoBranches,

    /**
     * Sync folder `dir` (relative to the repo top, '' = the top). Never rebases or rewrites commits.
     * Returns one of: {nothing, branch} | {needsConfirm: 'branch', branch} (nothing changed) |
     * {committed, branch, message, sha, pushed, ...details}. Throws GitError for a detached HEAD, a merge in progress or a failed commit.
     * `confirm`: questions already answered yes (only 'branch'). `serial` wraps the local steps that touch the worktree, so the
     * hub can run them in its own queue; the network steps (fetch, push) stay outside it.
     */
    sync(dir, { confirm = [], serial = (fn) => fn() } = {}) {
      return oneAtATime(async () => {
        const branch = (await run(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
        if (branch === 'HEAD') throw new GitError('the repo is on a detached HEAD; check out a branch first');
        for (const ref of ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) {
          if (await ok(['rev-parse', '-q', '--verify', ref])) throw new GitError(`the repo is in the middle of a ${ref.split('_')[0].toLowerCase().replace('cherry', 'cherry-pick')}; finish it first`);
        }
        const specs = drawingPathspecs(dir);
        const remote = (await run(['config', '--get', `branch.${branch}.remote`]).catch(() => '')).trim();
        const merge = (await run(['config', '--get', `branch.${branch}.merge`]).catch(() => '')).trim();
        const rbranch = merge.replace(/^refs\/heads\//, '');
        const upstream = remote && remote !== '.' && rbranch ? { remote, rbranch } : null;

        if (!autoBranches.includes(branch) && !confirm.includes('branch')) {
          return (await changedFiles(run, dir, specs)).length ? { needsConfirm: 'branch', branch } : { nothing: true, branch };
        }

        const result = { branch };
        // 1. Bring the checkout up to date when it is strictly behind, so our commit can go up as a plain push.
        let fetchError = null;
        if (upstream) {
          try { await run(['fetch', '-q', upstream.remote, upstream.rbranch]); } catch (e) { fetchError = e.message; }
          if (!fetchError) {
            const target = `${upstream.remote}/${upstream.rbranch}`;
            const [behind, ahead] = await Promise.all([count(['rev-list', '--count', `HEAD..${target}`]), count(['rev-list', '--count', `${target}..HEAD`])]);
            if (behind > 0 && ahead === 0) {
              try { await serial(() => run(['merge', '--ff-only', target])); result.fastForwarded = behind; } catch (e) { result.notUpdated = e.message; }
            }
          }
        }
        // 2. Commit the drawings and PNGs under the folder.
        const committed = await serial(async () => {
          const files = await changedFiles(run, dir, specs);
          if (!files.length) return null;
          await run([...LITERAL, 'add', '-A', '--', ...files]); // names from status are literal paths, never pathspec magic
          try {
            const message = commitMessage(dir ? path.posix.basename(dir) : path.basename((await run(['rev-parse', '--show-toplevel'])).trim()), files.filter((n) => n.endsWith('.excalidraw') || n.endsWith('.png')));
            await run([...LITERAL, 'commit', '-q', '-m', message, '--', ...files]);
            const commit = (await run(['rev-parse', 'HEAD'])).trim();
            return { message, commit };
          } catch (e) {
            await run([...LITERAL, 'reset', '-q', '--', ...files]).catch(() => {}); // leave nothing staged behind
            throw e;
          }
        });
        if (!committed) return { ...result, nothing: true };
        Object.assign(result, { committed: true, message: committed.message, sha: committed.commit.slice(0, 7), commit: committed.commit });
        // 3. Publish.
        if (!upstream) return { ...result, pushed: false, noUpstream: true, note: 'no upstream branch: committed locally only' };
        if (fetchError) return { ...result, pushed: false, pushError: fetchError };
        return { ...result, ...(await publish(committed.commit, upstream.remote, upstream.rbranch)) };
      });
    },
  };
}
