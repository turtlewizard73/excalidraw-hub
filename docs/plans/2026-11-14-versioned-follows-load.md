# Plan: Versioned checkbox follows the loaded drawing (2026-11-14)

Spec: `docs/specs/2026-11-02-excalidraw-hub.md`, "Save: versioning is an opt-in checkbox". Branch `feat/versioned-follows-load`.

## Steps
1. `public/app.js`: one `followVersioned(current)` helper that looks the drawing up in the listed projects (`d.version !== null` means versioned) and sets the checkbox and button text. Call it after a successful load and once at page open. Client only: the server's `versioned` flag stays required, so nothing changes on the API.
2. E2E (`e2e/hub.spec.js`): loading a versioned drawing ticks the box and labels the button "Save new version"; loading `board-before-clear` unticks it.
3. Unit + e2e runs, independent check, `## Outcome`.

Not built: a server-side default. The page decides, so an agent using the API still chooses explicitly.

## Outcome
Done 2026-11-14 on `feat/versioned-follows-load`. Loading a `<project>_v<i>` drawing ticks Versioned and the button reads "Save new version". Loading any other file unticks it. A page opened with a versioned drawing already loaded starts ticked. The API is unchanged. Tests: 70 unit/API and 14 e2e pass (new e2e: "versioned: follows the loaded drawing").
- Differed: none. Not followed on purpose: a load made from another tab (seen through the 2 s status poll) does not flip this tab's checkbox, so a manual choice is not overridden behind the user's back.
- No separate reviewer: a client-only change of about 15 lines, fully covered by the e2e test.
