# Plan: Survive the boot race on the drawings mount (2026-11-14)

Spec: `docs/specs/2026-11-02-excalidraw-hub.md`, "Docker and networking", "Boot race". Branch `feat/boot-mount-retry`, built in the worktree `sandbox/excalidraw-hub-boot`, so the main checkout's unmerged `feat/save-revert-sync` stays untouched.

## Steps
1. `src/mounts.js`: `checkDrawingsDir(dir)` returns `null` when `dir` holds at least one entry, or a reason string when it is missing or empty. Unit test in `test/mounts.test.js`.
2. `src/main.js`: before `createServer`, if the check returns a reason, log it and `process.exit(1)`. Keep the diff small, because `feat/save-revert-sync` rewrites `main.js`.
3. Retry chain check: run the built image as a throwaway container (own name, port 3181, `--restart unless-stopped`, an empty scratchpad dir as `/data`). Expect `RestartCount` to climb and the log to show the reason. Then add a file and expect the hub to serve within the backoff. Remove the container afterwards.
4. Unit/API tests and e2e, README/setup note, independent check, `## Outcome`.
5. Deploy only when the user asks. Merge to `main`, then from the worktree run `docker compose -p excalidraw-hub up -d --build` with `HUB_BACKUPS=../excalidraw-hub/backups` (was `HUB_AUTOSAVE` before the rebase), so it replaces the running container and keeps the real backups folder.

Not built: a Windows logon task or WSL startup script, and checks on other mounts (see spec).

## Outcome
Done 2026-11-14. Squash-merged to `main` (740f70b) and deployed the same day. The hub exits with "drawings folder /data is empty (bind mount not connected yet?)" when the folder is missing or empty. `restart: unless-stopped` then retries it.
- Evidence: 73 unit/API tests (3 new) and 14 e2e pass. A throwaway container with an empty `/data` restarted 12 times, then served ~3 s after a drawing was added.
- Differed: README also states that the drawings folder must not be empty (review finding).
- Learned: Docker retries a container that exits immediately, with growing backoff. The 10 s rule only resets the backoff.
- Independent review (separate agent): no bugs. Confirmed top-level await, the stderr flush before exit, a single entry point, and that the e2e fixtures are non-empty.
- Still open: proof on a real boot. After the next boot, `RestartCount` > 0 on `excalidraw-hub-hub-1`, a populated sidebar, and a working sync button (tests the unverified same-pass assumption for `~/.ssh` and `~/.gitconfig`; spec "Boot race"). Second review (after rebase): no bugs; this assumption was reworded from fact.
- Rebased 2026-11-14 onto `main` 13dd1fb (Save/Revert/git sync, #1). That merge replaced the `/data` and autosave mounts with parent repo's root at `/repo` (drawings at `/repo/docs/drawings`), `/backups`, `~/.ssh` and `~/.gitconfig`. The only conflict was the imports in `main.js`. The unchanged check now catches an unconnected `/repo` as "cannot read … ENOENT". After the rebase: 92 unit/API and 15 e2e pass. Retry chain with an empty `/repo`: 5 restarts, then served ~2 s after `docs/drawings` appeared.
