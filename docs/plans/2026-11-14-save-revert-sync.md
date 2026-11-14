# Plan: save buttons, save-before-switch, revert, git sync (2026-11-14)

Spec: `docs/specs/2026-11-02-excalidraw-hub.md`, sections "Save: two buttons", "Switching drawings saves first", "Revert", "Sync a project to git". Branch `feat/save-revert-sync`. Task records: parent repo `tasks/2026-11-14-hub-save-switch-revert.md`, `tasks/2026-11-14-hub-git-sync.md`.

## Decisions taken with the user (2026-11-14)
- Checkbox removed; two buttons.
- Switching saves into the open file without asking, backing up the overwritten file (Revert). No open file: save to `tmp/`. Refused save: popup with the reason, no load.
- Sync: push only on `dev`; elsewhere ask, then commit without pushing. "development" in the answer read as `dev` (`origin/development` is stale since 2026-08; `dev` is active). Configurable via `SYNC_BRANCH`.

## Steps
1. `src/backups.js` (replaces `src/autosave.js`): `save(project, file, bytes)`, `count`, `takeNewest`, `move` on rename. Unit tests.
2. `server.js`: extract the save into one function used by `/api/save` and by `/api/load` (save-first). Overwrites back up first. `/api/revert`. Listing adds `backups`. Rename moves backups.
3. `src/git.js` + `POST /api/sync`: runner injected (fake in unit tests). Message builder unit-tested.
4. UI: Save / Save new version / Revert buttons, no confirm on switch, `alert` for refused saves, sync button per project with the not-on-dev confirm.
5. Docker: git + openssh in the image; compose mounts; `.env.example`; `./backups` gitignored with `.gitkeep`; remove `./autosave`.
6. E2E: two buttons, switch saves and backs up, Revert restores, tmp save when nothing loaded, refused save shows a popup. Sync against a temp repo with a bare remote: on `dev` commits only the folder and pushes; on another branch asks and does not push.
7. Unit + e2e, independent review, Outcome, merge + redeploy on request.

## Outcome
Done 2026-11-14 on `feat/save-revert-sync`. All four behaviours work: two save buttons, save before switch (into the open file or `tmp/`, refused saves in a popup), Revert with backups, per-project sync (push only on `dev`). Tests: 89 unit/API including 12 real-git tests (hub image), 15 e2e against a throwaway repo with a bare origin (3 consecutive green runs).

**Differed from the plan**
- Advisor (before coding): save-first must run before stamping/reading the target; Revert keeps the file it replaces (`_reverted`); delete and re-create retire old backups. All built in.
- Independent review found:
  - Revert dropped unsaved edits with no copy. It now saves them first and keeps them in `_reverted`.
  - The push could publish unrelated unpushed commits unannounced. First fix (ask first, with the count) was rejected by the user. Now sync publishes only the drawing commit, cherry-picked onto `origin/dev` in a temporary worktree; no question. A second review caught that the first version (copying the whole folder state) reverted changes made on origin and that `worktree prune` in the container unregisters the user's worktrees; both fixed.
  - Four old `autosave/` drawings had been committed on the branch, because the ignore rule was renamed. They are untracked and ignored again and stay on disk; the squash merge keeps them out of `main`.
  - Sync now refuses a detached HEAD or a merge or rebase in progress.
  - Revert is only allowed for the loaded drawing.
- A flaky e2e (save fired before the tab synced the drawn rectangle) fixed in the test helper.

**Learned**
- `git commit -- <folder>/` commits only that folder even with other files staged. Names for messages must come from `git diff --cached` after `add`, since porcelain status collapses untracked folders.
- Renaming a gitignore rule can expose old runtime output: check `git status` for unexpected files before committing.

**Open**
- `~/.ssh` is read-only in the container, so an unknown host key fails the push (github.com is already in `known_hosts`).
- A slow pre-commit hook would hold the serial queue for up to 60 s (parent repo has no hooks today).
- Concurrent syncs are not serialized for the push; a ref-lock failure is reported.
