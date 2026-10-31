#!/bin/sh
# Keep the Discord gateway running.
#
#   bin/run-forever.sh <env-file>
#
# Sources <env-file> (set -a), then runs `node dist/cli.js gateway` in a loop:
# - restarts it on any exit, with exponential backoff (2s doubling to 60s,
#   back to 2s if the gateway ran for at least 5 minutes);
# - kills it if the health file it writes goes stale (no fresh write for
#   HEALTH_STALE_SECONDS after a startup grace of HEALTH_STARTUP_GRACE_SECONDS);
# - SIGTERM / SIGINT stop the gateway and exit;
# - one supervisor per pidfile (SUPERVISOR_PIDFILE, default <repo>/.supervisor.pid).
#
# Logs timestamped lines to stdout. Never prints values from the env file.
#
# Knobs (seconds unless noted; all optional):
#   DISCORD_HEALTH_FILE            health file path (default <repo>/.health, same as the gateway)
#   HEALTH_STALE_SECONDS=180       max age of the last health write
#   HEALTH_STARTUP_GRACE_SECONDS=120
#   HEALTH_CHECK_INTERVAL_SECONDS=15
#   RESTART_BACKOFF_MIN_SECONDS=2  RESTART_BACKOFF_MAX_SECONDS=60  RESTART_RESET_AFTER_SECONDS=300
#   KILL_WAIT_SECONDS=10           SIGTERM grace before SIGKILL
#   NODE_BIN=node                  node executable (tests point this at a stub)
#   RUN_FOREVER_MAX_STARTS=0       stop after N starts; 0 = forever (for tests)

set -u

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { printf '%s run-forever: %s\n' "$(ts)" "$*"; }

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <env-file>" >&2
  exit 2
fi

env_file=$1
if [ ! -f "$env_file" ] || [ ! -r "$env_file" ]; then
  log "env file not found or not readable: $env_file"
  exit 2
