# Excalidraw hub

A local web page that wraps the shared Excalidraw planning canvas with a sidebar of your drawings. You can list, load, save, rename and delete drawings, and a badge shows when the canvas has unsaved changes.

The drawings are `.excalidraw` files in a drawings folder, one subfolder per project: by default `drawings/` in this repo, or any folder you point it at, such as `docs/drawings` in one of your repos (`HUB_REPO`, see [Configure](#configure)). The canvas runs on port 3000, so an agent's Excalidraw MCP pointed there sees the same drawing you do.

```mermaid
flowchart LR
  B[Browser: hub page :3080] -->|/api/*| H[hub server]
  B -->|iframe| C[canvas :3000]
  A[agent MCP] --> C
  H -->|load / read scene| C
  H -->|list, write, rename, delete| D[(drawings folder)]
  C -->|PlantUML / Salt code blocks| P["plantuml-server (or PLANTUML_URL)"]
```

## What it looks like
Made-up demo data, regenerated with `scripts/screenshots.sh`.

![Sidebar with projects, versions, latest/unversioned tags and hover actions, next to a loaded drawing](docs/images/hub-overview.png)
*Sidebar: one folder per project, highest version marked "latest", off-scheme files "unversioned". Hovering a drawing shows rename and delete; ⟳ commits the project to git.*

![The badge reads Unsaved changes after an ellipse was drawn](docs/images/hub-unsaved.png)
*Any real edit turns the badge to "● Unsaved changes".*

![Mermaid flowchart, PlantUML sequence diagram and Salt wireframe on the canvas](docs/images/code-blocks.png)
*Code blocks: paste Mermaid, PlantUML or Salt text and it is rendered on the canvas. Saved here as `recipes_v2_flows` with the form at the top.*

![A code block in code view with Diagram and Edit buttons](docs/images/code-block-toggle.png)
*Hover a code block to switch between diagram and source, or edit it.*

## Run
The canvas runs from this repo too (`canvas/`, a fork of yctimlin/mcp_excalidraw with code blocks), so one command starts everything. Pick one way. Both use :3000 and :3080, so run only one at a time. If another canvas already runs on :3000, stop it first. In this folder:

**Docker** (starts at boot, restarts on crash, includes the PlantUML renderer unless `PLANTUML_URL` is set):
```bash
cp .env.example .env          # once: saved files get your UID/GID
docker compose up -d --build
```
Stop it with `docker compose down`.

**Without Docker** (needs Node.js 20+ and git):
```bash
scripts/native.sh install     # once, and after canvas/ changes: npm ci + build of the canvas
scripts/native.sh start       # canvas :3000 + hub :3080 in the background; logs in .native/
scripts/native.sh status      # or: stop, restart
```
PlantUML/Salt code blocks need `PLANTUML_URL` set to a renderer, such as a plantuml-server or Kroki ([docs/setup.md](docs/setup.md#diagram-renderers)). Mermaid works without it. It does not start at boot.

With no settings the drawings go to `drawings/` here and the ⟳ sync button is off. Under Docker the hub runs as UID/GID 1000 unless `.env` says otherwise, so if your user is not 1000, do the `cp .env.example .env` step (and set `UID`/`GID`) first.

## Configure
Point the hub at a repo of yours in `.env` (or the shell, which wins):
```bash
HUB_REPO=/home/me/my-repo          # folder holding the drawings; ⟳ sync is on only if it is a git repo's top level
HUB_DRAWINGS_SUBDIR=docs/drawings  # drawings folder inside it (default: HUB_REPO itself)
SYNC_BRANCH=main                   # the only branch ⟳ pushes from (default main)
```
A repo that embeds the hub (e.g. as a submodule) can keep these in a small wrapper script that writes them into this folder's `.env` (gitignored) and then runs `docker compose` or `scripts/native.sh` here.

Open http://localhost:3080. Details and overrides (port, repo, sync branch, canvas URL) are in [docs/setup.md](docs/setup.md). Both ways read the same `.env`.

The drawings folder must hold at least one entry, such as a project folder. If it is empty, the hub exits: Docker keeps retrying it (that is how it waits out Docker Desktop connecting the folder after a boot), and `native.sh start` shows why and stops.

## Use
- **Load:** click a drawing in the sidebar. It replaces what is on the shared canvas. Unsaved changes are saved first, without asking: into the loaded drawing, or as `tmp/tmp_v<n>` when nothing was loaded. If that save is refused, a popup says why and nothing is loaded.
- **Save:** pick a project, optionally type a label, click "Save". With no label this overwrites the loaded drawing, unless the canvas came back empty, lost an image, or the file changed on disk. With a label, or with nothing loaded, it writes `<project>[_<label>].excalidraw` and refuses if that file exists. A new project name creates the folder. Every save also writes `<name>.png` next to the drawing.
- **Save new version:** writes `<project>_v<next>[_<label>].excalidraw` and never overwrites.
- **Revert:** every overwrite first keeps the old file in `backups/` (newest 20 per drawing). Revert puts the loaded drawing back to its previous saved state; press again to go further back. It asks first, and the file it replaces is kept too.
- **Folders (workspace):** like a VS Code multi-root workspace. "+ Add folder" attaches another folder that holds project folders, for example `/home/me/other-repo/docs/drawings`; the sidebar then shows one section per folder (named after the repo, full path on hover). ✕ on a section detaches it; its files stay on disk. The list is saved in `workspace/workspace.json` and reopened after a restart. The configured drawings folder is the primary one: always shown, never detached, and the only one with ⟳ sync. Folders must be inside `HUB_FOLDERS_ROOT` (default your home folder). The save form gets a folder picker once there are two or more. A detached or missing folder's drawings are not deleted; a folder that cannot be read shows its error in its section.
- **Sync (⟳ on a project):** commits that project's folder in `HUB_REPO`'s git repo as "`<project> <names> diagram update`", only that folder. On `SYNC_BRANCH` (default `main`) it also pushes, and only the drawings: other unpushed commits on that branch stay local (then run `git pull --rebase` before pushing it yourself; the message says so). On any other branch it asks, then commits without pushing.
- **Rename / delete:** hover a drawing and use ✎ or 🗑. The `.png` with the same name moves or goes with it. Delete asks first.
- **Agents:** an agent can save with `POST /api/save` without any browser tab open. Elements it drew in MCP shorthand (labels, arrow `start`/`end`) are expanded into normal Excalidraw elements on save, and the canvas is updated to match. `GET /api/status` shows how many such elements are waiting (`agentElements`).
- **Unsaved badge:** "● Unsaved changes" after a real edit, "Saved" after a load or save. Leaving the page with unsaved changes shows the browser's warning.

The sidebar marks the highest version of each project as "latest". Files that don't follow the naming scheme are listed as "unversioned". 

### Naming
`<project>/<project>_v<i>[_<label>].excalidraw`, e.g. `budgeting/budgeting_v1_plan_with_proposal.excalidraw`. "Save new version" picks the next `v<i>`; each meaningful new state of a drawing gets one. A `.png` of a drawing has the same base name. Other `.excalidraw` files in a project folder are listed as "unversioned".

## Test
```bash
docker build -t excalidraw-hub-unit . && docker run --rm -u 1000:1000 -e HOME=/tmp -v "$PWD:/app:ro" -w /app excalidraw-hub-unit node --test test/   # unit + API + real git (the image has git)
scripts/e2e.sh   # browser tests, Playwright in Docker, against a throwaway git repo
scripts/screenshots.sh   # regenerates the README images in docs/images/ (same isolated stack, made-up drawings)
```
Without Docker: `npm test`, and `E2E_RUNTIME=native scripts/e2e.sh` (after `scripts/native.sh install` and `npm ci` in `e2e/`. Playwright needs a Chromium: `npx playwright install chromium` in `e2e/`, or `CHROMIUM_PATH=<path to chrome>`).
`scripts/e2e.sh` starts its own canvas (port 3100) and hub (port 3180) over a throwaway git repo holding a copy of `fixtures/`, with a bare repo as its origin. It never touches port 3000, the real drawings or any real repo.

## Layout
| Path | What it is |
|---|---|
| `canvas/` | The canvas on :3000: git subtree of a [yctimlin/mcp_excalidraw](https://github.com/yctimlin/mcp_excalidraw) 2.1.2 fork, plus code blocks (paste Mermaid / PlantUML / Salt, hover to toggle code and diagram). Design: `canvas/docs/specs/2026-11-14-code-block.md` |
| `src/` | Server: `names.js` (naming rules), `scene.js` (unsaved detection, save format), `agent.js` (expands agent elements), `store.js` (files), `backups.js` (copies for Revert), `workspace.js` (attached folders, `workspace.json`), `git.js` (sync), `canvas.js` (canvas client), `server.js` (HTTP API) |
| `backups/` | Copies of overwritten drawings, for Revert (gitignored). Attached folders' copies are under `backups/_folders/<id>/` |
| `workspace/` | `workspace.json`: the attached folders (gitignored) |
| `scripts/` | `native.sh` (run without Docker), `e2e.sh` (browser tests, Docker or native), `screenshots.sh` |
| `public/` | The page: one HTML file, a script and a stylesheet, no build step |
| `test/`, `e2e/` | Unit/API tests (`node --test`) and Playwright browser tests |
| `docs/images/` | README screenshots, made by `scripts/screenshots.sh` from `e2e/readme.shots.js` |
| `fixtures/` | Test drawings: sample projects plus an image test |
| `drawings/` | Default drawings folder when `HUB_REPO` is not set (gitignored) |
| `probe/` | Scripts that checked the canvas behaviour the design relies on |
| `docs/` | [Spec](docs/specs/2026-11-02-excalidraw-hub.md), plans with outcome ([build](docs/plans/2026-11-02-excalidraw-hub.md), [error fixes](docs/plans/2026-11-14-hub-errors.md), [save/revert/sync](docs/plans/2026-11-14-save-revert-sync.md), [workspace folders](docs/plans/2026-11-16-workspace-folders.md)), [setup](docs/setup.md) |

## Limits
- Background and grid changes made in the canvas are not saved, because the canvas does not expose them. A saved drawing keeps the background it was loaded with.
- A drawing's background colour is not shown on the canvas after loading.
- Labels an agent drew with no tab open get an estimated size until a tab re-measures them.
- The canvas on port 3000 has no protection against other web pages of its own. A page could rewrite the canvas, and a later unversioned save would then overwrite the loaded file. Git keeps committed states.

Why each design choice was made is in the [spec](docs/specs/2026-11-02-excalidraw-hub.md).
