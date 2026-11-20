#!/usr/bin/env node
// coord-start.mjs — the Chief of Staff starts a Claude Code session for a ticket the owner handed it (TCK-1974).
// The Chief's rules are in skill-templates/noesis-chief.md, "Starting ticket sessions".
//
//   node coord-start.mjs check   --ticket TCK-<n> [--repo <main checkout>] [--max <n>] [--self-pid <pid> | --session <chief id>]
//                                [--agents <agents.json>] [--json] [--prove-read-only]
//   node coord-start.mjs prepare --ticket TCK-<n> [--repo <main checkout>] [same options as check] [--json]
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
// The limit and the launch flags are in ~/.claude/coord/start.json:
//   {"maxSessions": 4, "claudeArgs": ["--dangerously-skip-permissions", "--chrome"]}
// Both fields are optional; those values are the defaults. --max wins over maxSessions.

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CLOSED_STATUSES, apiGet, installReadOnlySpy, loadAgents, loadPs, selfSessionPid, sessionOfPid, sourceOf } from './coord-close.mjs';

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

  const agents = deps.agents();
  let inUse = null;
  if (!Array.isArray(agents)) add('agents-unknown', '`claude agents --json` could not be read');
  else if (board) {
    inUse = sessionsInUse(agents, board.rows, selfSid, deps.alive);
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

export function realDeps(args = {}) {
  return {
    get: apiGet,
    agents: () => loadAgents(args.agents),
    alive: (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } },
    ps: loadPs,
    configDir,
  };
}

export function render(cmd, r) {
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
    const deps = { get, agents: () => agents, alive: (pid) => live.has(pid), ps: () => null, configDir: () => cfg, gitEnv };
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
    const child = await new Promise((ok) => {
      const c = spawn(process.execPath, [SELF, 'check', '--ticket', 'TCK-1', '--repo', repo, '--session', 'chief-0000', '--agents', agentsFile, '--json', '--prove-read-only'], {
        env: { ...process.env, CLAUDE_CONFIG_DIR: cfg, NOESIS_API_URL: `http://127.0.0.1:${server.address().port}`, NOESIS_API_TOKEN: 'test-token' },
      });
      let out = '';
      c.stdout.on('data', (d) => { out += d; });
      c.on('close', (code) => ok({ code, out }));
    });
    let proof = null;
    try { proof = JSON.parse(child.out); } catch { /* reported below */ }
    eq('check --prove-read-only: the spy is on, no side effect, and the verdict is the same as in process', [child.code, proof && proof.readOnly.watched, proof && proof.readOnly.effects, proof && proof.ok, proof && proof.slots.used], [0, true, [], true, 1]);
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
    else if (a === '--self-pid') { args.selfPid = Number(val()); if (!Number.isInteger(args.selfPid) || args.selfPid <= 0) throw new Error('--self-pid needs a process id'); }
    else if (a === '--max') { args.max = Number(val()); if (!Number.isInteger(args.max) || args.max < 1 || args.max > 20) throw new Error('--max needs a whole number from 1 to 20'); }
    else throw new Error(`unknown argument ${a}`);
  }
  return args;
}

const USAGE = 'usage: coord-start.mjs check --ticket TCK-<n> [--repo <main checkout>] [--max <n>] [--self-pid <pid> | --session <id>] [--agents <file>] [--json] [--prove-read-only] | prepare --ticket TCK-<n> [same options] [--json] | --selftest';

async function main(argv) {
  if (argv[0] === '--selftest') return selftest();
  let args;
  try { args = parseArgs(argv); } catch (e) { console.error(`${e.message}\n${USAGE}`); return 2; }
  if (args.cmd !== 'check' && args.cmd !== 'prepare') { console.error(USAGE); return 2; }
  if (args.proveReadOnly && args.cmd !== 'check') { console.error('--prove-read-only works with check only'); return 2; }
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
    const r = args.cmd === 'check' ? await check(args, deps) : await prepare(args, deps);
    if (args.proveReadOnly) r.readOnly = { effects, watched };
    console.log(args.json ? JSON.stringify(r, null, 2) : render(args.cmd, r) + (args.proveReadOnly ? `\nread-only proof: ${watched ? '' : 'NOT WATCHED (the spy refused nothing), '}${effects.length} side effect${effects.length === 1 ? '' : 's'}${effects.map((e) => `\n  ${e}`).join('')}` : ''));
    if (effects.length || (args.proveReadOnly && !watched)) return 3;
    return args.cmd === 'check' ? (r.ok ? 0 : 1) : r.prepared ? 0 : 1;
  } catch (e) {
    console.error(`coord-start: ${e.message}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
