#!/usr/bin/env node
// coord-start.mjs — the Chief of Staff starts a Claude Code session for a ticket the owner handed it (TCK-1974).
// The Chief's rules are in skill-templates/noesis-chief.md, "Starting ticket sessions".
//
//   node coord-start.mjs check   --ticket TCK-<n> [--repo <main checkout>] [--max <n>] [--self-pid <pid> | --session <chief id>]
//                                [--agents <agents.json>] [--json] [--prove-read-only]
//   node coord-start.mjs prepare --ticket TCK-<n> [--repo <main checkout>] [same options as check] [--json]
//   node coord-start.mjs start   --ticket TCK-<n> [same options as check] [--prompt <one line>] [--json]
//   node coord-start.mjs list    [--repo <main checkout>] [--json]
//   node coord-start.mjs --selftest
//
// `check` says whether the Chief may start a session for the ticket now, and why not. It reads the
// ticket from the list route, one call per status (a keyed GET would stamp the ticket's agent
// activity, see coord-close.mjs), the owner's pause from the Chief's inbox, the live local sessions
// from `claude agents --json`, and the ticket's worktree folder with git. It refuses when the
// ticket is not on the board, is closed (Shipped, Merged, Dropped) or past Planning, or is bound to
// a session; when the Chief is paused; when the limit of live local sessions that hold an open
// ticket is reached (the Chief itself is not counted); or when the worktree folder exists but is not
// this ticket's clean worktree on loop/tck-<n>. A fact it cannot read is a reason of its own, so a
// failure never reads as "start". It writes nothing: --prove-read-only shows it.
//
// `prepare` creates the ticket's worktree the way the loops did by hand (TCK-1949's setup script):
// it fetches origin/main, adds <parent of the main checkout>/<its folder name>-tck-<n> on a new
// branch loop/tck-<n> with no upstream (so a plain push never targets main), inits the MCP
// submodule on a branch of the same name, and links the installed packages and the .env files to
// the main checkout. It refuses on the ticket's and the worktree's reasons, never on the limit or
// the pause: a worktree starts no session. A second run changes nothing.
//
// `start` runs check (it starts nothing when check says no), then prepare, then opens a new iTerm2
// tab in the window of the Chief's own tab, named tck-<n>, that runs
// `cd <worktree> && claude <flags> -n tck-<n> '/cc-loop TCK-<n>'` (not exec, so the tab keeps its
// shell when Claude Code exits), and selects again the tab that was in front of that window. Claude
// Code asks whether to trust a new folder, with "No, exit" chosen (measured on 2.1.309, also with
// --dangerously-skip-permissions). It asks once per repository: it keeps the trust on the main
// checkout, so a worktree of a trusted repository shows no dialog (measured 2026-11-21: the second
// worktree of the same repository showed none). Only when the pane shows that dialog for the worktree it has just
// made does it press Down, wait until "Yes, I trust this folder" is chosen, and press Enter; it never
// presses Enter on "No, exit". It finds the new session by its folder in ~/.claude/sessions/ and
// writes ~/.claude/coord/started/TCK-<n>.json. --prompt replaces the /cc-loop line, for checks with a
// harmless prompt. A started session that has not bound its ticket yet holds a slot, so two starts in a
// row never pass the limit. A ticket is started only once: check refuses a ticket that has a start record
// ("started-before"), so a gone session is never restarted and a failed start is not tried again while its
// tab may still wait. The owner removes the record to allow another start. Starts run one at a time: an
// exclusive lock file (started/.start.lock) covers the check, the worktree, the tab and the record, so two
// starts at once never pass the limit or start one ticket twice. A second start meanwhile is refused ("busy"), and the Chief tries it on the next pass.
// The dialog's folder must be the worktree itself (shown whole, or with the home folder as ~), never a
// folder that merely contains its path.
//
// `list` shows each started session with its live state: alive, its status, its ticket's status,
// whether the session holds its ticket, and what needs the owner (not bound after 10 minutes, or gone
// before its ticket closed).
//
// The limit and the launch flags are in ~/.claude/coord/start.json:
//   {"maxSessions": 4, "claudeArgs": ["--dangerously-skip-permissions", "--chrome"]}
// Both fields are optional; those values are the defaults. --max wins over maxSessions.

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CLOSED_STATUSES, apiGet, composerText, escA, installReadOnlySpy, loadAgents, loadPs, paneScript, readJson, selfSessionPid, sessionOfPid, shq, sourceOf } from './coord-close.mjs';

const SELF = fileURLToPath(import.meta.url);
const HERE = path.dirname(SELF);
const MCP_DIR = 'md-manager-mcp-server';
const configDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
export const DEFAULT_REPO = path.join(os.homedir(), 'temp_cGit', 'md-manager');
/** TCK- and a number from 1 to 999999999: every key fits an integer column. */
export const TICKET_KEY_RE = /^TCK-[1-9]\d{0,8}$/;
export const OPEN_STATUSES = ['planning', 'ready_to_implement', 'implementing', 'iterating', 'ready_to_merge', 'deploying'];
const STARTABLE = ['created', 'planning'];
const ALL_STATUSES = ['created', ...OPEN_STATUSES, ...CLOSED_STATUSES];
const LIST_LIMIT = 500; // the list route returns at most 500 rows
export const DEFAULTS = Object.freeze({ maxSessions: 4, claudeArgs: Object.freeze(['--dangerously-skip-permissions', '--chrome']) });
/** What the loops linked to the main checkout (TCK-1949): the installed packages and the .env files. */
export const LINKS = ['node_modules', 'src/backend/node_modules', 'src/frontend/node_modules', `${MCP_DIR}/node_modules`, '.env', 'src/backend/.env'];
export const startConfigFile = () => path.join(configDir(), 'coord', 'start.json');
/** Reasons that keep a session from starting but not a worktree from being made. */
const SESSION_ONLY = ['limit', 'paused', 'pause-unknown', 'agents-unknown'];
export const startedDir = () => path.join(configDir(), 'coord', 'started');
export const startLockFile = () => path.join(startedDir(), '.start.lock');
/** How long start waits for the new session, and how long a started session may take to bind its ticket. */
export const START_WAIT_MS = 90_000;
const TRUST_MOVE_MS = 8_000;
const LOCK_STALE_MS = START_WAIT_MS + 5 * 60_000;
export const BIND_WAIT_MIN = 10;
/** Claude Code's folder-trust dialog (2.1.309): its question, and the option that trusts the folder. */
export const TRUST_QUESTION = 'Is this a project you created or one you trust?';
const TRUST_HEAD = 'Accessing workspace:';
const TRUST_CHECK = 'Quick safety check:';
const TRUST_YES_CHOSEN = /❯\s*Yes, I trust this folder/;
const PROMPT_MAX = 300;

// ── Copied verbatim from coord-scan.mjs (the selftest checks that each still matches) ─────────
function git(cwd, args, env) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...(env || {}) }, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, code: r.status, out: (r.stdout || '').trim(), raw: r.stdout || '', err: (r.stderr || '').trim() };
}

function mainCheckout(repo) {
  const common = git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!common.ok) return null;
  return path.basename(common.out) === '.git' ? path.dirname(common.out) : repo;
}

function worktrees(main) {
  const out = [];
  let cur = null;
  for (const line of git(main, ['worktree', 'list', '--porcelain']).out.split('\n')) {
    if (line.startsWith('worktree ')) { cur = { path: line.slice(9), head: null, branch: null }; out.push(cur); } else if (cur && line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (cur && line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
  }
  return out;
}
export const COPIED_FROM_SCAN = ['git', 'mainCheckout', 'worktrees'];
// ─────────────────────────────────────────────────────────────────────────────────────────────

const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const lexists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };

/** The limit and the launch flags: {config} or {error}. A missing file means the defaults. */
export function loadStartConfig(file = startConfigFile()) {
  if (!fs.existsSync(file)) return { config: { maxSessions: DEFAULTS.maxSessions, claudeArgs: [...DEFAULTS.claudeArgs] } };
  let j;
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { error: `${file} is not valid JSON` }; }
  return parseStartConfig(j, file);
}

export function parseStartConfig(j, file = 'start.json') {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { error: `${file} must hold one JSON object` };
  for (const k of Object.keys(j)) if (k !== 'maxSessions' && k !== 'claudeArgs') return { error: `${file}: unknown field ${k}` };
  const config = { maxSessions: DEFAULTS.maxSessions, claudeArgs: [...DEFAULTS.claudeArgs] };
  if ('maxSessions' in j) {
    if (!Number.isInteger(j.maxSessions) || j.maxSessions < 1 || j.maxSessions > 20) return { error: `${file}: maxSessions must be a whole number from 1 to 20` };
    config.maxSessions = j.maxSessions;
  }
  if ('claudeArgs' in j) {
    const ok = Array.isArray(j.claudeArgs) && j.claudeArgs.length <= 20 && j.claudeArgs.every((a) => typeof a === 'string' && a.length >= 1 && a.length <= 200 && !/[\u0000-\u001f\u007f]/.test(a));
    if (!ok) return { error: `${file}: claudeArgs must be at most 20 strings of 1 to 200 characters, without control characters` };
    config.claudeArgs = [...j.claudeArgs];
  }
  return { config };
}

/**
 * Every ticket's key, status and binding, from the list route, one call per status. null when a call
 * fails. `truncated`: a list came back full, so a ticket missing from it may still exist.
 */
export async function loadBoard(deps) {
  const rows = [];
  let truncated = false;
  for (const s of ALL_STATUSES) {
    const r = await deps.get(`/api/mcp/backlog/issues?status=${s}`);
    if (!r || !Array.isArray(r.issues)) return null;
    if (r.issues.length >= LIST_LIMIT) truncated = true;
    for (const i of r.issues) {
      if (i && TICKET_KEY_RE.test(i.key || '')) rows.push({ key: i.key, status: i.work_status || s, bound: typeof i.bound_session_id === 'string' && i.bound_session_id ? i.bound_session_id : null });
    }
  }
  return { rows, truncated };
}

/** The live local sessions that hold an open ticket, without the Chief's own session. */
export function sessionsInUse(agents, board, selfSid, alive) {
  const holder = new Map(board.filter((t) => OPEN_STATUSES.includes(t.status) && t.bound).map((t) => [t.bound, t.key]));
  return agents
    .filter((a) => a && a.kind !== 'background' && Number.isInteger(a.pid) && a.pid > 0 && typeof a.sessionId === 'string' && a.sessionId !== selfSid && holder.has(a.sessionId) && alive(a.pid))
    .map((a) => ({ sessionId: a.sessionId, name: a.name || null, pid: a.pid, ticket: holder.get(a.sessionId) }));
}

