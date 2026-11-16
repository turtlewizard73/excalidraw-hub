#!/usr/bin/env bash
# End-to-end run: fresh fixture copy -> isolated canvas + hub -> Playwright -> teardown.
# SEED_DIR (default fixtures/) is copied in as the drawings; arguments replace the runner command (see scripts/screenshots.sh).
# E2E_RUNTIME=native runs the stack with scripts/native.sh and Playwright on the host instead of Docker
# (needs `scripts/native.sh install`, `npm ci` in e2e/ and a Playwright Chromium); arguments then go to `playwright test`,
# so scripts/screenshots.sh (which passes a whole runner command) stays Docker-only.
set -euo pipefail
cd "$(dirname "$0")/.."
runtime="${E2E_RUNTIME:-docker}"
[ "$runtime" != native ] || [ "${1:-}" != npx ] || { echo "E2E_RUNTIME=native takes playwright test arguments, not a runner command" >&2; exit 2; }
tmp="$(mktemp -d /tmp/excalidraw-hub-e2e.XXXXXX)"
repo="$tmp/repo" remote="$tmp/remote.git" backups="$tmp/backups"
mkdir -p "$repo/docs/drawings" "$backups"
cp -r "${SEED_DIR:-fixtures}/." "$repo/docs/drawings/"
# Throwaway repo on dev with a bare origin; inside the containers origin is /remote, natively the real path.
g() { git -C "$repo" -c user.name=e2e -c user.email=e2e@example.invalid "$@"; }
git init -q --bare -b dev "$remote"
git init -q -b dev "$repo"
g add -A && g commit -qm fixtures && g push -q "$remote" dev
mkdir -p test-results

if [ "$runtime" = native ]; then
  g remote add origin "$remote"
  native() {
    # Every setting explicit: nothing from .env or the shell (e.g. CANVAS_URL) may point the tests at the real canvas.
    NATIVE_ENV_FILE=/dev/null NATIVE_DIR="$tmp/native" CANVAS_PORT=3100 HUB_PORT=3180 \
    CANVAS_URL=http://127.0.0.1:3100 CANVAS_PUBLIC_URL=http://localhost:3100 PLANTUML_URL= HUB_ALLOWED_HOSTS= \
    HUB_REPO="$repo" DRAWINGS_DIR="$repo/docs/drawings" HUB_BACKUPS="$backups" SYNC_BRANCH=dev \
    GIT_AUTHOR_NAME=e2e GIT_AUTHOR_EMAIL=e2e@example.invalid GIT_COMMITTER_NAME=e2e GIT_COMMITTER_EMAIL=e2e@example.invalid \
    scripts/native.sh "$@"
  }
  trap 'native stop >/dev/null 2>&1; rm -rf "$tmp"' EXIT
  native start
  (cd e2e && HUB_URL=http://127.0.0.1:3180 CANVAS_URL=http://127.0.0.1:3100 DATA_DIR="$repo/docs/drawings" \
    BACKUPS_DIR="$backups" REMOTE_DIR="$remote" npx playwright test "$@")
  exit
fi

g remote add origin /remote
export HUB_TEST_REPO="$repo" HUB_TEST_REMOTE="$remote" HUB_TEST_BACKUPS="$backups" UID GID="$(id -g)"
dc() { docker compose -f compose.test.yaml "$@"; }
trap 'dc --profile e2e down --remove-orphans >/dev/null 2>&1; rm -rf "$tmp"' EXIT
dc up -d --build canvas hub
ready=""
for _ in $(seq 60); do curl -sf http://127.0.0.1:3180/api/status >/dev/null && curl -sf http://127.0.0.1:3100/health >/dev/null && ready=1 && break; sleep 1; done
[ -n "$ready" ] || { echo "test stack did not become ready" >&2; dc logs >&2; exit 1; }
dc --profile e2e run --rm --build e2e "$@"
