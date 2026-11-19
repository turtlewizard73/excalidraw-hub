# Handoff: fix excalidraw-hub errors found on 2026-11-14

## Task
Fix the excalidraw-hub problems listed below. Work in `sandbox/excalidraw-hub/`. Read its `README.md`, `docs/specs/2026-11-02-excalidraw-hub.md` and `docs/plans/2026-11-02-excalidraw-hub.md` first. Follow the parent repo's root `CLAUDE.md`:
- Open a task record in `tasks/`.
- Work on a `feat/` branch.
- Run tests in the isolated stack (`scripts/e2e.sh`, ports 3100/3180), never against the live canvas `:3000` or `docs/drawings/`.
- Get an independent review before calling it done.

Reproduce each problem before fixing it. E2 and E3 are unconfirmed, so confirm or rule them out first.

## Context
- **Hub:** a Node server, Docker, `127.0.0.1:3080`. It shows a sidebar of drawings over an iframe of the mcp_excalidraw canvas (`:3000`, image `ghcr.io/yctimlin/mcp_excalidraw-canvas:2.1.2`), and saves to `the parent repo/docs/drawings/<project>/`.
- **Session that hit these problems:** an agent drew C4 diagrams with the excalidraw MCP tools (`batch_create_elements`, `update_element`), plus canvas REST `PUT /api/elements/:id` to re-route arrow points. It then tried to save through the hub, `POST /api/save {"project":"chartroom","label":"hub_and_excalidash_c4","versioned":true}`.
- **The user** has the hub page open only sometimes. They often view drawings as `.excalidraw` files in VS Code instead.

## Problems

### E1. Agents cannot save without a browser tab (blocking)
- **Symptom:** `POST /api/save` returned `409 {"error":"the canvas has not synced from a browser tab yet; wait a second and retry"}`. It failed on every retry for minutes: 12 retries, 5 s apart, in two rounds.
- **Cause:** the MCP server stores elements in shorthand: `label: {text}` on shapes and arrows, and `start: {id}` / `end: {id}` on arrows. Only an open canvas browser tab expands these into bound text elements and `startBinding`/`endBinding`. `src/scene.js:82` `hasShorthand()` and `src/server.js:73` refuse to save while any shorthand remains. With no tab open, it never goes away.
- **Reproduce:** close all hub and canvas tabs. `POST http://127.0.0.1:3000/api/elements/batch` with one rectangle carrying `label: {text: "A"}` and one arrow with `start`/`end`. Then call `/api/save`.
- **Workaround used:** `probe/2026-11-14-expand-shorthand.py` expands the shorthand offline:
  - Labels become bound text elements with an estimated width (0.48 × fontSize per char) and height (lines × fontSize × 1.25).
  - `start`/`end` become bindings, and fractional `index` values are added after the existing ones.
  - The result was written straight to `docs/drawings/chartroom/chartroom_v1_hub_and_excalidash_c4.excalidraw` (220 elements) and loaded with `/api/load`. It renders correctly.
- **Fix options:** pick one and record the decision in the spec.
  - (a) Expand shorthand on the server inside save, reusing the probe's logic. This is what makes agent-only workflows work.
  - (b) Keep the refusal but make the error say the real cause and fix: "N elements are still in MCP shorthand; open http://localhost:3080 so the canvas tab can convert them". Also report the shorthand count in `GET /api/status`.
  - Option (a) is preferred, with (b)'s status field added.

### E2. Status may report a false `dirty: true` (unconfirmed)
- **Observation:** at the start of the session, `GET /api/status` returned `{"current":{"project":"chartroom","file":"chartroom_v0_hub_prototype_c4.excalidraw"},"dirty":true,"elementCount":97}`.
- A field-by-field compare of the 97 canvas elements against the v0 file found no differences once these fields were ignored:
  - `updated`, `version`, `versionNonce`, `index`, `seed`
  - the canvas-only fields `syncedAt` and `syncTimestamp`
- **Possible causes:** appState drift, the baseline being lost after a hub restart, or a volatile field in the dirty compare. Compare against `probe/dirty-canon.mjs` and `probe/dirty-hybrid.mjs`, which earlier work used for the same question.

### E3. Unsaved agent work lost when a drawing was loaded from the page (unconfirmed severity)
- **Symptom:** 70 unsaved agent-drawn elements disappeared. Status then showed v0 loaded, `dirty: false`, 97 elements.
- **Likely cause:** the user clicked v0 in the sidebar and accepted the generic confirm in `public/app.js:83` ("The canvas has unsaved changes. Loading replaces them. Continue?") while looking for the new drawing.
- **Proposed fix:** before any forced load, write the current canvas to an autosave file, for example under the hub data dir or `sandbox/canvas-backups/`, and name it in the confirm dialog or a toast. Optionally show the count of unsaved elements in the confirm text.

### E4. Save writes no PNG (feature gap)
- `store.js` pairs `<base>.png` with drawings and moves it on rename. `/api/save` never creates one, so the agent exported the PNG separately with MCP `export_to_image`.
- **Decide:** should save render a PNG? The canvas server has a headless renderer (the MCP `export_to_image` and `get_canvas_screenshot` tools use it). Or keep this out of scope and document it.

## State at handoff (2026-11-14 14:36 +01:00)
- The hub has `chartroom_v1_hub_and_excalidash_c4.excalidraw` loaded, not dirty, 220 elements. The PNG is next to it.
- Canvas backups are in `sandbox/canvas-backups/`. The ExcaliDash diagram spec is `2026-11-14-excalidash-c4-spec.py`.
- The task record for the drawing work is `tasks/2026-11-14-chartroom-excalidash-c4.md`. It covers the C4 drawing only; open a new record for these fixes.
