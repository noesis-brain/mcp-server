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

# `$1 >= $2` for plain x.y.z versions.
version_ge() {
  [ "$(printf '%s\n%s\n' "$2" "$1" | sort -t. -k1,1n -k2,2n -k3,3n | head -1)" = "$2" ]
}

# The package directory backing a running daemon. Extracted WITHOUT a `[^ ]*` path regex:
# that could not cross a space, so an install under "/Users/x/My Repos/..." resolved to the
# wrong directory, was graded UNKNOWN, and the assert below killed a perfectly good daemon.
pkg_dir_for_pid() {
  local pid="$1" cmd path
  cmd="$(ps -o command= -p "$pid" 2>/dev/null || true)"
  case "$cmd" in *" agent") cmd="${cmd% agent}" ;; *) ;; esac
  path="${cmd#* }"                       # drop the interpreter, keep the (possibly spaced) path
  case "$path" in
    */dist/index.js) dirname "$(dirname "$path")"; return ;;
    */node_modules/.bin/noesis-mcp)
      printf '%s/@noesis-brain/mcp-server' "$(dirname "$(dirname "$path")")"; return ;;
  esac
  printf ''
}

# Comments are copied verbatim into dist (tsconfig sets no `removeComments`), and this
# codebase DOCUMENTS both markers heavily — `tools: []` occurs on 6 lines of the compiled
# output, only ONE of which is code. Grepping the raw file therefore certified a build with
# the boundary deleted as FIXED, which made the whole assurance layer theatre. Strip
# comments before looking for code.
strip_js_comments() { perl -0pe 's{/\*.*?\*/}{}gs; s{^[[:space:]]*//.*$}{}gm' "$1" 2>/dev/null || true; }

# Prints "<version> <FIXED|UNFIXED(reason)|PARENT>" for a pid.
#
# TWO INDEPENDENT SIGNALS, both required:
#   - the package version is >= MIN_FIXED_VERSION (the same signal the backend's
#     MIN_TOOL_AGENT_VERSION gate uses), and
#   - the compiled output actually contains both halves of the fix, comments removed.
# An earlier version compared neither: MIN_FIXED_VERSION was assigned and never used, and
# the content check matched documentation. "v2.1.5 FIXED" was two non-facts side by side.
describe_pid() {
  local pid="$1" dir ver stripped ver_ok=0 code_ok=0
  dir="$(pkg_dir_for_pid "$pid")"
  # No package dir = the `npm exec` wrapper, not a daemon. Its child is graded separately;
  # counting the parent as "unknown, therefore exposed" cried wolf on every healthy npx
  # launch, which is the mode that becomes correct once the fix is published.
  if [ -z "$dir" ] || [ ! -f "$dir/package.json" ]; then echo "- PARENT"; return; fi
  ver="$(node -e "process.stdout.write(String(require('$dir/package.json').version||'0.0.0'))" 2>/dev/null || echo '0.0.0')"
  version_ge "$ver" "$MIN_FIXED_VERSION" && ver_ok=1
  if [ -f "$dir/dist/agent/runner.js" ]; then
    stripped="$(strip_js_comments "$dir/dist/agent/runner.js")"
    if printf '%s' "$stripped" | grep -q 'tools: \[\]' \
       && printf '%s' "$stripped" | grep -q 'canUseTool:'; then code_ok=1; fi
  fi
  if [ "$ver_ok" = 1 ] && [ "$code_ok" = 1 ]; then echo "$ver FIXED"
  elif [ "$ver_ok" = 0 ]; then echo "$ver UNFIXED(v<$MIN_FIXED_VERSION)"
  else echo "$ver UNFIXED(code)"; fi
}

# --status: the one command that answers "is my machine exposed right now?".
if [ "$MODE" = "--status" ]; then
  exposed=0 total=0
  while read -r pid; do
    [ -z "$pid" ] && continue
    read -r ver state <<<"$(describe_pid "$pid")"
    if [ "$state" = "PARENT" ]; then
      printf '  pid %-7s %-10s (npm exec wrapper — its child is graded below)\n' "$pid" "$state"
      continue
    fi
    total=$((total + 1))
    printf '  pid %-7s v%-8s %s\n' "$pid" "$ver" "$state"
    [ "$state" = "FIXED" ] || exposed=$((exposed + 1))
  done < <(pids_matching)
  [ "$total" -eq 0 ] && echo "  no daemon running"
  # Honest about what this can and cannot see, rather than implying a clean bill of health.
  echo "  (grades the package on disk, for this user's processes only; a daemon started"
  echo "   before a rebuild may still be running older code in memory)"
  if [ "$exposed" -gt 0 ]; then
    echo "[start-agent] EXPOSED: $exposed of $total daemon process(es) lack the tool boundary." >&2
    echo "              They can read your filesystem. Run: $(basename "$0") --local" >&2
    exit 1
  fi
  echo "[start-agent] ok — $total daemon process(es), all carry the fix."
  exit 0
fi

# CHECK BEFORE KILLING. The published build is what the default mode is about to install,
# so verify it is new enough BEFORE tearing down a working daemon. Without this the default
# path was a guaranteed outage while the fix was unpublished: kill everything (including a
# healthy fixed daemon) -> install an unfixed one -> assert fails -> kill it -> exit 1,
# leaving the machine with NO daemon and subscription chat dead.
if [ "$MODE" = "" ]; then
  published="$(npm view @noesis-brain/mcp-server dist-tags.latest 2>/dev/null || true)"
  if [ -z "$published" ]; then
    echo "[start-agent] Could not reach npm to check the published version; refusing to" >&2
    echo "              tear down a running daemon on a guess. Use --local." >&2
    exit 1
  fi
  if ! version_ge "$published" "$MIN_FIXED_VERSION"; then
    echo "[start-agent] Published @latest is v$published, which is older than v$MIN_FIXED_VERSION" >&2
    echo "              and lacks the tool boundary. NOT touching the running daemon." >&2
    echo "              Publish $MIN_FIXED_VERSION, or start this checkout: $(basename "$0") --local" >&2
    exit 1
  fi
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
  # Both passes over the whole pattern set, not just this pid: killing the child alone
  # leaves the `npm exec` parent to respawn it — which is the exact failure this script's
  # own header describes, and it would have happened right after printing "Stopping it."
  kill_matching -TERM >&2
  sleep 2
  kill_matching -KILL >&2
  sleep 1
  if [ "$(count_matching)" -gt 0 ]; then
    echo "              WARNING: $(count_matching) process(es) survived; run --status." >&2
  fi
  echo "              Publish $MIN_FIXED_VERSION or newer, or start the local build:" >&2
  echo "              $(basename "$0") --local" >&2
  exit 1
fi

echo "[start-agent] running: pid $started (v$ver, $state)"
echo "[start-agent] log: $LOG_FILE"
tail -3 "$LOG_FILE" 2>/dev/null | sed 's/^/  /'
