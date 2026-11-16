#!/usr/bin/env bash
# Run the hub and its canvas without Docker: plain Node processes on the host (Linux/WSL).
#   scripts/native.sh install   # once, and after pulling canvas changes: npm ci + build in canvas/
#   scripts/native.sh start     # canvas :3000 + hub :3080 in the background, logs in .native/
#   scripts/native.sh stop | restart | status
# Reads .env like compose does (variables already set in the shell win). PlantUML is optional: set PLANTUML_URL.
set -euo pipefail
cd "$(dirname "$0")/.."
root="$PWD"
die() { echo "native: $*" >&2; exit 1; }

# .env, compose rules: KEY=VALUE, optional "export ", blank and # lines skipped, " # comment" after unquoted values,
# '...' or "..." keep everything inside, the last duplicate wins. Never overrides the shell. UID/GID are compose-only.
env_file="${NATIVE_ENV_FILE:-.env}"   # scripts/e2e.sh passes /dev/null so a personal .env cannot leak into tests
if [ -f "$env_file" ]; then
  declare -A dotenv=()
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"; line="${line#"${line%%[![:space:]]*}"}"; line="${line#export }"
    [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=[[:space:]]*(.*)$ ]] || continue
    key="${BASH_REMATCH[1]}" value="${BASH_REMATCH[2]}"
    if [[ "$value" =~ ^\'([^\']*)\' ]]; then value="${BASH_REMATCH[1]}"   # single quotes: literal, as in compose
    else
      if [[ "$value" =~ ^\"([^\"]*)\" ]]; then value="${BASH_REMATCH[1]}"
      else value="${value%%[[:space:]]#*}"; value="${value%"${value##*[![:space:]]}"}"; fi
      # Compose expands ${VAR} and backslash escapes here; this parser does not, so refuse rather than read it differently.
      [[ "$value" != *[\$\\]* ]] || die "$env_file: $key uses \$ or \\, which only compose expands. Write the value out, or put it in single quotes to keep it literal."
    fi
    dotenv[$key]="$value"
  done < "$env_file"
  for key in "${!dotenv[@]}"; do
    case "$key" in UID|GID) continue ;; esac
    [ -n "${!key+x}" ] || export "$key=${dotenv[$key]}"
  done
fi

state="$(realpath -m "${NATIVE_DIR:-$root/.native}")"
canvas_port="${CANVAS_PORT:-3000}"   # parent repo's .claude/mcp/excalidraw.sh connects to :3000
hub_port="${HUB_PORT:-3080}"
canvas_url="http://127.0.0.1:$canvas_port"
declare -A marker=([canvas]=dist/server.js [hub]=src/main.js)   # what a live process of ours has on its command line

need() { command -v "$1" >/dev/null || die "$1 not found. $2"; }
port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
# Pid from the pid file, only if that process is still ours (pids are reused after a reboot).
pid_of() {
  local pid; pid="$(cat "$state/$1.pid" 2>/dev/null)" || return 1
  [[ "$pid" =~ ^[0-9]+$ ]] && tr '\0' ' ' 2>/dev/null < "/proc/$pid/cmdline" | grep -qF "node ${marker[$1]}" && echo "$pid"
}

check_tools() {
  need node "Install Node.js 20 or newer (e.g. nvm, https://github.com/nvm-sh/nvm)."
  need npm "npm ships with Node.js."
  need curl "Used to wait until the servers answer."
  [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] || die "Node $(node -v) is too old; need 20 or newer."
}

install() {
  check_tools
  need git "The sync button needs git."
  (cd canvas && npm ci --no-audit --no-fund && npm run build)
  echo "native: installed. Start with: scripts/native.sh start"
}

# launch <name> <dir> <readiness url> <command...>: detached in its own process group, logs to $state/<name>.log,
# waits up to 60 s. Returns 0 if it was already running, 10 if this call started it, 1 on failure.
launch() {
  local name="$1" dir="$2" url="$3" pid; shift 3
  if pid="$(pid_of "$name")"; then echo "native: $name already running (pid $pid)"; return 0; fi
  (cd "$dir" && exec setsid "$@") >"$state/$name.log" 2>&1 < /dev/null &
  echo $! > "$state/$name.pid"
  for _ in $(seq 120); do
    curl -sf -o /dev/null "$url" && { echo "native: $name ready (pid $!, log $state/$name.log)"; return 10; }
    kill -0 "$!" 2>/dev/null || break
    sleep 0.5
  done
  echo "native: $name did not start. Last log lines:" >&2; tail -n 20 "$state/$name.log" >&2
  stop_one "$name"; return 1
}

start() {
  check_tools
  [ -f canvas/dist/server.js ] && [ -d canvas/dist/frontend ] || die "canvas not built. Run: scripts/native.sh install"
  mkdir -p "$state"
  local repo drawings backups workspace name port rc=0
  repo="$(realpath "${HUB_REPO:-../..}")"
  drawings="${DRAWINGS_DIR:-$repo/docs/drawings}"
  backups="$(mkdir -p "${HUB_BACKUPS:-./backups}" && realpath "${HUB_BACKUPS:-./backups}")"
  workspace="$(mkdir -p "${HUB_WORKSPACE:-./workspace}" && realpath "${HUB_WORKSPACE:-./workspace}")"
  [[ "${HUB_FOLDERS_ROOT:-$HOME}" == /* ]] || die "HUB_FOLDERS_ROOT must be an absolute path (compose needs it too), got: $HUB_FOLDERS_ROOT"
  for name in canvas hub; do
    port="$canvas_port"; [ "$name" = hub ] && port="$hub_port"
    pid_of "$name" >/dev/null || ! port_busy "$port" || die "port $port is in use by another program (Docker stack still up? docker compose down)"
  done
  [ -n "${PLANTUML_URL:-}" ] || echo "native: PLANTUML_URL not set, so PlantUML/Salt code blocks are off (Mermaid works)"

  launch canvas canvas "$canvas_url/health" env NODE_ENV=production HOST=127.0.0.1 PORT="$canvas_port" \
    ${PLANTUML_URL:+PLANTUML_URL="$PLANTUML_URL"} node dist/server.js || rc=$?
  [ "$rc" -ne 1 ] || exit 1
  local started_canvas=$(( rc == 10 ))
  rc=0
  launch hub . "http://127.0.0.1:$hub_port/api/status" env NODE_ENV=production \
    HUB_HOST=127.0.0.1 HUB_PORT="$hub_port" \
    CANVAS_URL="${CANVAS_URL:-$canvas_url}" CANVAS_PUBLIC_URL="${CANVAS_PUBLIC_URL:-http://localhost:$canvas_port}" \
    REPO_DIR="$repo" DRAWINGS_DIR="$drawings" BACKUPS_DIR="$backups" SYNC_BRANCH="${SYNC_BRANCH:-development}" \
    WORKSPACE_FILE="$workspace/workspace.json" FOLDERS_ROOT="${HUB_FOLDERS_ROOT:-$HOME}" \
    ${HUB_ALLOWED_HOSTS:+HUB_ALLOWED_HOSTS="$HUB_ALLOWED_HOSTS"} node src/main.js || rc=$?
  if [ "$rc" -eq 1 ]; then [ "$started_canvas" -eq 0 ] || stop_one canvas; exit 1; fi
  echo "native: open http://localhost:$hub_port"
}

# SIGTERM to the whole process group; SIGKILL if it is still there after 5 s (the hub waits for open requests).
stop_one() {
  local pid; pid="$(pid_of "$1")" || pid=""
  if [ -n "$pid" ]; then
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    for _ in $(seq 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
    if kill -0 "$pid" 2>/dev/null; then
      kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
      for _ in $(seq 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
    fi
    echo "native: $1 stopped"
  fi
  rm -f "$state/$1.pid"
}

status() {
  local rc=0 name pid
  for name in canvas hub; do
    if pid="$(pid_of "$name")"; then echo "$name: running (pid $pid)"; else echo "$name: stopped"; rc=1; fi
  done
  return $rc
}

case "${1:-}" in
  install) install ;;
  start) start ;;
  stop) stop_one hub; stop_one canvas ;;
  restart) stop_one hub; stop_one canvas; start ;;
  status) status ;;
  *) echo "usage: scripts/native.sh install|start|stop|restart|status" >&2; exit 2 ;;
esac
