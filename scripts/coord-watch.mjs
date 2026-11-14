#!/usr/bin/env node
// coord-watch.mjs — the Chief of Staff's scan watcher (TCK-1890). It has no model, so it costs no
// tokens. Every --interval seconds it reads the active tickets from the Noesis API and runs the
// read-only scanner (coord-scan.mjs). When the result differs from the last run, it posts the
// scan as the whole picture of the conflicts (the same call as the coord_report tool) and wakes
// the Chief: it types `/noesis-chief watch` into the Chief's iTerm2 tab. The first run only sets
// the baseline, because the Chief has just made its own pass.
//
//   node coord-watch.mjs --start --chief-pid <pid> [--repo <main checkout>] [--interval 300]   (opens its own tab)
//   node coord-watch.mjs --chief-pid <pid> [--repo <main checkout>] [--interval 300] [--once] [--dry-run] [--config-file <f>]
//   node coord-watch.mjs --selftest
//
// The Chief is named by the pid of its Claude Code process (`$PPID` in its Bash tool), never by a
// fixed tty, in the style of the loop watchdog:
// - before each wake it finds the tty again from that pid, so a tty that a closed tab gave back to
//   macOS is never typed into;
// - it types only when `claude agents --json` reports that session `idle`. At a question or a
//   permission prompt (`waiting`), or while it works, the wake waits: typing there could answer a
//   dialog. A change that could not wake the Chief stays pending until it can;
// - it exits within 10 s of the Chief's process ending, so a new Chief can start its own watcher.
// - TCK-1926: on every tick it also reads the questions and plan approvals that ticket sessions hold. A new one on
//   the Chief's route wakes the Chief, as a changed scan does; one for the owner alone does not. The first read only
//   sets the baseline, because the Chief has just made its own pass.
//
// It runs in its own iTerm2 tab, because macOS lets only a terminal-attached process drive iTerm2
// (measured for the loop watchdog, 2026-08-22). --start opens that tab and goes back to the tab you
// were in. It passes the API address and token through a mode-600 file that the new watcher reads
// and deletes, so neither is lost (the tab has iTerm2's environment) nor shown on a command line.
// It starts nothing while another watcher serves a live Chief.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ACTIVE_STATUSES = ['planning', 'ready_to_implement', 'implementing', 'iterating', 'ready_to_merge', 'deploying'];
export const WAKE_LINE = '/noesis-chief watch';
export const TICK_MS = 10_000;
const BOARD_FIELDS = ['key', 'work_status', 'work_status_at', 'bound_session_id', 'branch', 'worktree', 'pinned_at', 'priority', 'open_question_count'];

/** What a wake depends on: each open conflict (kind, pair, severity) and each active ticket's status. */
export function fingerprint(scan) {
  const conflicts = (scan.conflicts || []).map((c) => `${c.kind}|${c.a}|${c.b || ''}|${c.severity}`);
  const tickets = (scan.tickets || []).map((t) => `${t.key}|${t.status || t.work_status || ''}`);
  return [...new Set([...conflicts, ...tickets])].sort();
}

/** The lines that appeared and the lines that went away between two fingerprints. */
export function diffScans(prev, next) {
  const a = new Set(prev);
  const b = new Set(next);
  const added = next.filter((x) => !a.has(x));
  const gone = prev.filter((x) => !b.has(x));
  return { changed: added.length > 0 || gone.length > 0, added, gone };
}

/** The board the scanner reads: only the fields it needs, for the active statuses. */
export function boardOf(lists) {
  return { issues: lists.flat().map((i) => Object.fromEntries(BOARD_FIELDS.map((f) => [f, i[f] ?? null]))) };
}

/** How many 10-second ticks make one scan interval. */
export function ticksPerScan(intervalSeconds) {
  return Math.max(1, Math.round((intervalSeconds * 1000) / TICK_MS));
}

/**
 * One scan. `state.last` is the previous fingerprint (null before the first run). A change posts
 * the scan and makes the wake pending. It never throws: a failed board read or scan reports `error`
 * and keeps the old baseline.
 */
