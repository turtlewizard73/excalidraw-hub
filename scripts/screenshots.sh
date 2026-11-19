#!/usr/bin/env bash
# README screenshots: the isolated e2e stack, seeded with an empty folder, runs e2e/readme.shots.js.
# The shots file builds its own demo drawings (made-up names only). PNGs land in docs/images/.
set -euo pipefail
cd "$(dirname "$0")/.."
seed="$(mktemp -d /tmp/excalidraw-hub-seed.XXXXXX)"
trap 'rm -rf "$seed"' EXIT
touch "$seed/.gitkeep"   # the throwaway repo needs one file to commit; the shots file creates the folders and drawings
rm -rf test-results/readme
SEED_DIR="$seed" scripts/e2e.sh npx playwright test --config shots.config.js
mkdir -p docs/images
cp test-results/readme/*.png docs/images/
ls -l docs/images
