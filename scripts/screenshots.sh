#!/usr/bin/env bash
# README screenshots: the isolated e2e stack, seeded with one empty made-up project, runs e2e/readme.shots.js.
# The shots file builds its own demo drawings (made-up names only). PNGs land in docs/images/.
set -euo pipefail
cd "$(dirname "$0")/.."
seed="$(mktemp -d /tmp/excalidraw-hub-seed.XXXXXX)"
trap 'rm -rf "$seed"' EXIT
mkdir -p "$seed/garden" && touch "$seed/garden/.gitkeep"   # the hub needs one entry to start
rm -rf test-results/readme
SEED_DIR="$seed" scripts/e2e.sh npx playwright test --config shots.config.js
mkdir -p docs/images
cp test-results/readme/*.png docs/images/
ls -l docs/images
