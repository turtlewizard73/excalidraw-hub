# Setup

Everything installable is declared in a manifest: `Dockerfile` and `compose.yaml` (hub), `compose.test.yaml` and `e2e/package.json` (tests). The hub server has no npm dependencies.

## Needs
- Docker with Compose v2, in WSL. No Node in WSL.
- Nothing else: this compose builds and runs the canvas (`canvas/`, git subtree of a yctimlin/mcp_excalidraw 2.1.2 fork with code blocks) on `127.0.0.1:3000` and a pinned `plantuml/plantuml-server` (no host port). parent repo's `.claude/mcp/excalidraw.sh` must use the matching MCP image tag (2.1.2).

## Run
```bash
cp .env.example .env    # once; sets UID/GID so saved drawings are owned by you
docker compose up -d --build
# open http://localhost:3080
```
The hub mounts:
- parent repo's root at `/repo` (override with `HUB_REPO`); drawings are its `docs/drawings`. Read-write, for saving and for the sync button's `git add/commit/push`.
- `./backups` for Revert (override with `HUB_BACKUPS`).
- `~/.gitconfig` and `~/.ssh`, read-only: sync commits as you and pushes with your SSH key. The key must have no passphrase (there is no agent in the container). `SYNC_BRANCH` (default `development`) is the only branch sync pushes from.

The image installs `git` and `openssh-client` (Debian packages, `Dockerfile`).

It starts with Docker (`restart: unless-stopped`). After a boot, Docker Desktop may start it before the drawings folder is connected. The hub then exits with "excalidraw-hub not starting: cannot read drawings folder …" (or "… is empty") and Docker retries it until the folder is there, which usually takes a few seconds. `docker inspect excalidraw-hub-hub-1 --format '{{.RestartCount}}'` shows how often that happened. If the sidebar stays empty, `docker logs excalidraw-hub-hub-1` shows why.

## Test
```bash
docker build -t excalidraw-hub-unit . && docker run --rm -u 1000:1000 -e HOME=/tmp -v "$PWD:/app:ro" -w /app excalidraw-hub-unit node --test test/
scripts/e2e.sh   # isolated canvas :3100 + hub :3180 + Playwright, throwaway git repo + bare origin
```
Code-block browser tests (they clear their canvas, so only against the test stack): with `docker compose -f compose.test.yaml up -d --build canvas`, run from `canvas/` once `npm ci` has been done there in Docker:
`docker run --rm --network excalidraw-hub-test_default -u 1000:1000 -e HOME=/tmp -e CANVAS_URL=http://canvas:3000 -v "$PWD:/w" -w /w mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test -c playwright.codeblock.config.mjs`

`scripts/e2e.sh` builds a throwaway git repo from `fixtures/` with a bare origin and a temp backups folder. It never touches port 3000, `docs/drawings` or parent repo's git. Needs `git` in WSL.

## Canvas (`canvas/`)
- A git subtree, not a submodule: no GitHub fork needed, and the files are plain files in this repo.
- Origin of the code: a local clone of yctimlin/mcp_excalidraw at v2.1.2, branch `feat/code-block-build`, vendored here as a subtree. That playground (parent repo `sandbox/excalidraw-codeblock`) was deleted 2026-11-15; `canvas/` is now the only copy.
- Upgrade to a new upstream release: `git subtree pull --prefix=canvas https://github.com/yctimlin/mcp_excalidraw.git <tag> --squash`, resolve conflicts in `canvas/frontend/src/App.tsx` and `canvas/src/server.ts`, then bump the MCP image tag in parent repo's `.claude/mcp/excalidraw.sh` to the same version.
