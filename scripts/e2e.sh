#!/usr/bin/env bash
# End-to-end run: fresh fixture copy -> isolated canvas + hub -> Playwright -> teardown.
# SEED_DIR (default fixtures/) is copied in as the drawings; arguments replace the runner command (see scripts/screenshots.sh).
set -euo pipefail
cd "$(dirname "$0")/.."
tmp="$(mktemp -d /tmp/excalidraw-hub-e2e.XXXXXX)"
repo="$tmp/repo" remote="$tmp/remote.git" backups="$tmp/backups"
mkdir -p "$repo/docs/drawings" "$backups"
cp -r "${SEED_DIR:-fixtures}/." "$repo/docs/drawings/"
# Throwaway repo on dev with a bare origin; inside the containers origin is /remote.
g() { git -C "$repo" -c user.name=e2e -c user.email=e2e@example.invalid "$@"; }
git init -q --bare -b dev "$remote"
git init -q -b dev "$repo"
g add -A && g commit -qm fixtures && g push -q "$remote" dev && g remote add origin /remote
export HUB_TEST_REPO="$repo" HUB_TEST_REMOTE="$remote" HUB_TEST_BACKUPS="$backups" UID GID="$(id -g)"
dc() { docker compose -f compose.test.yaml "$@"; }
trap 'dc --profile e2e down --remove-orphans >/dev/null 2>&1; rm -rf "$tmp"' EXIT
dc up -d --build canvas hub
ready=""
for _ in $(seq 60); do curl -sf http://127.0.0.1:3180/api/status >/dev/null && curl -sf http://127.0.0.1:3100/health >/dev/null && ready=1 && break; sleep 1; done
[ -n "$ready" ] || { echo "test stack did not become ready" >&2; dc logs >&2; exit 1; }
mkdir -p test-results
dc --profile e2e run --rm --build e2e "$@"
