#!/usr/bin/env bash
# End-to-end run: fresh fixture copy -> isolated canvas + hub -> Playwright -> teardown.
set -euo pipefail
cd "$(dirname "$0")/.."
data="$(mktemp -d /tmp/excalidraw-hub-e2e.XXXXXX)"
autosave="$(mktemp -d /tmp/excalidraw-hub-autosave.XXXXXX)"
cp -r fixtures/. "$data/"
export HUB_TEST_DATA="$data" HUB_TEST_AUTOSAVE="$autosave" UID GID="$(id -g)"
dc() { docker compose -f compose.test.yaml "$@"; }
trap 'dc --profile e2e down --remove-orphans >/dev/null 2>&1; rm -rf "$data" "$autosave"' EXIT
dc up -d --build canvas hub
ready=""
for _ in $(seq 60); do curl -sf http://127.0.0.1:3180/api/status >/dev/null && curl -sf http://127.0.0.1:3100/health >/dev/null && ready=1 && break; sleep 1; done
[ -n "$ready" ] || { echo "test stack did not become ready" >&2; dc logs >&2; exit 1; }
mkdir -p test-results
dc --profile e2e run --rm --build e2e
