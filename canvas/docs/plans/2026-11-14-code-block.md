# Plan: code block

Spec: [../specs/2026-11-14-code-block.md](../specs/2026-11-14-code-block.md). Work in `sandbox/excalidraw-codeblock/canvas` on `feat/code-block`; run the isolated stack from `sandbox/excalidraw-codeblock/` (`docker compose up -d --build`, canvas :3001, hub :3081).

1. **Baseline.** Build the unmodified fork with the stack; confirm :3001 and :3081 work and load a fixture. Pin `plantuml/plantuml-server` to a version tag. Check `POST <plantuml>/svg` with a source body returns SVG (that is the endpoint the proxy uses).
2. **Probe the risky bits** (`probe/` in this repo, throwaway): add an SVG-mimetype image via `POST /api/files` + an image element via REST, then check (a) the browser shows it, (b) `POST /api/export/image {format:'png'}` draws it, (c) the hub saves and reloads it with `customData` intact. If (b) fails, rasterise to PNG in the browser (spec fallback).
3. **Renderers.** `frontend/src/codeblock/render.ts`: `render(lang, source)`, `detectLang(text)`, `codeSvg(source)`. Mermaid via `mermaid.render`. Unit tests for `detectLang` (fences, @startsalt, @startuml+salt, mermaid keywords, plain text) and `codeSvg` (escaping `<&>`).
4. **Create on paste.** `onPaste` in `App.tsx`: detected text → render → `addFiles` + insert image element at the pointer with `customData`, sync to server like other new elements. Undetected text → default paste.
5. **Hover overlay + editor.** Overlay with `Code`/`Diagram` and `Edit` over the hovered block; textarea editor (Save/Cancel, language select). Re-render keeps x/y/width. "Code block" button to create an empty one.
6. **PlantUML + Salt.** Server route `POST /api/render/plantuml` → `PLANTUML_URL/svg` (size limit, timeout, error passthrough); renderer entries for `plantuml` and `salt`.
7. **Verify.** Upstream tests still pass (`npm test` in Docker). Playwright e2e against :3001/:3081: paste each language, toggle, edit, save in hub, reload, PNG shows the diagram. Independent review by another agent before calling it done.
8. **Outcome** section below; record the lesson for chartroom (`projects/chartroom`) in parent repo's task record.

Not in scope: pushing the fork to GitHub or upstreaming (ask first); switching the real stack (:3000) to this image.

## Outcome
Built on `feat/code-block-build` (worktree `sandbox/excalidraw-codeblock/canvas-build`).

- **Done:** paste detection (Mermaid, PlantUML, Salt, fenced blocks), "Code block" button + editor (language select, Ctrl+Enter), hover `Code`/`Diagram` toggle and `Edit`, `/api/render/plantuml` proxy to a digest-pinned `plantuml-server`. Code in `frontend/src/codeblock/`; `App.tsx` has 4 hook-ins, `server.ts` one route.
- **Verified:** unit 6/6 (`node --experimental-strip-types --test frontend/src/codeblock/codeblock.test.ts`, node 22); browser 5/5 (`playwright.codeblock.config.mjs`, Playwright 1.63 in Docker on the compose network); upstream `npm test` exit 0; hub :3082 save → `.excalidraw` keeps `customData` + PNG file, headless PNG shows the diagram text, reload restores the block.
- **Differed from plan:** images are PNG, not SVG (step 2 probe: resvg drops nested-SVG text). File ids use a string hash, not `crypto.subtle` (needs a secure origin). Hub moved to :3082 (:3081 is Excalidash). Hub needed no code changes.
- **Learned:** (1) Upstream race: the WebSocket `initial_elements` is applied only after the font preload and replaces anything drawn in the first ~1 s after load; tests wait for `document.fonts.ready`. (2) Excalidraw `onChange` fires on every host re-render, so a listener that sets state unconditionally loops (React #185); compare a key first. (3) Old renders stay in the canvas server's file map until restart; the hub's save drops unused files.
- **Not done:** rotation-aware hover buttons, agent/MCP tool for code blocks, dark-mode styling of the code view, pushing the fork.
