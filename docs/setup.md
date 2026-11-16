# Setup

Everything installable is declared in a manifest: `Dockerfile` and `compose.yaml` (hub), `canvas/package.json` (canvas), `compose.test.yaml` and `e2e/package.json` (tests). The hub server has no npm dependencies.

Two ways to run it, one at a time (both bind :3000 and :3080): Docker (below) or [without Docker](#without-docker).

## Needs
- Docker with Compose 2.20 or later (`depends_on.required`; renderer switch verified on v5.6.1), in WSL. No Node in WSL for this way.
- Nothing else: this compose builds and runs the canvas (`canvas/`, git subtree of a yctimlin/mcp_excalidraw 2.1.2 fork with code blocks) on `127.0.0.1:3000` and a pinned `plantuml/plantuml-server` (no host port; skipped when `PLANTUML_URL` is set, see Diagram renderers). parent repo's `.claude/mcp/excalidraw.sh` must use the matching MCP image tag (2.1.2).

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

## Diagram renderers
- Mermaid renders in the browser. It never needs a container or a URL.
- PlantUML and Salt render through `PLANTUML_URL`. Unset (default): compose starts the pinned `plantuml` container and uses it. Set it in `.env` to a renderer you already have and the container is not started. [Without Docker](#without-docker) there is no container: PlantUML/Salt work only with `PLANTUML_URL` set.
  - another plantuml-server: `PLANTUML_URL=http://<host>:8080`. Under Docker the canvas container resolves `<host>`: for a server on your own machine use `host.docker.internal`, not `localhost`. Without Docker use `127.0.0.1`. A `.env` shared by both ways needs a host both can reach, or a shell override (`PLANTUML_URL=… scripts/native.sh start`).
  - Kroki: `PLANTUML_URL=https://kroki.io/plantuml` (or your own Kroki)
  - public PlantUML: `PLANTUML_URL=https://www.plantuml.com/plantuml` (keep `www.`: the redirect from the bare domain turns the POST into a GET)

  The canvas server POSTs the diagram text to `$PLANTUML_URL/svg`, so any server answering that works. A remote URL sends your diagram text off the machine. With Kroki a syntax error shows Kroki's message in the code block, not PlantUML's error drawing.
- Switching an existing stack to a URL leaves the old container running: `docker compose rm -sf plantuml`, then `docker compose up -d`.

## Without Docker
Needs Node.js 20 or newer (with npm), git and curl on the host (for example Node through [nvm](https://github.com/nvm-sh/nvm)). Linux/WSL bash.
```bash
scripts/native.sh install     # npm ci + build in canvas/ (node_modules/ and dist/ there, both gitignored)
scripts/native.sh start       # canvas 127.0.0.1:3000, hub 127.0.0.1:3080, detached; pids and logs in .native/
scripts/native.sh status | stop | restart
```
- Config: the same `.env` as compose (shell variables win). The defaults match compose: `HUB_REPO=../..` (parent repo root, drawings in its `docs/drawings`), `HUB_BACKUPS=./backups`, `SYNC_BRANCH=development`, `HUB_PORT=3080`. Native only: `CANVAS_PORT` (default 3000; parent repo's MCP expects 3000), `DRAWINGS_DIR`, `PLANTUML_URL`. `UID`/`GID` are ignored.
- Sync uses your own git, identity and SSH agent, so a key with a passphrase works too.
- PlantUML/Salt code blocks: set `PLANTUML_URL` to any renderer from [Diagram renderers](#diagram-renderers), e.g. Kroki, or only the plantuml container: `docker run -d -p 127.0.0.1:8080:8080 -e PLANTUML_SECURITY_PROFILE=SANDBOX plantuml/plantuml-server:jetty` and `PLANTUML_URL=http://127.0.0.1:8080`. Unset: the canvas answers "renderer not configured"; Mermaid still works.
- `start` refuses a busy port: stop the Docker stack first (`docker compose down`). If the hub cannot start, for example because the drawings folder is missing or empty, it prints the log tail and stops the canvas too, if this `start` started it.
- No autostart and no crash restart: run `start` again after a reboot. Leftover pid files are harmless: a pid only counts if it is still our `node` process.
- `stop` sends SIGTERM, then SIGKILL after 5 s (the hub waits for open requests).
- After pulling changes under `canvas/`, run `install` again, then `restart`. After editing `.env`, run `restart`: `start` leaves a running process with its old settings.
- `.env` values are read literally: `${VAR}` and backslash escapes, which only compose expands, are refused outside single quotes.

## Test
```bash
docker build -t excalidraw-hub-unit . && docker run --rm -u 1000:1000 -e HOME=/tmp -v "$PWD:/app:ro" -w /app excalidraw-hub-unit node --test test/
scripts/e2e.sh   # isolated canvas :3100 + hub :3180 + Playwright, throwaway git repo + bare origin
```
Code-block browser tests (they clear their canvas, so only against the test stack): with `docker compose -f compose.test.yaml up -d --build canvas`, run from `canvas/` once `npm ci` has been done there in Docker:
`docker run --rm --network excalidraw-hub-test_default -u 1000:1000 -e HOME=/tmp -e CANVAS_URL=http://canvas:3000 -v "$PWD:/w" -w /w mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test -c playwright.codeblock.config.mjs`

Without Docker: `npm test` (unit), and `E2E_RUNTIME=native scripts/e2e.sh` (browser). The latter needs `scripts/native.sh install`, `npm ci` in `e2e/` and a Chromium: `npx playwright install chromium` in `e2e/`, or `CHROMIUM_PATH=<chrome binary>`. The native stack uses the same ports (3100, 3180) and a throwaway state folder, and sets every setting itself, so neither `.env` nor exported variables like `CANVAS_URL` reach it. README screenshots (`scripts/screenshots.sh`) stay Docker-only.

`scripts/e2e.sh` builds a throwaway git repo from `fixtures/` with a bare origin and a temp backups folder. It never touches port 3000, `docs/drawings` or parent repo's git. Needs `git` in WSL.

## Canvas (`canvas/`)
- A git subtree, not a submodule: no GitHub fork needed, and the files are plain files in this repo.
- Origin of the code: a local clone of yctimlin/mcp_excalidraw at v2.1.2, branch `feat/code-block-build`, vendored here as a subtree. That playground (parent repo `sandbox/excalidraw-codeblock`) was deleted 2026-11-15; `canvas/` is now the only copy.
- Upgrade to a new upstream release: `git subtree pull --prefix=canvas https://github.com/yctimlin/mcp_excalidraw.git <tag> --squash`, resolve conflicts in `canvas/frontend/src/App.tsx` and `canvas/src/server.ts`, then bump the MCP image tag in parent repo's `.claude/mcp/excalidraw.sh` to the same version.
