# Spec: standalone (no knowledge of any parent repo)

## Goal
The hub runs from its own clone with zero configuration and knows nothing about the repo that happens to use it. A parent repo (for example as a git submodule) passes its settings in from outside; nothing in this repo names it.

## Not building
- No config file format of our own: settings stay environment variables (`.env` or the shell), as today.
- No migration of an existing `.env`. A setup that relied on the old defaults (`HUB_REPO=../..`, drawings in `docs/drawings`, sync branch `development`) must now set them, e.g. through a wrapper in the parent repo.
- Historical specs/plans keep their content; only the parent repo's name is replaced with a neutral term.

## Design
| Setting | Old default | New default | Meaning |
|---|---|---|---|
| `HUB_REPO` | `../..` (parent repo root) | `./drawings` (gitignored, in this repo) | Folder that holds the drawings folder. Git sync is on only if it is the top of a git work tree. |
| `HUB_DRAWINGS_SUBDIR` | (fixed `docs/drawings`) | `.` | Drawings folder inside `HUB_REPO`. |
| `SYNC_BRANCH` | `development` | `main` | The only branch sync pushes from. |

- Sync detection in `src/main.js`: `git -C REPO_DIR rev-parse --show-toplevel` must equal `REPO_DIR` (real paths). Otherwise sync is off and the log says why. This keeps a native run with the default `./drawings` from committing into the hub's own repo (git would otherwise find the hub checkout as the enclosing repo).
- `drawings/.gitkeep` is tracked so the default folder is never empty (the boot-race guard exits on an empty folder).
- The naming scheme (`<project>/<project>_v<i>[_<label>].excalidraw`) is written in the README instead of pointing to the parent's CLAUDE.md.
- Port 3000 stays the canvas default: the agent's Excalidraw MCP expects it. The comment no longer names the parent's script.

## Decisions
| Decision | Based on |
|---|---|
| Default to a folder inside this repo, not "required setting" | `docker compose up` must work on a fresh clone with no config (independence). |
| Keep the variable name `HUB_REPO` | Existing `.env` files and the parent's wrapper keep working; renaming buys nothing. |
| Detect sync by `--show-toplevel`, not by "REPO_DIR is set" | Under Docker the default mount has no `.git` (sync off naturally); natively the default folder sits inside the hub's checkout and must not sync into it. |
| Parent passes settings with a wrapper script in the parent repo that writes them into the hub's gitignored `.env` (a marked block) and also exports them | The settings live in the parent repo, nothing is committed here. Writing `.env` (not only exporting) keeps a plain `docker compose up` / `native.sh restart` in the hub folder on the parent's drawings: found in review, a shell-only wrapper silently fell back to the empty default. |
