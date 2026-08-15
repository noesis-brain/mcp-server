#!/usr/bin/env bash
#
# Start the Noesis Local Agent daemon, replacing any instance already running — and
# refuse to leave a daemon running that lacks the tool-boundary fix.
#
# Why this exists: the daemon is normally launched by hand
# (`npx @noesis-brain/mcp-server@latest agent`), and nothing stops a second one. On
# 2026-08-14 four were running at once, two rooted at $HOME. They all poll the same queue,
# so whichever won the race decided which build served the job — a stale daemon answered
# minutes after a fixed one started, which looked exactly like a fix that did not work.
#
# Killing is deliberately two passes because the launcher is TWO processes: an
# `npm exec @noesis-brain/mcp-server@<spec> agent` parent and a `node .../noesis-mcp agent`
# child. Killing only the child lets npm respawn it.
#
# WHY THE VERSION ASSERT: an earlier version of this script started `@latest` by default
# while the fix was still unpublished, so its no-argument path SIGKILLed the fixed daemon,
# started an UNFIXED one, and printed success — silently restoring the vulnerability it
# exists to prevent. Publishing lags code, so the script must verify what it actually
# started rather than trust the tag.
#
# Usage:  ./scripts/start-agent.sh            # published build via npx (default)
#         ./scripts/start-agent.sh --local    # this checkout's dist/ (after npm run build)
#         ./scripts/start-agent.sh --status   # report running daemons, exit 1 if any is unfixed
#         ./scripts/start-agent.sh --stop     # stop everything, start nothing

set -euo pipefail

# Resolve this script's own location BEFORE any cd — $BASH_SOURCE is relative when invoked
# as ./scripts/start-agent.sh, so reading it after the cd to $RUN_DIR resolves against the
# wrong directory and --local would fail.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# First release carrying `tools: []` + the canUseTool gate. A daemon below this exposes
# Claude Code's whole built-in tool set (Bash/Read/Write/Edit/Grep/Task) to every Navi.
MIN_FIXED_VERSION="2.1.5"

MODE="${1:-}"
case "$MODE" in
  ''|--local|--stop|--status) ;;
  *)
    echo "usage: $(basename "$0") [--local | --status | --stop]" >&2
    # Deliberately NOT a silent fallback: a typo'd flag used to start the PUBLISHED build
    # instead of the local one — the same "wrong build served the job" signature.
    exit 2
    ;;
esac

RUN_DIR="${NOESIS_AGENT_RUN_DIR:-$HOME/.noesis-agent}"
LOG_FILE="$RUN_DIR/agent.log"

# Every shape the daemon can appear as, matched against the full command line.
# `@noesis-brain/mcp-server(@[^ ]*)? agent` covers the npm exec parent for a pinned spec,
# a tag, AND no spec. A plain MCP-server invocation has no ` agent` argument and is never
# matched: that process is the user's Claude Code integration, not a daemon.
PATTERNS=(
  'noesis-mcp agent'
  '@noesis-brain/mcp-server(@[^ ]*)? agent'
  'dist/index.js agent'
)

# Only ever our own processes. Unscoped pgrep also matches other users' and root's, which
# `kill` cannot touch (EPERM) — those would be counted as survivors forever, wedging the
# guard into "refusing to start" after having already killed the real daemon.
pids_matching() {
  for pattern in "${PATTERNS[@]}"; do
    pgrep -U "$(id -u)" -f "$pattern" 2>/dev/null || true
  done | sort -un
}

# `|| true` inside the braces is load-bearing: pgrep exits 1 on no match, and with
# `set -e` + `pipefail` that would abort. Dedupe, or a process matching two patterns
# inflates the count and can trip the refuse-to-start guard.
count_matching() { pids_matching | wc -l | tr -d ' '; }

kill_matching() {
  local signal="$1" pid
  while read -r pid; do
    [ -z "$pid" ] && continue
    [ "$pid" = "$$" ] && continue
    [ "$pid" = "${PPID:-0}" ] && continue
    if kill "$signal" "$pid" 2>/dev/null; then
      echo "  ${signal#-} pid $pid"
    elif ! kill -0 "$pid" 2>/dev/null; then
      : # already exited from the previous pass — the normal case, not worth a line
    else
      # Still alive and we could not signal it (EPERM). Do NOT swallow this: a kill we
      # cannot perform is exactly what leaves a survivor and wedges the guard below.
      echo "  ${signal#-} pid $pid FAILED — still running and not killable by us" >&2
    fi
  done < <(pids_matching)
  return 0
}

# The package directory backing a running daemon, so we can read its version and check
# whether its compiled output carries the fix.
pkg_dir_for_pid() {
  local pid="$1" cmd js
  cmd="$(ps -o command= -p "$pid" 2>/dev/null || true)"
  js="$(printf '%s' "$cmd" | grep -oE '/[^ ]*/dist/index\.js' || true)"
  if [ -n "$js" ]; then dirname "$(dirname "$js")"; return; fi
  # npx-installed bin: .../node_modules/.bin/noesis-mcp -> the package root
  js="$(printf '%s' "$cmd" | grep -oE '/[^ ]*/node_modules/\.bin/noesis-mcp' || true)"
  if [ -n "$js" ]; then
    printf '%s/@noesis-brain/mcp-server' "$(dirname "$(dirname "$js")")"; return
  fi
  printf ''
}

