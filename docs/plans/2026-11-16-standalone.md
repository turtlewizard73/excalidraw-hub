# Plan: standalone

Spec: `docs/specs/2026-11-16-standalone.md`.

1. Defaults: `compose.yaml`, `scripts/native.sh`, `.env.example` (`HUB_REPO=./drawings`, `HUB_DRAWINGS_SUBDIR=.`, `SYNC_BRANCH=main`); `drawings/.gitkeep` + `.gitignore`.
2. `src/main.js`: sync only when `HUB_REPO` is a git top level; log the reason otherwise. Unit test for the detection helper.
3. Remove every mention of the parent repo: code comments, UI text (`public/app.js` branch question), README (naming scheme inline), `docs/`, tests, compose comments.
4. Verify: no mention of the parent repo left (grep for its name); unit tests; native e2e; fresh-clone run with no `.env` (empty sidebar, sync off, save works into `./drawings`); run with the parent's settings (sync on, drawings listed).
5. Parent side (the parent repo, separate PR): wrapper `scripts/excalidraw-hub.sh` exporting its settings, docs updated, submodule bumped after this merges.
6. Independent review, PR.