/** The start records in ~/.claude/coord/started/, oldest first. A file that is not a record is skipped. */
export function readStarted(dir = startedDir()) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /^TCK-\d+\.json$/.test(n)); } catch { return []; }
  return names.map((n) => readJson(path.join(dir, n))).filter((r) => r && TICKET_KEY_RE.test(r.ticket || '') && typeof r.startedAt === 'string').sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

/**
 * The sessions the Chief started that do not hold their ticket yet: each still takes a slot, so two
 * starts in a row never pass the limit. A record counts while its session is alive, or, when its
 * session was never found, for BIND_WAIT_MIN minutes after the start. Its ticket must still be open.
 */
export function pendingStarts(records, inUse, rows, alive, now) {
  const counted = new Set(inUse.map((s) => s.sessionId));
  const closed = new Set(rows.filter((t) => CLOSED_STATUSES.includes(t.status)).map((t) => t.key));
  return records
    .filter((r) => !closed.has(r.ticket) && !(r.sessionId && counted.has(r.sessionId)))
    .filter((r) => (Number.isInteger(r.pid) && r.pid > 0 ? alive(r.pid) : now - Date.parse(r.startedAt) < BIND_WAIT_MIN * 60_000))
    .map((r) => ({ sessionId: r.sessionId || null, name: null, pid: r.pid || null, ticket: r.ticket, pending: true }));
}

/** Where a ticket's worktree goes: next to the main checkout, named <folder>-tck-<n>, on loop/tck-<n>. */
export function worktreeFor(main, key) {
  const n = key.slice(4);
  return { main, path: path.join(path.dirname(main), `${path.basename(main)}-tck-${n}`), branch: `loop/tck-${n}` };
}

/** The worktree folder's state, with a reason when it cannot be used for this ticket. */
export function worktreeState(plan) {
  const list = worktrees(plan.main);
  const here = list.find((w) => real(w.path) === real(plan.path));
  const branchAt = list.find((w) => w.branch === plan.branch);
  const branchExists = git(plan.main, ['rev-parse', '--verify', '--quiet', `refs/heads/${plan.branch}`]).ok;
  const state = { ...plan, exists: lexists(plan.path), branchExists };
  if (!state.exists) {
    if (branchAt) return { ...state, reason: { code: 'branch-elsewhere', text: `${plan.branch} is checked out in ${branchAt.path}` } };
    return state;
  }
  if (!here) return { ...state, reason: { code: 'folder-taken', text: `${plan.path} exists but is not a worktree of ${plan.main}` } };
  if (here.branch !== plan.branch) return { ...state, reason: { code: 'wrong-branch', text: `${plan.path} is on ${here.branch || 'a detached HEAD'}, not ${plan.branch}` } };
  const st = git(plan.path, ['status', '--porcelain', '--untracked-files=no', '--ignore-submodules=untracked']);
  if (!st.ok) return { ...state, reason: { code: 'dirty', text: `git status failed in ${plan.path}` } };
  if (st.out) return { ...state, reason: { code: 'dirty', text: `${plan.path} has uncommitted changes to tracked files` } };
  return state;
}

/** The Chief's own session id: --session, else the session of --self-pid or of the claude process this runs under. */
function selfSession(args, deps) {
  if (args.session) return args.session;
  const pid = args.selfPid || selfSessionPid(deps.ps());
  return pid ? sessionOfPid(pid, deps) : null;
}

export async function check(args, deps) {
  const reasons = [];
  const add = (code, text) => reasons.push({ code, text });
  const key = typeof args.ticket === 'string' ? args.ticket : '';
  if (!TICKET_KEY_RE.test(key)) {
    add('bad-key', 'the ticket must be TCK- and a number, like TCK-1974');
    return { ok: false, ticket: { key: null }, reasons };
  }
  const main = mainCheckout(args.repo || DEFAULT_REPO);
  if (!main) {
    add('no-repo', `${args.repo || DEFAULT_REPO} is not a git checkout`);
    return { ok: false, ticket: { key }, reasons };
  }
  const cfg = loadStartConfig();
  if (cfg.error) add('config', cfg.error);
  const max = Number.isInteger(args.max) ? args.max : cfg.config ? cfg.config.maxSessions : DEFAULTS.maxSessions;

  const board = await loadBoard(deps);
  const ticket = { key, status: null, bound: null };
  if (!board) add('board-unknown', 'the ticket lists could not be read');
  else {
    const row = board.rows.find((t) => t.key === key);
    if (!row) add(board.truncated ? 'board-truncated' : 'not-found', board.truncated ? `${key} is not in the lists, and a list was full` : `${key} is not on the board`);
    else {
      Object.assign(ticket, { status: row.status, bound: row.bound });
      if (CLOSED_STATUSES.includes(row.status)) add('closed', `${key} is ${row.status}: a closed ticket never starts`);
      else if (!STARTABLE.includes(row.status)) add('started', `${key} is at ${row.status}, past Planning: its work has started`);
      if (row.bound && !CLOSED_STATUSES.includes(row.status)) add('bound', `${key} is bound to session ${row.bound.slice(0, 8)}`);
    }
  }

  const selfSid = selfSession(args, deps);
  const pause = selfSid ? await deps.get(`/api/mcp/coordination/inbox?session=${encodeURIComponent(selfSid)}&limit=1`) : null;
  const paused = pause && pause.pause ? Boolean(pause.pause.paused) : null;
  if (paused === null) add('pause-unknown', selfSid ? 'the owner\'s pause could not be read' : 'the Chief\'s own session was not found, so its pause could not be read');
  else if (paused) add('paused', 'the owner paused the sessions ("Pause all")');

  // A ticket is started once. A gone session is never started again, and neither is a start that found no session:
  // its tab may still wait at a dialog. The owner removes the record to allow another start.
  const before = readStarted().find((rec) => rec.ticket === key);
  if (before) add('started-before', `a session was started for ${key} at ${before.startedAt}, and the Chief never starts a ticket twice: remove ${path.join(startedDir(), `${key}.json`)} to allow another start`);

  const agents = deps.agents();
  let inUse = null;
  if (!Array.isArray(agents)) add('agents-unknown', '`claude agents --json` could not be read');
  else if (board) {
    const bound = sessionsInUse(agents, board.rows, selfSid, deps.alive);
    inUse = [...bound, ...pendingStarts(readStarted(), bound, board.rows, deps.alive, deps.now())];
    if (inUse.length >= max) add('limit', `${inUse.length} ticket sessions run, and the limit is ${max}`);
  }

  const wt = worktreeState(worktreeFor(main, key));
  if (wt.reason) add(wt.reason.code, wt.reason.text);
  const { reason, ...worktree } = wt;
  return { ok: reasons.length === 0, ticket, worktree, slots: { used: inUse ? inUse.length : null, max, sessions: inUse || [] }, paused, self: selfSid || null, reasons };
}

/** Creates the ticket's worktree (see the header). Any failed step stops it, with what was done so far. */
export async function prepare(args, deps) {
  const c = await check(args, deps);
  const steps = [];
  const blocking = c.reasons.filter((r) => !SESSION_ONLY.includes(r.code));
  if (blocking.length) return { prepared: false, why: blocking.map((r) => r.text).join('; '), check: c, steps };
  const wt = c.worktree;
  const stop = (why) => ({ prepared: false, why, check: c, steps });
  if (!wt.exists) {
    const f = git(wt.main, ['fetch', '-q', 'origin', 'main'], deps.gitEnv);
    if (!f.ok) return stop(`git fetch origin main failed: ${f.err.slice(0, 200)}`);
    const base = git(wt.main, ['rev-parse', 'origin/main']).out;
    const add = wt.branchExists ? git(wt.main, ['worktree', 'add', '-q', wt.path, wt.branch], deps.gitEnv) : git(wt.main, ['worktree', 'add', '-q', '--no-track', '-b', wt.branch, wt.path, 'origin/main'], deps.gitEnv);
    if (!add.ok) return stop(`git worktree add failed: ${add.err.slice(0, 200)}`);
    steps.push(wt.branchExists ? `created ${wt.path} on the existing ${wt.branch}` : `created ${wt.path} on ${wt.branch} from origin/main ${base.slice(0, 8)}`);
  }
  const sub = path.join(wt.path, MCP_DIR);
  const named = git(wt.path, ['config', '--file', '.gitmodules', '--get', `submodule.${MCP_DIR}.path`]);
  if (named.ok && named.out === MCP_DIR && !lexists(path.join(sub, '.git'))) {
    const s = git(wt.path, ['submodule', 'update', '--init', MCP_DIR], deps.gitEnv);
    if (!s.ok) return stop(`git submodule update --init ${MCP_DIR} failed: ${s.err.slice(0, 200)}`);
    steps.push(`initialised the ${MCP_DIR} submodule`);
  }
  if (lexists(path.join(sub, '.git')) && !git(sub, ['rev-parse', '--verify', '--quiet', `refs/heads/${wt.branch}`]).ok) {
    const b = git(sub, ['checkout', '-q', '-b', wt.branch], deps.gitEnv);
    if (!b.ok) return stop(`the submodule branch ${wt.branch} could not be made: ${b.err.slice(0, 200)}`);
    steps.push(`made ${wt.branch} in the submodule`);
  }
  for (const rel of LINKS) {
    const from = path.join(wt.main, rel);
    const to = path.join(wt.path, rel);
    // Only what the main checkout has; never over anything already in the worktree.
    if (!lexists(from) || lexists(to) || !fs.existsSync(path.dirname(to))) continue;
    try { fs.symlinkSync(from, to); } catch (e) { return stop(`linking ${rel} failed: ${e.message}`); }
    steps.push(`linked ${rel}`);
  }
  return { prepared: true, created: !wt.exists, path: wt.path, branch: wt.branch, head: git(wt.path, ['rev-parse', 'HEAD']).out, steps };
}

/** A prompt for --prompt: one line of 1 to 300 characters, without control characters. */
export const promptOk = (p) => typeof p === 'string' && p.length >= 1 && p.length <= PROMPT_MAX && !/[\u0000-\u001f\u007f\u2028\u2029]/.test(p);

/** The line the new tab's shell runs: every word quoted for the shell. */
export function launchLine(folder, key, claudeArgs, prompt) {
  return ['cd', shq(folder), '&&', 'claude', ...claudeArgs.map(shq), '-n', shq(`tck-${key.slice(4)}`), shq(prompt)].join(' ');
}

/**
 * Opens a new tab in the window that holds the Chief's own tab (found by its tty), names it, runs the
 * line, and selects again the tab that was in front of that window. Returns "<unique id>\x1f<tty>" of
 * the new session, or "" when no iTerm2 session has the Chief's tty.
 */
