#!/usr/bin/env bash
# Agent MCP server for the Excalidraw canvas (stdio). Register once: claude mcp add excalidraw -- <clone>/scripts/mcp.sh
# Runs inside the hub's running canvas container (docker compose exec, no new container per session), else as a native
# process from the canvas/ build. Reads .env from this clone, not from $PWD. stdout carries only JSON-RPC; messages go to stderr.
set -euo pipefail
die() { echo "mcp: $*" >&2; exit 1; }

clone="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
case "$clone" in /mnt/*) die "$clone is on a Windows drive (/mnt/*). Clone the hub inside the WSL filesystem, e.g. under your home folder." ;; esac

# .env, same rules as scripts/native.sh (KEY=VALUE, optional "export ", # comments, quotes, last duplicate wins, the shell wins),
# but only the two keys used here. $ and \ are refused, as there: compose would expand them, this parser does not.
declare -A dotenv=()
if [ -f "$clone/.env" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"; line="${line#"${line%%[![:space:]]*}"}"; line="${line#export }"
    [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=[[:space:]]*(.*)$ ]] || continue
    key="${BASH_REMATCH[1]}" value="${BASH_REMATCH[2]}"
    if [[ "$value" =~ ^\'([^\']*)\' ]]; then value="${BASH_REMATCH[1]}"
    else
      if [[ "$value" =~ ^\"([^\"]*)\" ]]; then value="${BASH_REMATCH[1]}"
      else value="${value%%[[:space:]]#*}"; value="${value%"${value##*[![:space:]]}"}"; fi
      [[ "$value" != *[\$\\]* ]] || die ".env: $key uses \$ or \\, which only compose expands. Write the value out, or put it in single quotes."
    fi
    dotenv[$key]="$value"
  done < "$clone/.env"
fi
setting() { # name default: shell, then .env, then default; empty counts as unset (as in src/config.js)
  local v="${!1:-}"; [ -n "$v" ] || v="${dotenv[$1]:-}"; echo "${v:-$2}"
}
port="$(setting CANVAS_PORT 3000)"
folders_root="$(setting FOLDERS_ROOT "$HOME")"

# Docker path: the compose canvas service of this clone (project name = clone folder name) is running.
if command -v docker >/dev/null 2>&1 \
  && [ -n "$(docker compose -f "$clone/compose.yaml" --project-directory "$clone" ps -q canvas 2>/dev/null)" ]; then
  exec docker compose -f "$clone/compose.yaml" --project-directory "$clone" exec -T -u "$(id -u):$(id -g)" \
    -e EXPRESS_SERVER_URL=http://127.0.0.1:3000 -e "EXCALIDRAW_EXPORT_DIR=$folders_root" canvas node dist/index.js
fi

# Native path: canvas/ was built by scripts/native.sh install.
if [ -f "$clone/canvas/dist/index.js" ]; then
  command -v node >/dev/null 2>&1 || die "node not found (native build present, but no Node on PATH)."
  EXPRESS_SERVER_URL="http://127.0.0.1:$port" EXCALIDRAW_EXPORT_DIR="$folders_root" exec node "$clone/canvas/dist/index.js"
fi

die "no running canvas and no native build: start the hub first (README, Run)."
