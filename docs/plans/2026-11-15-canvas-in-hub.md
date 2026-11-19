# Plan: the hub owns its canvas (code blocks)

Goal: the code block element (Mermaid / PlantUML / Salt, spec `canvas/docs/specs/2026-11-14-code-block.md`) on the real canvas at :3000. The editor lives in the canvas, not the hub, so the hub repo takes over the canvas.

## Decisions
| Decision | Based on |
|---|---|
| Vendor the canvas fork as a git subtree in `canvas/` (squashed) | No GitHub fork or push needed (a submodule needs a remote); plain files; `git subtree pull` can still take upstream releases. A copy would lose that. |
| Hub `compose.yaml` runs canvas (:3000, fixed), plantuml-server (pinned, `SANDBOX` profile, no host port) and hub; hub reaches the canvas as `http://canvas:3000` | One compose for the whole stack; :3000 is what the parent repo's MCP script connects to. |
| the parent repo's root `compose.yaml` drops its stock canvas service | Two canvases cannot share :3000. |
| Test stack (`compose.test.yaml`) builds the same canvas | Hub e2e must test the canvas it ships with. |
| `SYNC_BRANCH` default `dev` → `development` | the parent repo renamed its integration branch (2026-11-15). |
| `.dockerignore` with `canvas/` | The hub image only copies `src/` and `public/`. |

## Steps
1. Hub feat branch (worktree `sandbox/excalidraw-codeblock/hub`, ff to `main`): subtree add, compose, test stack, docs, default branch.
2. Verify: hub unit tests, `scripts/e2e.sh` (now with the built canvas), code-block Playwright tests against the test stack.
3. Independent review of the compose changes and cutover.
4. Squash into hub `main` (not pushed).
5. Cutover: snapshot :3000 to the parent repo `sandbox/canvas-backups/`, `docker compose down` at the parent repo root, `docker compose up -d --build` in `sandbox/excalidraw-hub`, health checks, restore the snapshot, compare counts, MCP read check.
6. the parent repo feat branch: remove canvas service, update `docs/setup.md`; squash into `development`.

Rollback: `docker compose down` in the hub, `git -C <the parent repo> show <old development>:compose.yaml > /tmp/c.yaml && docker compose -f /tmp/c.yaml -p the parent repo up -d`, then the previous hub image (`git checkout` the old hub `main` in a worktree and `up -d --build`).
