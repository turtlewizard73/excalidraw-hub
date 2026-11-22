# Plan: page startup survives a failed request (2026-11-20)

Branch `feat/boot-retry` (worktree `tortuga/sandbox/tmp/hub-boot-retry`). Task record: the parent repo `tasks/2026-11-20-hub-stuck-loading.md`.

## Bug
After a hub restart (Docker Desktop start, 2026-11-20) the sidebar stayed on "Loading…" until a manual reload.
- Cause: `public/app.js` ends in a chain of top-level awaits (`/api/config` → `/api/status` → `/api/folders` → `/api/tree`). One rejected request stops the module: no retry, no message, and `setInterval(refreshStatus)` (after the chain) never starts.
- Reproduction: Playwright, abort the first `/api/folders` → tree still "Loading…" after 30 s. Without the abort the tree shows in ~0.1-0.14 s (also right after a hub restart, and from Windows curl: 3-27 ms per call), so it is not slowness.

## Steps
1. e2e test first (`e2e/boot.spec.js`): new page, abort the first `/api/folders` and the first `/api/config` (separate tests), expect the root folder row to appear and the "Hub not reachable" text before it. Watch it fail on the current code.
2. `public/app.js`: wrap the start chain in `boot()`. On failure write "Hub not reachable, retrying…" (with the error) into `#tree`, wait 2 s, retry until it succeeds. The canvas iframe src is set once only (a retry must not reload the canvas).
3. Unit tests + full `scripts/e2e.sh`, independent review, `## Outcome`.

Based on: the measured cause above; `refreshStatus` already shows "Canvas offline"-style states, so a retrying message fits the existing UI.

Not built: caching headers, and the `~/.gitconfig` single-file bind mount that failed at Docker start (separate issue, offered to the user).

## Outcome
Done 2026-11-20 on `feat/boot-retry`; follow-up and merge 2026-11-22.
- A failed startup request now shows "Hub not reachable, retrying… (<error>)" in the sidebar and retries every 2 s; the tree appears once the hub answers. The canvas iframe is set once, so a retry does not reload it.
- Differed: GET requests in `api()` now time out after 10 s (`AbortSignal.timeout`), POSTs stay untimed. The review pointed out that "only after reload" fits a hung request as well as a failed one; a third e2e case (first `/api/folders` never answers) went red without the timeout and green with it.
- Evidence: `scripts/e2e.sh npx playwright test boot.spec.js` red (2 failed, "Loading…") before the fix, 3 passed after; full `scripts/e2e.sh` 31 + 1 passed. Unit tests: 7 failures, identical on unchanged `development`, caused by the `node:20-slim` test image having no git (pre-existing, not touched).
- Follow-up 2026-11-22: a folder whose `/api/tree` failed used to keep its error until the loaded drawing changed or the page reloaded. Now the 2 s status poll re-fetches only the errored folders (one retry in flight at a time; review: refetching every open folder forever on a permanent error would not scale) and re-renders only when one changed. Mutation check: without the retry call the test goes red again. e2e `first /api/tree fails` red ("Failed to fetch") before, green after. Re-verified: boot spec 4 passed, full `scripts/e2e.sh` 32 + 1 passed, unit tests 153/153 in `node:20` (has git; the 7 earlier failures were the `node:20-slim` image) on both the branch and `development`.
- Still open: the hub container itself still dies at Docker Desktop start on the `~/.gitconfig` single-file mount, which this page fix cannot restart.
- Learned: top-level await chains in a page are all-or-nothing; give the boot a retry loop and give reads a timeout.
