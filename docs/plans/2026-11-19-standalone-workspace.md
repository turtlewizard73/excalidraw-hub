# Plan: standalone hub with a VS Code-style workspace

Spec: `docs/specs/2026-11-19-standalone-workspace.md`.
- Branch: `feat/standalone-workspace`, on the rewritten `development` (`715dd13`).
- The running hub (`:3000` / `:3080`, the parent repo's submodule checkout on `development`) is not touched until the cutover in step 14.

Each step ends green: unit tests (Docker command in the README, or `npm test` with Node 20+), and from step 0 on also `scripts/e2e.sh`. Commit after each step.

0. **Made-up fixtures.** The history rewrite removed the personal drawings, leaving only `fixtures/image-test/`.
   - Create synthetic drawings under the file names the e2e specs use (`budgeting/budgeting_v0_plan.excalidraw`, `budgeting/budgeting_v1_plan_with_proposal.excalidraw`, and every other name `e2e/*.js` and `scripts/` load). Use neutral content, made-up shapes and text.
   - Add one nested case for later steps: `nested/deep/deep_v0.excalidraw`.
   - Run e2e until green against the unchanged code.
   - Renaming the fixtures to neutral names is allowed in step 11.
1. **Config** (`src/config.js`). Every env var is read in one place with its default (`HUB_PORT`, `CANVAS_PORT`, `CANVAS_URL`, `CANVAS_PUBLIC_URL`, `FOLDERS_ROOT`, `HUB_STATE`, `BACKUPS_DIR`, `HUB_AUTO_SYNC_BRANCHES`, `HUB_WAIT_FOR_MOUNT`, `HUB_ALLOWED_HOSTS`). `main.js` uses only this module. Drop the removed vars. Unit test: defaults and overrides.
2. **Workspace without a primary** (`src/workspace.js`).
   - The state file is v2 (`folders`, `recent`); a v1 file is treated as invalid and moved to `.bad`.
   - All roots are equal; zero roots is valid; backups go to `BACKUPS_DIR/<id>/`.
   - Repo detection per root through `repoTopLevel`, with one git client and one queue per repo top level.
   - `recent` is updated on detach.
   - Tests rewritten: no primary; recent; repo vs non-repo roots; a root inside another root's repo.
3. **Paths and naming** (rule confirmed 2026-11-19: families by stem per folder) (`src/names.js`, `src/store.js`).
   - `resolve(root, rel)` checks: inside the root, no `..`, real path inside the root.
   - Families by stem per folder; the folder name is the default stem for new drawings; `latest` per stem.
   - Save, save-version and plain-save targets take a directory.
   - `mkdir`; `move` with the `.png`, the backups folder and the `EXDEV` fallback.
   - Tests: depth 0 / 1 / 3, symlink escape, unsafe folder name refused, move clash, move across roots, `EXDEV` (simulated through an injected rename).
4. **Tree listing** (`src/tree.js`). `list(root, rel)` returns dirs (skipping dot-dirs, `node_modules` and git-ignored dirs through one `git check-ignore --stdin` call when the root is in a repo) and `.excalidraw` drawings with version info and backup counts. Tests with a temp git repo.
5. **Sync** (`src/git.js`).
   - Current branch and its upstream; `SYNC_BRANCH` removed; auto-commit only on `HUB_AUTO_SYNC_BRANCHES` (default `development,dev`), `needsConfirm: 'branch'` elsewhere.
   - Fetch, then `merge --ff-only` when strictly behind, before the commit.
   - Pathspec limited to `:(glob)<F>/**/*.excalidraw` and `:(glob)<F>/**/*.png`, plus the same two directly under F.
   - Plain push when exactly our commit is ahead, otherwise `pushDrawingsOnly`; no upstream means a local commit only.
   - Tests against real git with a bare origin: behind (checkout updated), even, own unpushed commits, remote moved between fetch and push, ff refused by a dirty file, no upstream, files outside the glob left unstaged.
6. **API** (`src/server.js`). Routes as in the spec table; `current = {root, path}`; agent `POST /api/save` takes `{root, dir}`. Server tests updated.
7. **Explorer UI** (`public/`).
   - Tree with lazy expand and collapse, collapse-all, folder selection as the save target (breadcrumb in the header).
   - Hover actions; drag and drop with drop-target highlight; resize handle with iframe overlay, clamped, double-click to reset; ☰ and `Ctrl+B` to hide.
   - `localStorage` holds width, hidden, expanded and selected.
   - Attach prompt lists `recent`; empty state shows "+ Add folder".
   - The page stays one HTML file, one script and one stylesheet, with no build step.
8. **E2E** (`e2e/`). Update the existing specs to the tree model. Add tests for:
   - expand and collapse surviving a reload;
   - drag-move across roots (`.png` moved, Revert still works);
   - resize and hide surviving a reload;
   - attach, restart the hub, the folder is still there;
   - sync updating a behind checkout;
   - save at depth 2 writing `<dirname>_v<n>` plus its PNG.
9. **Hosting.**
   - `compose.yaml`: `CANVAS_PORT` / `HUB_PORT`, `FOLDERS_ROOT` mounted at the same path in hub and canvas, `HUB_WAIT_FOR_MOUNT=1`, `HUB_STATE` under `./config`.
   - `scripts/native.sh`: both ports from `.env`.
   - `.env.example` lists every variable.
   - `src/mounts.js`: guard on `FOLDERS_ROOT` when `HUB_WAIT_FOR_MOUNT=1`.
   - `.gitignore`: `config/*` (keep `.gitkeep`); drop `drawings/` and `workspace/`.
   - `docker compose config` must be checked with and without `.env`.
10. **Agent MCP** (`scripts/mcp.sh`). Docker exec path, native path, "start the hub first" path, `/mnt/*` refusal.
    - Test: a JSON-RPC `initialize` piped through each path answers.
    - `docker ps` count unchanged before and after the Docker path.
11. **Public-repo cleanup.**
    - Made-up `fixtures/`, including a nested case; tests repointed.
    - README rewritten per the spec; `docs/setup.md` trimmed to what the README does not cover; screenshots regenerated.
    - Gate: `git grep -i <former parent name>` prints nothing, and `git grep -n '/home/'` prints only documented examples like `/home/me`.
12. **Install check (independent).**
    - A fresh subagent clones the pushed branch (`git clone -b feat/standalone-workspace <GitHub URL>`) into an ignored scratch folder of the parent repo.
    - It follows only the README, without reading `src/`.
    - It runs the native path on ports 3280/3200, then Docker on 3380/3300, because the real hub holds 3000/3080.
    - It attaches a scratch folder, saves, confirms the PNG, moves a drawing, and runs sync against a throwaway bare repo.
    - It registers `scripts/mcp.sh` on the non-default canvas port, creates an element over MCP and confirms it appears in the hub's iframe. This is the end-to-end check that `CANVAS_PORT` works.
    - It reports every place it had to guess, then tears everything down.
    - Fix the README for each gap and rerun until a run needs no guesses.
13. **Independent review** by another agent of the full diff against `development`; fix findings.
14. **Cutover of the maintainer's own setup.** This is a separate parent-repo change, in that repo's flow A/B.
    - Snapshot the canvas, then `docker compose down` in the submodule.
    - After the hub PR is squash-merged into hub `development`, bump the submodule.
    - In the submodule: `.env` with the old ports, `config/hub.json` listing the parent repo's drawings folder.
    - Move `backups/<project>/` to `backups/<id>/<project>/` and `backups/_folders/<id>/` to `backups/<id>/`.
    - `docker compose up -d --build`, then verify the drawings are listed, Revert history is there, and ⟳ works.
    - Parent repo: `.mcp.json` points to the hub's `scripts/mcp.sh` and the old per-session `docker run` script is deleted; then restart the sessions and check that `docker ps` shows no `mcp_excalidraw` containers.
    - Update the parent's docs that mention the sync button's direct commits and the hub's setup.
15. **History rewrite:** done 2026-11-19, before implementation (see the spec). Nothing left to do.
16. **Outcome** section here.

## Risks
- The tree with drag and drop is the largest UI change so far for a no-build page, so `app.js` might outgrow one file. If it passes about 500 lines, split the explorer into `public/explorer.js` (an ES module, still no build step).
- `git check-ignore` costs one call per expanded folder of a repo root. That is acceptable at today's sizes; cache per folder until the next refresh if it gets slow.
- Mounting `FOLDERS_ROOT` into the canvas container widens what that container can write. This is documented, and `FOLDERS_ROOT` narrows it.