export const openTabScript = (chiefTty, title, line) => `tell application "iTerm2"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if (tty of s) is "${escA(chiefTty)}" then
          set prevTab to current tab of w
          tell w
            set newTab to (create tab with default profile)
            tell current session of newTab
              set name to "${escA(title)}"
              write text "${escA(line)}"
              set res to (unique id) & (character id 31) & (tty)
            end tell
          end tell
          select prevTab
          return res
        end if
      end repeat
    end repeat
  end repeat
  return ""
end tell`;
/** One key into a session by its unique id: Down is ESC [ B, Enter is a bare write. */
export const keyScript = (uid, key) => `tell application "iTerm2"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if ((unique id of s) as text) is "${escA(uid)}" then
          ${key === 'down' ? 'write s text ((character id 27) & "[B") newline no' : 'write s text ""'}
          return "sent"
        end if
      end repeat
    end repeat
  end repeat
  return "gone"
end tell`;

/** The trust dialog in a pane, for one folder: 'no-chosen', 'yes-chosen', 'other-folder', or null (not shown). */
export function trustDialog(pane, folder) {
  const text = String(pane || '');
  const flat = (s) => s.replace(/\s+/g, '');
  // A narrow tab wraps the question and a long path: compare both without white space.
  if (!flat(text).includes(flat(TRUST_QUESTION))) return null;
  // The folder is the block of lines between "Accessing workspace:" and "Quick safety check". It must BE this folder
  // (Claude Code may write the home folder as ~), never merely contain it: a subfolder or a longer sibling is another folder.
  const ls = text.split('\n');
  const head = ls.findIndex((l) => l.includes(TRUST_HEAD));
  const end = ls.findIndex((l, i) => i > head && flat(l).startsWith(flat(TRUST_CHECK)));
  if (head < 0 || end < 0) return 'other-folder';
  const shown = flat(ls.slice(head + 1, end).join(''));
  const home = os.homedir();
  const mine = [folder, folder.startsWith(`${home}/`) ? `~${folder.slice(home.length)}` : null].filter(Boolean).map(flat);
  if (!mine.includes(shown)) return 'other-folder';
  return TRUST_YES_CHOSEN.test(text) ? 'yes-chosen' : 'no-chosen';
}

/** The live session whose folder is `folder` and that started at or after `since`, from ~/.claude/sessions/. */
export function sessionIn(folder, since, deps) {
  const dir = path.join(deps.configDir(), 'sessions');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /^\d+\.json$/.test(n)); } catch { return null; }
  const want = real(folder);
  const hits = names.map((n) => readJson(path.join(dir, n))).filter((s) => s && Number.isInteger(s.pid) && typeof s.sessionId === 'string' && typeof s.cwd === 'string' && real(s.cwd) === want && Number(s.startedAt) >= since && deps.alive(s.pid));
  return hits.sort((a, b) => Number(b.startedAt) - Number(a.startedAt))[0] || null;
}