fi
case $env_file in
  */*) ;;
  *) env_file=./$env_file ;;
esac

ROOT=$(cd "$(dirname "$0")/.." && pwd) || exit 2

set -a
# shellcheck disable=SC1090
. "$env_file"
set +a

NODE_BIN=${NODE_BIN:-node}
HEALTH_FILE=${DISCORD_HEALTH_FILE:-$ROOT/.health}
STALE=${HEALTH_STALE_SECONDS:-180}
GRACE=${HEALTH_STARTUP_GRACE_SECONDS:-120}
CHECK_EVERY=${HEALTH_CHECK_INTERVAL_SECONDS:-15}
BACKOFF_MIN=${RESTART_BACKOFF_MIN_SECONDS:-2}
BACKOFF_MAX=${RESTART_BACKOFF_MAX_SECONDS:-60}
RESET_AFTER=${RESTART_RESET_AFTER_SECONDS:-300}
KILL_WAIT=${KILL_WAIT_SECONDS:-10}
MAX_STARTS=${RUN_FOREVER_MAX_STARTS:-0}
PIDFILE=${SUPERVISOR_PIDFILE:-$ROOT/.supervisor.pid}

require_int() {
  case $2 in
    '' | *[!0-9]*)
      log "$1 must be a whole number"
      exit 2
      ;;
  esac
}
require_int HEALTH_STALE_SECONDS "$STALE"
require_int HEALTH_STARTUP_GRACE_SECONDS "$GRACE"
require_int HEALTH_CHECK_INTERVAL_SECONDS "$CHECK_EVERY"
require_int RESTART_BACKOFF_MIN_SECONDS "$BACKOFF_MIN"
require_int RESTART_BACKOFF_MAX_SECONDS "$BACKOFF_MAX"
require_int RESTART_RESET_AFTER_SECONDS "$RESET_AFTER"
require_int KILL_WAIT_SECONDS "$KILL_WAIT"
require_int RUN_FOREVER_MAX_STARTS "$MAX_STARTS"
if [ "$CHECK_EVERY" -lt 1 ]; then
  CHECK_EVERY=1
fi

child=
checker=

# --- one supervisor per pidfile ---------------------------------------------

claim_pidfile() {
  if (set -C && echo "$$" >"$PIDFILE") 2>/dev/null; then
    return 0
  fi

  holder=$(cat "$PIDFILE" 2>/dev/null || true)
  case $holder in
    '' | *[!0-9]*) holder= ;;
  esac
  if [ -n "$holder" ] && [ "$holder" != "$$" ] && kill -0 "$holder" 2>/dev/null; then
    log "another supervisor is running (pid $holder, pidfile $PIDFILE); refusing to start"
    exit 1
  fi

  log "removing stale pidfile $PIDFILE"
  rm -f "$PIDFILE"
  if ! (set -C && echo "$$" >"$PIDFILE") 2>/dev/null; then
    log "could not claim pidfile $PIDFILE"
    exit 1
  fi
}

release_pidfile() {
  if [ "$(cat "$PIDFILE" 2>/dev/null || true)" = "$$" ]; then
    rm -f "$PIDFILE"
  fi
}

# --- child control ------------------------------------------------------------

stop_child() {
  pid=$1
  kill -TERM "$pid" 2>/dev/null || return 0
  waited=0
  while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt "$KILL_WAIT" ]; do
    sleep 1
    waited=$((waited + 1))
  done
  if kill -0 "$pid" 2>/dev/null; then
    log "gateway pid $pid ignored SIGTERM for ${KILL_WAIT}s; sending SIGKILL"
    kill -KILL "$pid" 2>/dev/null || true
  fi
}

on_signal() {
  log "received SIG$1; stopping"
  if [ -n "$checker" ]; then
    kill "$checker" 2>/dev/null || true
  fi
  if [ -n "$child" ]; then
    stop_child "$child"
    wait "$child" 2>/dev/null || true
  fi
  release_pidfile
  exit 0
}

# Seconds since the gateway last wrote the health file, or since it started if it has not written yet.
health_age() {
  started=$1
  now=$(date +%s)
  written=0
  if [ -r "$HEALTH_FILE" ]; then
    ms=
    read -r ms _rest <"$HEALTH_FILE" 2>/dev/null || true
    case $ms in
      '' | *[!0-9]*) ms=0 ;;
    esac
    written=$((ms / 1000))
  fi
  base=$started
  if [ "$written" -gt "$base" ]; then
    base=$written
  fi
  echo $((now - base))
}

watch_health() {
  pid=$1
  started=$2
  while kill -0 "$pid" 2>/dev/null; do
    sleep "$CHECK_EVERY"
    now=$(date +%s)
    if [ $((now - started)) -lt "$GRACE" ]; then
      continue
    fi
    age=$(health_age "$started")
    if [ "$age" -gt "$STALE" ]; then
      log "health file $HEALTH_FILE is stale (${age}s > ${STALE}s); killing gateway pid $pid"
      stop_child "$pid"
      return 0
    fi
  done
}

# --- main ---------------------------------------------------------------------

claim_pidfile
trap 'release_pidfile' EXIT
trap 'on_signal TERM' TERM
trap 'on_signal INT' INT

log "supervising gateway (supervisor pid $$; health file $HEALTH_FILE; stale after ${STALE}s, grace ${GRACE}s)"

backoff=$BACKOFF_MIN
starts=0
while :; do
  starts=$((starts + 1))
  start=$(date +%s)
  "$NODE_BIN" "$ROOT/dist/cli.js" gateway &
  child=$!
  log "gateway started (pid $child, start #$starts)"

  watch_health "$child" "$start" &
  checker=$!

  wait "$child"
  code=$?
  child=
  kill "$checker" 2>/dev/null || true
  wait "$checker" 2>/dev/null || true
  checker=

  ran=$(($(date +%s) - start))
  if [ "$ran" -ge "$RESET_AFTER" ]; then
    backoff=$BACKOFF_MIN
  fi

  if [ "$MAX_STARTS" -gt 0 ] && [ "$starts" -ge "$MAX_STARTS" ]; then
    log "gateway exited (code $code) after ${ran}s; reached RUN_FOREVER_MAX_STARTS=$MAX_STARTS, stopping"
    exit 0
  fi

  log "gateway exited (code $code) after ${ran}s; restarting in ${backoff}s"
  sleep "$backoff" &
  wait $! || true

  backoff=$((backoff * 2))
  if [ "$backoff" -gt "$BACKOFF_MAX" ]; then
    backoff=$BACKOFF_MAX
  fi
done
