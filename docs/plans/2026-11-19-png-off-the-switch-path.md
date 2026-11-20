# Plan: PNG off the switch path

Spec: [../specs/2026-11-19-png-off-the-switch-path.md](../specs/2026-11-19-png-off-the-switch-path.md). Branch `feat/switch-speed` (worktree `../excalidraw-hub-switch-speed` next to the parent repo). Task record: the parent repo's `tasks/2026-11-19-hub-switch-speed.md`.

## Steps
1. Canvas `src/core/render/png.ts`: `svgToPng` becomes async with `renderAsync`; update its callers (`render/index.ts`, CLI).
2. Canvas `src/server.ts`: `exportImageSchema` gains optional `elements` (array) and `files` (object); the node renderer uses them when given. The browser renderer ignores them (it renders the tab).
3. Hub `src/canvas.js`: `exportPng(scene?)` sends the scene.
4. Hub `src/server.js`:
   - `renderPng` gets a background mode: per-path generation counter, a pending set, `idle()` promise, last error per path.
   - `saveCanvas({ ..., png })`: `"background"` starts the render from `doc` and returns `png: "pending"`; docs over 9 MB fall back to waiting.
   - Load and revert autosaves pass `png: "background"`.
   - Rename, move, delete, revert, sync await `idle()` first.
   - `GET /api/status` adds `png: { pending, error }`.
5. Hub `public/app.js`: save sends `png: "background"`; message "(.png rendering)"; `refreshStatus` shows a new PNG error once.
6. Tests: unit/API tests with the fake canvas (background returns before the render ends; latest wins; delete waits; status error); canvas render test still passes; e2e message texts updated, PNG asserted with a poll. Measure the probe table again.
7. README "PNG on save" text, independent review, `## Outcome`.

## Outcome
- Done as planned. README: the "Every save also writes" line now says the page renders in the background.
- Measured on the test stack over a copy of a real drawings folder (529-element drawing, page Save button):

| | before | after |
|---|---|---|
| Save | 2.1 s | 0.18 s |
| Switch right after a save | waits for the PNG | 0.09 s |
| Switch with unsaved changes | 0.6–2.0 s | 0.21–0.67 s |

- Differed from the plan:
  - Review (subagent) found stale errors after rename/move/delete/detach, detach not waiting, a sync race (a save during a sync), and a character-vs-byte size check. All fixed; detach was added to the waiting operations.
  - Renders of a given scene lose the browser-tab fallback (spec decision 2).
- Learned:
  - The canvas export blocked its whole event loop: a `GET /api/elements` waited 1.7 s during a render. resvg's `renderAsync` fixes that with the same bytes.
  - The PNG time itself (2–5 s, longer right after a restart) no longer matters for switching, which is what the user cares about.
  - There was no false "unsaved" state after a save; the delay was only the render.
- Tests: 153 unit/API tests pass (7 new ones for background renders); canvas `check-render` passes; e2e 28 + 1 passed.