function writeRecord(rec) {
  fs.mkdirSync(startedDir(), { recursive: true });
  const file = path.join(startedDir(), `${rec.ticket}.json`);
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(rec, null, 2)}\n`);
  fs.renameSync(`${file}.tmp`, file);
  return file;
}

/** Starts a session for the ticket (see the header). Each step that fails stops it, with the steps done so far. */
/**
 * One start at a time (the check, the worktree, the tab and the record are one step): an exclusive lock file in
 * started/. A lock whose process is gone, or that is older than LOCK_STALE_MS, is taken over. Returns {release} or {why}.
 */
export function takeStartLock(deps) {
  const file = startLockFile();
  const mine = JSON.stringify({ pid: process.pid, at: deps.now() });
  try { fs.mkdirSync(startedDir(), { recursive: true }); } catch (e) { return { why: `the start lock could not be made: ${e.message}` }; }
  for (let i = 0; i < 2; i++) {
    try {
      fs.writeFileSync(file, mine, { flag: 'wx' });
      return { release: () => { try { if (fs.readFileSync(file, 'utf8') === mine) fs.rmSync(file); } catch { /* already gone */ } } };
    } catch (e) {
      if (e.code !== 'EEXIST') return { why: `the start lock could not be made: ${e.message}` };
      const held = readJson(file);
      const live = held && Number.isInteger(held.pid) && held.pid > 0 && deps.alive(held.pid) && deps.now() - Number(held.at) <= LOCK_STALE_MS;
      if (live) return { why: `another start runs now (pid ${held.pid}): try again on the next pass` };
      try { fs.rmSync(file); } catch { /* taken by another start meanwhile: the next try sees it */ }
    }
  }
  return { why: 'the start lock could not be taken' };
}

export async function start(args, deps) {
  const steps = [];
  const stop = (why, extra = {}) => ({ started: false, why, steps, ...extra });
  const prompt = args.prompt === undefined ? `/cc-loop ${args.ticket}` : args.prompt;
  if (!promptOk(prompt)) return stop('the prompt must be one line of 1 to 300 characters');
  const lock = takeStartLock(deps);
  if (!lock.release) return stop(lock.why, { busy: true });
  try {
    return await startLocked(args, deps, { steps, stop, prompt });
  } finally {
    lock.release();
  }
}

async function startLocked(args, deps, { steps, stop, prompt }) {
  const cfg = loadStartConfig();
  const c = await check(args, deps);
  if (!c.ok) return stop(c.reasons.map((r) => r.text).join('; '), { check: c });
  const p = await prepare(args, deps);
  steps.push(...p.steps);
  if (!p.prepared) return stop(p.why);
  const chiefPid = args.selfPid || selfSessionPid(deps.ps());
  const tty = chiefPid ? deps.ttyOf(chiefPid) : null;
  if (!tty) return stop('the Chief\'s own terminal was not found, so no tab was opened');
  const folder = real(p.path);
  const line = launchLine(folder, args.ticket, cfg.config.claudeArgs, prompt);
  const t0 = deps.now();
  const rec = { ticket: args.ticket, path: folder, branch: p.branch, head: p.head, prompt, claudeArgs: cfg.config.claudeArgs, by: c.self, startedAt: new Date(t0).toISOString(), iterm: null, trust: 'not shown', sessionId: null, pid: null, found: false };
  const opened = deps.iterm.open(tty, `tck-${args.ticket.slice(4)}`, line);
  const [uid, newTty] = String(opened || '').split(String.fromCharCode(31));
  if (!uid) return stop('iTerm2 did not open the tab: no iTerm2 session has the Chief\'s terminal');
  rec.iterm = { uid, tty: newTty || null };
  steps.push(`opened the iTerm2 tab tck-${args.ticket.slice(4)} running: ${line}`);
  const file = writeRecord(rec);
  let downAt = null;
  let session = null;
  while (deps.now() - t0 < START_WAIT_MS) {
    await deps.sleep(1000);
    const pane = deps.iterm.pane(uid);
    const dialog = trustDialog(pane, folder);
    if (dialog === 'other-folder') { writeRecord({ ...rec, trust: 'other folder' }); return stop('the trust dialog names another folder, so nothing was pressed', { record: file }); }
    if (dialog === 'no-chosen') {
      if (downAt === null) { deps.iterm.key(uid, 'down'); downAt = deps.now(); steps.push('the folder-trust dialog showed "No, exit": pressed Down'); } else if (deps.now() - downAt > TRUST_MOVE_MS) {
        writeRecord({ ...rec, trust: 'not accepted' });
        return stop('the trust dialog did not move to "Yes, I trust this folder", so Enter was not pressed', { record: file });
      }
      continue;
    }
    if (dialog === 'yes-chosen') {
      if (rec.trust !== 'accepted') { deps.iterm.key(uid, 'enter'); rec.trust = 'accepted'; steps.push('"Yes, I trust this folder" is chosen: pressed Enter'); }
      continue;
    }
    // The session file can appear before the dialog is drawn: wait for Claude Code's own prompt box.
    if (composerText(pane) === null) continue;
    session = sessionIn(folder, t0 - 5000, deps);
    if (session) break;
  }
  if (!session) { writeRecord(rec); return stop(`no session appeared in ${folder} within ${START_WAIT_MS / 1000} s`, { record: file }); }
  Object.assign(rec, { sessionId: session.sessionId, pid: session.pid, found: true, name: session.name || null });
  writeRecord(rec);
  steps.push(`found the session ${session.sessionId.slice(0, 8)} (pid ${session.pid}) in ${folder}`);
  return { started: true, ticket: args.ticket, sessionId: session.sessionId, pid: session.pid, path: folder, branch: p.branch, trust: rec.trust, record: file, steps };
}

/** Each started session with its live state, and what needs the owner. */
export async function list(args, deps) {
  const records = readStarted();
  const board = await loadBoard(deps);
  const now = deps.now();
  const rows = records.map((r) => {
    const t = board ? board.rows.find((x) => x.key === r.ticket) : null;
    const alive = Number.isInteger(r.pid) && r.pid > 0 ? deps.alive(r.pid) : false;
    const s = alive ? readJson(path.join(deps.configDir(), 'sessions', `${r.pid}.json`)) : null;
    const status = !alive ? (r.found ? 'gone' : 'not found') : s && s.sessionId === r.sessionId ? s.status || 'unknown' : 'unknown';
    const ticketStatus = board ? (t ? t.status : 'not-on-board') : null;
    const holds = Boolean(t && r.sessionId && t.bound === r.sessionId);
    const ageMin = Math.floor((now - Date.parse(r.startedAt)) / 60_000);
    const open = ticketStatus !== null && !CLOSED_STATUSES.includes(ticketStatus);
    let needsYou = null;
    if (open && alive && !holds && ageMin >= BIND_WAIT_MIN) needsYou = `${r.ticket} is not bound by its session after ${ageMin} minutes`;
    else if (open && !alive && r.found) needsYou = `the session of ${r.ticket} is gone, and the ticket is still ${ticketStatus}`;
    else if (open && !r.found && ageMin >= BIND_WAIT_MIN) needsYou = `no session was found for ${r.ticket}`;
    return { ticket: r.ticket, sessionId: r.sessionId, name: s ? s.name || null : r.name || null, alive, status, ticketStatus, holdsTicket: holds, startedAt: r.startedAt, ageMin, path: r.path, needsYou };
  });
  return { rows, board: board ? 'read' : 'unknown' };
}

const osaRun = (script) => execFileSync('osascript', ['-e', script], { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'ignore'] });

export function realDeps(args = {}) {
  return {
    get: apiGet,
    agents: () => loadAgents(args.agents),
    alive: (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } },
    ps: loadPs,
    configDir,
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    ttyOf: (pid) => { const r = spawnSync('ps', ['-o', 'tty=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 }); const t = (r.stdout || '').trim(); return r.status === 0 && t && t !== '??' ? `/dev/${t}` : null; },
    iterm: {
      open: (tty, title, line) => { try { return osaRun(openTabScript(tty, title, line)).trim(); } catch { return ''; } },
      pane: (uid) => { try { return osaRun(paneScript(uid)); } catch { return ''; } },
      key: (uid, key) => { try { return osaRun(keyScript(uid, key)).trim(); } catch { return 'error'; } },
    },
  };
}

export function render(cmd, r) {
  if (cmd === 'start') return [r.started ? `started ${r.ticket}: session ${r.sessionId.slice(0, 8)} (pid ${r.pid}) in ${r.path}, folder trust ${r.trust}` : `not started: ${r.why}`, ...r.steps.map((s) => `  ${s}`)].join('\n');
  if (cmd === 'list') {
    if (!r.rows.length) return 'No session was started by the Chief.';
    return r.rows.map((x) => `${x.ticket} ${x.name || (x.sessionId ? x.sessionId.slice(0, 8) : 'no session')} ${x.status} · ticket ${x.ticketStatus || 'unknown'}${x.holdsTicket ? ', held by it' : ''} · started ${x.ageMin} min ago${x.needsYou ? `\n  needs you: ${x.needsYou}` : ''}`).join('\n');
  }
  if (cmd === 'check') {
    const head = r.ok ? `${r.ticket.key} can start now` : `${r.ticket.key || 'the ticket'} cannot start now`;
    const slots = r.slots && r.slots.used !== null ? ` (${r.slots.used} of ${r.slots.max} ticket sessions run)` : '';
    return [`${head}${slots}`, ...r.reasons.map((x) => `  no: ${x.text}`), ...(r.worktree ? [`  worktree: ${r.worktree.path} (${r.worktree.exists ? 'exists' : 'not made yet'}), branch ${r.worktree.branch}`] : [])].join('\n');
  }
  return r.prepared ? [`prepared ${r.path} on ${r.branch} at ${String(r.head).slice(0, 8)}`, ...r.steps.map((s) => `  ${s}`)].join('\n') : [`not prepared: ${r.why}`, ...r.steps.map((s) => `  ${s}`)].join('\n');
}

// ── selftest ─────────────────────────────────────────────────────────────────

async function selftest() {
  let failed = 0;
  const eq = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
  };
  const codes = (r) => r.reasons.map((x) => x.code);

  // The copies still match coord-scan.mjs.
  const mine = fs.readFileSync(SELF, 'utf8');
  const scanText = fs.readFileSync(path.join(HERE, 'coord-scan.mjs'), 'utf8');
  for (const name of COPIED_FROM_SCAN) {
    const a = sourceOf(mine, name);
    eq(`the copy of ${name} matches coord-scan.mjs`, Boolean(a) && a === sourceOf(scanText, name), true);
  }

  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coord-start-test-')));
  const cfg = path.join(root, 'claude');
  const savedCfg = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = cfg;
  // The selftest's submodule is a local folder: git refuses file:// submodules unless told.
  const gitEnv = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'protocol.file.allow', GIT_CONFIG_VALUE_0: 'always' };
  const sh = (cwd, ...a) => { const r = git(cwd, a, gitEnv); if (!r.ok) throw new Error(`git ${a.join(' ')}: ${r.err}`); return r.out; };
  const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  let server = null;
  try {
    // An MCP package repository, a remote, and a main checkout that holds the package as a submodule.
    const mcp = path.join(root, 'mcp');
    const remote = path.join(root, 'remote.git');
    const repo = path.join(root, 'repo');
    for (const d of [mcp, repo]) { fs.mkdirSync(d); sh(d, 'init', '-q', '-b', 'main'); sh(d, 'config', 'user.email', 't@t'); sh(d, 'config', 'user.name', 't'); sh(d, 'config', 'commit.gpgsign', 'false'); }
    write(path.join(mcp, 'package.json'), '{ "version": "2.19.0" }\n'); sh(mcp, 'add', '-A'); sh(mcp, 'commit', '-q', '-m', 'mcp');
    sh(root, 'init', '-q', '--bare', remote);
    write(path.join(repo, 'src', 'x.ts'), 'export const x = 1;\n');
    write(path.join(repo, 'src', 'backend', 'b.ts'), 'export const b = 1;\n');
    write(path.join(repo, 'src', 'frontend', 'f.ts'), 'export const f = 1;\n');
    sh(repo, 'submodule', 'add', '-q', mcp, MCP_DIR);
    sh(repo, 'add', '-A'); sh(repo, 'commit', '-q', '-m', 'base');
    sh(repo, 'remote', 'add', 'origin', remote); sh(repo, 'push', '-q', 'origin', 'main');
    // A commit on the remote's main that the local main does not have yet: prepare must fetch it.
    const other = path.join(root, 'other');
    sh(root, 'clone', '-q', '-b', 'main', remote, other); sh(other, 'config', 'user.email', 't@t'); sh(other, 'config', 'user.name', 't'); sh(other, 'config', 'commit.gpgsign', 'false');
    write(path.join(other, 'src', 'y.ts'), 'export const y = 1;\n'); sh(other, 'add', '-A'); sh(other, 'commit', '-q', '-m', 'newer'); sh(other, 'push', '-q', 'origin', 'main');
    const newest = sh(other, 'rev-parse', 'HEAD');
    // What the loops link: installed packages and one .env (src/backend/.env is absent here).
    for (const d of ['node_modules', 'src/backend/node_modules', 'src/frontend/node_modules', `${MCP_DIR}/node_modules`]) fs.mkdirSync(path.join(repo, d), { recursive: true });
    write(path.join(repo, '.env'), 'X=1\n');

    // The board: TCK-1 created, TCK-2 planning, TCK-3 implementing (bound to sA), TCK-4 shipped,
    // TCK-5 planning but bound (sB), TCK-6..9 implementing (s6..s9), TCK-10 shipped but still naming s10.
    const board = [
      { key: 'TCK-1', work_status: 'created', bound_session_id: null },
      { key: 'TCK-2', work_status: 'planning', bound_session_id: null },
      { key: 'TCK-3', work_status: 'implementing', bound_session_id: 'sA-000000' },
      { key: 'TCK-4', work_status: 'shipped', bound_session_id: null },
      { key: 'TCK-5', work_status: 'planning', bound_session_id: 'sB-000000' },
      ...[6, 7, 8, 9].map((n) => ({ key: `TCK-${n}`, work_status: 'implementing', bound_session_id: `s${n}-000000` })),
      { key: 'TCK-10', work_status: 'shipped', bound_session_id: 's10-00000' },
      { key: 'not-a-key', work_status: 'created', bound_session_id: null },
    ];
    let lists = board;
    let pause = { pause: { paused: false } };
    let failList = null;
    const get = async (p) => {
      const m = /status=([a-z_]+)$/.exec(p);
      if (m) return failList === m[1] ? null : { issues: lists.filter((i) => i.work_status === m[1]) };
      if (p.startsWith('/api/mcp/coordination/inbox?session=')) return pause;
      return null;
    };
    const live = new Set([101, 102, 106, 107, 108, 109, 110, 200]);
    let agents = [{ pid: 101, sessionId: 'sA-000000', kind: 'interactive', name: 'a' }];
    const deps = { get, agents: () => agents, alive: (pid) => live.has(pid), ps: () => null, configDir: () => cfg, gitEnv, now: () => Date.now() };
    const base = { repo, session: 'chief-0000' };
    const run = (ticket, extra = {}) => check({ ...base, ticket, ...extra }, deps);

    let r = await run('TCK-1');
    eq('check: a created, unbound ticket with a free slot can start', [r.ok, r.reasons, r.ticket, r.slots.used, r.slots.max], [true, [], { key: 'TCK-1', status: 'created', bound: null }, 1, 4]);
    eq('check: the worktree goes next to the main checkout, on loop/tck-<n>', [r.worktree.path, r.worktree.branch, r.worktree.exists, r.worktree.branchExists], [path.join(root, 'repo-tck-1'), 'loop/tck-1', false, false]);
    eq('check: a planning ticket with no session can start', (await run('TCK-2')).ok, true);
    eq('check: a ticket not on the board', codes(await run('TCK-77')), ['not-found']);
    eq('check: a shipped ticket never starts', codes(await run('TCK-4')), ['closed']);
    eq('check: a shipped ticket that still names a session is closed, not bound', codes(await run('TCK-10')), ['closed']);
    // Every status, on a ticket no session holds (the bound-session SOP releases a binding and leaves the status).
    // The expected answers are written out here, never taken from this file's own lists, so a changed list is caught.
    const VERDICT = { created: [], planning: [], ready_to_implement: ['started'], implementing: ['started'], iterating: ['started'], ready_to_merge: ['started'], deploying: ['started'], shipped: ['closed'], merged: ['closed'], dropped: ['closed'] };
    const HOLDS_SLOT = { created: 0, planning: 1, ready_to_implement: 1, implementing: 1, iterating: 1, ready_to_merge: 1, deploying: 1, shipped: 0, merged: 0, dropped: 0 };
    for (const [s, want] of Object.entries(VERDICT)) {
      lists = [...board, { key: 'TCK-50', work_status: s, bound_session_id: null }];
      eq(`check: an unbound ticket at ${s}`, codes(await run('TCK-50')), want);
    }
    eq('check: the statuses are the server\'s ten', ALL_STATUSES, Object.keys(VERDICT));
    // A session counts toward the limit at every open status of its ticket, and at no other.
    for (const [s, want] of Object.entries(HOLDS_SLOT)) {
      lists = [...board.filter((t) => t.key !== 'TCK-3'), { key: 'TCK-60', work_status: s, bound_session_id: 'sA-000000' }];
      eq(`check: a live session whose ticket is at ${s} takes ${want} slot`, (await run('TCK-1')).slots.used, want);
    }
    lists = board;
    eq('check: a ticket past Planning has started, and its session holds it', codes(await run('TCK-3')), ['started', 'bound']);
    eq('check: a planning ticket bound to a session', codes(await run('TCK-5')), ['bound']);
    for (const bad of ['TCK-0', 'tck-1', 'TCK-01', 'TCK-1 ', 'TCK-1;rm', 'TCK-1\u0000', 'TCK-1234567890', 'TCK-2147483648', '', 'TCK-１']) {
      eq(`check: the key ${JSON.stringify(bad)} is refused before any call`, codes(await run(bad)), ['bad-key']);
    }
    eq('check: TCK-999999999 is a key (9 digits), not on the board', codes(await run('TCK-999999999')), ['not-found']);
    eq('check: a missing --ticket is a bad key', codes(await check({ ...base }, deps)), ['bad-key']);
    eq('check: a folder that is not a git checkout', codes(await check({ ticket: 'TCK-1', repo: root, session: 'chief-0000' }, deps)), ['no-repo']);

    // The pause.
    pause = { pause: { paused: true } };
    eq('check: the owner\'s pause stops a start', codes(await run('TCK-1')), ['paused']);
    pause = null;
    eq('check: an unreadable pause stops a start (fail closed)', codes(await run('TCK-1')), ['pause-unknown']);
    pause = {};
    eq('check: an inbox reply with no pause field is unreadable too', codes(await run('TCK-1')), ['pause-unknown']);
    pause = { pause: { paused: false } };
    eq('check: no Chief session means no pause to read', codes(await check({ repo, ticket: 'TCK-1' }, deps)), ['pause-unknown']);

    // The board and the sessions.
    failList = 'shipped';
    eq('check: one unreadable list stops a start, with no ticket verdict', codes(await run('TCK-1')), ['board-unknown']);
    failList = null;
    lists = [...board, ...Array.from({ length: LIST_LIMIT }, (_, i) => ({ key: `TCK-${5000 + i}`, work_status: 'merged', bound_session_id: null }))];
    eq('check: a full list makes a missing ticket unknown, not absent', codes(await run('TCK-77')), ['board-truncated']);
    lists = board;
    agents = null;
    eq('check: unreadable sessions stop a start', codes(await run('TCK-1')), ['agents-unknown']);
    const four = [101, 106, 107, 108].map((pid, i) => ({ pid, sessionId: ['sA-000000', 's6-000000', 's7-000000', 's8-000000'][i], kind: 'interactive' }));
    agents = four;
    r = await run('TCK-1');
    eq('check: 4 live sessions with open tickets fill the 4 slots', [codes(r), r.slots.used, r.slots.sessions.map((s) => s.ticket)], [['limit'], 4, ['TCK-3', 'TCK-6', 'TCK-7', 'TCK-8']]);
    r = await check({ ...base, session: 's8-000000', ticket: 'TCK-1' }, deps);
    eq('check: the Chief\'s own session is not counted', [codes(r), r.slots.used], [[], 3]);
    agents = [...four.slice(0, 3), { pid: 999, sessionId: 's9-000000', kind: 'interactive' }];
    eq('check: a session whose process is gone is not counted', codes(await run('TCK-1')), []);
    agents = [...four.slice(0, 3), { sessionId: 's9-000000', kind: 'background', state: 'running' }, { pid: 109, sessionId: 's9-000000', kind: 'background' }];
    eq('check: a background agent is not counted', codes(await run('TCK-1')), []);
    agents = [...four.slice(0, 3), { pid: 110, sessionId: 's10-00000', kind: 'interactive' }, { pid: 200, sessionId: 'free-0000', kind: 'interactive' }];
    eq('check: a session on a closed ticket, or on none, is not counted', [codes(await run('TCK-1')), (await run('TCK-1')).slots.used], [[], 3]);
    agents = four;
    eq('check: --max raises the limit', codes(await run('TCK-1', { max: 5 })), []);
    write(path.join(cfg, 'coord', 'start.json'), '{ "maxSessions": 2 }\n');
    agents = four.slice(0, 2);
    eq('check: start.json lowers the limit', [codes(await run('TCK-1')), (await run('TCK-1')).slots.max], [['limit'], 2]);
    eq('check: --max wins over start.json', codes(await run('TCK-1', { max: 3 })), []);
    for (const [text, why] of [['{ "maxSessions": 0 }', 'maxSessions 0'], ['{ "maxSessions": 2.5 }', 'a fraction'], ['{ "maxSessions": "4" }', 'a string'], ['{ "max": 4 }', 'an unknown field'], ['[4]', 'an array'], ['{ "claudeArgs": ["--chrome", "a\\u0007b"] }', 'a control character'], ['{ "claudeArgs": "--chrome" }', 'one string'], ['not json', 'not JSON']]) {
      write(path.join(cfg, 'coord', 'start.json'), text);
      eq(`check: a bad start.json (${why}) stops a start`, codes(await run('TCK-1')).includes('config'), true);
    }
    eq('parseStartConfig: the defaults, and claudeArgs replaced whole', [loadStartConfig(path.join(root, 'none.json')).config, parseStartConfig({ claudeArgs: ['--model', 'opus[1m]'] }).config], [{ maxSessions: 4, claudeArgs: ['--dangerously-skip-permissions', '--chrome'] }, { maxSessions: 4, claudeArgs: ['--model', 'opus[1m]'] }]);
    fs.rmSync(path.join(cfg, 'coord', 'start.json'));
    agents = [{ pid: 101, sessionId: 'sA-000000', kind: 'interactive' }];

    // prepare.
    eq('prepare: a shipped ticket gets no worktree', [(await prepare({ ...base, ticket: 'TCK-4' }, deps)).prepared, fs.existsSync(path.join(root, 'repo-tck-4'))], [false, false]);
    pause = { pause: { paused: true } };
    agents = four;
    let p = await prepare({ ...base, ticket: 'TCK-1' }, deps);
    const w1 = path.join(root, 'repo-tck-1');
    eq('prepare: the pause and the limit do not stop a worktree', [p.prepared, p.created, p.path], [true, true, w1]);
    pause = { pause: { paused: false } };
    agents = [{ pid: 101, sessionId: 'sA-000000', kind: 'interactive' }];
    eq('prepare: the worktree starts at the fetched origin/main, on loop/tck-1, with no upstream', [sh(w1, 'rev-parse', 'HEAD'), sh(w1, 'branch', '--show-current'), git(w1, ['rev-parse', '--abbrev-ref', 'loop/tck-1@{upstream}']).ok], [newest, 'loop/tck-1', false]);
    eq('prepare: the submodule is checked out on a branch of the same name', [fs.existsSync(path.join(w1, MCP_DIR, 'package.json')), sh(path.join(w1, MCP_DIR), 'branch', '--show-current')], [true, 'loop/tck-1']);
    const links = LINKS.map((rel) => { try { return fs.readlinkSync(path.join(w1, rel)); } catch { return null; } });
    eq('prepare: the packages and the .env are links to the main checkout; a file main lacks is not made', links, [...['node_modules', 'src/backend/node_modules', 'src/frontend/node_modules', `${MCP_DIR}/node_modules`, '.env'].map((rel) => path.join(repo, rel)), null]);
    eq('prepare: its steps say what it did', p.steps.map((s) => s.replace(root, '<root>')), [`created <root>/repo-tck-1 on loop/tck-1 from origin/main ${newest.slice(0, 8)}`, 'initialised the md-manager-mcp-server submodule', 'made loop/tck-1 in the submodule', 'linked node_modules', 'linked src/backend/node_modules', 'linked src/frontend/node_modules', `linked ${MCP_DIR}/node_modules`, 'linked .env']);
    const snapshot = () => JSON.stringify([sh(w1, 'rev-parse', 'HEAD'), sh(w1, 'status', '--porcelain'), sh(repo, 'worktree', 'list', '--porcelain'), sh(repo, 'branch', '--list'), LINKS.map((rel) => lexists(path.join(w1, rel)))]);
    const before = snapshot();
    p = await prepare({ ...base, ticket: 'TCK-1' }, deps);
    eq('prepare: a second run changes nothing', [p.prepared, p.created, p.steps, snapshot() === before], [true, false, [], true]);
    eq('check: the prepared, clean worktree is no reason', codes(await run('TCK-1')), []);
    write(path.join(w1, 'src', 'x.ts'), 'export const x = 2;\n');
    eq('check: uncommitted changes to tracked files block the start', codes(await run('TCK-1')), ['dirty']);
    eq('prepare: and block the worktree too', (await prepare({ ...base, ticket: 'TCK-1' }, deps)).prepared, false);
    sh(w1, 'checkout', '-q', '--', 'src/x.ts');
    write(path.join(w1, MCP_DIR, 'package.json'), '{ "version": "2.20.0" }\n');
    eq('check: an uncommitted change inside the MCP submodule blocks the start', codes(await run('TCK-1')), ['dirty']);
    sh(path.join(w1, MCP_DIR), 'checkout', '-q', '--', 'package.json');
    eq('check: the submodule\'s untracked node_modules link is no reason', [lexists(path.join(w1, MCP_DIR, 'node_modules')), codes(await run('TCK-1'))], [true, []]);
    // A worktree whose .git link is broken: git status fails, and that is a reason (fail closed).
    const w18 = path.join(root, 'repo-tck-18');
    sh(repo, 'worktree', 'add', '-q', '-b', 'loop/tck-18', w18, 'main');
    const dotGit = fs.readFileSync(path.join(w18, '.git'), 'utf8');
    fs.writeFileSync(path.join(w18, '.git'), 'gitdir: /nonexistent/coord-start-test\n');
    lists = [...board, { key: 'TCK-18', work_status: 'created', bound_session_id: null }];
    r = await run('TCK-18');
    eq('check: git status failing in the worktree is a reason', [codes(r), r.reasons[0] && r.reasons[0].text.startsWith('git status failed')], [['dirty'], true]);
    fs.writeFileSync(path.join(w18, '.git'), dotGit);
    lists = board;
    write(path.join(w1, 'scratch.txt'), 'untracked\n');
    eq('check: an untracked file is no reason', codes(await run('TCK-1')), []);
    fs.mkdirSync(path.join(root, 'repo-tck-2'));
    eq('check: a plain folder in the worktree\'s place', codes(await run('TCK-2')), ['folder-taken']);
    sh(repo, 'worktree', 'add', '-q', '-b', 'side', path.join(root, 'repo-tck-6'), 'main');
    lists = board.map((t) => (t.key === 'TCK-6' ? { ...t, work_status: 'created', bound_session_id: null } : t));
    eq('check: a worktree on another branch', codes(await run('TCK-6')), ['wrong-branch']);
    sh(repo, 'worktree', 'add', '-q', '-b', 'loop/tck-7', path.join(root, 'elsewhere-7'), 'main');
    lists = board.map((t) => (t.key === 'TCK-7' ? { ...t, work_status: 'planning', bound_session_id: null } : t));
    eq('check: the ticket\'s branch is checked out in another folder', codes(await run('TCK-7')), ['branch-elsewhere']);
    // prepare refuses on every reason of the ticket and of the worktree, and makes or links nothing.
    lists = board.map((t) => (t.key === 'TCK-6' ? { ...t, work_status: 'created', bound_session_id: null } : t.key === 'TCK-7' ? { ...t, work_status: 'planning', bound_session_id: null } : t));
    const untouched = (ticket) => { const f = worktreeFor(repo, ticket).path; return !lexists(path.join(f, 'node_modules')) && !lexists(path.join(f, '.env')); };
    // TCK-50 is started but held by no session, so 'started' is its only reason.
    lists = [...lists, { key: 'TCK-50', work_status: 'implementing', bound_session_id: null }];
    for (const [ticket, code] of [['TCK-2', 'folder-taken'], ['TCK-6', 'wrong-branch'], ['TCK-7', 'branch-elsewhere'], ['TCK-5', 'bound'], ['TCK-50', 'started'], ['TCK-77', 'not-found'], ['TCK-4', 'closed']]) {
      const q = await prepare({ ...base, ticket }, deps);
      eq(`prepare: refuses on ${code}, and links nothing`, [q.prepared, codes(q.check).includes(code), untouched(ticket), fs.existsSync(worktreeFor(repo, ticket).path) === ['TCK-2', 'TCK-6'].includes(ticket)], [false, true, true, true]);
    }
    failList = 'shipped';
    let q = await prepare({ ...base, ticket: 'TCK-19' }, deps);
    eq('prepare: refuses when the board cannot be read, and makes no folder', [q.prepared, codes(q.check), fs.existsSync(worktreeFor(repo, 'TCK-19').path)], [false, ['board-unknown'], false]);
    failList = null;
    lists = [...board, ...Array.from({ length: LIST_LIMIT }, (_, i) => ({ key: `TCK-${5000 + i}`, work_status: 'merged', bound_session_id: null }))];
    q = await prepare({ ...base, ticket: 'TCK-19' }, deps);
    eq('prepare: refuses when a full list hides the ticket, and makes no folder', [q.prepared, codes(q.check), fs.existsSync(worktreeFor(repo, 'TCK-19').path)], [false, ['board-truncated'], false]);
    lists = board;
    sh(repo, 'branch', 'loop/tck-8', 'main');
    lists = board.map((t) => (t.key === 'TCK-8' ? { ...t, work_status: 'created', bound_session_id: null } : t));
    p = await prepare({ ...base, ticket: 'TCK-8' }, deps);
    eq('prepare: an existing branch is checked out, not made again', [p.prepared, p.steps[0].replace(root, '<root>')], [true, 'created <root>/repo-tck-8 on the existing loop/tck-8']);
    lists = board;

    // ── start and list (INC-3) ──
    const rule = '─'.repeat(40);
    const named = (n) => `${'─'.repeat(30)} tck-${n} ─`;
    const dialog = (folder, yes) => ['─'.repeat(60), ' Accessing workspace: ', ' ', ` ${folder} `, ' ', ` Quick safety check: ${TRUST_QUESTION} (Like your own code...)`, ' ', `${yes ? '  ' : '❯ '}No, exit `, `${yes ? '❯ ' : '  '}Yes, I trust this folder `, ' ', ' Enter to confirm · Esc to cancel'].join('\n');
    const promptBox = (n) => ['▐▛███▜▌   Claude Code v2.1.309', '❯ /cc-loop TCK-1', named(n), '❯  ', rule, '  ⏵⏵ bypass permissions on · ← 1 agent'].join('\n');
    eq('trustDialog: not shown, another folder, No chosen, Yes chosen, a wrapped path', [trustDialog('a shell', '/x'), trustDialog(dialog('/other', false), '/x/y'), trustDialog(dialog('/x/y', false), '/x/y'), trustDialog(dialog('/x/y', true), '/x/y'), trustDialog(dialog('/very/long/pa\n th/end', false), '/very/long/path/end')], [null, 'other-folder', 'no-chosen', 'yes-chosen', 'no-chosen']);
    // The folder must BE the worktree: a subfolder, a longer sibling, a parent, or a pane without the folder block is another folder.
    eq('trustDialog: a subfolder, a longer sibling and a parent are other folders', [trustDialog(dialog('/w/repo-tck-1/src', false), '/w/repo-tck-1'), trustDialog(dialog('/w/repo-tck-19', false), '/w/repo-tck-1'), trustDialog(dialog('/w', false), '/w/repo-tck-1')], ['other-folder', 'other-folder', 'other-folder']);
    const home = os.homedir();
    eq('trustDialog: the home folder written as ~ is the same folder', trustDialog(dialog('~/temp/repo-tck-1', false), `${home}/temp/repo-tck-1`), 'no-chosen');
    eq('trustDialog: the question without the folder block is never this folder', trustDialog(`${TRUST_QUESTION}\n❯ No, exit\n  Yes, I trust this folder`, '/x'), 'other-folder');
    eq('trustDialog: the folder line without its "Accessing workspace:" header is not trusted (an unknown layout)', trustDialog([' /x ', ` Quick safety check: ${TRUST_QUESTION}`, '❯ No, exit', '  Yes, I trust this folder'].join('\n'), '/x'), 'other-folder');
    eq('trustDialog: a wrapped question is still seen', trustDialog(dialog('/x/y', false).replace(TRUST_QUESTION, 'Is this a project you created or one\n you trust?'), '/x/y'), 'no-chosen');
    // Real panes measured on Claude Code 2.1.309 (probe-out/pane-01.txt and accept-19.txt): the dialog, then the session.
    const realDialog = ['─'.repeat(134), ' Accessing workspace: ', ' ', ' /private/tmp/claude-501/x/scratchpad/probe-folder ', ' ', ' Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work ', ' from your team). If not, take a moment to review what\'s in this folder first. ', ' ', ' Claude Code\'ll be able to read, edit, and execute files here. ', ' ', ' Security guide ', ' ', ' ❯ No, exit ', '   Yes, I trust this folder ', ' ', ' Enter to confirm · Esc to cancel'].join('\n');
    eq('trustDialog on the real pane: this folder, a shorter name, and the folder above', [trustDialog(realDialog, '/private/tmp/claude-501/x/scratchpad/probe-folder'), trustDialog(realDialog, '/private/tmp/claude-501/x/scratchpad/probe-fold'), trustDialog(realDialog, '/private/tmp/claude-501/x/scratchpad')], ['no-chosen', 'other-folder', 'other-folder']);
    eq('composerText (coord-close.mjs) finds the prompt box of a named session (-n draws the name in its top rule)', composerText(promptBox(7)), '');
    eq('promptOk: one line of 1 to 300 characters', ['/cc-loop TCK-1', '', 'a\nb', 'a\u2028b', 'a\u0007', 'x'.repeat(300), 'x'.repeat(301)].map(promptOk), [true, false, false, false, false, true, false]);
    eq('launchLine: every word is quoted for the shell', launchLine("/a b/it's", 'TCK-5', ['--model', 'opus[1m]', '--chrome'], '/cc-loop TCK-5'), "cd '/a b/it'\\''s' && claude --model 'opus[1m]' --chrome -n tck-5 '/cc-loop TCK-5'");
    const tabScript = openTabScript('/dev/ttys042', 'tck-5', 'cd \'x\' && claude "a"');
    eq('openTabScript: the Chief\'s window by its tty, a named tab, the line, then the tab that was in front again', [tabScript.includes('if (tty of s) is "/dev/ttys042" then'), tabScript.includes('create tab with default profile'), tabScript.includes('set name to "tck-5"'), tabScript.includes('write text "cd \'x\' && claude \\"a\\""'), tabScript.indexOf('select prevTab') > tabScript.indexOf('write text'), /exec /.test(tabScript)], [true, true, true, true, true, false]);
    eq('keyScript: Down is ESC [ B with no newline; Enter is a bare write', [keyScript('U1', 'down').includes('write s text ((character id 27) & "[B") newline no'), keyScript('U1', 'enter').includes('write s text ""'), keyScript('U1', 'enter').includes('[B')], [true, true, false]);
    eq('keyScript: Enter is exactly a bare write, with its newline', [/\n\s*write s text ""\n\s*return "sent"/.test(keyScript('U1', 'enter')), keyScript('U1', 'enter').includes('newline no')], [true, false]);
    eq('openTabScript: the new tab opens in the window that holds the Chief\'s tab (tell w), never the front window', [/set prevTab to current tab of w\n\s*tell w\n\s*set newTab to \(create tab with default profile\)/.test(tabScript), tabScript.includes('current window')], [true, false]);

    let clock = Date.parse('2026-11-21T01:00:00Z');
    const opened = [];
    const keys = [];
    let panes = [''];
    const sessionsDir = path.join(cfg, 'sessions');
    const sessionFile = (pid, sid, folder, at) => write(path.join(sessionsDir, `${pid}.json`), JSON.stringify({ pid, sessionId: sid, cwd: folder, startedAt: at, kind: 'interactive', status: 'busy', name: 'tck' }));
    let onPane = null; // runs once, at the next pane read
    const sd = {
      ...deps, now: () => clock, sleep: async (ms) => { clock += ms; }, ps: () => null, ttyOf: (pid) => (pid === 4242 ? '/dev/ttys042' : null),
      iterm: { open: (tty, title, line) => { opened.push({ tty, title, line }); return `UID-${opened.length}\u001f/dev/ttys05${opened.length}`; }, pane: () => { if (onPane) { onPane(); onPane = null; } return panes.length > 1 ? panes.shift() : panes[0]; }, key: (uid, k) => { keys.push(k); return 'sent'; } },
    };
    lists = [...board, ...[11, 12, 13, 14, 15, 16, 17].map((n) => ({ key: `TCK-${n}`, work_status: 'created', bound_session_id: null }))];
    // A high limit, so the records of the earlier starts here never stop a later one; the limit has its own cases.
    const sargs = (ticket, extra = {}) => ({ ...base, ticket, selfPid: 4242, max: 20, ...extra });
    const w11 = path.join(root, 'repo-tck-11');
    // The session file is there before the dialog is drawn: start must still answer the dialog first.
    sessionFile(777, 'new-sess-11', w11, clock);
    live.add(777);
    // "Yes" stays on screen for two looks (the redraw lags): Enter is still pressed once.
    panes = ['chandler % cd …', dialog(w11, false), dialog(w11, false), dialog(w11, true), dialog(w11, true), promptBox(11)];
    // At the first look at the new tab, the record already holds the slot, and the start lock is held.
    let atFirstPane = null;
    onPane = () => { atFirstPane = { rec: readJson(path.join(cfg, 'coord', 'started', 'TCK-11.json')), lock: lexists(startLockFile()) }; };
    let s = await start(sargs('TCK-11'), sd);
    eq('start: the record is written as soon as the tab opens (found: false), under the start lock', [atFirstPane && atFirstPane.rec && atFirstPane.rec.found, atFirstPane && atFirstPane.rec && atFirstPane.rec.iterm.uid, atFirstPane && atFirstPane.lock], [false, 'UID-1', true]);
    eq('start: the lock is gone when the start ends', lexists(startLockFile()), false);
    const rec11 = readJson(path.join(cfg, 'coord', 'started', 'TCK-11.json'));
    eq('start: the dialog shows No: Down, then Enter only once Yes is chosen; the session is found by its folder', [s.started, keys, s.sessionId, s.pid, s.trust], [true, ['down', 'enter'], 'new-sess-11', 777, 'accepted']);
    eq('start: one tab in the Chief\'s window, named tck-11, running the /cc-loop line in the new worktree', [opened.length, opened[0].tty, opened[0].title, opened[0].line], [1, '/dev/ttys042', 'tck-11', `cd ${w11} && claude --dangerously-skip-permissions --chrome -n tck-11 '/cc-loop TCK-11'`]);
    eq('start: the record says what was started', [rec11.ticket, rec11.path, rec11.branch, rec11.prompt, rec11.by, rec11.sessionId, rec11.pid, rec11.found, rec11.trust, rec11.iterm], ['TCK-11', w11, 'loop/tck-11', '/cc-loop TCK-11', 'chief-0000', 'new-sess-11', 777, true, 'accepted', { uid: 'UID-1', tty: '/dev/ttys051' }]);
    eq('start: the worktree was made first', sh(w11, 'branch', '--show-current'), 'loop/tck-11');
    const young = (await list({}, sd)).rows.find((x) => x.ticket === 'TCK-11');
    eq('list: a session started minutes ago that has not bound its ticket yet needs nothing', [young.holdsTicket, young.ageMin < BIND_WAIT_MIN, young.needsYou], [false, true, null]);

    keys.length = 0;
    const w12 = path.join(root, 'repo-tck-12');
    panes = ['chandler % cd …', promptBox(12)];
    sessionFile(778, 'new-sess-12', w12, clock);
    live.add(778);
    s = await start(sargs('TCK-12', { prompt: 'Reply with the single word ready.' }), sd);
    eq('start: no dialog, nothing pressed; --prompt replaces the /cc-loop line', [s.started, keys, s.trust, opened[1].line.endsWith("-n tck-12 'Reply with the single word ready.'")], [true, [], 'not shown', true]);

    keys.length = 0;
    panes = [dialog('/somewhere/else', false)];
    s = await start(sargs('TCK-13'), sd);
    eq('start: a dialog that names another folder: nothing is pressed', [s.started, keys, /another folder/.test(s.why), readJson(path.join(cfg, 'coord', 'started', 'TCK-13.json')).trust], [false, [], true, 'other folder']);

    keys.length = 0;
    const w14 = path.join(root, 'repo-tck-14');
    panes = [dialog(w14, false)];
    s = await start(sargs('TCK-14'), sd);
    eq('start: the choice never moves to Yes: Down once, never Enter', [s.started, keys, /did not move/.test(s.why)], [false, ['down'], true]);

    keys.length = 0;
    panes = [promptBox(15)];
    // In TCK-15's folder: a session from before this start, and one whose process is gone. Neither is the new session.
    const w15 = path.join(root, 'repo-tck-15');
    sessionFile(779, 'old-sess-15', w15, clock - 10 * 60_000);
    live.add(779);
    sessionFile(780, 'dead-sess-15', w15, clock + 1000);
    // Also live, and not the new session: one in the same folder a minute before the start, and one in another folder after it.
    sessionFile(781, 'early-sess-15', w15, clock - 60_000);
    sessionFile(783, 'elsewhere-sess-15', path.join(root, 'elsewhere-15'), clock + 1000);
    live.add(781);
    live.add(783);
    const before15 = clock;
    s = await start(sargs('TCK-15'), sd);
    const rec15 = readJson(path.join(cfg, 'coord', 'started', 'TCK-15.json'));
    eq('start: no session in the folder within 90 s: not started, and the record says not found', [s.started, /no session appeared/.test(s.why), rec15.found, rec15.sessionId, clock - before15 >= 90_000], [false, true, false, null, true]);
    const young15 = (await list({}, sd)).rows.find((x) => x.ticket === 'TCK-15');
    eq('list: a start that found no session, minutes ago, needs nothing yet', [young15.status, young15.ageMin < BIND_WAIT_MIN, young15.needsYou], ['not found', true, null]);

    // The dialog is accepted, but no session appears: the record keeps the accepted trust, and says not found.
    keys.length = 0;
    lists = [...lists, { key: 'TCK-20', work_status: 'created', bound_session_id: null }, { key: 'TCK-21', work_status: 'created', bound_session_id: null }];
    const w20 = path.join(root, 'repo-tck-20');
    panes = [dialog(w20, false), dialog(w20, true), promptBox(20)];
    s = await start(sargs('TCK-20'), sd);
    const rec20 = readJson(path.join(cfg, 'coord', 'started', 'TCK-20.json'));
    eq('start: accepted, then no session: the record says accepted and not found', [s.started, keys, rec20.trust, rec20.found], [false, ['down', 'enter'], 'accepted', false]);
    // prepare fails after check passed (the remote cannot be fetched): no tab is opened.
    const openedBefore = opened.length;
    sh(repo, 'remote', 'set-url', 'origin', path.join(root, 'no-such-remote.git'));
    s = await start(sargs('TCK-21'), sd);
    eq('start: a failed prepare opens no tab', [s.started, /git fetch origin main failed/.test(s.why), opened.length], [false, true, openedBefore]);
    sh(repo, 'remote', 'set-url', 'origin', remote);
    s = await start(sargs('TCK-16', { max: 1 }), sd);
    eq('start: a refused check opens no tab and makes no worktree', [s.started, opened.length, fs.existsSync(path.join(root, 'repo-tck-16'))], [false, openedBefore, false]);
    s = await start(sargs('TCK-17', { selfPid: undefined }), sd);
    eq('start: without the Chief\'s terminal no tab is opened', [s.started, /terminal was not found/.test(s.why), opened.length], [false, true, openedBefore]);
    eq('start: a bad --prompt is refused before anything', [(await start(sargs('TCK-17', { prompt: 'a\nb' }), sd)).started, opened.length], [false, openedBefore]);

    // Pending starts hold a slot, and the same ticket is never started twice.
    r = await check(sargs('TCK-11'), sd);
    eq('check: a ticket whose started session has not bound it yet is not started again', [codes(r), r.reasons[0].text.includes(path.join(cfg, 'coord', 'started', 'TCK-11.json'))], [['started-before'], true]);
    eq('check: a start that found no session is not tried again (its tab may still wait at a dialog)', codes(await check(sargs('TCK-15'), sd)), ['started-before']);
    eq('prepare: and a started ticket gets no second worktree step', (await prepare(sargs('TCK-15'), sd)).prepared, false);
    r = await check(sargs('TCK-17'), sd);
    eq('check: started sessions not bound yet hold slots: sA + TCK-11 + TCK-12, and the 4 records with no session (under 10 min)', r.slots.used, 7);
    clock += 11 * 60_000;
    r = await check(sargs('TCK-17'), sd);
    eq('check: a record with no session stops counting after 10 minutes', [r.slots.used, r.slots.sessions.filter((x) => x.pending).map((x) => x.ticket)], [3, ['TCK-11', 'TCK-12']]);
    lists = lists.map((t) => (t.key === 'TCK-12' ? { ...t, work_status: 'shipped' } : t));
    r = await check(sargs('TCK-17'), sd);
    eq('check: a started session whose ticket closed holds no slot, even while it runs', [r.slots.used, r.slots.sessions.filter((x) => x.pending).map((x) => x.ticket)], [2, ['TCK-11']]);
    lists = lists.map((t) => (t.key === 'TCK-12' ? { ...t, work_status: 'created' } : t));
    live.delete(778);
    lists = lists.map((t) => (t.key === 'TCK-11' ? { ...t, work_status: 'planning', bound_session_id: 'new-sess-11' } : t));
    agents = [{ pid: 101, sessionId: 'sA-000000', kind: 'interactive' }, { pid: 777, sessionId: 'new-sess-11', kind: 'interactive' }];
    r = await check(sargs('TCK-17'), sd);
    eq('check: once bound, a started session counts once; a gone one not at all', [r.slots.used, r.slots.sessions.map((x) => `${x.ticket}${x.pending ? ' pending' : ''}`)], [2, ['TCK-3', 'TCK-11']]);
    eq('check: the ticket of a gone session is never started again (no automatic restart)', codes(await check(sargs('TCK-12'), sd)), ['started-before']);

    // list.
    let l = await list({}, sd);
    const byKey = Object.fromEntries(l.rows.map((x) => [x.ticket, x]));
    eq('list: one row per start, oldest first', l.rows.map((x) => x.ticket), ['TCK-11', 'TCK-12', 'TCK-13', 'TCK-14', 'TCK-15', 'TCK-20']);
    eq('list: a bound, alive session', [byKey['TCK-11'].alive, byKey['TCK-11'].status, byKey['TCK-11'].ticketStatus, byKey['TCK-11'].holdsTicket, byKey['TCK-11'].needsYou], [true, 'busy', 'planning', true, null]);
    eq('list: a gone session whose ticket is still open needs the owner', [byKey['TCK-12'].alive, byKey['TCK-12'].status, byKey['TCK-12'].needsYou], [false, 'gone', 'the session of TCK-12 is gone, and the ticket is still created']);
    eq('list: no session found after 10 minutes needs the owner', [byKey['TCK-15'].status, byKey['TCK-15'].needsYou], ['not found', 'no session was found for TCK-15']);
    lists = lists.map((t) => (t.key === 'TCK-11' ? { ...t, bound_session_id: null } : t.key === 'TCK-12' ? { ...t, work_status: 'shipped' } : t));
    l = await list({}, sd);
    const k2 = Object.fromEntries(l.rows.map((x) => [x.ticket, x]));
    eq('list: alive but not bound after 10 minutes needs the owner; a closed ticket needs nothing', [k2['TCK-11'].needsYou, k2['TCK-12'].needsYou], [`TCK-11 is not bound by its session after ${k2['TCK-11'].ageMin} minutes`, null]);
    lists = lists.map((t) => (t.key === 'TCK-11' ? { ...t, bound_session_id: 'someone-else' } : t));
    const k3 = Object.fromEntries((await list({}, sd)).rows.map((x) => [x.ticket, x]));
    eq('list: a ticket that another session holds is not held by the one we started', [k3['TCK-11'].holdsTicket, k3['TCK-11'].needsYou], [false, `TCK-11 is not bound by its session after ${k3['TCK-11'].ageMin} minutes`]);
    // The process id was reused: its session file now names another session, so its status is not ours to show.
    const f777 = path.join(sessionsDir, '777.json');
    const own777 = fs.readFileSync(f777, 'utf8');
    fs.writeFileSync(f777, JSON.stringify({ ...JSON.parse(own777), sessionId: 'another-session', status: 'busy' }));
    eq('list: a session file of another session under the same pid gives status unknown', (await list({}, sd)).rows.find((x) => x.ticket === 'TCK-11').status, 'unknown');
    fs.writeFileSync(f777, own777);
    failList = 'created';
    l = await list({}, sd);
    eq('list: an unreadable board leaves the ticket status unknown and names nothing', [l.board, l.rows.every((x) => x.ticketStatus === null && x.needsYou === null)], ['unknown', true]);
    failList = null;
    // Files in started/ that are not records are skipped: bad JSON, no start time, a bad key, a half-written .tmp.
    const sdir = path.join(cfg, 'coord', 'started');
    const goodKeys = readStarted().map((x) => x.ticket);
    fs.writeFileSync(path.join(sdir, 'TCK-90.json'), 'not json');
    fs.writeFileSync(path.join(sdir, 'TCK-91.json'), JSON.stringify({ ticket: 'TCK-91' }));
    fs.writeFileSync(path.join(sdir, 'TCK-92.json'), JSON.stringify({ ticket: 'bad', startedAt: new Date(clock).toISOString() }));
    fs.writeFileSync(path.join(sdir, 'TCK-93.json.tmp'), JSON.stringify({ ticket: 'TCK-93', startedAt: new Date(clock).toISOString(), pid: 101 }));
    fs.writeFileSync(path.join(sdir, 'notes.txt'), 'x');
    eq('readStarted: bad files are skipped, the good records stay', readStarted().map((x) => x.ticket), goodKeys);
    eq('list: no row for a bad file', (await list({}, sd)).rows.map((x) => x.ticket), goodKeys);

    // More starts, each one case: the newest of two sessions, start.json's flags, no tab, and the start lock.
    lists = [...board, ...[22, 23, 24, 25].map((n) => ({ key: `TCK-${n}`, work_status: 'created', bound_session_id: null }))];
    agents = [{ pid: 101, sessionId: 'sA-000000', kind: 'interactive' }];
    const w22 = path.join(root, 'repo-tck-22');
    sessionFile(784, 'first-sess-22', w22, clock + 200);
    sessionFile(785, 'second-sess-22', w22, clock + 700);
    live.add(784); live.add(785);
    panes = [promptBox(22)];
    s = await start(sargs('TCK-22'), sd);
    eq('start: of two new sessions in the folder, the newest is the one', [s.started, s.pid, s.sessionId], [true, 785, 'second-sess-22']);
    write(path.join(cfg, 'coord', 'start.json'), JSON.stringify({ claudeArgs: ['--model', 'opus[1m]'] }));
    const w24 = path.join(root, 'repo-tck-24');
    sessionFile(786, 'sess-24', w24, clock + 100);
    live.add(786);
    s = await start(sargs('TCK-24'), sd);
    eq('start: the flags in start.json reach the launch line', [s.started, opened[opened.length - 1].line], [true, `cd ${w24} && claude --model 'opus[1m]' -n tck-24 '/cc-loop TCK-24'`]);
    fs.rmSync(path.join(cfg, 'coord', 'start.json'));
    const clockBefore23 = clock;
    s = await start(sargs('TCK-23'), { ...sd, iterm: { ...sd.iterm, open: () => '' } });
    eq('start: when iTerm2 opens no tab, it stops at once and writes no record', [s.started, /did not open the tab/.test(s.why), fs.existsSync(path.join(sdir, 'TCK-23.json')), clock - clockBefore23], [false, true, false, 0]);
    const lockText = JSON.stringify({ pid: 101, at: clock });
    fs.writeFileSync(startLockFile(), lockText);
    const openedAtLock = opened.length;
    s = await start(sargs('TCK-25'), sd);
    eq('start: another start that runs now (a live lock) is refused as busy; its lock is left alone', [s.started, s.busy, /another start runs now \(pid 101\)/.test(s.why), opened.length, fs.readFileSync(startLockFile(), 'utf8')], [false, true, true, openedAtLock, lockText]);
    fs.writeFileSync(startLockFile(), JSON.stringify({ pid: 999, at: clock }));
    const w25 = path.join(root, 'repo-tck-25');
    sessionFile(787, 'sess-25', w25, clock + 100);
    live.add(787);
    s = await start(sargs('TCK-25'), sd);
    eq('start: a lock whose process is gone is taken over, and removed at the end', [s.started, lexists(startLockFile())], [true, false]);
    fs.writeFileSync(startLockFile(), JSON.stringify({ pid: 101, at: clock - (LOCK_STALE_MS + 1000) }));
    eq('takeStartLock: a lock older than the longest start is taken over', typeof takeStartLock(sd).release, 'function');
    fs.rmSync(startLockFile(), { force: true });
    lists = board;
    agents = [{ pid: 101, sessionId: 'sA-000000', kind: 'interactive' }];
    fs.rmSync(path.join(cfg, 'coord', 'started'), { recursive: true, force: true });

    // --prove-read-only: check in a child process, against a local API that answers the lists and the inbox.
    server = http.createServer((req, res) => {
      const m = /status=([a-z_]+)$/.exec(req.url || '');
      const body = m ? { issues: board.filter((i) => i.work_status === m[1]) } : (req.url || '').startsWith('/api/mcp/coordination/inbox') ? { pause: { paused: false } } : {};
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const agentsFile = path.join(root, 'agents.json');
    write(agentsFile, JSON.stringify([{ pid: process.pid, sessionId: 'sA-000000', kind: 'interactive' }]));
    const runChild = (...a) => new Promise((ok) => {
      const c = spawn(process.execPath, [SELF, ...a, '--json', '--prove-read-only'], {
        env: { ...process.env, CLAUDE_CONFIG_DIR: cfg, NOESIS_API_URL: `http://127.0.0.1:${server.address().port}`, NOESIS_API_TOKEN: 'test-token' },
      });
      let out = '';
      c.stdout.on('data', (d) => { out += d; });
      c.on('close', (code) => ok({ code, out }));
    });
    const parsed = (c) => { try { return JSON.parse(c.out); } catch { return null; } };
    const child = await runChild('check', '--ticket', 'TCK-1', '--repo', repo, '--session', 'chief-0000', '--agents', agentsFile);
    const proof = parsed(child);
    eq('check --prove-read-only: the spy is on, no side effect, and the verdict is the same as in process', [child.code, proof && proof.readOnly.watched, proof && proof.readOnly.effects, proof && proof.ok, proof && proof.slots.used], [0, true, [], true, 1]);
    write(path.join(cfg, 'coord', 'started', 'TCK-2.json'), JSON.stringify({ ticket: 'TCK-2', startedAt: new Date().toISOString(), path: path.join(root, 'repo-tck-2'), sessionId: null, pid: null, found: false }));
    const listed = await runChild('list');
    const lp = parsed(listed);
    eq('list --prove-read-only: the spy is on, no side effect, one row', [listed.code, lp && lp.readOnly.watched, lp && lp.readOnly.effects, lp && lp.rows.map((x) => [x.ticket, x.ticketStatus, x.status])], [0, true, [], [['TCK-2', 'planning', 'not found']]]);
  } finally {
    if (server) server.close();
    if (savedCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = savedCfg;
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log(failed ? `${failed} FAILED` : 'all ok');
  return failed ? 1 : 0;
}

// ── main ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {};
  const [cmd, ...rest] = argv;
  args.cmd = cmd;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const val = () => { const v = rest[++i]; if (v === undefined) throw new Error(`${a} needs a value`); return v; };
    if (a === '--json') args.json = true;
    else if (a === '--prove-read-only') args.proveReadOnly = true;
    else if (a === '--ticket') args.ticket = val();
    else if (a === '--repo') args.repo = val();
    else if (a === '--session') args.session = val();
    else if (a === '--agents') args.agents = val();
    else if (a === '--prompt') { args.prompt = val(); if (!promptOk(args.prompt)) throw new Error('--prompt needs one line of 1 to 300 characters'); }
    else if (a === '--self-pid') { args.selfPid = Number(val()); if (!Number.isInteger(args.selfPid) || args.selfPid <= 0) throw new Error('--self-pid needs a process id'); }
    else if (a === '--max') { args.max = Number(val()); if (!Number.isInteger(args.max) || args.max < 1 || args.max > 20) throw new Error('--max needs a whole number from 1 to 20'); }
    else throw new Error(`unknown argument ${a}`);
  }
  return args;
}

