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

## Outcome
Done 2026-11-03. All six features work against the running containers: 37 unit/API tests and 9 Playwright e2e tests pass, both on the test stack (`scripts/e2e.sh`) and on the production `compose.yaml` run in isolation (spare port 3081, own canvas on 3100, fixture copy; saved files owned by uid 1000, hard links work on the bind mount). The default `docker compose up` stack lists the real `docs/drawings` and reaches the `:3000` canvas; it was checked read-only, with no load or save against the shared canvas.

**Differed from the plan**
- Networking: planned `network_mode: host`. Docker here is Docker Desktop, where host mode binds inside its VM, so the hub was unreachable from WSL even though e2e passed (all test containers shared the VM network). Switched to published `127.0.0.1` ports and `host.docker.internal`; tests use compose service names.
- Unsaved detection became a hybrid of tolerant and strict comparison. A plain hash showed "unsaved" after any click, because the tab normalizes the scene on its first sync.
- The beforeunload e2e checks the handler and a real navigation prompt. Closing the page did not raise the dialog in headless Chromium.
- Review (independent agent, Fable) found no traversal, XSS or CSRF hole. It confirmed 8 lower issues, all fixed with tests: delete of the loaded drawing kept "Saved"; orphan png at the rename destination; half-finished rename; frameable page; huge version numbers; long labels (and a clear 400 for project names too long to version); non-regular files and bad shapes; test gaps. Also fixed: request serialization, random temp names, and the static-file error path. A second review pass of the fixes found three small items (version overflow lockout, untested rollback, delete dropping appState); all fixed with tests.

**Learned**
- Load and save through the raw canvas REST API are lossless. The MCP's scene export is not lossless for browser-made files.
- Under Docker Desktop, test networking must match production networking, or green tests can hide an unreachable service.

**Open**
- Background and grid changes made in the canvas are not saved: the canvas has no appState API.
- The canvas on `:3000` has no CSRF or Host guard of its own (upstream).

## Outcome addendum, 2026-11-05: Versioned checkbox
The user asked for a top-bar checkbox, off by default, that turns versioning on. This reverses the "always a new version" decision; the spec section "Save: versioning is an opt-in checkbox" holds the rules. An advisor check found that a tab from before the change would overwrite through its old "Save new version" button, so the API requires the flag. An independent review found four data-loss paths in the overwrite (empty or image-less canvas after a restart, failed load, symbols-only label, file changed on disk), all fixed with tests. Not built: preserving file mode on overwrite, and a guard against a second tab during its 2 s poll window.
