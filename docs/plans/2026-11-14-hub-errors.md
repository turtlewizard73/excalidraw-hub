# Plan: fix hub errors E1–E4 (2026-11-14)

Input: [handoff](../handoffs/2026-11-14-hub-errors.md). Spec: [2026-11-02-excalidraw-hub.md](../specs/2026-11-02-excalidraw-hub.md), sections "Agent-format elements", "Load", "PNG on save". Branch `feat/hub-errors`, squash-merged to `main` on request. Task record: the parent repo `tasks/2026-11-14-excalidraw-hub-errors.md`.

## Reproduction (before any code, isolated stack :3100/:3180)
- **E1 confirmed.** With no tab, `POST /api/elements/batch` of a labelled rectangle and a bound arrow, then `/api/save` → 409 "has not synced from a browser tab yet", indefinitely.
- **E2 ruled out: the dirty flag was correct.** The v0 file was last written at 13:37 by the hub (`source: excalidraw-hub`), so the hub's baseline was that file. Running the hub's own `scene.js` compare on the 14:23 canvas backup (`sandbox/canvas-backups/2026-11-14-canvas-before-excalidash-c4.excalidraw`) against v0 finds one real difference: the `legend` text moved from (1360, 1680) to (1530.7, 1320.7) and gained `frameId: "f-l2"`, with `updated` at 14:21:39. That was a mouse drag into frame L2 in a browser tab, 2 min after that session started. The handoff compared the canvas against the backup, not against v0. No compare change.
- **E3 confirmed.** Load → agent adds an element → load returns 409 dirty → `force: true` wipes it, nothing is written anywhere.
- **Tab ground truth** (`probe/2026-11-14-tab-conversion.mjs`): an open tab turns `label` into a `<id>-label` text element (fontSize 20, fontFamily 5, centred), `start`/`end` into bindings with back-references, fills every missing default (`roundness: null`, `seed`, `index`, …), and ignores `text` on shapes. A tab syncs only on its next change, not on open.
- **Headless PNG:** canvas `POST /api/export/image {format:"png"}` renders in node with no tab (`renderer: "node"`), shorthand included.

## Steps
1. Commit handoff, probes, spec update and this plan.
2. `src/agent.js` (new, pure): `isAgentFormat(e)` (has `label`/`start`/`end`, or no `seed`) and `expandAgentElements(elements, rand)` → complete Excalidraw elements. Unit tests first: mixed scene leaves complete elements byte-identical, idempotent, `<id>-label` collision, missing arrow target, label on a container that already has bound text, index keys ascending after the current max.
3. `server.js` save: expand → if anything changed, write back to the canvas (`batch replace`) and re-read; build the document from the expanded elements; set the baseline from the re-read canvas. `/api/status` gains `agentElements`.
4. E3: `src/autosave.js` writes the canvas (expanded) to `AUTOSAVE_DIR` before a forced load of a dirty canvas, keeps the newest 50. The write failing aborts the load. 409 payload carries `elementCount`; load response carries `autosaved`. `app.js` confirm and message name them. Mount `./autosave` in both compose files, gitignore it.
5. E4: after a save, `canvas.exportPng()` and `store.writePng()` (atomic). Best-effort: the save response reports `png: true` or `pngError`.
6. Tests: API tests on the fake canvas (expand + write-back + clean status, autosave, png). E2E: a first spec, run before the page opens, asserting `websocketClients == 0`, then save 200 → status clean → file has bound text and bindings → PNG exists → open page and interact → still clean. Then the existing suite, plus forced-load autosave.
7. README (limits: stale PNG gone), setup.md (autosave mount), independent review, `## Outcome`.

## Verification
- `docker run --rm -v "$PWD:/app:ro" -w /app node:20-slim node --test test/`
- `scripts/e2e.sh` (tear down the manual stack first: same compose project name).

## Outcome
Done 2026-11-14. Squash-merged to `main` and deployed to the live hub on :3080.
- **E1 fixed.** Agents save with no tab: `src/agent.js` expands shorthand and skeletal elements, the file is written, then the canvas is updated to match. E2E proves it with zero websocket clients: save 200, status clean, bound labels and bindings in the file, PNG written, and still clean after a tab opens and syncs.
- **E3 fixed.** A forced load over unsaved work first writes `autosave/<timestamp>_<drawing>.excalidraw` (newest 50 kept). A failed backup aborts the load. The confirm shows the element count; the message names the backup.
- **E2: not a bug.** The dirty flag was right: the legend had been dragged into frame L2 at 14:21:39. No change.
- **E4 fixed.** Every save writes `<name>.png` using the canvas's headless renderer. Best-effort; an overwrite regenerates it, so the README's stale-PNG limit is gone.
- **Tests:** 70 unit/API (`node --test`), 13 e2e (`scripts/e2e.sh`), all passing.

**Differed from the plan**
- Write-back moved after the file write, guarded by a canvas fingerprint. The review found that a replace right after the read wiped concurrent agent writes, and that refused saves had already rewritten the canvas.
- No reordering of elements. The first version moved un-indexed elements to the end, which changed z-order (review).
- Edited complete elements get a version bump (review). Shapes without a size get 100 × 100. `start: null` no longer unbinds.
- The advisor suggested keeping the 409 while a tab is connected. Not done: a hidden tab may never sync, which would bring E1 back. A race with a converting tab is benign because both name labels `<id>-label`.

**Learned**
- An open tab syncs only on its next change, not on open, so "wait for the tab" is not a dependable save precondition.
- The canvas's own `expandElementsForExport` cannot be reused on mixed scenes (rounding, renumbering). The headless renderer can be reused and needs no tab.
- The handoff's E2 evidence compared the canvas against the wrong reference. Running the hub's own compare on the saved backup settled it in one step.

**Open**
- Residual race between the re-check and the write-back (two requests; no compare-and-swap on the canvas).
- Estimated label sizes until a tab re-measures.
