# Plan: workspace folders

Spec: `docs/specs/2026-11-16-workspace-folders.md`.

1. `src/workspace.js`: folder list, ids, config file read/write, attach/detach checks, per-folder store + backups. Unit tests `test/workspace.test.js`.
2. `src/server.js`: take a workspace (adapter for the old `store/backups/git` arguments), `folder` on every drawing route and in `current`, `/api/projects` grouped by folder, attach/detach routes. Update `test/server.test.js`, add multi-folder tests.
3. `src/main.js`: build the workspace from `WORKSPACE_FILE`, `FOLDERS_ROOT`.
4. UI (`public/`): folder sections, add/detach, folder select in the save form.
5. Wiring: `compose.yaml` (same-path mount, `/workspace` volume), `scripts/native.sh`, `.env.example`, `.gitignore`, `docs/setup.md`, README.
6. Verify: `npm test`; run the hub natively against temp folders and drive the page with Playwright (attach, list, load, save, restart keeps folders, detach). Independent review by a subagent.

## Outcome
- Done as planned: `src/workspace.js`, folder-aware routes, sidebar sections with "+ Add folder" / ✕, folder picker in the save form, compose same-path mount of `HUB_FOLDERS_ROOT`, `./workspace` volume, native.sh and e2e wiring, docs.
- Added beyond the plan: `e2e/workspace.spec.js` (attach, load + save in the attached folder, detach refused while loaded, detach) with a temp folder in both e2e runtimes; folder labels use the repo name for `<repo>/docs/drawings`, since two repos' folders would otherwise look the same.
- Review fixes (independent subagent review): saved entries go through the same checks as attach at start (they were trusted); the primary is matched by device + inode, so under Docker parent repo's folder cannot be attached a second time through `$HOME`; nested folders are refused; an unreadable workspace file is never written over; fsync before rename; folder names in rename/delete messages, git note only where sync exists; `HUB_FOLDERS_ROOT` must be absolute.
- Verified: unit 103/103 (`GIT_CONFIG_GLOBAL=/dev/null npm test`; the unreadable-file test also run as an unprivileged user), native browser e2e 18/18, manual attach → `native.sh restart` → folder still listed. The Docker e2e was not run (no Docker daemon in the build session).
- Learned: under Docker, a path typed in the UI only works if the host folder is mounted at the same path in the container; that is the whole reason for the same-path mount.
