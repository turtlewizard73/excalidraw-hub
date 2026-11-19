#!/usr/bin/env bash
# End-to-end run: fresh fixture copy -> isolated canvas + hub -> Playwright -> teardown.
# SEED_DIR (default fixtures/) is copied in as the drawings; arguments replace the runner command (see scripts/screenshots.sh).
# Without arguments the suite runs in two phases around a hub restart: everything not tagged @restart, then the @restart
# tests (e2e/restart.spec.js), which check that attached folders survive the restart.
# E2E_RUNTIME=native runs the stack with scripts/native.sh and Playwright on the host instead of Docker
# (needs `scripts/native.sh install`, `npm ci` in e2e/ and a Playwright Chromium); arguments then go to `playwright test`,
# so scripts/screenshots.sh (which passes a whole runner command) stays Docker-only.
set -euo pipefail
cd "$(dirname "$0")/.."
runtime="${E2E_RUNTIME:-docker}"
[ "$runtime" != native ] || [ "${1:-}" != npx ] || { echo "E2E_RUNTIME=native takes playwright test arguments, not a runner command" >&2; exit 2; }
# Everything the stack touches lives under $tmp, which is also FOLDERS_ROOT and is mounted at the same path in the
# containers, so every path means the same thing to the hub, the tests and git.
tmp="$(mktemp -d /tmp/excalidraw-hub-e2e.XXXXXX)"
repo="$tmp/repo" remote="$tmp/remote.git" backups="$tmp/backups" state="$tmp/state/hub.json"
drawings="$repo/docs/drawings"
mkdir -p "$drawings" "$backups" "$(dirname "$state")"
cp -r "${SEED_DIR:-fixtures}/." "$drawings/"
# A second folder to attach (e2e/workspace.spec.js).
extra="$tmp/extra"
mkdir -p "$extra/other-repo/docs/drawings/notes"
echo '{"type":"excalidraw","version":2,"elements":[{"id":"n1","type":"rectangle","x":0,"y":0,"width":80,"height":40}],"appState":{}}' \
  > "$extra/other-repo/docs/drawings/notes/notes_v0.excalidraw"
# The hub starts with the throwaway repo's drawings attached (state file v2).
printf '{"version":2,"folders":[{"path":"%s"}],"recent":[]}\n' "$drawings" > "$state"
# Throwaway repo on dev (an auto-sync branch) with a bare origin and upstream tracking.
g() { git -C "$repo" -c user.name=e2e -c user.email=e2e@example.invalid "$@"; }
git init -q --bare -b dev "$remote"
git init -q -b dev "$repo"
g add -A && g commit -qm fixtures
g remote add origin "$remote" && g push -q -u origin dev
mkdir -p test-results
e2e_env=(DATA_DIR="$drawings" REPO_DIR="$repo" BACKUPS_DIR="$backups" REMOTE_DIR="$remote" EXTRA_DIR="$extra" STATE_FILE="$state")

wait_ready() {
  for _ in $(seq 60); do curl -sf http://127.0.0.1:3180/api/status >/dev/null && curl -sf http://127.0.0.1:3100/health >/dev/null && return 0; sleep 1; done
  echo "test stack did not become ready" >&2; return 1
}

if [ "$runtime" = native ]; then
  native() {
    # Every setting explicit: nothing from .env or the shell (e.g. CANVAS_URL) may point the tests at the real canvas.
    NATIVE_ENV_FILE=/dev/null NATIVE_DIR="$tmp/native" CANVAS_PORT=3100 HUB_PORT=3180 \
    CANVAS_URL=http://127.0.0.1:3100 CANVAS_PUBLIC_URL=http://localhost:3100 PLANTUML_URL= HUB_ALLOWED_HOSTS= \
    BACKUPS_DIR="$backups" HUB_STATE="$state" FOLDERS_ROOT="$tmp" \
    GIT_AUTHOR_NAME=e2e GIT_AUTHOR_EMAIL=e2e@example.invalid GIT_COMMITTER_NAME=e2e GIT_COMMITTER_EMAIL=e2e@example.invalid \
    scripts/native.sh "$@"
  }
  pw() {
    (cd e2e && env "${e2e_env[@]}" HUB_URL=http://127.0.0.1:3180 CANVAS_URL=http://127.0.0.1:3100 \
      GIT_AUTHOR_NAME=e2e GIT_AUTHOR_EMAIL=e2e@example.invalid GIT_COMMITTER_NAME=e2e GIT_COMMITTER_EMAIL=e2e@example.invalid npx playwright test "$@")
  }
  trap 'native stop >/dev/null 2>&1; rm -rf "$tmp"' EXIT
  native start
  if [ "$#" -gt 0 ]; then pw "$@"; exit; fi
  pw --grep-invert @restart
  native restart && wait_ready
  pw --grep @restart
  exit
fi

export HUB_TEST_DIR="$tmp" UID GID="$(id -g)"
dc() { docker compose -f compose.test.yaml "$@"; }
trap 'dc --profile e2e down --remove-orphans >/dev/null 2>&1; rm -rf "$tmp"' EXIT
dc up -d --build canvas hub
wait_ready || { dc logs >&2; exit 1; }
if [ "$#" -gt 0 ]; then dc --profile e2e run --rm --build e2e "$@"; exit; fi
dc --profile e2e run --rm --build e2e npx playwright test --grep-invert @restart
dc restart hub
wait_ready || { dc logs hub >&2; exit 1; }
dc --profile e2e run --rm e2e npx playwright test --grep @restart
