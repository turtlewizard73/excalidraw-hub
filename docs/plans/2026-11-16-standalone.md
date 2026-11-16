# Plan: standalone

Spec: `docs/specs/2026-11-16-standalone.md`.

1. Defaults: `compose.yaml`, `scripts/native.sh`, `.env.example` (`HUB_REPO=./drawings`, `HUB_DRAWINGS_SUBDIR=.`, `SYNC_BRANCH=main`); `drawings/.gitkeep` + `.gitignore`.
2. `src/main.js`: sync only when `HUB_REPO` is a git top level; log the reason otherwise. Unit test for the detection helper.
3. Remove every mention of the parent repo: code comments, UI text (`public/app.js` branch question), README (naming scheme inline), `docs/`, tests, compose comments.
4. Verify: no mention of the parent repo left (grep for its name); unit tests; native e2e; fresh-clone run with no `.env` (empty sidebar, sync off, save works into `./drawings`); run with the parent's settings (sync on, drawings listed).
5. Parent side (the parent repo, separate PR): wrapper `scripts/excalidraw-hub.sh` exporting its settings, docs updated, submodule bumped after this merges.
6. Independent review, PR.

## Outcome
- Done as planned: neutral defaults (`HUB_REPO=./drawings`, `HUB_DRAWINGS_SUBDIR=.`, `SYNC_BRANCH=main`), sync only when `HUB_REPO` is a git top level (`repoTopLevel` in `src/git.js`), naming scheme in the README, every mention of the parent repo removed from files (one old commit message still names it; history is not rewritten).
- Changed after review: the parent's wrapper also writes its settings into the hub's gitignored `.env`, because a shell-only wrapper let a plain `docker compose up` in the hub folder fall back silently to the empty default. `repoTopLevel` reports git's own error (e.g. dubious ownership) instead of "not a git repository". README notes the UID/GID step for zero-config Docker users whose uid is not 1000.
- Verified: unit 104/104; native e2e 18/18; fresh clone with no `.env` (sync off with reason logged, save into `drawings/`, `git status` clean); parent settings via the wrapper (parent's drawings, sync on its branch; stale personal `.env` values overridden; block rewritten idempotently); `docker compose config` for both setups. Docker e2e not run (no daemon here).