export async function step(deps, state) {
  let scan;
  try {
    scan = await deps.scan(boardOf(await Promise.all(ACTIVE_STATUSES.map((s) => deps.listIssues(s)))));
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
  const next = fingerprint(scan);
  if (state.last === null) {
    state.last = next;
    return { baseline: true, size: next.length };
  }
  const d = diffScans(state.last, next);
  if (!d.changed) return { changed: false };
  state.last = next;
  state.pending = true;
  let posted = false;
  try {
    await deps.postReport(scan.conflicts || []);
    posted = true;
  } catch {
    /* the Chief posts again on its pass */
  }
  return { changed: true, added: d.added, gone: d.gone, posted };
}

/**
 * Wakes the Chief when it is safe: its process is alive, its session is idle, and exactly one
 * iTerm2 session has the tty that process has now. Returns { gone } when the Chief has ended,
 * { woke: 0, reason } when the wake must wait, and { woke: n } after typing.
 */
export function wakeChief(pid, line, deps) {
  if (!deps.alive(pid)) return { gone: true };
  const status = deps.statusOf(pid);
  if (status !== 'idle') return { woke: 0, reason: `the Chief is ${status || 'not listed by claude agents'}` };
  const tty = deps.ttyOf(pid);
  if (!/^\/dev\/ttys\d+$/.test(tty || '')) return { woke: 0, reason: 'no tty for the Chief' };
  // A failed or slow osascript call throws: the wake then waits for the next tick, as iterm-lib's
  // countTtyMatches and the loop watchdog's nudge do, instead of ending the watcher.
  let n;
  try {
    n = deps.count(tty);
  } catch {
    return { woke: 0, reason: 'iTerm2 did not answer the count' };
  }
  if (n !== 1) return { woke: 0, reason: `${n} sessions on ${tty}` };
  try {
    return { woke: deps.type(tty, line) };
  } catch {
    return { woke: 0, reason: 'iTerm2 did not answer the typing' };
  }
}

/**
 * Whether the owner has paused the sessions ("Pause all" on the Chief view, TCK-1926). A failed read counts as not
 * paused, so the watcher wakes the Chief as it did before the pause existed.
 */
export async function pausedNow(deps, pid) {
  if (!deps.paused) return false;
  try {
    return (await deps.paused(pid)) === true;
  } catch {
    return false;
  }
}

/**
 * The questions and plans that wait for the Chief (TCK-1926): `state.requests` holds the open ids on its route. A new
 * id makes the wake pending. A failed read changes nothing; the first read only sets the baseline.
 */
export async function checkRequests(deps, state) {
  if (!deps.openRequests) return null;
  let list;
  try {
    list = await deps.openRequests();
  } catch {
    return null;
  }
  if (!Array.isArray(list)) return null;
  const ids = list.filter((r) => r && r.route === 'chief' && r.status === 'open' && Number.isInteger(r.id)).map((r) => r.id);
  const known = state.requests;
  state.requests = ids;
  if (!Array.isArray(known)) return null;
  const fresh = ids.filter((id) => !known.includes(id));
  if (!fresh.length) return null;
  state.pending = true;
  return { fresh };
}

/** The open requests as the server lists them; anything but a list (a reply without `requests`) changes nothing. */
export const REQUESTS_PATH = '/api/mcp/coordination/requests';
export const requestsReader = (call) => async () => {
  const r = await call('GET', REQUESTS_PATH);
  return r ? r.requests : undefined;
};

/** One 10-second tick: a scan on every `every`-th tick and a read of the requests, then a wake when one is pending and the owner has not paused. */
export async function tick(deps, state, pid, every) {
  const out = {};
  if (state.ticks % every === 0) out.scan = await step(deps, state);
  state.ticks++;
  const asked = await checkRequests(deps, state);
  if (asked) out.requests = asked;
  if (state.pending) {
    // While paused, the change stays pending and the Chief is woken after "Continue all".
    const w = deps.alive(pid) && (await pausedNow(deps, pid)) ? { woke: 0, reason: 'the owner paused the sessions' } : wakeChief(pid, WAKE_LINE, deps);
    out.wake = w;
    if (w.woke > 0) state.pending = false;
  } else if (!deps.alive(pid)) {
    out.wake = { gone: true };
  }
  return out;
}

// ---- AppleScript, built as text so it can be checked ----

export const esc = (s) => String(s).replace(/["\\]/g, '\\$&');

/** Counts the iTerm2 sessions on this tty. */
export function countScript(tty) {
  return `tell application "iTerm2"
  set hits to 0
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if (tty of s) is "${esc(tty)}" then set hits to hits + 1
      end repeat
    end repeat
  end repeat
  return hits
end tell`;
}

/** Types one line into the session on this tty, then a bare Enter: the newline of the first write
 *  alone leaves a Claude Code prompt in the composer (measured for the loop watchdog, 2026-08-22). */
export function typeScript(tty, line) {
  return `tell application "iTerm2"
  set hits to 0
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if (tty of s) is "${esc(tty)}" then
          set hits to hits + 1
          write s text "${esc(line)}"
          delay 0.6
          write s text ""
        end if
      end repeat
    end repeat
  end repeat
  return hits
end tell`;
}

const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** The AppleScript that opens a new iTerm2 tab running `exec node <this script> <args>`, names the
 *  tab, and goes back to the tab that was current. */
export function startScript(node, script, argv) {
  const cmd = ['exec', ...[node, script, ...argv].map(shellQuote)].join(' ');
  return `tell application "iTerm2"
  if (count of windows) is 0 then
    create window with default profile
    tell current session of current window to write text "${esc(cmd)}"
  else
    set prevTab to current tab of current window
    tell current window
      set newTab to (create tab with default profile)
      tell current session of newTab
        set name to "coord-watch"
        write text "${esc(cmd)}"
      end tell
    end tell
    select prevTab
  end if
end tell`;
}

/** The other coord-watch processes that watch (not a starter, not a selftest, not this pid), with
 *  the Chief pid each one serves. */
export function runningWatchers(pgrepOut, selfPid) {
  return String(pgrepOut || '')
    .split('\n')
    .map((l) => l.trim().match(/^(\d+)\s+(.*)$/))
    .filter((m) => m && Number(m[1]) !== selfPid && /coord-watch\.mjs/.test(m[2]) && !/--start\b/.test(m[2]) && !/--selftest\b/.test(m[2]))
    .map((m) => ({ pid: Number(m[1]), chiefPid: Number((m[2].match(/--chief-pid\s+'?(\d+)/) || [])[1]) || null }));
}

/** The status in `claude agents --json` output for this pid. Output that is not a JSON list (cut
 *  short by the timeout, or an error text) gives null, so the wake waits: it fails closed. */
export function statusFromOutput(stdout, pid) {
  try {
    return statusIn(JSON.parse(stdout || ''), pid);
  } catch {
    return null;
  }
}

/** The session id `claude agents --json` reports for this pid, or null. */
export function sessionIdIn(agents, pid) {
  const row = (Array.isArray(agents) ? agents : []).find((a) => a && a.pid === pid);
  return row && typeof row.sessionId === 'string' && row.sessionId ? row.sessionId : null;
}

/** The status `claude agents --json` reports for the session of this pid, or null. */
export function statusIn(agents, pid) {
  const row = (Array.isArray(agents) ? agents : []).find((a) => a && a.pid === pid);
  return row ? row.status || row.state || null : null;
}

const osa = (script) => execFileSync('osascript', ['-e', script], { encoding: 'utf-8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/** True while a process with this pid exists (EPERM: it exists but belongs to another user). */
export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function ttyOf(pid) {
  try {
    const t = execFileSync('ps', ['-o', 'tty=', '-p', String(pid)], { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return t && t !== '??' ? `/dev/${t}` : null;
  } catch {
    return null;
  }
}

/** The status from one `claude agents --json` run: a run that failed or timed out gives null. */
export function statusFromRun(run, pid) {
  return run && run.status === 0 && !run.error ? statusFromOutput(run.stdout, pid) : null;
}

function agentsStatus(pid) {
  return statusFromRun(spawnSync('claude', ['agents', '--json'], { encoding: 'utf8', timeout: 20_000 }), pid);
}

/** The Chief's session id from one `claude agents --json` run, or null. */
function agentsSessionId(pid) {
  const run = spawnSync('claude', ['agents', '--json'], { encoding: 'utf8', timeout: 20_000 });
  if (!run || run.status !== 0 || run.error) return null;
  try {
    return sessionIdIn(JSON.parse(run.stdout || ''), pid);
  } catch {
    return null;
  }
}

async function apiConfig(args) {
  if (args.configFile) {
    const cfg = JSON.parse(fs.readFileSync(args.configFile, 'utf8'));
    fs.rmSync(args.configFile, { force: true });
    return cfg;
  }
  const { loadConfig } = await import('./noesis-ticket-session.mjs');
  return loadConfig(process.cwd());
}

async function realDeps(args, cfg) {
  const call = async (method, p, body) => {
    const res = await fetch(cfg.baseUrl + p, {
      method,
      headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`${method} ${p} -> HTTP ${res.status}`);
    return res.json();
  };
  const dir = path.join(os.homedir(), '.claude', 'coord');
  fs.mkdirSync(dir, { recursive: true });
  const boardFile = path.join(dir, `watch-board-${args.chiefPid}.json`); // one file per Chief
  return {
    listIssues: async (status) => (await call('GET', `/api/mcp/backlog/issues?status=${status}`)).issues || [],
    scan: async (board) => {
      fs.writeFileSync(boardFile, JSON.stringify(board));
      const r = spawnSync(process.execPath, [path.join(HERE, 'coord-scan.mjs'), '--board', boardFile, '--repo', args.repo, '--json'], { encoding: 'utf8', timeout: 300_000, maxBuffer: 64 * 1024 * 1024 });
      if (r.status !== 0) throw new Error(`coord-scan exit ${r.status}: ${(r.stderr || '').slice(0, 200)}`);
      return JSON.parse(r.stdout);
    },
    postReport: async (conflicts) => (args.dryRun ? console.log(`[dry-run] would post ${conflicts.length} conflict(s)`) : call('POST', '/api/mcp/coordination/report', { conflicts })),
    // The pause flag is the owner's newest "Pause all" or "Continue all", read from the Chief's own inbox.
    paused: async (pid) => {
      const session = agentsSessionId(pid) || `chief-pid-${pid}`;
      const r = await call('GET', `/api/mcp/coordination/inbox?session=${encodeURIComponent(session)}&limit=1`);
      return !!(r && r.pause && r.pause.paused);
    },
    // TCK-1926: the open questions and plans; the watcher keeps only those on the Chief's route.
    openRequests: requestsReader(call),
    alive,
    statusOf: agentsStatus,
    ttyOf,
    count: (tty) => Number(osa(countScript(tty))) || 0,
    type: (tty, line) => (args.dryRun ? (console.log(`[dry-run] would type "${line}" into ${tty}`), 0) : Number(osa(typeScript(tty, line))) || 0),
  };
}

export function parseArgs(argv) {
  const out = { repo: path.join(os.homedir(), 'temp_cGit', 'md-manager'), interval: 300, once: false, dryRun: false, chiefPid: 0, start: false, configFile: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--start') out.start = true;
    else if (a === '--once') out.once = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--repo') out.repo = path.resolve(argv[++i] || '');
    else if (a === '--interval') out.interval = Math.max(60, Number(argv[++i]) || 300);
    else if (a === '--chief-pid') out.chiefPid = Number(argv[++i]) || 0;
    else if (a === '--config-file') out.configFile = argv[++i] || '';
    else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

/** The arguments the started watcher gets: absolute paths, never --start, the config file. */
export function startedArgv(args, configFile) {
  return ['--chief-pid', String(args.chiefPid), '--repo', args.repo, '--interval', String(args.interval), '--config-file', configFile];
}

const stamp = () => new Date().toISOString().slice(11, 19) + 'Z';
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function start(args) {
  for (let waited = 0; ; waited++) {
    const r = spawnSync('pgrep', ['-lf', 'coord-watch.mjs'], { encoding: 'utf8' });
    const others = runningWatchers(r.stdout, process.pid);
    const live = others.filter((w) => w.chiefPid && alive(w.chiefPid));
    if (live.length) return console.log(`coord-watch already serves Chief pid ${live.map((w) => w.chiefPid).join(' ')} (watcher pid ${live.map((w) => w.pid).join(' ')})`);
    if (!others.length) break;
    if (waited >= 15) return console.log(`an old coord-watch (pid ${others.map((w) => w.pid).join(' ')}) has not exited yet; run --start again in a minute`);
    await sleep(1000); // a watcher whose Chief has gone exits within one tick
  }
  const cfg = await apiConfig({});
  if (!cfg) throw new Error('no Noesis API token (set NOESIS_API_TOKEN or configure the noesis MCP server)');
  const dir = path.join(os.homedir(), '.claude', 'coord');
  fs.mkdirSync(dir, { recursive: true });
  const configFile = path.join(dir, `watch-config-${args.chiefPid}.json`);
  fs.writeFileSync(configFile, JSON.stringify({ baseUrl: cfg.baseUrl, token: cfg.token }), { mode: 0o600 });
  try {
    osa(startScript(process.execPath, fileURLToPath(import.meta.url), startedArgv(args, configFile)));
  } catch (e) {
    fs.rmSync(configFile, { force: true }); // no tab: the token must not stay on disk
    throw new Error(`iTerm2 did not open the tab: ${e.message}`);
  }
  console.log(`coord-watch started in its own iTerm2 tab for Chief pid ${args.chiefPid}, on ${cfg.baseUrl}`);
}

async function main(argv) {
  const args = parseArgs(argv);
  if (!(args.chiefPid > 1)) throw new Error('--chief-pid <the Chief session pid> is required');
  if (args.start) return start(args);
  const cfg = await apiConfig(args);
  if (!cfg) throw new Error('no Noesis API token (set NOESIS_API_TOKEN or configure the noesis MCP server)');
  const deps = await realDeps(args, cfg);
  const state = { last: null, pending: false, ticks: 0 };
  const every = ticksPerScan(args.interval);
  console.log(`${stamp()} watching Chief pid ${args.chiefPid} on ${cfg.baseUrl}, a scan every ${every * (TICK_MS / 1000)} s`);
  for (;;) {
    let r;
    try {
      r = await tick(deps, state, args.chiefPid, every);
    } catch (e) {
      // Nothing in a tick may end the watcher: the change stays pending for the next tick.
      console.log(`${stamp()} tick failed, still watching: ${(e && e.message) || e}`);
      await sleep(TICK_MS);
      continue;
    }
    const s = r.scan;
    if (s && s.error) console.log(`${stamp()} scan failed, kept the old baseline: ${s.error}`);
    else if (s && s.baseline) console.log(`${stamp()} baseline: ${s.size} line(s)`);
    else if (s && s.changed) console.log(`${stamp()} changed: +${s.added.length} -${s.gone.length}; posted ${s.posted}`);
    if (r.requests) console.log(`${stamp()} ${r.requests.fresh.length} new question(s) or plan(s) for the Chief`);
    if (r.wake && r.wake.gone) return console.log(`${stamp()} the Chief (pid ${args.chiefPid}) has ended; stopping`);
    if (r.wake && r.wake.woke > 0) console.log(`${stamp()} woke the Chief`);
    else if (r.wake && r.wake.reason && s && s.changed) console.log(`${stamp()} wake waits: ${r.wake.reason}`);
    if (args.once && s) return;
    await sleep(TICK_MS);
  }
}

async function selftest() {
  let n = 0;
  let bad = 0;
  const eq = (name, got, want) => {
    n++;
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) bad++;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
  };
  const c = (kind, a, b, severity = 'medium') => ({ kind, a, b, severity, detail: 'd' });
  const t = (key, status) => ({ key, status });
  eq('fingerprint: conflicts and ticket statuses, sorted, once each', fingerprint({ conflicts: [c('C4', 'TCK-2', 'TCK-1'), c('C4', 'TCK-2', 'TCK-1')], tickets: [t('TCK-1', 'implementing')] }), ['C4|TCK-2|TCK-1|medium', 'TCK-1|implementing']);
  eq('fingerprint: a severity change is a change', diffScans(fingerprint({ conflicts: [c('C2', 'TCK-1', 'TCK-2', 'low')] }), fingerprint({ conflicts: [c('C2', 'TCK-1', 'TCK-2', 'high')] })).changed, true);
  eq('diff: added and gone', diffScans(['a', 'b'], ['b', 'c']), { changed: true, added: ['c'], gone: ['a'] });
  eq('diff: same lines in another order is no change', diffScans(['a', 'b'], ['b', 'a']).changed, false);
  eq('board: only the scanner fields, nulls for missing ones', boardOf([[{ key: 'TCK-1', work_status: 'planning', title: 'x' }], []]).issues[0], { key: 'TCK-1', work_status: 'planning', work_status_at: null, bound_session_id: null, branch: null, worktree: null, pinned_at: null, priority: null, open_question_count: null });
  eq('ticks: a scan every interval, in 10-second ticks, at least one', [ticksPerScan(300), ticksPerScan(60), ticksPerScan(1)], [30, 6, 1]);

  // The scan and the wake, with fakes.
  const calls = [];
  let scanResult = { conflicts: [c('C4', 'TCK-2', 'TCK-1')], tickets: [t('TCK-1', 'implementing')] };
  let status = 'idle';
  let pidAlive = true;
  let sessions = 1;
  let tty = '/dev/ttys012';
  const deps = {
    listIssues: async (s) => (calls.push(`list ${s}`), s === 'implementing' ? [{ key: 'TCK-1', work_status: 'implementing' }] : []),
    scan: async (board) => (calls.push(`scan ${board.issues.length}`), scanResult),
    postReport: async (conflicts) => calls.push(`post ${conflicts.length}`),
    alive: () => pidAlive,
    statusOf: () => status,
    ttyOf: () => tty,
    count: () => sessions,
    type: (on, line) => (calls.push(`type ${on} ${line}`), 1),
  };
  const state = { last: null, pending: false, ticks: 0 };
  const only = (pre) => calls.splice(0).filter((x) => x.startsWith(pre));
  eq('first scan: a baseline, nothing posted or typed', (await tick(deps, state, 42, 3)).scan, { baseline: true, size: 2 });
  eq('first scan: every active status is listed, then one scan', calls.splice(0), [...ACTIVE_STATUSES.map((s) => `list ${s}`), 'scan 1']);
  eq('the ticks between scans do not scan', [await tick(deps, state, 42, 3), await tick(deps, state, 42, 3)], [{}, {}]);
  eq('no change: nothing posted, nothing typed', (await tick(deps, state, 42, 3)).scan, { changed: false });
  eq('no change: no post and no typing', [only('post'), only('type')], [[], []]);
  scanResult = { conflicts: [c('C4', 'TCK-2', 'TCK-1'), c('C1', 'TCK-1', 'TCK-3', 'high')], tickets: [t('TCK-1', 'ready_to_merge')] };
  status = 'waiting';
  state.ticks = 6;
  const r1 = await tick(deps, state, 42, 3);
  eq('a change while the Chief waits at a prompt: posted, not typed, pending', [r1.scan.changed, r1.scan.posted, r1.wake, state.pending], [true, true, { woke: 0, reason: 'the Chief is waiting' }, true]);
  eq('the post carries the whole picture; nothing typed', [only('post'), only('type')], [['post 2'], []]);
  status = 'busy';
  eq('still busy at the next tick: no scan, the wake waits', await tick(deps, state, 42, 3), { wake: { woke: 0, reason: 'the Chief is busy' } });
  status = 'idle';
  eq('idle at the next tick: typed once, then no longer pending', [await tick(deps, state, 42, 3), state.pending], [{ wake: { woke: 1 } }, false]);
  eq('the one line typed, into the tty the pid has now', only('type'), ['type /dev/ttys012 /noesis-chief watch']);
  eq('no second wake for the same change', (await tick(deps, state, 42, 3)).scan, { changed: false });
  const failing = { ...deps, scan: async () => { throw new Error('git broke'); } };
  state.ticks = 12;
  eq('a failed scan reports the error and keeps the baseline', (await tick(failing, state, 42, 3)).scan, { error: 'git broke' });
  state.ticks = 15;
  eq('after the failure, the same result is still no change', (await tick(deps, state, 42, 3)).scan, { changed: false });
  scanResult = { conflicts: [], tickets: [] };
  const posting = { ...deps, postReport: async () => { throw new Error('HTTP 503'); } };
  state.ticks = 18;
  const r2 = await tick(posting, state, 42, 3);
  eq('a failed post still wakes the Chief', [r2.scan.changed, r2.scan.posted, r2.wake], [true, false, { woke: 1 }]);
  calls.length = 0;

  // Who gets typed into.
  status = 'idle';
  eq('wake: the Chief has ended', wakeChief(42, WAKE_LINE, { ...deps, alive: () => false }), { gone: true });
  eq('wake: not listed by claude agents', wakeChief(42, WAKE_LINE, { ...deps, statusOf: () => null }), { woke: 0, reason: 'the Chief is not listed by claude agents' });
  for (const s of ['waiting', 'busy', 'shell']) eq(`wake: the Chief is ${s}, nothing typed`, wakeChief(42, WAKE_LINE, { ...deps, statusOf: () => s }).woke, 0);
  eq('wake: no tty, or not a ttys path', [wakeChief(42, WAKE_LINE, { ...deps, ttyOf: () => null }).woke, wakeChief(42, WAKE_LINE, { ...deps, ttyOf: () => '/dev/console' }).woke, wakeChief(42, WAKE_LINE, { ...deps, ttyOf: () => '/dev/ttys1; rm -rf /' }).woke], [0, 0, 0]);
  sessions = 2;
  eq('wake: two sessions on the tty, nothing typed', wakeChief(42, WAKE_LINE, deps), { woke: 0, reason: '2 sessions on /dev/ttys012' });
  sessions = 0;
  eq('wake: no session on the tty, nothing typed', wakeChief(42, WAKE_LINE, deps).woke, 0);
  sessions = 1;
  tty = '/dev/ttys099';
  eq('wake: the tty is read again from the pid each time', [wakeChief(42, WAKE_LINE, deps), only('type')], [{ woke: 1 }, ['type /dev/ttys099 /noesis-chief watch']]);
  pidAlive = false;
  eq('tick: the Chief has ended, nothing pending', await tick(deps, { last: [], pending: false, ticks: 1 }, 42, 3), { wake: { gone: true } });
  eq('tick: the Chief has ended while a wake is pending', (await tick(deps, { last: [], pending: true, ticks: 1 }, 42, 3)).wake, { gone: true });
  const boom = () => { throw new Error('osascript timed out'); };
  eq('wake: a failed count waits, nothing typed', wakeChief(42, WAKE_LINE, { ...deps, alive: () => true, count: boom }), { woke: 0, reason: 'iTerm2 did not answer the count' });
  eq('wake: a failed typing waits', wakeChief(42, WAKE_LINE, { ...deps, alive: () => true, type: boom }), { woke: 0, reason: 'iTerm2 did not answer the typing' });
  const keep = { last: [], pending: true, ticks: 1 };
  eq('tick: a failed typing keeps the change pending', [(await tick({ ...deps, alive: () => true, type: boom }, keep, 42, 3)).wake.woke, keep.pending], [0, true]);

  // The owner's pause (TCK-1926): no wake while paused; the change waits for "Continue all".
  calls.length = 0;
  let paused = true;
  const asked = [];
  const pausing = { ...deps, alive: () => true, paused: async (p) => (asked.push(p), paused) };
  const held = { last: [], pending: true, ticks: 1 };
  eq('pause: a pending wake waits, nothing typed, still pending', [await tick(pausing, held, 42, 3), only('type'), held.pending, asked], [{ wake: { woke: 0, reason: 'the owner paused the sessions' } }, [], true, [42]]);
  paused = false;
  eq('continue: the held change wakes the Chief once', [await tick(pausing, held, 42, 3), held.pending], [{ wake: { woke: 1 } }, false]);
  eq('pause: nothing pending, the pause is not even read', [await tick(pausing, { last: [], pending: false, ticks: 1 }, 42, 3), asked.length], [{}, 2]);
  const unreadable = { ...pausing, paused: async () => { throw new Error('HTTP 503'); } };
  eq('pause: a failed read wakes as before', (await tick(unreadable, { last: [], pending: true, ticks: 1 }, 42, 3)).wake, { woke: 1 });
  eq('pause: an answer that is not true is not a pause', (await tick({ ...pausing, paused: async () => 'yes' }, { last: [], pending: true, ticks: 1 }, 42, 3)).wake, { woke: 1 });
  paused = true;
  eq('pause: a Chief that has ended is gone, paused or not', (await tick({ ...pausing, alive: () => false }, { last: [], pending: true, ticks: 1 }, 42, 3)).wake, { gone: true });
  eq('pause: no reader at all wakes as before', [await pausedNow({}, 42), await pausedNow({ paused: async () => true }, 42)], [false, true]);
  // The questions and plans that wait for the Chief (TCK-1926): a new one wakes it, as a changed scan does.
  // 1000 ticks per scan: these ticks read the requests only.
  calls.length = 0;
  let open = [{ id: 5, route: 'chief', status: 'open' }, { id: 6, route: 'owner', status: 'open' }];
  const asking = { ...deps, alive: () => true, statusOf: () => 'idle', ttyOf: () => '/dev/ttys012', count: () => 1, openRequests: async () => open };
  const rs = { last: [], pending: false, ticks: 1 };
  eq('requests: the first read is the baseline, no wake', [await tick(asking, rs, 42, 1000), rs.requests, rs.pending], [{}, [5], false]);
  open = [{ id: 5, route: 'chief', status: 'open' }, { id: 7, route: 'chief', status: 'open' }, { id: 6, route: 'owner', status: 'open' }, { id: 8, route: 'chief', status: 'answered' }];
  eq('requests: a new one on the Chief\'s route wakes it; the owner\'s and an answered one do not count', [await tick(asking, rs, 42, 1000), rs.pending, only('type')], [{ requests: { fresh: [7] }, wake: { woke: 1 } }, false, ['type /dev/ttys012 /noesis-chief watch']]);
  eq('requests: the same ones again: no second wake', await tick(asking, rs, 42, 1000), {});
  open = [{ id: 7, route: 'chief', status: 'open' }, { id: 9, route: 'owner', status: 'open' }];
  eq('requests: one answered, one for the owner alone: nothing new', [await tick(asking, rs, 42, 1000), rs.requests], [{}, [7]]);
  eq('requests: a failed read or a list that is not a list changes nothing',
    [await tick({ ...asking, openRequests: async () => { throw new Error('HTTP 503'); } }, rs, 42, 1000), await tick({ ...asking, openRequests: async () => ({}) }, rs, 42, 1000), rs.requests],
    [{}, {}, [7]]);
  open = [{ id: 7, route: 'chief', status: 'open' }, { id: 10, route: 'chief', status: 'open' }];
  const pausedAsk = { ...asking, paused: async () => true };
  eq('requests: while paused, a new one waits for "Continue all"', [await tick(pausedAsk, rs, 42, 1000), rs.pending], [{ requests: { fresh: [10] }, wake: { woke: 0, reason: 'the owner paused the sessions' } }, true]);
  eq('requests: after "Continue all" the held one wakes the Chief once', [await tick(asking, rs, 42, 1000), rs.pending], [{ wake: { woke: 1 } }, false]);
  // The open set changes without growing (7 answered, 12 asked between two reads): 12 is new, and wakes the Chief.
  const swap = { last: [], pending: false, ticks: 1, requests: [7] };
  open = [{ id: 12, route: 'chief', status: 'open' }];
  eq('requests: one answered and one new between two reads: the new one wakes the Chief', [await tick(asking, swap, 42, 1000), swap.requests], [{ requests: { fresh: [12] }, wake: { woke: 1 } }, [12]]);
  // A first read that fails sets no baseline: the next good read is the baseline, and wakes nothing.
  const late = { last: [], pending: false, ticks: 1 };
  calls.length = 0;
  eq('requests: a failed first read, then a good one: the good one is the baseline, nothing typed',
    [await tick({ ...asking, openRequests: async () => { throw new Error('HTTP 503'); } }, late, 42, 1000), late.requests, await tick({ ...asking, openRequests: async () => [{ id: 20, route: 'chief', status: 'open' }] }, late, 42, 1000), late.requests, only('type')],
    [{}, undefined, {}, [20], []]);
  const asked2 = [];
  const reader = requestsReader(async (method, p) => (asked2.push(`${method} ${p}`), { requests: [{ id: 3 }] }));
  eq('requests: the reader asks the Chief\'s MCP route and returns its list', [await reader(), asked2], [[{ id: 3 }], ['GET /api/mcp/coordination/requests']]);
  eq('requests: a reply without the list is no list (it changes nothing)', await requestsReader(async () => ({}))(), undefined);
  // The needle is built from two parts, so this line itself never matches it: only realDeps' line can.
  eq('requests: the real watcher uses this reader', fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').includes(['    openRequests', ': requestsReader(call),'].join('')), true);
  eq('requests: no reader (an older server): no requests key', await tick({ ...asking, openRequests: undefined }, { last: [], pending: false, ticks: 1 }, 42, 1000), {});
  calls.length = 0;
  eq('session id: the row with this pid, else null',
    [sessionIdIn([{ pid: 7, sessionId: 'a' }, { pid: 42, sessionId: 'b' }], 42), sessionIdIn([{ pid: 42 }], 42), sessionIdIn([{ pid: 42, sessionId: '' }], 42), sessionIdIn('x', 42), sessionIdIn([{ pid: 9, sessionId: 'c' }], 42)],
    ['b', null, null, null, null]);
  calls.length = 0;
  eq('claude agents output: fails closed on output that is not a JSON list',
    [statusFromOutput('[{"pid":42,"status":"idle"}]', 42), statusFromOutput('[{"pid":42,"status":"idle"}', 42), statusFromOutput('Error: not logged in', 42), statusFromOutput('', 42), statusFromOutput('{"pid":42,"status":"idle"}', 42)],
    ['idle', null, null, null, null]);
  const listed = '[{"pid":42,"status":"idle"}]';
  eq('claude agents run: only a clean exit is read; a failure or a timeout gives null',
    [statusFromRun({ status: 0, stdout: listed }, 42), statusFromRun({ status: 1, stdout: listed }, 42), statusFromRun({ status: null, error: new Error('ETIMEDOUT'), stdout: listed }, 42), statusFromRun({ status: 0, error: new Error('x'), stdout: listed }, 42), statusFromRun(null, 42)],
    ['idle', null, null, null, null]);
  const gone = spawnSync(process.execPath, ['-e', '0']).pid;
  eq('alive: this process yes, an ended one no, pid 1 (another user: EPERM) yes', [alive(process.pid), alive(gone), alive(1)], [true, false, true]);
  eq('claude agents: the status of the row with that pid', [statusIn([{ pid: 7, status: 'busy' }, { pid: 42, status: 'idle' }], 42), statusIn([{ pid: 7, status: 'busy' }], 42), statusIn('x', 42)], ['idle', null, null]);

  // The AppleScript.
  const cs = countScript('/dev/ttys012');
  eq('count script: counts the sessions on that tty and returns the count', [cs.includes('if (tty of s) is "/dev/ttys012" then set hits to hits + 1'), cs.includes('return hits')], [true, true]);
  const ts = typeScript('/dev/ttys012', WAKE_LINE);
  eq('type script: only into the session on that tty', /if \(tty of s\) is "\/dev\/ttys012" then\n\s+set hits to hits \+ 1\n\s+write s text "\/noesis-chief watch"\n\s+delay 0\.6\n\s+write s text ""\n\s+end if/.test(ts), true);
  eq('type script: the line once, then one bare Enter', [ts.split('write s text').length - 1, (ts.match(/write s text ""/g) || []).length], [2, 1]);
  eq('type script: quotes and backslashes escaped', typeScript('/dev/ttys1', 'a "b" \\c').includes('write s text "a \\"b\\" \\\\c"'), true);
  const sc = startScript('/usr/bin/node', '/p/coord-watch.mjs', ['--chief-pid', '42', '--repo', "/w/it's"]);
  eq('start: the tab runs exec node with each argument quoted', sc.includes(`write text "exec '/usr/bin/node' '/p/coord-watch.mjs' '--chief-pid' '42' '--repo' '/w/it'\\\\''s'"`), true);
  eq('start: it goes back to the tab you were in', /set prevTab to current tab[\s\S]*select prevTab/.test(sc), true);
  eq('start: the started watcher gets absolute paths, the config file, never --start',
    startedArgv(parseArgs(['--start', '--chief-pid', '42', '--repo', 'rel/dir', '--interval', '120']), '/c/f.json'),
    ['--chief-pid', '42', '--repo', path.resolve('rel/dir'), '--interval', '120', '--config-file', '/c/f.json']);
  eq('running watchers: other watchers with the Chief they serve, not the starter, not a selftest, not this pid',
    runningWatchers("10 node /p/coord-watch.mjs --chief-pid 42 --repo /r\n11 node /p/coord-watch.mjs --start --chief-pid 42\n12 node /p/coord-watch.mjs --selftest\n13 node /p/other.mjs\n15 node /p/coord-watch.mjs --chief-pid '77' --repo /r\n14 node /p/coord-watch.mjs --chief-pid 9", 14),
    [{ pid: 10, chiefPid: 42 }, { pid: 15, chiefPid: 77 }]);
  eq('args: defaults, the interval floor of 60 s, the Chief pid', [parseArgs([]).interval, parseArgs(['--interval', '5']).interval, parseArgs(['--interval', '600']).interval, parseArgs(['--chief-pid', '42']).chiefPid], [300, 60, 600, 42]);
  let threw = false;
  try {
    parseArgs(['--chief-tty', '/dev/ttys1']);
  } catch {
    threw = true;
  }
  eq('args: an unknown argument (the old --chief-tty) is refused', threw, true);
  console.log(`\n${n - bad}/${n} passed`);
  return bad ? 1 : 0;
}

const isMain = (() => {
  try {
    return process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) {
  if (process.argv.includes('--selftest')) {
    selftest().then((code) => process.exit(code));
  } else {
    main(process.argv.slice(2)).catch((e) => {
      console.error(`coord-watch: ${e.message}`);
      process.exit(2);
    });
  }
}
