// noesis-capture-session-end.mjs
// SessionEnd hook for /noesis-capture. When the CONTROLLER session (the one that
// started captures) ends, mark all of its captures stopped so they don't linger
// as stale "active" entries, and best-effort kill any lingering watcher processes.
//
// This is a GLOBAL hook — Claude Code runs it for every session that ends — so it
// must be a strict no-op unless the ending session is the recorded capture
// controller (state.controllerSessionId). Fully fail-safe: any error, missing
// state, non-controller session, or non-terminal reason exits 0 with no changes.
//
// It does NOT push a final sync to Noesis (a shell hook can't call the MCP). The
// local .md files are already current via the watcher, and the watcher pushes to
// the cloud on every change. For a guaranteed final cloud sync, run
// `/noesis-capture stop` before closing instead.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

// Shared controller state, written by the /noesis-capture skill. Kept in ~/.claude
// (not under a notes root) so it's independent of where captures are written.
const STATE_FILE = path.join(os.homedir(), '.claude', 'noesis-capture-state.json');

// Reasons that mean the session is genuinely ending -> dispose. Skip `clear`
// and `resume` (the session keeps running with the same id) and
// `bypass_permissions_disabled` (a mid-session toggle), so we never tear down
// a still-live monitor.
const TERMINAL_REASONS = new Set(['logout', 'prompt_input_exit', 'other']);

let data = '';
process.stdin.on('data', (chunk) => (data += chunk));
process.stdin.on('end', () => {
  try { run(); } catch { /* never block or fail a session exit */ }
  process.exit(0);
});

function run() {
  const input = JSON.parse(data || '{}');
  const sessionId = input.session_id;
  const reason = input.reason || 'other';
  if (!sessionId || !TERMINAL_REASONS.has(reason)) return;

  let state;
  try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')); }
  catch { return; }                          // no/unreadable state -> nothing to do
  if (!state || typeof state !== 'object') return;

  // Only act if THIS ending session owns the captures.
  if (!state.controllerSessionId || state.controllerSessionId !== sessionId) return;

  // Mark every capture stopped (v3 schema; tolerate the legacy singleton).
  if (state.sessions && typeof state.sessions === 'object') {
    for (const s of Object.values(state.sessions)) {
      if (s && typeof s === 'object') s.watching = false;
    }
  } else if (state.sessionId) {              // legacy singleton
    state.watching = false;
  }
  writeState(state);                         // important part — always lands

  killWatchers();                            // best-effort, detached, non-blocking
}

function writeState(obj) {
  try {
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf-8');
    fs.renameSync(tmp, STATE_FILE);
  } catch { /* ignore */ }
}

// Kill lingering watcher node processes without delaying the session exit.
// Detached + unref so it outlives this short-lived hook process. Cross-platform:
// PowerShell on Windows, pkill on macOS/Linux.
function killWatchers() {
  try {
    const marker = 'noesis-capture-watcher.mjs';
    let cmd, cmdArgs;
    if (process.platform === 'win32') {
      const ps =
        'Get-CimInstance Win32_Process | ' +
        `Where-Object { $_.CommandLine -like '*${marker}*' } | ` +
        'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }';
      cmd = 'powershell';
      cmdArgs = ['-NoProfile', '-NonInteractive', '-Command', ps];
    } else {
      cmd = 'pkill';
      cmdArgs = ['-f', marker];
    }
    const child = spawn(cmd, cmdArgs, { detached: true, stdio: 'ignore' });
    child.unref();
  } catch { /* ignore */ }
}