const USAGE = 'usage: coord-start.mjs check --ticket TCK-<n> [--repo <main checkout>] [--max <n>] [--self-pid <pid> | --session <id>] [--agents <file>] [--json] [--prove-read-only] | prepare --ticket TCK-<n> [same options] [--json] | start --ticket TCK-<n> [same options] [--prompt <one line>] [--json] | list [--json] [--prove-read-only] | --selftest';
const COMMANDS = { check, prepare, start, list };
const READ_ONLY = ['check', 'list'];

async function main(argv) {
  if (argv[0] === '--selftest') return selftest();
  let args;
  try { args = parseArgs(argv); } catch (e) { console.error(`${e.message}\n${USAGE}`); return 2; }
  if (!Object.hasOwn(COMMANDS, args.cmd || '')) { console.error(USAGE); return 2; }
  if (args.proveReadOnly && !READ_ONLY.includes(args.cmd)) { console.error('--prove-read-only works with check and list only'); return 2; }
  if (args.prompt !== undefined && args.cmd !== 'start') { console.error('--prompt works with start only'); return 2; }
  const deps = realDeps(args);
  const effects = [];
  let watched = false;
  if (args.proveReadOnly) {
    await installReadOnlySpy(effects);
    // The proof means something only while the spy is on: one probe write must be refused. It is not counted.
    try { fs.writeFileSync(path.join(os.tmpdir(), `coord-start-probe-${process.pid}`), ''); } catch { watched = true; }
    effects.length = 0;
  }
  try {
    const r = await COMMANDS[args.cmd](args, deps);
    if (args.proveReadOnly) r.readOnly = { effects, watched };
    console.log(args.json ? JSON.stringify(r, null, 2) : render(args.cmd, r) + (args.proveReadOnly ? `\nread-only proof: ${watched ? '' : 'NOT WATCHED (the spy refused nothing), '}${effects.length} side effect${effects.length === 1 ? '' : 's'}${effects.map((e) => `\n  ${e}`).join('')}` : ''));
    if (effects.length || (args.proveReadOnly && !watched)) return 3;
    if (args.cmd === 'list') return 0;
    return (args.cmd === 'check' ? r.ok : args.cmd === 'prepare' ? r.prepared : r.started) ? 0 : 1;
  } catch (e) {
    console.error(`coord-start: ${e.message}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
