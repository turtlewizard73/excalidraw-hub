# Plan: run without Docker

Spec: [2026-11-16-run-without-docker](../specs/2026-11-16-run-without-docker.md). Branch `feat/run-without-docker` from `development`. Not merged.

## Steps
1. Probe: does `canvas/` build with plain npm, and can PlantUML run natively?
2. Add `scripts/native.sh` (install/start/stop/restart/status) and add `.native/` to `.gitignore`.
3. Add the `E2E_RUNTIME=native` mode to `scripts/e2e.sh` and `CHROMIUM_PATH` to `e2e/playwright.config.js`.
4. Docs: README Run/Test, `docs/setup.md`.
5. Verify natively: `npm test`, native e2e, lifecycle and failure paths (busy port, empty drawings folder, `.env` parsing, `PLANTUML_URL` passthrough). Check the Docker path with `docker compose config`.
6. Independent review, then push the branch.

## Outcome
- Done as planned. `scripts/native.sh` runs canvas + hub as host processes. This feature leaves the Docker files unchanged apart from `.gitignore` and the boot-race log message; `compose.yaml` and the canvas proxy change only through the external-renderer work merged with it (`2026-11-16-external-renderer.md`).
- Verified (2026-11-16, Node 22.23, Linux sandbox): `npm test` 92/92; `E2E_RUNTIME=native CHROMIUM_PATH=/opt/pw-browsers/chromium scripts/e2e.sh` 15/15; start/status/idempotent start/stop leave no processes behind; a busy :3000 is refused; an empty drawings folder stops both processes and shows the reason; `PLANTUML_URL` reaches the canvas proxy.
- Not verified: the Docker stack itself (no Docker daemon in the sandbox) and `plantuml.jar -picoweb` (running the jar was blocked in the sandbox).
- Differed from plan: `npm test` was already broken on Node 22 (`node --test <dir>`) and is fixed with a glob. The native e2e also needed `CHROMIUM_PATH`, because e2e pins Playwright 1.56.1 while the host had another Chromium build.
- Independent review (subagent) found, and reproduced, these. All fixed and re-tested:
  - `stop` gave up while the hub held an open request. Now SIGKILL follows.
  - A pid file whose pid had been reused was trusted, and `stop` killed the foreign process. Now `/proc` cmdline is checked.
  - A relative `NATIVE_DIR` broke start.
  - Native e2e inherited exported `CANVAS_URL` etc., which could aim the tests at the real :3000 canvas. Now every setting is explicit.
  - `.env` parsing differed from compose: last line without a newline, `=` in values, `#` inside quotes, duplicates.
  - A failed hub stopped a canvas that was already running.
  - curl was not checked.
  - `E2E_RUNTIME=native scripts/screenshots.sh` mangled its command. It now refuses: screenshots stay Docker-only.
  - Re-run after the fixes: unit 92/92, native e2e 15/15 with `CANVAS_URL=http://127.0.0.1:3999` exported.
- Learned: `.env` inline comments (`KEY=v   # note`) left trailing spaces in the value, which broke the readiness URL. The lifecycle test caught it; the parser now strips the comment, the spaces and the quotes.
- Consolidation (2026-11-16): merged with `feat/external-renderer` into one PR. `PLANTUML_URL` now means the same in both runtimes (a renderer URL; under Docker unset = local container, natively unset = off), docs cross-linked. A second independent review found that compose expands `${VAR}` and `\"` in `.env` but `native.sh` did not; `native.sh` now refuses such values with a message. Also noted: `start` keeps a running process's old config, so `restart` after editing `.env`.
- Re-verified after consolidation: unit 92/92, canvas tests pass, native e2e 15/15, native start with `PLANTUML_URL` at a local Kroki-like stub gives SVG and the 502-with-message path, `docker compose config --services` lists `plantuml` only when `PLANTUML_URL` is unset.
