#!/usr/bin/env bash
#
# Start the Noesis Local Agent daemon, replacing any instance already running.
#
# Why this exists: the daemon is normally launched by hand
# (`npx @noesis-brain/mcp-server@latest agent`), and nothing stops a second one.
# On 2026-08-14 four were running at once, two rooted at $HOME, so whichever won
# the race decided which build ran the job — a job was served by a stale daemon
# minutes after the current one was started, which looked exactly like a fix that
# did not work.
#
# Killing is deliberately done in two passes because the launcher is TWO processes:
# `npm exec @noesis-brain/mcp-server@<spec> agent` (parent) and
# `node .../noesis-mcp agent` (child). Killing only the child lets npm respawn it —
# `pkill -f 'noesis-mcp agent'` alone is NOT enough, and that is the hole that left a
# stale daemon alive during the 2026-08-14 investigation.
#
# Usage:  ./scripts/start-agent.sh            # published build via npx (default)
#         ./scripts/start-agent.sh --local    # this checkout's dist/ (after npm run build)
#         ./scripts/start-agent.sh --stop     # stop everything, start nothing

set -euo pipefail

# Resolve this script's own location BEFORE any cd — $BASH_SOURCE is relative when
# invoked as ./scripts/start-agent.sh, so reading it after the cd to $RUN_DIR would
# resolve against the wrong directory and --local would fail.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

MODE="${1:-}"
case "$MODE" in
  ''|--local|--stop) ;;
  *)
    echo "usage: $(basename "$0") [--local | --stop]" >&2
    # Deliberately NOT a silent fallback: a typo'd flag used to start the PUBLISHED
    # build instead of the local one, which is the same "wrong build served the job"
    # signature this script exists to prevent.
    exit 2
    ;;
esac

# Neutral working directory. The daemon needs no filesystem access, and cwd is what a
# filesystem-capable build was able to read. Never launch from $HOME or a source tree.
RUN_DIR="${NOESIS_AGENT_RUN_DIR:-$HOME/.noesis-agent}"
LOG_FILE="$RUN_DIR/agent.log"

# Every shape the daemon can appear as, matched against the full command line.
# `@noesis-brain/mcp-server(@[^ ]*)? agent` covers the npm exec parent for a pinned
# spec (`@2.1.4`), a tag (`@latest`) AND no spec at all — an earlier version required a
# literal space right after `mcp-server`, so a pinned launch left the parent alive to
# respawn its child. A plain MCP-server invocation has no ` agent` argument and so is
# never matched: that process is the user's Claude Code integration, not a daemon.
PATTERNS=(
  'noesis-mcp agent'                            # npx-installed bin (the child)
  '@noesis-brain/mcp-server(@[^ ]*)? agent'     # the npm exec parent, any version spec
  'dist/index.js agent'                         # local build
)

# macOS pgrep has no -c (that is FreeBSD/procps), and `pgrep -fc … || echo 0` silently
# yields 0 for every pattern, which made an earlier version of this guard dead code.
# `|| true` inside the braces is load-bearing: pgrep exits 1 when a pattern matches
# nothing, and with `set -e` + `pipefail` that would abort. It happens not to today only
# because /bin/bash is 3.2, which does not inherit -e into $( ) — installing a modern
# bash would otherwise make the first empty pattern abort AFTER both kill passes, leaving
# ZERO daemons running. Do not "simplify" this away.
count_matching() {
  local total=0 n
  for pattern in "${PATTERNS[@]}"; do
    n=$( { pgrep -f "$pattern" 2>/dev/null || true; } | wc -l | tr -d ' ')
    total=$((total + n))
  done
  echo "$total"
}

kill_matching() {
  local signal="$1" found=0 pid
  for pattern in "${PATTERNS[@]}"; do
    while read -r pid; do
      [ -z "$pid" ] && continue
      [ "$pid" = "$$" ] && continue           # never kill this script
      [ "$pid" = "${PPID:-0}" ] && continue   # nor the shell that invoked it
      echo "  ${signal#-} pid $pid ($pattern)"
      kill "$signal" "$pid" 2>/dev/null || true
      found=1
    done < <(pgrep -f "$pattern" 2>/dev/null || true)
  done
  return 0
}

echo "[start-agent] stopping existing daemons..."
[ "$(count_matching)" -eq 0 ] && echo "  none running"
kill_matching -TERM

# A parent can respawn its child on SIGTERM, so settle, then SIGKILL any survivor.
sleep 2
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
  pgrep -fl 'agent' >&2 || true
  exit 1
fi

# Credentials come from the same place the MCP server registration uses, so there is one
# source of truth and the token never has to be pasted into a shell or a process argv.
CLAUDE_JSON="$HOME/.claude.json"
if ! node -e "
  const e = (require('$CLAUDE_JSON').mcpServers || {}).noesis?.env;
  if (!e?.NOESIS_API_URL || !e?.NOESIS_API_TOKEN) process.exit(1);
" 2>/dev/null; then
  echo "[start-agent] No Noesis credentials in $CLAUDE_JSON (mcpServers.noesis.env)." >&2
  echo "              Register the MCP server first:" >&2
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

sleep 6

# Assert the end state rather than assuming it: killing everything and then failing to
# start would otherwise exit 0 with zero daemons running.
started="$(count_matching)"
if [ "$started" -eq 0 ]; then
  echo "[start-agent] ERROR: daemon did not come up. Tail of $LOG_FILE:" >&2
  tail -5 "$LOG_FILE" >&2 2>/dev/null || true
  exit 1
fi
echo "[start-agent] running ($started process(es) matching):"
for pattern in "${PATTERNS[@]}"; do pgrep -f "$pattern" 2>/dev/null || true; done | sort -u | sed 's/^/  pid /'
echo "[start-agent] log: $LOG_FILE"
tail -3 "$LOG_FILE" 2>/dev/null | sed 's/^/  /'
