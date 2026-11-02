# Plan: Excalidraw hub

Spec: `docs/specs/2026-11-02-excalidraw-hub.md`. Repo: `sandbox/excalidraw-hub` (own git, `main`). Branch per step, squash-merged to `main`, then deleted.

## Steps
1. **Scaffold** (`feat/scaffold`): `package.json` (no deps, `"type": "module"`), `Dockerfile` (`node:20-slim`), `compose.yaml`, `.env.example`, `docs/setup.md`, `.gitignore`.
2. **Pure logic, test-first** (`feat/core`), with `node --test` in `node:20-slim`:
   - `src/names.js`: validate names, parse `<project>_v<n>[_<label>]`, next version, latest, build a save name.
   - `src/scene.js`: strict/tolerant forms, `Baseline` (load, save, observe → dirty), save body (strip server keys, filter files, carry appState), shorthand detection.
   - `src/store.js`: list projects/drawings, read, create exclusively, rename (+png), delete (+png), path containment, symlink rejection. Tests on a temp dir.
3. **Canvas client + HTTP API** (`feat/api`): `src/canvas.js` (load, read, health), `src/server.js` (routes, origin/content-type checks, static). Tests: the server against a fake canvas (in-process `node:http`).
4. **UI** (`feat/ui`): `public/index.html`, `public/app.js`, `public/style.css`. Sidebar of projects and versions (latest marked), iframe, Save/Rename/Delete, unsaved badge, confirm dialogs, `beforeunload`.
5. **Compose e2e** (`feat/e2e`): `compose.test.yaml` (canvas :3100, hub :3180 on a fixture copy, Playwright 1.56.1 runner), `e2e/hub.spec.mjs` covering list, load, save, rename, delete, unsaved. `scripts/e2e.sh` copies fixtures to a temp dir first.
6. **Review**: independent subagent review (correctness + security, path traversal). Fix findings. Run the default `docker compose up` stack and do a read-only listing check against the real `docs/drawings`.
7. **Close**: `## Outcome` here, parent repo task record, conclusion in parent repo.

## Verification
- Unit: `docker run --rm -v $PWD:/app -w /app node:20-slim node --test`.
- E2E: `scripts/e2e.sh` (exit 0, per-feature test names in the output).
- Real stack: `docker compose up -d` then `curl 127.0.0.1:3080/api/projects`. No load/save against port 3000.