# Prints "<version> <FIXED|UNFIXED|UNKNOWN>" for a pid.
describe_pid() {
  local pid="$1" dir ver fixed
  dir="$(pkg_dir_for_pid "$pid")"
  if [ -z "$dir" ] || [ ! -f "$dir/package.json" ]; then echo "? UNKNOWN"; return; fi
  ver="$(node -e "process.stdout.write(String(require('$dir/package.json').version||'?'))" 2>/dev/null || echo '?')"
  # The fix is two things; require BOTH so a half-applied build is not reported clean.
  if grep -q 'tools: \[\]' "$dir/dist/agent/runner.js" 2>/dev/null \
     && grep -q 'canUseTool' "$dir/dist/agent/runner.js" 2>/dev/null; then
    fixed=FIXED
  else
    fixed=UNFIXED
  fi
  echo "$ver $fixed"
}

# --status: the one command that answers "is my machine exposed right now?".
if [ "$MODE" = "--status" ]; then
  exposed=0 total=0
  while read -r pid; do
    [ -z "$pid" ] && continue
    total=$((total + 1))
    read -r ver state <<<"$(describe_pid "$pid")"
    printf '  pid %-7s v%-8s %s\n' "$pid" "$ver" "$state"
    [ "$state" = "FIXED" ] || exposed=$((exposed + 1))
  done < <(pids_matching)
  [ "$total" -eq 0 ] && echo "  no daemon running"
  if [ "$exposed" -gt 0 ]; then
    echo "[start-agent] EXPOSED: $exposed of $total daemon process(es) lack the tool boundary." >&2
    echo "              They can read your filesystem. Run: $(basename "$0") --local" >&2
    exit 1
  fi
  echo "[start-agent] ok — $total daemon process(es), all carry the fix."
  exit 0
fi

echo "[start-agent] stopping existing daemons..."
[ "$(count_matching)" -eq 0 ] && echo "  none running"
kill_matching -TERM
sleep 2                 # a parent can respawn its child on SIGTERM
kill_matching -KILL
sleep 1

remaining="$(count_matching)"
if [ "$MODE" = "--stop" ]; then
  if [ "$remaining" -gt 0 ]; then
    echo "[start-agent] WARNING: $remaining daemon process(es) survived --stop." >&2
    exit 1
  fi
  echo "[start-agent] all stopped."
  exit 0
fi
if [ "$remaining" -gt 0 ]; then
  echo "[start-agent] ERROR: $remaining daemon process(es) still alive; refusing to start another." >&2
  pids_matching | sed 's/^/  surviving pid /' >&2
  exit 1
fi

# Credentials come from the same place the MCP server registration uses, so the token never
# has to be pasted into a shell or a process argv.
CLAUDE_JSON="$HOME/.claude.json"
if ! node -e "
  const e = (require('$CLAUDE_JSON').mcpServers || {}).noesis?.env;
  if (!e?.NOESIS_API_URL || !e?.NOESIS_API_TOKEN) process.exit(1);
" 2>/dev/null; then
  echo "[start-agent] No Noesis credentials in $CLAUDE_JSON (mcpServers.noesis.env)." >&2
  echo "              claude mcp add -s user noesis -- npx -y @noesis-brain/mcp-server" >&2
  exit 1
fi
NOESIS_API_URL="$(node -e "console.log(require('$CLAUDE_JSON').mcpServers.noesis.env.NOESIS_API_URL)")"
NOESIS_API_TOKEN="$(node -e "console.log(require('$CLAUDE_JSON').mcpServers.noesis.env.NOESIS_API_TOKEN)")"
export NOESIS_API_URL NOESIS_API_TOKEN

mkdir -p "$RUN_DIR"
cd "$RUN_DIR"

if [ "$MODE" = "--local" ]; then
  DIST="$PKG_DIR/dist/index.js"
  [ -f "$DIST" ] || { echo "[start-agent] $DIST missing — run 'npm run build' first." >&2; exit 1; }
  echo "[start-agent] starting LOCAL build: $DIST"
  nohup node "$DIST" agent >> "$LOG_FILE" 2>&1 &
else
  echo "[start-agent] starting published @noesis-brain/mcp-server@latest"
  nohup npx -y @noesis-brain/mcp-server@latest agent >> "$LOG_FILE" 2>&1 &
fi

# Wait for the DAEMON, not the npx parent. A cold `npx -y` install can take 10-60s, and the
# parent alone used to satisfy the old fixed 6s check — so a failed install reported success
# with zero daemons running.
started=0
for _ in $(seq 1 60); do
  sleep 1
  while read -r pid; do
    [ -z "$pid" ] && continue
    case "$(ps -o command= -p "$pid" 2>/dev/null || true)" in
      *dist/index.js\ agent*|*noesis-mcp\ agent*) started="$pid"; break ;;
    esac
  done < <(pids_matching)
  [ "$started" != 0 ] && break
done

if [ "$started" = 0 ]; then
  echo "[start-agent] ERROR: daemon did not come up within 60s. Tail of $LOG_FILE:" >&2
  tail -5 "$LOG_FILE" >&2 2>/dev/null || true
  exit 1
fi

# THE ASSERT. Never leave a daemon running that lacks the tool boundary, whichever mode got
# us here — including the published default while the fix is unpublished.
read -r ver state <<<"$(describe_pid "$started")"
if [ "$state" != "FIXED" ]; then
  echo "[start-agent] ERROR: started daemon pid $started is v$ver ($state) — it lacks the" >&2
  echo "              tool boundary and can read your filesystem. Stopping it." >&2
  kill -TERM "$started" 2>/dev/null || true
  sleep 1
  kill -KILL "$started" 2>/dev/null || true
  echo "              Publish $MIN_FIXED_VERSION or newer, or start the local build:" >&2
  echo "              $(basename "$0") --local" >&2
  exit 1
fi

echo "[start-agent] running: pid $started (v$ver, $state)"
echo "[start-agent] log: $LOG_FILE"
tail -3 "$LOG_FILE" 2>/dev/null | sed 's/^/  /'
