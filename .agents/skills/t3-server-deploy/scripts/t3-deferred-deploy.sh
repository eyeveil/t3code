#!/usr/bin/env bash
# Deferred, idle-gated deployment of a complete T3 server runtime.
set -u

STAGED_PKG=${STAGED_PKG:-$HOME/.local/state/t3-deploy/package}
GLOBAL_PKG=${GLOBAL_PKG:-$HOME/.npm-global/lib/node_modules/t3}
SQLITE=${SQLITE:-sqlite3}
DB=${DB:-$HOME/.t3/userdata/state.sqlite}
SERVE_CMD=${SERVE_CMD:-t3 serve --host 0.0.0.0 --no-browser}
SERVE_PORT=${SERVE_PORT:-3773}
HEALTH_URL=${HEALTH_URL:-http://127.0.0.1:3773/.well-known/t3/environment}
TMUX_SESSION=${TMUX_SESSION:-main}
SERVE_WINDOW=${SERVE_WINDOW:-t3-}
NTFY_URL=${NTFY_URL:-}
BASE_PATH=${BASE_PATH:-/run/current-system/sw/bin:$HOME/.npm-global/bin}

set -u
export PATH=$BASE_PATH:$PATH
STATE_DIR=$(dirname "$STAGED_PKG")
LOG=${LOG:-$STATE_DIR/deploy.log}
GLOBAL_NEW=${GLOBAL_PKG}.new
GLOBAL_OLD=${GLOBAL_PKG}.old
GLOBAL_FAILED=${GLOBAL_PKG}.failed

say() { echo "$(date '+%F %T') $*" >> "$LOG"; }
notify() {
  [ -z "$NTFY_URL" ] && return 0
  curl --fail -s --max-time 10 -H "Title: $1" -H "Tags: $2" -d "$3" "$NTFY_URL" >/dev/null || true
}

busy_sessions() {
  "$SQLITE" -readonly "$DB" \
    "SELECT count(*) FROM projection_thread_sessions WHERE status IN ('running','starting');" \
    2>/dev/null || echo 1
}

if [ ! -f "$STAGED_PKG/.t3-deploy-runtime.json" ] || \
   [ ! -f "$STAGED_PKG/dist/bin.mjs" ] || \
   [ ! -d "$STAGED_PKG/node_modules/effect" ] || \
   [ ! -d "$GLOBAL_PKG" ]; then
  say "FAIL: staged complete runtime or global package missing"
  notify "t3 deploy misconfigured" "x,warning" "Complete staged runtime or global t3 package missing; nothing deployed."
  exit 1
fi

if [ -d "$STAGED_PKG/dist/dist" ]; then
  say "FAIL: staged runtime contains a nested dist directory"
  notify "t3 deploy misconfigured" "x,warning" "Staged runtime has the old nested-dist packaging bug; nothing deployed."
  exit 1
fi

if ! node "$STAGED_PKG/dist/bin.mjs" --version >/dev/null 2>&1; then
  say "FAIL: staged runtime import preflight"
  notify "t3 deploy failed preflight" "x,warning" "Staged t3 cannot load against its staged dependencies; nothing restarted."
  exit 1
fi

say "armed; waiting for idle (staged runtime: $STAGED_PKG)"
consecutive_idle=0
deadline=$(( $(date +%s) + 12*3600 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  if [ "$(busy_sessions)" = "0" ]; then
    consecutive_idle=$((consecutive_idle + 1))
    [ "$consecutive_idle" -ge 3 ] && break
  else
    consecutive_idle=0
  fi
  sleep 20
done

if [ "$consecutive_idle" -lt 3 ]; then
  say "gave up: never idle within 12h"
  notify "t3 deploy skipped" "warning" "t3 was never idle within 12h; run the deploy again."
  exit 1
fi

# Resolve the exact listener and its tmux window. Never match or kill processes
# by name: this host runs the agent doing the deploy and several other servers.
serve_pid=$(ss -H -ltnp "sport = :$SERVE_PORT" 2>/dev/null \
  | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' | head -1)
pane=
win=
if [ -n "${serve_pid:-}" ]; then
  serve_cmdline=$(tr '\0' ' ' < "/proc/$serve_pid/cmdline" 2>/dev/null || true)
  case "$serve_cmdline" in
    *"/.npm-global/bin/t3 serve "*) ;;
    *)
      say "FAIL: port $SERVE_PORT owner $serve_pid is not the expected global t3 serve"
      notify "t3 deploy needs a hand" "x,warning" "Port $SERVE_PORT is owned by an unexpected process; nothing deployed."
      exit 1
      ;;
  esac
  serve_tty=/dev/$(ps -o tty= -p "$serve_pid" | tr -d ' ')
  pane=$(tmux list-panes -a -F '#{pane_id} #{pane_tty}' 2>/dev/null \
    | awk -v t="$serve_tty" '$2==t {print $1; exit}')
  win=$(tmux list-panes -a -F '#{pane_id} #{window_id}' 2>/dev/null \
    | awk -v p="$pane" '$1==p {print $2; exit}')
  if [ -z "${pane:-}" ] || [ -z "${win:-}" ]; then
    say "FAIL: could not map port $SERVE_PORT owner $serve_pid to a tmux window"
    notify "t3 deploy needs a hand" "warning" "Verified t3 serve is not mapped to tmux; nothing deployed."
    exit 1
  fi
fi

say "idle confirmed, copying complete runtime"
rm -rf "$GLOBAL_NEW" "$GLOBAL_OLD" "$GLOBAL_FAILED"
if ! cp -a "$STAGED_PKG" "$GLOBAL_NEW"; then
  say "FAIL: staging copy into global package directory"
  notify "t3 deploy failed" "x,warning" "Copying the complete runtime failed; nothing restarted."
  exit 1
fi
if ! node "$GLOBAL_NEW/dist/bin.mjs" --version >/dev/null 2>&1; then
  say "FAIL: copied runtime import preflight"
  rm -rf "$GLOBAL_NEW"
  notify "t3 deploy failed preflight" "x,warning" "Copied t3 runtime cannot load; nothing restarted."
  exit 1
fi

say "swapping complete runtime"
if ! mv "$GLOBAL_PKG" "$GLOBAL_OLD" || ! mv "$GLOBAL_NEW" "$GLOBAL_PKG"; then
  say "FAIL: complete runtime swap"
  [ -d "$GLOBAL_OLD" ] && [ ! -d "$GLOBAL_PKG" ] && mv "$GLOBAL_OLD" "$GLOBAL_PKG"
  notify "t3 deploy failed" "x,warning" "Complete runtime swap failed and was rolled back; nothing restarted."
  exit 1
fi

if [ -z "${serve_pid:-}" ]; then
  say "no running t3 serve found; runtime installed, nothing to restart"
  notify "t3 deployed (no restart needed)" "white_check_mark" "Complete t3 runtime installed; no serve process was running."
  exit 0
fi

say "restarting t3 serve in pane $pane"
tmux send-keys -t "$pane" C-c 2>/dev/null || true
for _ in $(seq 1 15); do
  [ ! -e "/proc/$serve_pid/stat" ] && break
  sleep 1
done
if [ -e "/proc/$serve_pid/stat" ]; then
  say "SIGINT did not stop serve; closing verified tmux window $win"
fi
tmux kill-window -t "$win" 2>/dev/null || true

active_win=
start_serve() {
  active_win=$(tmux new-window -d -P -F '#{window_id}' -t "$TMUX_SESSION" -n "$SERVE_WINDOW" "$SERVE_CMD")
}

serve_up() {
  for _ in $(seq 1 120); do
    curl -fsS --max-time 5 -o /dev/null "$HEALTH_URL" 2>/dev/null && return 0
    sleep 1
  done
  return 1
}

start_serve
if serve_up; then
  say "deployed complete runtime and restarted (previous package kept at $GLOBAL_OLD)"
  MANIFEST="$STATE_DIR/deploy-manifest.txt"
  if [ -f "$MANIFEST" ]; then
    BODY="$(head -c 400 "$MANIFEST")"
  else
    BODY="new complete t3 runtime is live"
  fi
  notify "t3 deployed" "white_check_mark,rocket" "$BODY"
else
  say "serve did not come back, rolling back complete runtime"
  [ -n "${active_win:-}" ] && tmux kill-window -t "$active_win" 2>/dev/null || true
  mv "$GLOBAL_PKG" "$GLOBAL_FAILED" 2>/dev/null
  mv "$GLOBAL_OLD" "$GLOBAL_PKG" 2>/dev/null
  start_serve
  if serve_up; then
    say "rollback ok (bad package kept at $GLOBAL_FAILED)"
    notify "t3 deploy rolled back" "x,warning" "New complete runtime did not start; package and dependencies were rolled back together."
  else
    say "FAIL: rollback also did not come back"
    notify "t3 down after deploy" "x,rotating_light" "t3 serve did not come back after deploy or full-package rollback."
  fi
fi
