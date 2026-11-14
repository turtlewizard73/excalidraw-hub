# Setup

Everything installable is declared in a manifest: `Dockerfile` and `compose.yaml` (hub), `compose.test.yaml` and `e2e/package.json` (tests). The hub server has no npm dependencies.

## Needs
- Docker with Compose v2, in WSL. No Node in WSL.
- parent repo's canvas running: `docker compose up -d` at the parent repo root (`ghcr.io/yctimlin/mcp_excalidraw-canvas:2.1.2` on `127.0.0.1:3000`).

## Run
```bash
cp .env.example .env    # once; sets UID/GID so saved drawings are owned by you
docker compose up -d --build
# open http://localhost:3080
```
The hub mounts parent repo's `docs/drawings` (override with `HUB_DRAWINGS`) and `./autosave` for backups taken before a forced load (override with `HUB_AUTOSAVE`). Loading a drawing replaces whatever is on the shared canvas, after a confirm if it has unsaved changes.

## Test
```bash
docker run --rm -v "$PWD:/app:ro" -w /app node:20-slim node --test test/   # unit + API
scripts/e2e.sh                                                            # isolated canvas :3100 + hub :3180 + Playwright
```
`scripts/e2e.sh` copies `fixtures/` to a temp folder and uses a temp autosave folder. It never touches port 3000 or `docs/drawings`.
