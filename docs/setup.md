# Setup details

What the [README](../README.md) leaves out. Everything installable is declared in a manifest: `Dockerfile` and `compose.yaml` (hub and canvas), `canvas/package.json` (canvas), `compose.test.yaml` and `e2e/package.json` (tests). The hub server has no npm dependencies; its Docker image installs `git` and `openssh-client`.

## Diagram renderers
- Mermaid renders in the browser. It never needs a container or a URL.
- PlantUML and Salt render through `PLANTUML_URL`. Unset (the default under Docker): compose starts the pinned `plantuml` container and uses it. Set it in `.env` to a renderer you already have and the container is not started. Without Docker there is no container, so PlantUML and Salt work only with `PLANTUML_URL` set; unset, the canvas answers "renderer not configured".
  - another plantuml-server: `PLANTUML_URL=http://<host>:8080`. Under Docker the canvas container resolves `<host>`: for a server on your own machine use `host.docker.internal`, not `localhost`. Without Docker use `127.0.0.1`. A `.env` shared by both ways needs a host both can reach, or a shell override (`PLANTUML_URL=... scripts/native.sh start`).
  - Kroki: `PLANTUML_URL=https://kroki.io/plantuml` (or your own Kroki)
  - public PlantUML: `PLANTUML_URL=https://www.plantuml.com/plantuml` (keep `www.`: the redirect from the bare domain turns the POST into a GET)
  - only the container, for the native runtime: `docker run -d -p 127.0.0.1:8080:8080 -e PLANTUML_SECURITY_PROFILE=SANDBOX plantuml/plantuml-server:jetty`, then `PLANTUML_URL=http://127.0.0.1:8080`

  The canvas server POSTs the diagram text to `$PLANTUML_URL/svg`, so any server answering that works. A remote URL sends your diagram text off the machine. With Kroki a syntax error shows Kroki's message in the code block, not PlantUML's error drawing.
- Switching a running Docker stack to a URL leaves the old container running: `docker compose rm -sf plantuml`, then `docker compose up -d`.

## Docker details
- After a boot, Docker Desktop may start the hub before `FOLDERS_ROOT` is mounted. The hub then exits with "excalidraw-hub not starting: ..." and Docker retries until the folder is there, usually a few seconds. `docker logs <clone folder name>-hub-1` shows why if the explorer stays empty.
- The compose project name is the clone's folder name, so two clones on different ports can run side by side.

## Native details
- `.env` values are read literally: `${VAR}` and backslash escapes, which only compose expands, are refused outside single quotes.
- `UID`/`GID` in `.env` are ignored natively.
- No autostart and no crash restart: run `start` again after a reboot. Leftover pid files are harmless: a pid only counts if it is still our `node` process.
- `stop` sends SIGTERM, then SIGKILL after 5 s (the hub waits for open requests).
- If the hub cannot start, `start` prints the log tail and stops the canvas too, if this `start` started it.
- After pulling changes under `canvas/`, run `install` again, then `restart`.

## More tests
Code-block browser tests clear their canvas, so run them only against the test stack. With `docker compose -f compose.test.yaml up -d --build canvas`, and `npm ci` done once in `canvas/` (in Docker), from `canvas/`:
`docker run --rm --network excalidraw-hub-test_default -u "$(id -u):$(id -g)" -e HOME=/tmp -e CANVAS_URL=http://canvas:3000 -v "$PWD:/w" -w /w mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test -c playwright.codeblock.config.mjs`

## Canvas (`canvas/`)
- A git subtree, not a submodule: the files are plain files in this repo.
- Upgrade to a new upstream release: `git subtree pull --prefix=canvas https://github.com/yctimlin/mcp_excalidraw.git <tag> --squash`, resolve conflicts in `canvas/frontend/src/App.tsx` and `canvas/src/server.ts`, then use the same MCP version for the agent that talks to this canvas.
