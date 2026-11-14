#!/usr/bin/env node
// coord-close.mjs — "Can this session close?" for the Chief of Staff (TCK-1930).
// The rules are in references/chief-conflict-catalogue.md, row C20.
//
//   node coord-close.mjs check [--session <id> | --pid <pid> | --all [--save]] [--closed <file>] [--repo <main checkout>]
//                              [--agents <agents.json>] [--npm-latest <version>] [--config-repo <claude-config>] [--json]
//   node coord-close.mjs record (--pid <pid> | --session <id>) --verdict yes|no [--left <text>]...
//   node coord-close.mjs candidates [--self-pid <pid>] [same options as check] [--json]
//   node coord-close.mjs ask --session <id> [--by-message] [same options as check] [--json]
//   node coord-close.mjs close --session <id> [same options as check] [--json]
//   node coord-close.mjs --selftest
//
// `check` gives each local interactive Claude Code session a verdict: yes, no or maybe. Each reason
// that keeps a session open names who fixes it: the Chief, the session or the owner. A machine-wide
// item that the session did not cause (an MCP version that is not on npm, an old main-checkout build)
// never blocks: it is listed under "after you close".
//
// Which ticket a session worked on comes from local evidence, because the server clears a ticket's
// binding when the ticket closes (backlogWorkStatus.ts, clearBinding(..., 'closed')): the ticket hook's
// cache file (~/.claude/tck-bindings/<session>.json keeps the key), the session's transcript (its
// backlog_bind and backlog_set_status calls, and the hook's "[tck-session] ... bound to TCK-<n>"
// lines), its loop registry file and loop state file, and a worktree named tck-<n>. The server then
// says whether that ticket is closed: --closed <file> ({"issues": [{key, work_status}]}, written by
// the Chief), else the list route, read once per status. A ticket is never read by its key: that
// GET stamps the ticket's agent activity, and the board would show every shipped ticket as active.
//
// `record` stores a session's own answer to "Can I close the session?" in
// ~/.claude/coord/close/<session-id>.json. A session runs it with --pid $PPID. The answer goes stale
// when a real owner prompt comes after it: hook text, a wakeup's prompt and a task notification do
// not count.
//
// `candidates` lists the sessions that can close now, in groups of at most 4 (one AskUserQuestion
// question holds at most 4 options). It never lists the Chief's own session (--self-pid), a
// background agent, or a session whose loop still runs.
//
// `check --all --save` also writes the result to ~/.claude/coord/close-check.json, with whether
// the Chief may ask each session now and which loop tabs no session owns. coord-scan.mjs reads that
// file and posts one C20 row per session, so the Chief's pass and the watcher's scan post the same rows.
//
// `ask` asks "Can I close the session?" once, only of an idle session whose ticket is Shipped, Merged
// or Dropped and that has not answered. It writes askedAt first, so a session is never asked twice.
// With --by-message it prints the line for the Chief to send with SendMessage (that wakes an idle
// session); otherwise it types the line into the session's iTerm2 tab.
//
// `close` closes one session that the owner chose: it stops while the owner's pause is in force or
// when the check says no (only the processes, the port slot and the tabs, which it fixes itself, let
// it go on). It stops the session's processes, releases its port slot, closes its sure-orphan tabs,
// types /exit once into an idle session with an empty prompt line, closes the iTerm2 session by its
// unique id when only shells run in it, reports the session as gone, and prints
// `claude --resume <id>`. It never closes the Chief's own session or a background agent.
//
// It only reads: `claude agents --json`, `ps`, `lsof`, git (with GIT_OPTIONAL_LOCKS=0), the files
// named above, the installed hook and skills, and `npm view`. Its API calls are GETs. Check and
// candidates write nothing; `record` and `ask` write only the session's file under
// ~/.claude/coord/close/, and --save only ~/.claude/coord/close-check.json. A fact it cannot read is a
// reason of its own, so a failure never reads as "yes": ps, lsof, `claude agents`, git, the ticket
// lists, the port slots and leases, and npm's version when the session's own commits changed the MCP.
// --prove-read-only (check and candidates) shows it: every side effect then throws and is listed
// (a writing command, a file write, a signal other than 0, a fetch that is not a GET), and the run
// exits 3 if there was one.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CLOSED_STATUSES = ['shipped', 'merged', 'dropped'];
const MCP_DIR = 'md-manager-mcp-server';
const MCP_PACKAGE = '@noesis-brain/mcp-server';
const HOOK_SCRIPT = 'noesis-ticket-session.mjs';
const TRANSCRIPT_TAIL_BYTES = 8 * 1024 * 1024;
const WAKEUP_MIN_S = 60;
const WAKEUP_MAX_S = 3600;
export const GROUP_SIZE = 4;
// A login or interactive shell is where the owner works; it is never a leftover to stop.
const SHELL_RE = /^-?(?:\/bin\/|\/usr\/bin\/|\/opt\/homebrew\/bin\/)?(?:zsh|bash|sh|fish|login)(?:\s|$)/;
const TICKET_RE = /^TCK-\d+$/;

// ── Copied verbatim from coord-scan.mjs (the selftest checks that each still matches) ─────────
// Working memory of loops and agents: never product files.
const IGNORED = [/(^|\/)[^/]*LOOP-STATE[^/]*\.md$/, /^loop-stack\//, /^\.loop\//, /^\.claude\/worktrees\//, /^\.claude-notes\//];

function git(cwd, args, env) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...(env || {}) }, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, code: r.status, out: (r.stdout || '').trim(), raw: r.stdout || '', err: (r.stderr || '').trim() };
}
const lines = (s) => s.split('\n').map((x) => x.trim()).filter(Boolean);
const keep = (f) => !IGNORED.some((re) => re.test(f));

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

function ticketNumberOf(wt) {
  const m = /(?:^|[/-])tck-(\d+)(?:$|[^\d])/i.exec(wt.branch || '') || /-tck-(\d+)$/i.exec(path.basename(wt.path));
  return m ? Number(m[1]) : null;
}

// The worktree that holds a path, or null. The longest matching worktree path wins.
function worktreeOf(dir, wts) {
  if (!dir) return null;
  const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
  const d = real(dir);
  return wts.filter((w) => d === real(w.path) || d.startsWith(real(w.path) + path.sep)).sort((a, b) => b.path.length - a.path.length)[0] || null;
}

function mcpVersion(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, MCP_DIR, 'package.json'), 'utf8')).version || null; } catch { return null; }
}

const verCmp = (a, b) => {
  const pa = String(a).split('.').map(Number); const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
};

function newestMtime(dir) {
  let newest = 0;
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else { try { newest = Math.max(newest, fs.statSync(p).mtimeMs); } catch { /* gone */ } }
    }
  };
  walk(dir);
  return newest;
}
// ── end of the copies ───────────────────────────────────────────────────────────────────────

/** The names of the copied functions and constants, for the selftest's comparison with coord-scan.mjs. */
export const COPIED_FROM_SCAN = ['IGNORED', 'git', 'lines', 'keep', 'mainCheckout', 'worktrees', 'ticketNumberOf', 'worktreeOf', 'mcpVersion', 'verCmp', 'newestMtime'];

const configDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
export const closeDir = () => path.join(configDir(), 'coord', 'close');
/** The saved check for the Chief's scan (check --all --save): coord-scan.mjs turns it into C20 rows. */
export const closeCheckFile = () => path.join(configDir(), 'coord', 'close-check.json');
const sidOk = (s) => typeof s === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(s);
export const short = (s, n) => { const t = String(s ?? ''); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const folderOf = (p) => (p ? path.basename(p) : null);

export function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** The last `bytes` of a file as text, starting at a line break (so no line is cut). */
function tail(file, bytes) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    return start === 0 ? text : text.slice(text.indexOf('\n') + 1);
  } catch { return ''; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

// ── Facts from the machine (each source can be replaced, for the selftest) ────────────────────

/** The `claude agents --json` list, or null when the command fails (fail closed). */
export function loadAgents(file, run = spawnSync) {
  if (file) return readJson(file);
  const r = run('claude', ['agents', '--json'], { encoding: 'utf8', timeout: 20_000 });
  if (r.status !== 0 || r.error) return null;
  try { const v = JSON.parse(r.stdout); return Array.isArray(v) ? v : null; } catch { return null; }
}

/** Every process: pid -> {pid, ppid, pgid, command}, or null when `ps` fails. */
export function parsePs(stdout) {
  const out = new Map();
  for (const line of String(stdout || '').split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) out.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), command: m[4].trim() });
  }
  return out.size ? out : null;
}
export function loadPs(run = spawnSync) {
  const r = run('ps', ['-axo', 'pid=,ppid=,pgid=,command='], { encoding: 'utf8', timeout: 10_000, maxBuffer: 32 * 1024 * 1024 });
  return r.status === 0 && !r.error ? parsePs(r.stdout) : null;
}

/** `lsof -Fpn` output -> pid -> the one name (cwd) or the list of names (listen ports). */
export function parseLsofCwd(stdout) {
  const out = new Map();
  let pid = null;
  for (const line of String(stdout || '').split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (pid && line.startsWith('n') && !out.has(pid)) out.set(pid, line.slice(1));
  }
  return out.size ? out : null;
}
export function parseLsofPorts(stdout) {
  const out = new Map();
  let pid = null;
  for (const line of String(stdout || '').split('\n')) {
    if (line.startsWith('p')) { pid = Number(line.slice(1)); if (!out.has(pid)) out.set(pid, []); } else if (pid && line.startsWith('n')) {
      const m = /:(\d+)$/.exec(line);
      if (m && !out.get(pid).includes(Number(m[1]))) out.get(pid).push(Number(m[1]));
    }
  }
  return out;
}
export function loadCwds(run = spawnSync) {
  // lsof exits 1 when it could not read some process; the output it has is still right. No output at all is a failure.
  const r = run('lsof', ['-d', 'cwd', '-Fpn'], { encoding: 'utf8', timeout: 15_000, maxBuffer: 32 * 1024 * 1024 });
  return r.error ? null : parseLsofCwd(r.stdout);
}
export function loadPorts(run = spawnSync) {
  const r = run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn'], { encoding: 'utf8', timeout: 10_000 });
  return r.error || (r.status !== 0 && !r.stdout) ? null : parseLsofPorts(r.stdout);
}

export function npmLatest(given, run = spawnSync) {
  if (given) return given;
  // --logs-max=0: npm writes no debug log for this read.
  const r = run('npm', ['view', MCP_PACKAGE, 'version', '--logs-max=0'], { encoding: 'utf8', timeout: 20_000 });
  return r.status === 0 && !r.error ? r.stdout.trim() || null : null;
}

/** The stdio MCP servers Claude Code starts for a session (user scope, and the project of `cwd`). */
export function mcpServerCommands(cfgDir, cwd) {
  const file = process.env.CLAUDE_CONFIG_DIR ? path.join(cfgDir, '.claude.json') : path.join(os.homedir(), '.claude.json');
  const j = readJson(file) || {};
  const servers = [...Object.values(j.mcpServers || {}), ...Object.values(((j.projects || {})[cwd] || {}).mcpServers || {})];
  return servers.filter((s) => s && s.command && (!s.type || s.type === 'stdio')).map((s) => [s.command, ...(s.args || [])].join(' '));
}

/** A process the session started for itself and that ends with it: caffeinate, or one of its stdio MCP servers, as its direct child. */
export function isHelper(p, sessionPid, mcpCommands) {
  if (!p || p.ppid !== sessionPid) return false;
  if (/^caffeinate(\s|$)/.test(p.command)) return true;
  return mcpCommands.some((c) => p.command === c || p.command.endsWith(` ${c}`) || p.command.endsWith(`/${c}`));
}

/** A GET to the Noesis API with the ticket hook's config. null when there is no token or the call fails. */
async function apiGet(p) {
  try {
    const { loadConfig } = await import('./noesis-ticket-session.mjs');
    const cfg = loadConfig(process.cwd());
    if (!cfg) return null;
    const res = await fetch(cfg.baseUrl + p, { method: 'GET', headers: { Authorization: `Bearer ${cfg.token}` }, signal: AbortSignal.timeout(15_000) });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

export function realDeps(args = {}) {
  return {
    agents: () => loadAgents(args.agents),
    ps: loadPs,
    cwds: loadCwds,
    ports: loadPorts,
    npmLatest: () => npmLatest(args.npmLatest),
    get: apiGet,
    now: () => Date.now(),
    configDir,
    tabs: async (F, run) => {
      const m = await import('./coord-tabs.mjs');
      const tabs = run ? m.listChromeTabs(run) : m.listChromeTabs();
      if (tabs === null) return null;
      const facts = await m.tabFacts(F);
      return m.classify(tabs, { ...facts, status: m.statusMapFor(tabs, facts, F) });
    },
  };
}

// ── The transcript ─────────────────────────────────────────────────────────────────────────

/** The transcript file of a session, or null. */
export function transcriptFile(sid, cfgDir = configDir()) {
  if (!sidOk(sid)) return null;
  const root = path.join(cfgDir, 'projects');
  try {
    for (const d of fs.readdirSync(root)) {
      const f = path.join(root, d, `${sid}.jsonl`);
      if (fs.existsSync(f)) return f;
    }
  } catch { /* no projects folder */ }
  return null;
}

const textOf = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.filter((c) => c && c.type === 'text').map((c) => c.text || '').join('\n') : '');
const isToolResult = (content) => Array.isArray(content) && content.some((c) => c && c.type === 'tool_result');

/**
 * What a transcript says: the ticket keys the session named (in order), the time of the last real
 * owner prompt, and the fire time of a wakeup that has not fired yet.
 * A real owner prompt is a `user` record that is not meta, not a tool result, not a task
 * notification or a local command, and not the prompt of a wakeup (which follows a
 * `system/scheduled_task_fire` record). A prompt the owner typed while a turn ran arrives as a
 * `queued_command` attachment with origin human, and counts too.
 */
export function readTranscript(text, now = Date.now()) {
  const keys = [];
  const tabTools = new Set(); // tool_use ids of the session's own Chrome tab tools
  const tabIds = new Set();
  let lastOwnerPrompt = 0;
  let wakeupAt = 0;
  let fired = false;
  // The hook's reminder, in a hook attachment (an array of strings) or in a prompt's text.
  const boundIn = (s) => { for (const m of String(s).matchAll(/\[tck-session\] This session is bound to (TCK-\d+)/g)) keys.push(m[1]); };
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    const at = Date.parse(r.timestamp || '') || 0;
    // A wakeup that fires is spent, and the next prompt is its own, not the owner's.
    if (r.type === 'system' && r.subtype === 'scheduled_task_fire') { fired = true; wakeupAt = 0; continue; }
    if (r.type === 'assistant' && Array.isArray(r.message?.content)) {
      fired = false; // the wakeup's turn has begun: what the user sends after this is the owner's
      for (const c of r.message.content) {
        if (!c || c.type !== 'tool_use') continue;
        const name = String(c.name || '');
        if (/^mcp__noesis__backlog_(bind|set_status|refine|set_gut|ship)$/.test(name) && TICKET_RE.test(String(c.input?.key || ''))) keys.push(c.input.key);
        if (/^mcp__claude-in-chrome__tabs_(create|context)_mcp$/.test(name) && c.id) tabTools.add(c.id);
        if (name === 'ScheduleWakeup') {
          const d = Math.min(WAKEUP_MAX_S, Math.max(WAKEUP_MIN_S, Number(c.input?.delaySeconds) || 0));
          wakeupAt = c.input?.stop ? 0 : at + d * 1000;
        }
      }
      continue;
    }
    if (r.type === 'attachment' || r.attachment) {
      const a = r.attachment || {};
      if (a.type === 'hook_additional_context') boundIn(Array.isArray(a.content) ? a.content.join('\n') : a.content || '');
      if (a.type === 'queued_command' && a.origin?.kind === 'human') lastOwnerPrompt = Math.max(lastOwnerPrompt, at);
      continue;
    }
    if (r.type === 'user' && isToolResult(r.message?.content)) {
      for (const c of r.message.content) {
        if (!c || c.type !== 'tool_result' || !tabTools.has(c.tool_use_id)) continue;
        for (const m of JSON.stringify(c.content ?? '').matchAll(/tabId\\?"?\s*[:=]?\s*(\d{3,12})/g)) tabIds.add(Number(m[1]));
      }
      continue;
    }
    if (r.type === 'user' && !isToolResult(r.message?.content)) {
      const t = textOf(r.message?.content).trimStart();
      boundIn(t);
      // Every user record between a fire and the next assistant record is the wakeup's own: a meta
      // note ("[1 prior /loop wakeup found nothing active]"), the prompt (free text, or a command),
      // and a skill body.
      if (fired || r.isMeta) continue;
      const machine = /^<(task-notification|local-command|system-reminder)/.test(t);
      if (!machine && t) lastOwnerPrompt = Math.max(lastOwnerPrompt, at);
    }
  }
  return { keys, lastOwnerPrompt, wakeupAt: wakeupAt > now ? wakeupAt : 0, tabIds: [...tabIds] };
}

// ── Gathering ──────────────────────────────────────────────────────────────────────────────

/** The machine-wide facts that every session's check shares. */
export async function gather(args, deps) {
  const repo = args.repo || process.cwd();
  const main = mainCheckout(repo);
  if (!main) throw new Error(`not a git repository: ${repo}`);
  // The main checkout's branch. A detached HEAD has none: then main (never the literal HEAD, which in a worktree is its own HEAD).
  const mainRef = git(main, ['symbolic-ref', '--quiet', '--short', 'HEAD']).out || 'main';
  const cfg = deps.configDir();
  const agents = deps.agents();
  const ps = deps.ps();
  const cwds = deps.cwds();
  const ports = deps.ports();
  const npm = deps.npmLatest();
  const mainVersion = mcpVersion(main);
  const distFile = path.join(main, MCP_DIR, 'dist', 'index.js');
  const distStale = fs.existsSync(distFile) ? fs.statSync(distFile).mtimeMs < newestMtime(path.join(main, MCP_DIR, 'src')) : false;
  const closed = args.closed ? readJson(args.closed) : null;
  const statusByKey = new Map(((closed && (closed.issues || closed)) || []).filter((i) => i && TICKET_RE.test(i.key || '')).map((i) => [i.key, i.work_status || null]));
  const statuses = await loadStatuses(deps);
  const allocations = await deps.get('/api/mcp/coordination/allocations');
  const leases = await deps.get('/api/mcp/coordination/leases');
  // claude-config: --config-repo, else the usual clone; null (the selftest) means none.
  const configRepo = args.configRepo !== undefined ? args.configRepo || null : [path.join(os.homedir(), 'temp_cGit', 'claude-config'), 'C:\\temp_cGit\\claude-config'].find((p) => fs.existsSync(path.join(p, '.git'))) || null;
  const sub = path.join(main, MCP_DIR);
  const hookLive = path.join(cfg, 'hooks', HOOK_SCRIPT);
  const hookMain = path.join(sub, 'scripts', HOOK_SCRIPT);
  const hookStale = fs.existsSync(hookLive) && fs.existsSync(hookMain) && !sameFile(hookLive, hookMain);
  // Each installed skill of the package: compared with claude-config's copy when there is one
  // (claude-config is the source of the live ~/.claude), else with the package template.
  const skills = (() => { try { return fs.readdirSync(path.join(sub, 'skill-templates')).filter((f) => f.endsWith('.md')); } catch { return []; } })()
    .filter((f) => fs.existsSync(path.join(cfg, 'commands', f)))
    .map((f) => {
      const tpl = path.join(sub, 'skill-templates', f);
      const copy = configRepo ? path.join(configRepo, 'commands', f) : null;
      const hasCopy = Boolean(copy && fs.existsSync(copy));
      const ref = hasCopy ? 'claude-config' : 'package';
      return { file: f, ref, liveDiffers: !sameFile(path.join(cfg, 'commands', f), hasCopy ? copy : tpl), copiesDiffer: hasCopy && !sameFile(tpl, copy) };
    });
  const F = {
    main, mainRef, cfg, wts: worktrees(main), agents, ps, cwds, ports, npm, mainVersion, distStale, statusByKey, statuses,
    portSlots: allocations && Array.isArray(allocations.ports) ? allocations.ports : null,
    leases: leases && Array.isArray(leases.leases) ? leases.leases : null,
    configRepo, configWts: configRepo ? worktrees(configRepo) : [], hookStale, skills, now: deps.now(),
  };
  F.ticketOfDir = (dir) => { const w = worktreeOf(dir, F.wts); const n = w && path.resolve(w.path) !== path.resolve(main) ? ticketNumberOf(w) : null; return n ? `TCK-${n}` : null; };
  F.bySid = new Map();
  // Every live session, background agents too: a background loop still works on its ticket (its tabs are in use).
  for (const a of (Array.isArray(agents) ? agents : []).filter((x) => x && sidOk(x.sessionId))) {
    const tf = transcriptFile(a.sessionId, cfg);
    const transcript = readTranscript(tf ? tail(tf, TRANSCRIPT_TAIL_BYTES) : '', F.now);
    F.bySid.set(a.sessionId, { agent: a, transcript, ev: ticketEvidence(a.sessionId, a.cwd, F, transcript) });
  }
  // The loop tabs in Chrome (coord-tabs.mjs): null when AppleScript fails. coord-tabs reads them itself (withTabs: false).
  const tabResult = args.withTabs === false || !deps.tabs ? { tabs: [], nonLocalBySession: {} } : await deps.tabs(F);
  F.tabs = tabResult ? tabResult.tabs : null;
  F.tabsNonLocal = tabResult ? tabResult.nonLocalBySession || {} : {};
  F.tabCounts = tabResult ? { otherLocal: tabResult.otherLocal || 0, nonLocal: tabResult.nonLocal || 0 } : null;
  return F;
}

const ALL_STATUSES = ['created', 'planning', 'ready_to_implement', 'implementing', 'iterating', 'ready_to_merge', 'deploying', 'shipped', 'merged', 'dropped'];
const LIST_LIMIT = 500; // the list route returns at most 500 rows

/**
 * Every ticket's work status, from the list route, one call per status. The list route never
 * stamps a ticket's agent activity; a keyed GET (/issues/<key>) would mark every shipped ticket
 * as active on the board. null when a call fails. `truncated`: a list came back full, so a ticket
 * missing from it may still exist.
 */
export async function loadStatuses(deps) {
  const map = new Map();
  let truncated = false;
  for (const s of ALL_STATUSES) {
    const r = await deps.get(`/api/mcp/backlog/issues?status=${s}`);
    if (!r || !Array.isArray(r.issues)) return null;
    if (r.issues.length >= LIST_LIMIT) truncated = true;
    for (const i of r.issues) if (i && TICKET_RE.test(i.key || '')) map.set(i.key, i.work_status || s);
  }
  return { map, truncated };
}

/** The machine-wide items for the owner, "after you close": listed once, never a reason. */
export function machineFollowUps(F) {
  const out = [];
  if (F.mainVersion && F.npm && verCmp(F.mainVersion, F.npm) > 0) out.push({ code: 'npm', text: `MCP ${F.mainVersion} on main is not on npm yet (npm has ${F.npm})` });
  if (F.distStale) out.push({ code: 'dist', text: 'the main checkout\'s MCP build is older than its source: build it, then run /mcp in the sessions that use it' });
  if (F.hookStale) out.push({ code: 'hook', text: 'the installed ticket hook differs from main\'s package' });
  const live = F.skills.filter((s) => s.liveDiffers);
  if (live.length) out.push({ code: 'skills', text: `installed skills differ from their source: ${live.map((s) => `${s.file} (${s.ref})`).join(', ')}` });
  const copies = F.skills.filter((s) => s.copiesDiffer);
  if (copies.length) out.push({ code: 'skill-copies', text: `main's package template differs from claude-config's copy: ${copies.map((s) => s.file).join(', ')} (the next noesis-mcp setup installs the package's)` });
  return out;
}

/** A ticket's status: --closed first, then the lists. null = unknown; 'not-on-board' = the full lists do not have it. */
export function statusOf(key, F) {
  if (F.statusByKey.has(key)) return F.statusByKey.get(key);
  if (!F.statuses) return null;
  if (F.statuses.map.has(key)) return F.statuses.map.get(key);
  return F.statuses.truncated ? null : 'not-on-board';
}

/** The pids from this one up to the top. */
function ancestors(pid, ps) {
  const out = new Set();
  let p = ps.get(pid);
  for (let i = 0; p && i < 64 && !out.has(p.ppid); i++) { out.add(p.ppid); p = ps.get(p.ppid); }
  return out;
}
function isDescendant(pid, of, ps) { return ancestors(pid, ps).has(of); }

/** Which ticket the session worked on, from local evidence, newest first. */
export function ticketEvidence(sid, cwd, F, transcript) {
  const by = [];
  const cache = readJson(path.join(F.cfg, 'tck-bindings', `${sid}.json`));
  if (cache && TICKET_RE.test(cache.key || '')) by.push(['binding-cache', cache.key]);
  if (transcript.keys.length) by.push(['transcript', transcript.keys[transcript.keys.length - 1]]);
  const sc = readJson(path.join(F.cfg, 'loop-supervisor', `${sid}.json`));
  if (sc && sc.stateFile) {
    const head = (() => { try { return fs.readFileSync(sc.stateFile, 'utf8').slice(0, 4000); } catch { return ''; } })();
    const m = /^Ticket:\s*(TCK-\d+)/m.exec(head);
    if (m) by.push(['loop-state', m[1]]);
  }
  for (const dir of [sc && sc.cwd, cwd]) {
    const wt = worktreeOf(dir, F.wts);
    const n = wt && path.resolve(wt.path) !== path.resolve(F.main) ? ticketNumberOf(wt) : null;
    if (n) { by.push(['worktree-name', `TCK-${n}`]); break; }
  }
  return { key: by.length ? by[0][1] : null, by, sidecar: sc };
}

/** The worktree where the session's work is: the loop's folder, a folder named for its ticket, else its own folder. Never the main checkout. */
function workFolder(cwd, key, sc, F) {
  const notMain = (w) => w && path.resolve(w.path) !== path.resolve(F.main) ? w : null;
  const n = key ? Number(key.slice(4)) : null;
  return notMain(worktreeOf(sc && sc.cwd, F.wts)) || (n ? F.wts.find((w) => ticketNumberOf(w) === n && notMain(w)) : null) || notMain(worktreeOf(cwd, F.wts)) || null;
}

/** The files that a ticket's commits on a repository's branch changed: commits with the trailer
 *  `Ticket: TCK-<n>`, or with the key in the message (TCK-1 never matches TCK-10). Only a folder
 *  that is a repository of its own counts (the MCP package is a submodule). */
function ticketPaths(dir, ref, key) {
  if (!dir || !TICKET_RE.test(key || '') || !fs.existsSync(path.join(dir, '.git'))) return [];
  const r = git(dir, ['log', ref, '-i', '-E', `--grep=${key}([^0-9]|$)`, '--name-only', '--format=']);
  return r.ok ? [...new Set(lines(r.out))] : [];
}

const sameFile = (a, b) => { try { return fs.readFileSync(a).equals(fs.readFileSync(b)); } catch { return false; } };

/** The commits of HEAD that are not on main (or origin/main). Without either ref: not on any remote branch. null when git fails. */
export function notOnMain(dir, mainRef = 'main') {
  const refs = [...new Set([mainRef, 'main', `origin/${mainRef}`, 'origin/main'])].filter((r) => r && r !== 'HEAD' && !r.endsWith('/HEAD') && git(dir, ['rev-parse', '--verify', '--quiet', `${r}^{commit}`]).ok);
  const r = git(dir, ['rev-list', '--count', 'HEAD', '--not', ...(refs.length ? refs : ['--remotes'])]);
  return r.ok ? { n: Number(r.out) || 0, against: refs.length ? 'main' : 'any remote branch' } : null;
}

/** Uncommitted work and commits not on main, in one repository and (for md-manager) its MCP submodule. */
function repoChecks(dir, mainRef, add) {
  const label = folderOf(dir);
  const sub = path.join(dir, MCP_DIR);
  const hasSub = fs.existsSync(path.join(sub, '.git'));
  const status = (d) => git(d, ['status', '--porcelain=v1', '-uall']);
  const st = status(dir);
  const dirty = st.raw.split('\n').filter(Boolean).map((l) => l.slice(3).replace(/^"|"$/g, '').split(' -> ').pop()).filter(keep);
  const subSt = hasSub ? status(sub) : { ok: true, raw: '' };
  const subDirty = subSt.raw.split('\n').filter(Boolean).map((l) => `${MCP_DIR}/${l.slice(3).replace(/^"|"$/g, '').split(' -> ').pop()}`).filter(keep);
  if (!st.ok || !subSt.ok) add('facts-failed', `the check could not read git status in ${label}`, 'chief');
  const files = [...dirty.filter((f) => f !== MCP_DIR && f !== `${MCP_DIR}/`), ...subDirty];
  if (files.length) add('uncommitted', `${files.length} uncommitted file${files.length > 1 ? 's' : ''} in ${label} (${short(files.slice(0, 3).join(', '), 120)})`, 'session', { files: files.slice(0, 20) });
  for (const [d, l, ref] of [[dir, label, mainRef], ...(hasSub ? [[sub, `${label}/${MCP_DIR}`, 'main']] : [])]) {
    const c = notOnMain(d, ref);
    if (!c) add('facts-failed', `the check could not count the commits in ${l}`, 'chief');
    else if (c.n) add('not-on-main', `${c.n} commit${c.n > 1 ? 's' : ''} in ${l} ${c.n > 1 ? 'are' : 'is'} not on ${c.against}`, 'session');
  }
}

/** The verdict for one session. */
export async function checkSession(agent, F, deps) {
  const sid = agent.sessionId;
  const reasons = [];
  const followUps = [];
  const add = (code, text, fixer, extra) => reasons.push({ code, text, fixer, ...(extra || {}) });
  const cached = F.bySid && F.bySid.get(sid);
  const transcript = cached ? cached.transcript : (() => { const tf = transcriptFile(sid, F.cfg); return readTranscript(tf ? tail(tf, TRANSCRIPT_TAIL_BYTES) : '', F.now); })();
  const ev = cached ? cached.ev : ticketEvidence(sid, agent.cwd, F, transcript);
  const key = ev.key;
  const status = key ? statusOf(key, F) : null;
  const wt = workFolder(agent.cwd, key, ev.sidecar, F);
  const n = key ? Number(key.slice(4)) : null;
  const configWt = n && F.configRepo ? F.configWts.find((w) => ticketNumberOf(w) === n && path.resolve(w.path) !== path.resolve(F.configRepo)) || null : null;
  const state = agent.status || agent.state || null;

  // The facts the check could not read.
  if (!F.ps || !F.cwds) add('facts-failed', `the check could not read the processes (${!F.ps ? 'ps' : 'lsof'} failed)`, 'chief');
  if (!F.portSlots || !F.leases) add('facts-failed', 'the check could not read the port slots and leases from the server', 'chief');
  if (F.tabs === null) add('facts-failed', 'the check could not read the Chrome tabs', 'chief');

  // The ticket.
  if (key && !status) add('ticket-unknown', `the check could not read ${key}'s status`, 'chief');
  else if (status === 'not-on-board') add('ticket-unknown', `${key} is not on the Jot board`, 'owner');
  else if (key && !CLOSED_STATUSES.includes(status)) add('ticket-open', status === 'ready_to_merge' ? `${key} is Ready to merge: it waits for your "ship it"` : `${key} is at ${status}`, status === 'ready_to_merge' ? 'owner' : 'session');

  // The session itself.
  if (state === 'busy') add('busy', 'it is working', 'session');
  else if (state === 'waiting' || state === 'blocked') add('waiting', `it waits for you${agent.waitingFor ? ` (${agent.waitingFor})` : ''}`, 'owner');
  if (transcript.wakeupAt) add('wakeup', `a wakeup is armed for ${new Date(transcript.wakeupAt).toISOString().slice(11, 16)} UTC`, 'session');
  if (ev.sidecar && ev.sidecar.stateFile) {
    const head = (() => { try { return fs.readFileSync(ev.sidecar.stateFile, 'utf8').slice(0, 2000); } catch { return ''; } })();
    if (/Loop-state:\s*RUNNING/.test(head)) add('loop-running', `its loop is still RUNNING (${folderOf(ev.sidecar.stateFile)})`, 'session');
  }

  // Its worktrees (md-manager, and the claude-config worktree of its ticket): uncommitted work and commits not on main.
  if (wt) repoChecks(wt.path, F.mainRef, add);
  if (configWt) repoChecks(configWt.path, 'main', add);

  // Processes that run from its worktree and are not the session, its parents, a shell or its own helpers.
  if (wt && F.ps && F.cwds) {
    const up = ancestors(agent.pid, F.ps);
    const helpers = mcpServerCommands(F.cfg, agent.cwd);
    const others = new Set((F.agents || []).filter((a) => a.pid && a.pid !== agent.pid).map((a) => a.pid));
    const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
    const root = real(wt.path);
    const found = [];
    for (const [pid, cwd] of F.cwds) {
      const d = real(cwd);
      if (!(d === root || d.startsWith(root + path.sep))) continue;
      const p = F.ps.get(pid);
      if (!p || pid === agent.pid || up.has(pid) || SHELL_RE.test(p.command)) continue;
      if (others.has(pid) || [...others].some((o) => isDescendant(pid, o, F.ps))) continue; // another session's own work
      const mine = agent.pid && isDescendant(pid, agent.pid, F.ps);
      if (isHelper(p, agent.pid, helpers)) continue;
      found.push({ pid, pgid: p.pgid, command: short(p.command, 100), ports: (F.ports && F.ports.get(pid)) || [], mine: Boolean(mine) });
    }
    for (const p of found) add('process', `${p.mine ? 'its own process' : 'a process'} runs from ${folderOf(wt.path)}: pid ${p.pid} ${p.command}${p.ports.length ? ` (port ${p.ports.join(', ')})` : ''}`, 'chief', { pid: p.pid, pgid: p.pgid, ports: p.ports, command: p.command });
  }

  // Its Chrome tabs: a loop tab of its ticket, or a tab its own Chrome tools opened.
  const tabs = (F.tabs || []).filter((t) => (key && t.ticket === key) || (t.openedBy && t.openedBy.sessionId === sid));
  if (tabs.length) add('tabs', `it has ${tabs.length} Chrome tab${tabs.length > 1 ? 's' : ''} open: ${short(tabs.map((t) => `tab ${t.id} (${t.label})`).join(', '), 200)}`, 'chief', { tabIds: tabs.map((t) => t.id) });
  const ownNonLocal = (F.tabsNonLocal || {})[sid] || 0;
  if (ownNonLocal) add('tabs', `it has ${ownNonLocal} other Chrome tab${ownNonLocal > 1 ? 's' : ''} open that its own Chrome tools opened (not local, so the Chief never closes ${ownNonLocal > 1 ? 'them' : 'it'})`, 'session', { nonLocal: ownNonLocal });

  // Its port slot and leases.
  if (F.portSlots) {
    for (const s of F.portSlots.filter((s) => (key && s.ticket === key) || s.holder === sid)) add('port', `it holds port slot ${s.slot} (${s.host}, ports ${s.backend_port} and ${s.frontend_port})`, 'chief', { slot: s.slot, holder: s.holder || null, ticket: s.ticket || null });
  }
  if (F.leases) {
    for (const l of F.leases.filter((l) => l.holder === sid && !l.expired)) add('lease', `it holds the ${l.resource} lease`, 'session');
  }
  // The local test-db lease of coord-lease.mjs (COORD_LEASE_DIR, else ~/.claude/coord/locks).
  const testDb = readJson(path.join(process.env.COORD_LEASE_DIR || path.join(F.cfg, 'coord', 'locks'), 'test-db', 'holder.json'));
  if (testDb && testDb.pid && F.ps && F.ps.has(testDb.pid) && (testDb.pid === agent.pid || isDescendant(testDb.pid, agent.pid, F.ps))) add('test-db-lease', 'it holds the local test-db lease', 'session');

  // What its own commits changed and is not yet published or installed.
  const sub = path.join(F.main, MCP_DIR);
  const subPaths = key ? ticketPaths(sub, 'HEAD', key) : [];
  const ownMcp = subPaths.length > 0;
  const unpublished = F.mainVersion && F.npm && verCmp(F.mainVersion, F.npm) > 0;
  if (ownMcp && unpublished) add('mcp-unpublished', `MCP ${F.mainVersion} on main is not on npm yet (npm has ${F.npm})`, 'owner');
  if (ownMcp && !F.npm) add('mcp-npm-unknown', `the check could not read npm's version, so it cannot tell whether MCP ${F.mainVersion || '?'} is published`, 'chief');
  if (ownMcp && F.distStale && subPaths.some((p) => p.startsWith('src/'))) add('mcp-dist-stale', 'the main checkout\'s MCP build is older than its source', 'chief');
  if (F.hookStale && subPaths.includes(`scripts/${HOOK_SCRIPT}`)) add('hook-stale', 'the installed ticket hook differs from main\'s package (run noesis-mcp setup)', 'session');
  for (const f of F.skills.filter((s) => subPaths.includes(`skill-templates/${s.file}`) && !sameFile(path.join(sub, 'skill-templates', s.file), path.join(F.cfg, 'commands', s.file))).map((s) => s.file)) {
    add('skill-stale', `the installed skill ${f} differs from main's package`, 'session');
  }
  if (F.configRepo && key) {
    const cfgRef = git(F.configRepo, ['rev-parse', '--abbrev-ref', 'HEAD']).out || 'main';
    for (const p of ticketPaths(F.configRepo, cfgRef, key)) {
      const live = path.join(F.cfg, p);
      const repoFile = path.join(F.configRepo, p);
      if (fs.existsSync(repoFile) && fs.existsSync(live) && !sameFile(repoFile, live)) add('config-drift', `~/.claude/${p} differs from claude-config`, 'session', { path: p });
    }
  }

  // The session's own answer.
  // An answer counts only with a verdict of yes or no and a time that parses.
  const answer = readJson(path.join(closeDir(), `${sid}.json`));
  const hasAnswer = Boolean(answer && (answer.verdict === 'yes' || answer.verdict === 'no') && Number.isFinite(Date.parse(answer.at)));
  const stale = hasAnswer && transcript.lastOwnerPrompt > Date.parse(answer.at);
  if (hasAnswer && answer.verdict === 'no') add('answer-no', `the session said no: ${short((answer.left || []).join('; ') || 'no reason given', 200)}`, 'session');
  else if (hasAnswer && stale) add('answer-stale', 'its answer is older than your last message to it: ask it again yourself', 'owner');
  else if (!hasAnswer && key) add('answer-missing', 'it has not answered "Can I close the session?" yet', 'chief');

  // A session with no ticket is never "yes": only the session can confirm, even when it said yes.
  const verdict = reasons.length ? 'no' : key ? 'yes' : 'maybe';
  if (verdict === 'maybe') followUps.unshift({ code: 'no-ticket', text: hasAnswer && !stale ? `it has no ticket; the session itself said yes at ${answer.at}` : 'it has no ticket, so only the session itself can confirm' });
  return {
    sessionId: sid, name: agent.name || null, pid: agent.pid || null, cwd: agent.cwd || null, folder: folderOf(agent.cwd), worktree: wt ? wt.path : null, state,
    ticket: key ? { key, status, by: ev.by.map(([k]) => k) } : null,
    verdict, reasons, followUps,
    answer: hasAnswer ? { verdict: answer.verdict, at: answer.at, left: answer.left || [], stale: Boolean(stale) } : null,
    askedAt: answer && answer.askedAt || null,
    checkedAt: new Date(F.now).toISOString(),
  };
}

/** Which sessions to check: the interactive ones (a background agent has no terminal to close). */
export function interactive(agents) {
  return (Array.isArray(agents) ? agents : []).filter((a) => a && a.kind !== 'background' && a.pid && sidOk(a.sessionId));
}

export async function check(args, deps) {
  const F = await gather(args, deps);
  if (!F.agents) return { error: 'the check could not read `claude agents --json`', sessions: [] };
  let rows = interactive(F.agents);
  if (args.session) rows = rows.filter((a) => a.sessionId === args.session);
  else if (args.pid) rows = rows.filter((a) => a.pid === Number(args.pid));
  const sessions = [];
  for (const a of rows) sessions.push(await checkSession(a, F, deps));
  // The loop tabs (local, of a ticket); every other tab is only counted.
  const tabs = F.tabs === null ? null : {
    loop: F.tabs.map((t) => ({ id: t.id, ticket: t.ticket, status: t.status, label: t.label, sureOrphan: t.sureOrphan, active: t.active, url: t.url, title: t.title, openedBy: t.openedBy ? t.openedBy.sessionId : null })),
    ...(F.tabCounts || { otherLocal: 0, nonLocal: 0 }),
  };
  return { checkedAt: new Date(F.now).toISOString(), main: F.main, npmLatest: F.npm, mainMcpVersion: F.mainVersion, sessions, followUps: machineFollowUps(F), tabs };
}

/**
 * The check as the scan reads it (check --all --save): each session also says whether the Chief may
 * ask it now (askable) and whether it is the Chief's own (self); the tabs say which loop tabs no
 * checked session owns (unowned).
 */
export function forScan(result, selfPid) {
  const owned = new Set(result.sessions.flatMap((s) => s.reasons.filter((x) => x.code === 'tabs' && Array.isArray(x.tabIds)).flatMap((x) => x.tabIds)));
  return {
    version: 1,
    checkedAt: result.checkedAt,
    main: result.main,
    followUps: result.followUps || [],
    sessions: result.sessions.map((s) => ({ ...s, self: Boolean(selfPid) && s.pid === selfPid, askable: askRefusal(s, selfPid) === null })),
    tabs: result.tabs ? { ...result.tabs, unowned: result.tabs.loop.filter((t) => !owned.has(t.id)).map((t) => t.id) } : null,
  };
}

/** check --all --save: the check, saved for the scan, with the Chief's own session marked (self), so the rules never ask it. */
export async function checkAndSave(args, deps) {
  const r = await check(args, deps);
  if (!r.error) r.savedTo = saveCheck(forScan(r, chiefPid(args, deps)));
  return r;
}

/** Write the saved check whole: a temporary file in the same folder, then a rename, so a reader never sees half of it. */
export function saveCheck(saved, file = closeCheckFile()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(saved));
  fs.renameSync(tmp, file);
  return file;
}

/** The sessions that can close now, in groups of at most GROUP_SIZE; the "maybe" ones apart. */
export function candidatesOf(result, selfPid) {
  const ok = (s) => s.pid !== Number(selfPid);
  const ready = result.sessions.filter((s) => s.verdict === 'yes' && ok(s));
  const maybe = result.sessions.filter((s) => s.verdict === 'maybe' && ok(s));
  const pick = (s) => ({ sessionId: s.sessionId, name: s.name, pid: s.pid, ticket: s.ticket ? s.ticket.key : null, folder: s.folder, notes: s.followUps.map((f) => f.text) });
  const groups = [];
  for (let i = 0; i < ready.length; i += GROUP_SIZE) groups.push(ready.slice(i, i + GROUP_SIZE).map(pick));
  return { ready: ready.map(pick), maybe: maybe.map(pick), groups, followUps: (result.followUps || []).map((f) => f.text) };
}

/** Store a session's own answer. Keeps askedAt. Returns the file written. */
export function record({ sessionId, verdict, left = [], now = Date.now() }) {
  if (!sidOk(sessionId)) throw new Error('record: no valid session id');
  if (verdict !== 'yes' && verdict !== 'no') throw new Error('record: --verdict must be yes or no');
  const file = path.join(closeDir(), `${sessionId}.json`);
  const old = readJson(file) || {};
  fs.mkdirSync(closeDir(), { recursive: true });
  const data = { ...old, sessionId, verdict, left: left.map((l) => short(l, 300)).slice(0, 10), at: new Date(now).toISOString() };
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
  return file;
}

/** The session id of a Claude Code process: ~/.claude/sessions/<pid>.json, else `claude agents --json`. */
export function sessionOfPid(pid, deps) {
  const s = readJson(path.join(deps.configDir(), 'sessions', `${Number(pid)}.json`));
  if (s && sidOk(s.sessionId)) return s.sessionId;
  const row = (deps.agents() || []).find((a) => a && a.pid === Number(pid));
  return row && sidOk(row.sessionId) ? row.sessionId : null;
}

export function render(result) {
  if (result.error) return `Close check failed: ${result.error}`;
  const out = [`Close check at ${result.checkedAt}: ${result.sessions.length} session${result.sessions.length === 1 ? '' : 's'}`];
  for (const s of result.sessions) {
    out.push('', `${s.verdict.toUpperCase().padEnd(5)} ${s.name || s.sessionId.slice(0, 8)} (${s.sessionId.slice(0, 8)}, pid ${s.pid}, ${s.folder})${s.ticket ? ` ${s.ticket.key} ${s.ticket.status || '?'}` : ' no ticket'}`);
    for (const r of s.reasons) out.push(`      no: ${r.text} [fix: ${r.fixer}]`);
    for (const f of s.followUps) out.push(`      note: ${f.text}`);
  }
  if ((result.followUps || []).length) out.push('', 'After you close (machine-wide, not caused by one session):', ...result.followUps.map((f) => `  ${f.text}`));
  return out.join('\n');
}

// ── ask and close (INC-3) ────────────────────────────────────────────────────
//
// `ask` types "Can I close the session?" into an idle session whose ticket is closed, once. `close`
// ends a session the owner chose: it stops the session's processes, releases its port slot, closes
// its sure-orphan tabs, types /exit, and closes its iTerm session. Each step checks again first,
// and any doubt stops the step without a keystroke. Typing is done through iTerm2's own scripting,
// found by the session's tty and named by the iTerm session's unique id, never by a window index.

export const ASK_PHRASE = 'Can I close the session?';
const SELF = fileURLToPath(import.meta.url);
/** A path as one shell word: plain paths stay as they are, any other is single-quoted. */
export const shq = (x) => (/^[\w@%+=:,./-]+$/.test(x) ? x : `'${String(x).replace(/'/g, "'\\''")}'`);

export const askLine = (repo) => `${ASK_PHRASE} (Chief of Staff: run your close check with \`node ${shq(SELF)} check --pid $PPID${repo ? ` --repo ${shq(repo)}` : ''}\`, fix what is yours, then record your answer with \`node ${shq(SELF)} record --pid $PPID --verdict yes|no --left "<what is left>"\`.)`;

const escA = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
const US = String.fromCharCode(31);
const RS2 = String.fromCharCode(30);
/** The iTerm2 sessions on one tty: [{uid, inTab}] (inTab = how many sessions its tab holds). */
export const itermSessionsScript = (tty) => `tell application "iTerm2"
  set out to ""
  repeat with w in windows
    repeat with t in tabs of w
      set n to count of sessions of t
      repeat with s in sessions of t
        if (tty of s) is "${escA(tty)}" then set out to out & (unique id of s) & (character id 31) & n & (character id 30)
      end repeat
    end repeat
  end repeat
  return out
end tell`;
const bySessionUid = (uid, body, none) => `tell application "iTerm2"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if ((unique id of s) as text) is "${escA(uid)}" then
${body}
        end if
      end repeat
    end repeat
  end repeat
  return "${none}"
end tell`;
export const paneScript = (uid) => bySessionUid(uid, '          return (text of s)', '');
/** Types one line without a newline, waits, then sends a bare Enter. With a shorter gap, Claude Code takes the Enter as part of
 *  the paste and leaves the prompt unsent (measured 2026-11-15 with a 0.6 s gap; TCK-1897's iterm-lib uses 1.5 s). */
export const typeLineScript = (uid, line) => bySessionUid(uid, `          write s text "${escA(line)}" newline no
          delay 1.5
          write s text ""
          return "typed"`, 'gone');
export const closeItermScript = (uid) => bySessionUid(uid, `          if (count of sessions of t) is not 1 then return "shared"
          close s
          return "closed"`, 'gone');

export function parseItermSessions(out) {
  return String(out || '').split(RS2).map((r) => r.replace(/^\n+/, '')).filter(Boolean).map((r) => { const [uid, n] = r.split(US); return { uid: String(uid || '').trim(), inTab: Number(n) }; }).filter((x) => x.uid);
}

/** The text in Claude Code's prompt line: between the last two lines made only of ─, without ❯. null when no prompt box is seen. */
export function composerText(pane) {
  const ls = String(pane || '').split('\n');
  const rules = ls.map((l, i) => (/^\s*─{8,}\s*$/.test(l) ? i : -1)).filter((i) => i >= 0);
  if (rules.length < 2) return null;
  const [a, b] = rules.slice(-2);
  const text = ls.slice(a + 1, b).join('\n').replace(/^\s*❯\s?/, '').trim();
  // An empty prompt shows a dim suggestion, which the pane text cannot tell apart: Try "write a test for <filepath>" (measured 2026-11-15).
  return /^Try "[^"\n]*"$/.test(text) ? '' : text;
}

/** Background work in the status bar below the prompt box: "· 1 shell" (a running background shell).
 *  "← N agent" is counted too, but a brand-new session shows "← 1 agent", so it is not the session's own work. */
export function backgroundWork(pane) {
  const ls = String(pane || '').split('\n');
  const rules = ls.map((l, i) => (/^\s*─{8,}\s*$/.test(l) ? i : -1)).filter((i) => i >= 0);
  const bar = ls.slice(rules.length ? rules[rules.length - 1] + 1 : 0).join(' ');
  const n = (re) => Number((re.exec(bar) || [])[1]) || 0;
  return { shells: n(/(\d+)\s+shells?\b/), agents: n(/←\s*(\d+)\s+agents?\b/) };
}

/** Merge fields into a session's close file (askedAt, an answer). */
function writeClose(sessionId, patch) {
  const file = path.join(closeDir(), `${sessionId}.json`);
  fs.mkdirSync(closeDir(), { recursive: true });
  const data = { ...(readJson(file) || {}), sessionId, ...patch };
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
  return data;
}

/** Whether the session's transcript shows the ask as a user turn after `since`. */
export function askArrived(text, since) {
  for (const line of String(text || '').split('\n')) {
    if (!line.includes(ASK_PHRASE)) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (r.type === 'user' && (Date.parse(r.timestamp || '') || 0) >= since - 2000 && textOf(r.message?.content).includes(ASK_PHRASE)) return true;
  }
  return false;
}

const NOT_DONE = ['facts-failed', 'busy', 'waiting', 'wakeup', 'loop-running'];

/** Why the Chief may not ask this session, or null. */
export function askRefusal(s, selfPid) {
  if (!s) return 'no such interactive session';
  if (selfPid && s.pid === selfPid) return "it is the Chief's own session";
  if (s.state !== 'idle') return `it is not idle (${s.state || 'unknown'})`;
  if (!s.ticket) return 'it has no ticket';
  if (!CLOSED_STATUSES.includes(s.ticket.status)) return `its ticket ${s.ticket.key} is not closed (${s.ticket.status || 'unknown'})`;
  if (s.answer) return 'it has already answered';
  if (s.askedAt) return `it was already asked at ${s.askedAt}`;
  const r = s.reasons.find((x) => NOT_DONE.includes(x.code));
  return r ? `it is not done: ${r.text}` : null;
}

/** The reasons close itself fixes: it stops the processes, releases the port slot and closes the sure-orphan tabs. Every other reason blocks. */
export const FIXED_BY_CLOSE = ['process', 'port', 'tabs'];

/** Why the Chief may not close this session, or null. Only a reason close fixes itself (FIXED_BY_CLOSE, fixer chief) lets it go on. */
export function closeRefusal(s, selfPid) {
  if (!s) return 'no such interactive session';
  if (selfPid && s.pid === selfPid) return "it is the Chief's own session";
  if (s.state !== 'idle') return `it is not idle (${s.state || 'unknown'})`;
  const blocking = s.reasons.filter((x) => !(FIXED_BY_CLOSE.includes(x.code) && x.fixer === 'chief'));
  return blocking.length ? `its check says no: ${blocking.map((x) => x.text).join('; ')}` : null;
}

/** Just before a keystroke: the session is still idle, alone on its tty in iTerm, its prompt line empty, nothing in the background. */
function readyToType(s, deps, { alone }) {
  const st = deps.sessionStatus(s.pid);
  if (st !== 'idle') return { why: `its status is now ${st || 'unknown'}` };
  const tty = deps.ttyOf(s.pid);
  if (!tty) return { why: 'it has no terminal' };
  const its = deps.iterm.sessionsOfTty(tty);
  if (its === null) return { why: 'iTerm2 could not be read' };
  if (its.length !== 1) return { why: `${its.length} iTerm sessions are on its terminal ${tty}` };
  if (alone && its[0].inTab !== 1) return { why: 'it shares its iTerm tab with another pane' };
  const pane = deps.iterm.pane(its[0].uid);
  const text = composerText(pane);
  if (text === null) return { why: 'its prompt line cannot be read' };
  // A dim prompt suggestion looks the same as typed text in the pane, so any text refuses (measured 2026-11-15).
  if (text !== '') return { why: `its prompt line shows text ("${short(text, 40)}"): typed, or Claude Code's own suggestion; clear that line in its tab, or close the tab yourself` };
  const bg = backgroundWork(pane);
  if (bg.shells) return { why: `it has ${bg.shells} background shell${bg.shells > 1 ? 's' : ''} running` };
  return { tty, uid: its[0].uid };
}

/** Ask one session "Can I close the session?", once. */
export async function ask(args, deps) {
  const r = await check({ ...args, all: false }, deps);
  if (r.error) return { asked: false, why: r.error };
  const s = r.sessions[0];
  const self = chiefPid(args, deps);
  const why = askRefusal(s, self);
  if (why) return { asked: false, why, sessionId: s && s.sessionId };
  // --by-message: the Chief sends the line itself with SendMessage, which wakes an idle session
  // (measured 2026-11-15 on a scratch session: the message arrived as a user turn and was answered).
  if (args.byMessage) {
    if (deps.sessionStatus(s.pid) !== 'idle') return { asked: false, why: 'its status is no longer idle', sessionId: s.sessionId };
    writeClose(s.sessionId, { askedAt: new Date(deps.now()).toISOString(), askedBy: 'message' });
    return { asked: true, by: 'message', sessionId: s.sessionId, name: s.name, line: askLine(r.main) };
  }
  const ready = readyToType(s, deps, { alone: false });
  if (ready.why) return { asked: false, why: ready.why, sessionId: s.sessionId };
  const typedAt = deps.now();
  writeClose(s.sessionId, { askedAt: new Date(typedAt).toISOString() }); // before the keystroke: never twice
  const typed = deps.iterm.type(ready.uid, askLine(r.main));
  if (typed !== 'typed') return { asked: false, why: `iTerm2 did not type (${typed})`, sessionId: s.sessionId };
  const confirmed = await deps.waitFor(() => { const tf = transcriptFile(s.sessionId, deps.configDir()); return tf ? askArrived(tail(tf, 2 * 1024 * 1024), typedAt) : false; }, 60_000);
  return { asked: true, confirmed, sessionId: s.sessionId, name: s.name };
}

/** Close one session the owner chose. Each step reports what it did; a refusal changes nothing after it. */
export async function closeSession(args, deps) {
  const steps = [];
  const stop = (why) => ({ closed: false, why, steps });
  const self = chiefPid(args, deps);
  // The owner's pause is in the inbox of this (the Chief's) session: the server reads it per session.
  const paused = await deps.paused(self ? sessionOfPid(self, deps) : null);
  if (paused !== false) return stop(paused === null ? "the owner's pause cannot be read" : 'the owner has paused every session');
  const r = await check({ ...args, all: false }, deps);
  if (r.error) return stop(r.error);
  const s = r.sessions[0];
  const why = closeRefusal(s, self);
  if (why) return stop(why);
  // Every refusal that does not depend on the cleanup comes first, so a refused close changes nothing.
  const first = readyToType(s, deps, { alone: true });
  if (first.why) return stop(first.why);
  // Its processes: checked again just before the signal (pid, folder, command), a group signalled when its leader is one of them.
  const procs = s.reasons.filter((x) => x.code === 'process');
  if (procs.length) {
    const stopScript = s.worktree ? path.join(s.worktree, 'loop-stack', 'stop.sh') : null;
    if (stopScript && fs.existsSync(stopScript)) { const run = deps.run('bash', [stopScript], { cwd: s.worktree, timeout: 30_000 }); steps.push(`ran ${stopScript}: exit ${run.status}`); }
    const ps = deps.ps();
    const cwds = deps.cwds();
    if (!ps || !cwds) return stop('the processes cannot be read again');
    const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
    const root = s.worktree ? real(s.worktree) : null;
    const still = procs.filter((x) => ps.has(x.pid));
    const ids = new Set(still.map((x) => x.pid));
    // Check every process first (folder and command), so a doubt stops the close before any signal.
    for (const x of still) {
      const p = ps.get(x.pid);
      const d = cwds.get(x.pid) ? real(cwds.get(x.pid)) : null;
      if (!root || !d || !(d === root || d.startsWith(root + path.sep))) return stop(`pid ${x.pid} no longer runs from ${folderOf(s.worktree)}`);
      if (!p.command.startsWith(String(x.command || '').replace(/…$/, ''))) return stop(`pid ${x.pid} now runs another command`);
    }
    const signalled = new Set();
    for (const x of still) {
      const p = ps.get(x.pid);
      const target = ids.has(p.pgid) && p.pgid !== x.pid ? -p.pgid : p.pgid === x.pid ? -x.pid : x.pid;
      if (signalled.has(target)) continue;
      signalled.add(target);
      try { deps.kill(target, 'SIGTERM'); steps.push(`sent SIGTERM to ${target < 0 ? `group ${-target}` : `pid ${target}`}`); } catch (e) { return stop(`could not stop pid ${x.pid}: ${e.message}`); }
    }
    const gone = await deps.waitFor(() => still.every((x) => !deps.alive(x.pid)), 5000);
    if (!gone) return stop(`still running after SIGTERM: ${still.filter((x) => deps.alive(x.pid)).map((x) => x.pid).join(', ')}`);
  }
  // Its port slot and its sure-orphan tabs.
  for (const x of s.reasons.filter((y) => y.code === 'port')) {
    const ok = await deps.post('/api/mcp/coordination/allocations/port/release', { holder: x.holder, ...(x.ticket ? { ticket: x.ticket } : {}) });
    steps.push(ok ? `released port slot ${x.slot}` : `could not release port slot ${x.slot}`);
  }
  const tabIds = s.reasons.filter((y) => y.code === 'tabs' && y.tabIds).flatMap((y) => y.tabIds);
  if (tabIds.length) {
    const t = await deps.closeTabs(tabIds);
    steps.push(`tabs: closed ${t.closed.map((x) => x.id).join(', ') || 'none'}${t.refused.length ? `; kept ${t.refused.map((x) => `${x.id} (${x.why})`).join(', ')}` : ''}${t.error ? `; ${t.error}` : ''}`);
  }
  // /exit, once, and only when it is still idle, alone in its tab, with an empty prompt line.
  const ready = readyToType(s, deps, { alone: true });
  if (ready.why) return stop(ready.why);
  const typed = deps.iterm.type(ready.uid, '/exit');
  if (typed !== 'typed') return stop(`iTerm2 did not type /exit (${typed})`);
  steps.push('typed /exit');
  const ended = await deps.waitFor(() => !deps.alive(s.pid), 30_000);
  if (!ended) return stop('its Claude Code process did not end within 30 s (no second keystroke was sent)');
  // Its iTerm session: closed only when only shells run in the foreground on its terminal.
  const fg = deps.foreground(ready.tty);
  if (fg === null || fg.some((c) => !SHELL_RE.test(c))) steps.push(`left its iTerm tab open: ${fg === null ? 'its terminal cannot be read' : `it runs ${fg.filter((c) => !SHELL_RE.test(c)).join(', ')}`}`);
  else steps.push(`iTerm tab: ${deps.iterm.close(ready.uid)}`);
  const hb = await deps.post('/api/mcp/coordination/sessions/heartbeat', { session_id: s.sessionId, state: 'gone', machine: os.hostname().slice(0, 100), ...(s.worktree || s.cwd ? { cwd: String(s.worktree || s.cwd).slice(0, 500) } : {}), ...(s.ticket ? { ticket: s.ticket.key } : {}), note: 'closed by the Chief of Staff (coord-close.mjs close)' });
  steps.push(hb ? 'reported it as gone' : 'could not report it as gone');
  return { closed: true, sessionId: s.sessionId, name: s.name, folder: s.cwd || s.folder, resume: `claude --resume ${s.sessionId}`, steps };
}

const osaRun = (script) => execFileSync('osascript', ['-e', script], { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'ignore'] });

/** The real side of ask and close (the selftest replaces each). */
export function actDeps(args, base = realDeps(args)) {
  return {
    ...base,
    sessionStatus: (pid) => { const j = readJson(path.join(configDir(), 'sessions', `${Number(pid)}.json`)); return j ? j.status || null : null; },
    ttyOf: (pid) => { const r = spawnSync('ps', ['-o', 'tty=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 }); const t = (r.stdout || '').trim(); return r.status === 0 && t && t !== '??' ? `/dev/${t}` : null; },
    foreground: (tty) => { const r = spawnSync('ps', ['-t', tty.replace('/dev/', ''), '-o', 'stat=,command='], { encoding: 'utf8', timeout: 5000 }); return r.status === 0 ? lines(r.stdout).filter((l) => /^\S*\+/.test(l)).map((l) => l.replace(/^\S+\s+/, '')) : null; },
    iterm: {
      sessionsOfTty: (tty) => { try { return parseItermSessions(osaRun(itermSessionsScript(tty))); } catch { return null; } },
      pane: (uid) => { try { return osaRun(paneScript(uid)); } catch { return ''; } },
      type: (uid, line) => { try { return osaRun(typeLineScript(uid, line)).trim(); } catch (e) { return `error: ${short(e.message, 60)}`; } },
      close: (uid) => { try { return osaRun(closeItermScript(uid)).trim(); } catch (e) { return `error: ${short(e.message, 60)}`; } },
    },
    kill: (target, sig) => process.kill(target, sig),
    alive: (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } },
    run: (cmd, a, o) => spawnSync(cmd, a, { encoding: 'utf8', ...o }),
    waitFor: async (fn, ms) => { const end = Date.now() + ms; for (;;) { if (await fn()) return true; if (Date.now() >= end) return false; await new Promise((r) => setTimeout(r, 500)); } },
    paused: async (sessionId) => {
      if (!sessionId) return null;
      const r = await base.get(`/api/mcp/coordination/inbox?session=${encodeURIComponent(sessionId)}&limit=1`);
      return r && r.pause ? Boolean(r.pause.paused) : null;
    },
    post: async (p, body) => {
      try {
        const { loadConfig } = await import('./noesis-ticket-session.mjs');
        const cfg = loadConfig(process.cwd());
        if (!cfg) return false;
        const res = await fetch(cfg.baseUrl + p, { method: 'POST', headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
        return res.ok;
      } catch { return false; }
    },
    closeTabs: async (ids) => { const m = await import('./coord-tabs.mjs'); return m.close({ ...args, ids }, base); },
  };
}

// ── --prove-read-only ────────────────────────────────────────────────────────

// The commands a check may run. Everything else (and git's writing subcommands) is a side effect.
const READ_GIT = new Set(['rev-parse', 'symbolic-ref', 'status', 'rev-list', 'log', 'diff', 'show', 'merge-base', 'ls-files', 'cat-file', 'for-each-ref']);
/** AppleScript texts that only read (coord-tabs.mjs adds its tab list here). */
export const READ_ONLY_SCRIPTS = new Set();
export function readOnlyCommand(cmd, args = []) {
  const name = path.basename(String(cmd));
  if (name === 'ps' || name === 'lsof' || name === 'pgrep') return true;
  if (name === 'npm') return args[0] === 'view' && args.length === 4 && args[3] === '--logs-max=0';
  if (name === 'claude') return args.length === 2 && args[0] === 'agents' && args[1] === '--json';
  if (name === 'osascript') return args.length === 2 && args[0] === '-e' && READ_ONLY_SCRIPTS.has(args[1]);
  if (name === 'git') {
    const a = args[0] === '-C' ? args.slice(2) : args;
    if (a.some((x) => /^--output(=|$)/.test(String(x)))) return false; // diff, log and show can write a file
    if (a[0] === 'symbolic-ref') return a.length === 4 && a[1] === '--quiet' && a[2] === '--short' && a[3] === 'HEAD';
    if (a[0] === 'worktree') return a.length === 3 && a[1] === 'list' && a[2] === '--porcelain';
    if (a[0] === 'branch') return a.length === 2 && (a[1] === '--list' || a[1] === '--show-current');
    return READ_GIT.has(a[0]);
  }
  return false;
}

/**
 * Make every side effect throw, and list it in `effects`: a child process that is not a read-only
 * command, a file write, delete or rename, a signal other than 0, and a fetch that is not a GET.
 * It patches the built-in modules and syncs their ESM bindings, so this file's own imports see it.
 */
export async function installReadOnlySpy(effects) {
  const { createRequire, syncBuiltinESMExports } = await import('node:module');
  const require = createRequire(import.meta.url);
  const cp = require('node:child_process');
  const fsc = require('node:fs');
  const refuse = (what) => { effects.push(short(what, 200)); throw new Error(`read-only: ${what} is a side effect`); };
  for (const fn of ['spawnSync', 'execFileSync']) {
    const orig = cp[fn];
    cp[fn] = function spy(cmd, args, ...rest) {
      return readOnlyCommand(cmd, Array.isArray(args) ? args : []) ? orig.call(this, cmd, args, ...rest) : refuse(`${fn} ${cmd} ${Array.isArray(args) ? args.join(' ') : ''}`);
    };
  }
  for (const fn of ['spawn', 'exec', 'execFile', 'execSync', 'fork']) cp[fn] = (cmd, args) => refuse(`${fn} ${cmd} ${Array.isArray(args) ? args.join(' ') : ''}`);
  // Every fs call that writes, deletes, renames, links or changes a file, sync, callback and promise forms.
  const WRITES = ['writeFile', 'appendFile', 'rename', 'rm', 'rmdir', 'unlink', 'mkdir', 'mkdtemp', 'copyFile', 'cp', 'link', 'symlink', 'truncate', 'ftruncate', 'utimes', 'futimes', 'lutimes', 'chmod', 'fchmod', 'lchmod', 'chown', 'fchown', 'lchown', 'write', 'writev'];
  for (const fn of WRITES) {
    for (const name of [fn, `${fn}Sync`]) if (typeof fsc[name] === 'function') fsc[name] = (p) => refuse(`fs.${name} ${p}`);
    if (fsc.promises && typeof fsc.promises[fn] === 'function') fsc.promises[fn] = async (p) => refuse(`fs.promises.${fn} ${p}`);
  }
  fsc.createWriteStream = (p) => refuse(`fs.createWriteStream ${p}`);
  // Opening is a write when the flags are not read-only.
  const readOnlyFlags = (f) => f === undefined || f === 'r' || f === 'rs' || f === fsc.constants.O_RDONLY;
  const { openSync, open } = fsc;
  const promisesOpen = fsc.promises.open;
  fsc.openSync = (p, flags, ...rest) => (readOnlyFlags(flags) ? openSync(p, flags, ...rest) : refuse(`fs.openSync ${p} ${flags}`));
  fsc.open = (p, flags, ...rest) => (readOnlyFlags(typeof flags === 'function' ? undefined : flags) ? open(p, flags, ...rest) : refuse(`fs.open ${p} ${flags}`));
  fsc.promises.open = async (p, flags, ...rest) => (readOnlyFlags(flags) ? promisesOpen(p, flags, ...rest) : refuse(`fs.promises.open ${p} ${flags}`));
  // stdout and stderr: when they are files, console.log writes through fs.writeSync on fd 1 and 2.
  fsc.writeSync = (fd, ...rest) => (fd === 1 || fd === 2 ? ORIGINAL_WRITE_SYNC(fd, ...rest) : refuse(`fs.writeSync fd ${fd}`));
  const kill = process.kill.bind(process);
  process.kill = (pid, sig) => (sig === 0 ? kill(pid, 0) : refuse(`kill ${pid} ${sig ?? 'SIGTERM'}`));
  // Network: only GET. fetch with a method or a Request object, and http(s).request.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (u, init) => {
    const method = String(init?.method || (u && typeof u === 'object' && 'method' in u ? u.method : 'GET')).toUpperCase();
    return method === 'GET' ? realFetch(u, init) : refuse(`${method} ${u && u.url ? u.url : u}`);
  };
  const methodOf = (a) => String((a.find((x) => x && typeof x === 'object' && !(x instanceof URL)) || {}).method || 'GET').toUpperCase();
  for (const mod of ['node:http', 'node:https']) {
    const m = require(mod);
    const req = m.request;
    m.request = (...a) => (methodOf(a) === 'GET' ? req(...a) : refuse(`${mod.slice(5)}.request ${methodOf(a)}`));
    if (typeof m.ClientRequest === 'function') {
      const CR = m.ClientRequest;
      m.ClientRequest = function ClientRequest(...a) { return methodOf(a) === 'GET' ? new CR(...a) : refuse(`${mod.slice(5)}.ClientRequest ${methodOf(a)}`); };
    }
  }
  syncBuiltinESMExports();
}
// The real fs.writeSync, kept before any spy replaces it (stdout and stderr still need it).
const ORIGINAL_WRITE_SYNC = fs.writeSync;

// ── selftest ─────────────────────────────────────────────────────────────────

/** The source text of one top-level function or const in a module's text, or null. */
function sourceOf(text, name) {
  const fn = new RegExp(`^(?:export )?function ${name}\\(`, 'm').exec(text);
  const cn = new RegExp(`^(?:export )?const ${name} = `, 'm').exec(text);
  const m = fn || cn;
  if (!m) return null;
  const rest = text.slice(m.index);
  if (cn && !fn) return rest.slice(0, rest.indexOf('\n') + 1).trim().endsWith(';') ? rest.slice(0, rest.indexOf('\n')) : rest.slice(0, rest.search(/\n\};?\n/) + 3).trim();
  return rest.slice(0, rest.search(/\n\}\n/) + 2);
}

async function selftest() {
  let failed = 0;
  const eq = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
  };

  // The copies still match coord-scan.mjs.
  const mine = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const scanText = fs.readFileSync(path.join(HERE, 'coord-scan.mjs'), 'utf8');
  for (const name of COPIED_FROM_SCAN) {
    const a = sourceOf(mine, name);
    const b = sourceOf(scanText, name);
    eq(`the copy of ${name} matches coord-scan.mjs`, Boolean(a) && a === b, true);
  }

  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coord-close-test-')));
  const cfg = path.join(root, 'claude');
  const savedCfg = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = cfg;
  const sh = (cwd, ...args) => { const r = git(cwd, args); if (!r.ok) throw new Error(`git ${args.join(' ')}: ${r.err}`); return r.out; };
  const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  const iso = (ms) => new Date(ms).toISOString();
  try {
    const NOW = Date.parse('2026-11-14T13:00:00Z');
    // A main checkout with an MCP submodule-like folder, a remote, and worktrees for TCK-1, TCK-2 and TCK-3.
    const remote = path.join(root, 'remote.git');
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    sh(root, 'init', '-q', '--bare', remote);
    sh(repo, 'init', '-q', '-b', 'main');
    sh(repo, 'config', 'user.email', 't@t'); sh(repo, 'config', 'user.name', 't'); sh(repo, 'config', 'commit.gpgsign', 'false');
    write(path.join(repo, MCP_DIR, 'package.json'), '{ "version": "2.16.0" }\n');
    write(path.join(repo, MCP_DIR, 'src', 'a.ts'), 'export const a = 1;\n');
    write(path.join(repo, MCP_DIR, 'scripts', HOOK_SCRIPT), '// hook v2\n');
    write(path.join(repo, MCP_DIR, 'skill-templates', 'noesis-chief.md'), 'chief v2\n');
    write(path.join(repo, MCP_DIR, 'skill-templates', 'noesis-ticket.md'), 'ticket v1\n');
    write(path.join(repo, 'src', 'x.ts'), 'export const x = 1;\n');
    // The MCP package is a repository of its own, as the real submodule is.
    const sub = path.join(repo, MCP_DIR);
    sh(sub, 'init', '-q', '-b', 'main'); sh(sub, 'config', 'user.email', 't@t'); sh(sub, 'config', 'user.name', 't'); sh(sub, 'config', 'commit.gpgsign', 'false');
    sh(sub, 'add', '-A'); sh(sub, 'commit', '-q', '-m', 'mcp base');
    // The parent tracks the MCP folder as a gitlink, as it tracks the real submodule.
    sh(repo, 'add', 'src', MCP_DIR); sh(repo, 'commit', '-q', '-m', 'base');
    sh(repo, 'remote', 'add', 'origin', remote); sh(repo, 'push', '-q', 'origin', 'main');
    const wt = (n) => { const p = path.join(root, `repo-tck-${n}`); sh(repo, 'worktree', 'add', '-q', '-b', `loop/tck-${n}`, p, 'main'); return p; };
    const w1 = wt(1); const w2 = wt(2); const w3 = wt(3);
    fs.mkdirSync(`${w1}-old`); // a sibling folder whose name starts with w1's
    write(path.join(repo, 'owner-notes.txt'), 'the owner\'s own file in the main checkout\n'); // never any session's work
    // TCK-1 shipped: its commit is on main and pushed, and it changed the hook (Ticket trailer).
    write(path.join(w1, 'src', 'x.ts'), 'export const x = 2;\n'); sh(w1, 'add', '-A'); sh(w1, 'commit', '-q', '-m', 'feat: one\n\nTicket: TCK-1');
    sh(repo, 'merge', '-q', '--ff-only', 'loop/tck-1'); sh(repo, 'push', '-q', 'origin', 'main');
    // TCK-2 shipped but left an uncommitted file, and a commit that is pushed to its own branch but not merged.
    write(path.join(w2, 'src', 'y.ts'), 'export const y = 1;\n'); sh(w2, 'add', 'src'); sh(w2, 'commit', '-q', '-m', 'feat: two');
    sh(w2, 'push', '-q', 'origin', 'loop/tck-2');
    write(path.join(w2, 'notes.txt'), 'draft\n'); write(path.join(w2, 'TCK-2-LOOP-STATE.md'), 'state');
    // TCK-2's MCP submodule checkout: a commit on its loop branch, and an uncommitted file.
    const w2sub = path.join(w2, MCP_DIR);
    sh(w2sub, 'init', '-q', '-b', 'main'); sh(w2sub, 'config', 'user.email', 't@t'); sh(w2sub, 'config', 'user.name', 't'); sh(w2sub, 'config', 'commit.gpgsign', 'false');
    sh(w2sub, 'commit', '-q', '--allow-empty', '-m', 'base'); sh(w2sub, 'checkout', '-q', '-b', 'loop/tck-2');
    sh(w2sub, 'commit', '-q', '--allow-empty', '-m', 'mcp two');
    write(path.join(w2sub, 'wip.txt'), 'wip\n');
    // TCK-3 is Ready to merge.

    // Sessions: s1 (TCK-1, shipped, clean), s2 (TCK-2, shipped, dirty), s3 (TCK-3 open), s4 (no ticket), s5 (busy), s6 (waiting), self.
    const sid = (n) => `0000000${n}-aaaa-4bbb-8ccc-dddddddddddd`;
    const agents = [
      { pid: 101, cwd: w1, kind: 'interactive', sessionId: sid(1), name: 'one', status: 'idle' },
      { pid: 102, cwd: repo, kind: 'interactive', sessionId: sid(2), name: 'two', status: 'idle' },
      { pid: 103, cwd: w3, kind: 'interactive', sessionId: sid(3), name: 'three', status: 'idle' },
      { pid: 104, cwd: repo, kind: 'interactive', sessionId: sid(4), name: 'four', status: 'idle' },
      { pid: 105, cwd: w1, kind: 'interactive', sessionId: sid(5), name: 'five', status: 'busy' },
      { pid: 106, cwd: repo, kind: 'interactive', sessionId: sid(6), name: 'six', status: 'waiting', waitingFor: 'permission prompt' },
      { cwd: repo, kind: 'background', sessionId: sid(7), name: 'bg', state: 'blocked' },
    ];
    // Evidence of which ticket: s1 by its binding cache (even with a stale status), s2 by its transcript, s3 by the worktree name,
    // s5 by the transcript's [tck-session] line, s6 by its loop state file.
    write(path.join(cfg, 'tck-bindings', `${sid(1)}.json`), JSON.stringify({ key: 'TCK-1', status: 'deploying', bound_session_id: sid(1) }));
    const line = (o) => JSON.stringify(o);
    const tr = (n, recs) => write(path.join(cfg, 'projects', '-repo', `${sid(n)}.jsonl`), recs.map(line).join('\n') + '\n');
    tr(1, [
      { type: 'user', timestamp: iso(NOW - 3600_000), message: { content: 'ship it' } },
      { type: 'assistant', timestamp: iso(NOW - 3500_000), message: { content: [{ type: 'tool_use', name: 'mcp__noesis__backlog_set_status', input: { key: 'TCK-1', status: 'shipped' } }] } },
    ]);
    tr(2, [
      { type: 'assistant', timestamp: iso(NOW - 7200_000), message: { content: [{ type: 'tool_use', name: 'mcp__noesis__backlog_bind', input: { key: 'TCK-2' } }] } },
      // A wakeup that already fired: not armed.
      { type: 'assistant', timestamp: iso(NOW - 3000_000), message: { content: [{ type: 'tool_use', name: 'ScheduleWakeup', input: { delaySeconds: 60, prompt: '/cc-loop resume' } }] } },
      { type: 'system', subtype: 'scheduled_task_fire', timestamp: iso(NOW - 2900_000) },
      { type: 'user', timestamp: iso(NOW - 2900_000), message: { content: '/cc-loop resume' } },
    ]);
    tr(5, [
      { type: 'user', timestamp: iso(NOW - 600_000), message: { content: 'go on\n[tck-session] This session is bound to TCK-1 (status: implementing on mac)' } },
      // A wakeup armed for 20 minutes from now.
      { type: 'assistant', timestamp: iso(NOW - 60_000), message: { content: [{ type: 'tool_use', name: 'ScheduleWakeup', input: { delaySeconds: 1200, prompt: '/cc-loop resume' } }] } },
    ]);
    const loopState = path.join(root, 'six-LOOP-STATE.md');
    write(loopState, '# x\n**Loop-state: RUNNING**\nTicket: TCK-3 bound at kickoff\n');
    write(path.join(cfg, 'loop-supervisor', `${sid(6)}.json`), JSON.stringify({ sessionId: sid(6), cwd: w3, stateFile: loopState }));

    // Processes: s1's own MCP helper and caffeinate (skipped), the owner's shell in w1 (skipped), a leftover tsx server in w1
    // (parent pid 1), s5's own vite child in w1 (another session's work for s1, its own for s5).
    // s1 was started through npx (a parent that is not a shell), and the owner has a second shell open in w1.
    const ps = new Map([
      [1, { pid: 1, ppid: 0, pgid: 1, command: 'launchd' }],
      [90, { pid: 90, ppid: 1, pgid: 90, command: '-zsh' }],
      [91, { pid: 91, ppid: 1, pgid: 91, command: '/bin/zsh -l' }],
      [95, { pid: 95, ppid: 90, pgid: 95, command: 'node /usr/local/bin/npx claude' }],
      [101, { pid: 101, ppid: 95, pgid: 101, command: 'claude --chrome' }],
      [201, { pid: 201, ppid: 101, pgid: 101, command: `node ${repo}/${MCP_DIR}/dist/index.js` }],
      [202, { pid: 202, ppid: 101, pgid: 101, command: 'caffeinate -i -t 300' }],
      // s1's own MCP-package test run: it names the MCP folder, but it is no helper.
      [203, { pid: 203, ppid: 101, pgid: 101, command: `node ${w1}/${MCP_DIR}/node_modules/.bin/vitest --watch` }],
      [300, { pid: 300, ppid: 1, pgid: 300, command: 'npm exec tsx server.ts' }],
      [301, { pid: 301, ppid: 300, pgid: 300, command: `node ${w1}/node_modules/.bin/tsx server.ts` }],
      // A leftover that looks like an MCP server, but no session started it; a command with "zsh" in it that is no shell.
      [302, { pid: 302, ppid: 1, pgid: 302, command: `node ${repo}/${MCP_DIR}/dist/index.js` }],
      [303, { pid: 303, ppid: 1, pgid: 303, command: 'python3 run.py --shell zsh' }],
      // A server in a sibling folder (w1-old): not in w1.
      [304, { pid: 304, ppid: 1, pgid: 304, command: 'node server.js' }],
      [105, { pid: 105, ppid: 90, pgid: 105, command: 'claude' }],
      [401, { pid: 401, ppid: 105, pgid: 105, command: `node ${w1}/node_modules/.bin/vite --port 3701` }],
      [102, { pid: 102, ppid: 90, pgid: 102, command: 'claude' }], [103, { pid: 103, ppid: 90, pgid: 103, command: 'claude' }],
      [104, { pid: 104, ppid: 90, pgid: 104, command: 'claude' }], [106, { pid: 106, ppid: 90, pgid: 106, command: 'claude' }],
    ]);
    const cwds = new Map([[90, w1], [91, w1], [95, w1], [101, w1], [201, w1], [202, w1], [203, w1], [300, w1], [301, `${w1}/src`], [302, w1], [303, w1], [304, `${w1}-old`], [105, w1], [401, w1], [102, repo], [103, w3], [104, repo], [106, repo]]);
    const ports = new Map([[301, [5701]], [401, [3701]]]);
    const issues = { 'TCK-1': 'shipped', 'TCK-2': 'shipped', 'TCK-3': 'ready_to_merge', 'TCK-4': 'deploying', 'TCK-10': 'shipped' };
    const portSlots = [{ slot: 1, backend_port: 5701, frontend_port: 3701, host: 'tck-2.localhost', ticket: 'TCK-2', holder: sid(2) }];
    // The stdio MCP servers Claude Code starts (CLAUDE_CONFIG_DIR/.claude.json): s1's helper 201 is one of them.
    write(path.join(cfg, '.claude.json'), JSON.stringify({ mcpServers: { noesis: { type: 'stdio', command: 'node', args: [`${repo}/${MCP_DIR}/dist/index.js`] }, web: { type: 'http', url: 'https://x' } } }));
    const calls = [];
    const baseGet = async (p) => {
      calls.push(p);
      if (p === '/api/mcp/coordination/allocations') return { allocations: [], ports: portSlots };
      if (p === '/api/mcp/coordination/leases') return { leases: [{ resource: 'ship', holder: sid(2), expired: false }], waiters: [] };
      const m = /^\/api\/mcp\/backlog\/issues\?status=([a-z_]+)$/.exec(p);
      return m ? { issues: Object.entries(issues).filter(([, v]) => v === m[1]).map(([key, work_status]) => ({ key, work_status })) } : null;
    };
    const deps = (over = {}) => ({
      agents: () => agents,
      ps: () => ps,
      cwds: () => cwds,
      ports: () => ports,
      npmLatest: () => '2.15.0',
      get: baseGet,
      now: () => NOW,
      configDir: () => cfg,
      ...over,
    });
    // The installed hook and skills: the hook differs (TCK-1 did not change it on main, so it is a follow-up), noesis-chief differs.
    write(path.join(cfg, 'hooks', HOOK_SCRIPT), '// hook v1\n');
    write(path.join(cfg, 'commands', 'noesis-chief.md'), 'chief v1\n');
    write(path.join(cfg, 'commands', 'noesis-ticket.md'), 'ticket v1\n');

    const r = await check({ configRepo: null, repo, all: true }, deps());
    const by = (n) => r.sessions.find((s) => s.sessionId === sid(n));
    const codes = (n) => by(n).reasons.map((x) => x.code);
    eq('only interactive sessions are checked (the background agent has no terminal)', r.sessions.length, 6);
    write(path.join(cfg, 'tck-bindings', `${sid(7)}.json`), JSON.stringify({ key: 'TCK-3', status: 'implementing' }));
    const G = await gather({ configRepo: null, repo, all: true, withTabs: false }, deps());
    eq('gather keeps the facts of a background agent too (its loop still works on its ticket)', [G.bySid.has(sid(7)), G.bySid.get(sid(7)) && G.bySid.get(sid(7)).ev.key], [true, 'TCK-3']);
    fs.rmSync(path.join(cfg, 'tck-bindings', `${sid(7)}.json`));
    eq('s1: the ticket comes from the binding cache, with the transcript as second evidence', by(1).ticket, { key: 'TCK-1', status: 'shipped', by: ['binding-cache', 'transcript', 'worktree-name'] });
    eq('s1: a shipped, clean session with no answer yet waits for the ask and for the processes in its worktree', codes(1), ['process', 'process', 'process', 'process', 'process', 'answer-missing']);
    eq('s1: its own MCP test run, the leftover tsx server and its npm parent, a stray MCP-looking server and a non-shell "zsh" command all count', by(1).reasons.filter((x) => x.code === 'process').map((x) => x.pid), [203, 300, 301, 302, 303]);
    eq('s1: its MCP server and caffeinate (direct children, configured) do not count; its own test run is marked as its own, a leftover is not', [by(1).reasons.some((x) => x.pid === 201 || x.pid === 202), /^its own process/.test(by(1).reasons[0].text), /^a process/.test(by(1).reasons[1].text)], [false, true, true]);
    eq('a process in a sibling folder whose name starts with the worktree\'s is not in the worktree', r.sessions.some((s) => s.reasons.some((x) => x.pid === 304)), false);
    eq('the machine-wide items are listed once, as follow-ups, and are no session\'s reason', [r.followUps.map((f) => f.code), by(1).followUps], [['npm', 'hook', 'skills'], []]);
    eq('an installed skill with no claude-config copy is compared with the package template', r.followUps[2].text, 'installed skills differ from their source: noesis-chief.md (package)');
    eq('s2: the ticket comes from the transcript; its session ran in the main checkout, so its work is the tck-2 worktree', [by(2).ticket.key, path.basename(by(2).worktree)], ['TCK-2', 'repo-tck-2']);
    eq('s2: uncommitted work, commits not on main (in the worktree and its MCP checkout), a port slot and a lease keep it open', codes(2), ['uncommitted', 'not-on-main', 'not-on-main', 'port', 'lease', 'answer-missing']);
    eq('s2: the uncommitted list leaves out the loop state file and includes the MCP checkout\'s file', by(2).reasons[0].files, ['notes.txt', `${MCP_DIR}/wip.txt`]);
    eq('s2: a commit pushed to its own branch but not merged is still not on main', by(2).reasons[1].text, '1 commit in repo-tck-2 is not on main');
    eq('s2: a wakeup that already fired is not armed', codes(2).includes('wakeup'), false);
    eq('s3: a Ready to merge ticket found by the worktree name waits for the owner', [by(3).ticket.key, by(3).reasons[0].code, by(3).reasons[0].fixer], ['TCK-3', 'ticket-open', 'owner']);
    eq('s4: no ticket and nothing left: maybe', [by(4).verdict, by(4).reasons.length, by(4).followUps[0].code], ['maybe', 0, 'no-ticket']);
    eq('s5: busy, and a wakeup armed for later', ['busy', 'wakeup'].every((c) => codes(5).includes(c)), true);
    eq('s5: its own vite child runs from the worktree', by(5).reasons.some((x) => x.code === 'process' && x.pid === 401), true);
    eq('s1 does not count s5\'s vite as its own leftover', by(1).reasons.some((x) => x.pid === 401), false);
    eq('s6: waiting at a permission prompt, its loop still RUNNING, ticket from the loop state file', [codes(6).includes('waiting'), codes(6).includes('loop-running'), by(6).ticket.by[0]], [true, true, 'loop-state']);

    // record: the answer makes s1 "yes" once the leftover is gone; a later owner prompt makes it stale.
    const cwds2 = new Map([...cwds].filter(([p]) => ![203, 300, 301, 302, 303].includes(p)));
    record({ sessionId: sid(1), verdict: 'yes', now: NOW - 1000 });
    const r2 = await check({ configRepo: null, repo, session: sid(1) }, deps({ cwds: () => cwds2 }));
    eq('a fresh "yes" answer and nothing left: yes', [r2.sessions[0].verdict, r2.sessions[0].reasons], ['yes', []]);
    tr(1, [
      { type: 'assistant', timestamp: iso(NOW - 3500_000), message: { content: [{ type: 'tool_use', name: 'mcp__noesis__backlog_set_status', input: { key: 'TCK-1', status: 'shipped' } }] } },
      { type: 'user', timestamp: iso(NOW - 500), isMeta: true, message: { content: 'meta' } },
      { type: 'attachment', timestamp: iso(NOW - 450), attachment: { type: 'hook_additional_context', content: ['[tck-session] This session is bound to TCK-1 (status: shipped on mac).'] } },
      { type: 'user', timestamp: iso(NOW - 400), message: { content: '<task-notification>done</task-notification>' } },
      { type: 'user', timestamp: iso(NOW - 390), message: { content: '<system-reminder>x</system-reminder>' } },
      { type: 'user', timestamp: iso(NOW - 380), message: { content: '<local-command-stdout>ok</local-command-stdout>' } },
      { type: 'attachment', timestamp: iso(NOW - 370), attachment: { type: 'queued_command', commandMode: 'task-notification', origin: { kind: 'task-notification' }, prompt: 'x' } },
      { type: 'system', subtype: 'scheduled_task_fire', timestamp: iso(NOW - 300) },
      { type: 'user', timestamp: iso(NOW - 300), message: { content: '/cc-loop resume' } },
      // A free-text wakeup prompt is a meta record; it still ends the fire.
      { type: 'system', subtype: 'scheduled_task_fire', timestamp: iso(NOW - 250) },
      { type: 'user', timestamp: iso(NOW - 250), isMeta: true, message: { content: 'check the build' } },
    ]);
    const r3 = await check({ configRepo: null, repo, session: sid(1) }, deps({ cwds: () => cwds2 }));
    eq('a meta record, a hook line, a task notification, a system reminder, a local command and a wakeup prompt do not make the answer stale', r3.sessions[0].verdict, 'yes');
    tr(1, [{ type: 'user', timestamp: iso(NOW - 200), message: { content: 'one more thing' } }]);
    const r4 = await check({ configRepo: null, repo, session: sid(1) }, deps({ cwds: () => cwds2 }));
    eq('a real owner prompt after the answer makes it stale', r4.sessions[0].reasons.map((x) => x.code), ['answer-stale']);
    // After a free-text (meta) wakeup prompt, the owner's next prompt still counts.
    tr(1, [
      { type: 'system', subtype: 'scheduled_task_fire', timestamp: iso(NOW - 600) },
      { type: 'user', timestamp: iso(NOW - 600), isMeta: true, message: { content: 'check the build' } },
      { type: 'assistant', timestamp: iso(NOW - 500), message: { content: [{ type: 'text', text: 'The build is green.' }] } },
      { type: 'user', timestamp: iso(NOW - 200), message: { content: 'are you done?' } },
    ]);
    const r4c = await check({ configRepo: null, repo, session: sid(1) }, deps({ cwds: () => cwds2 }));
    eq('a meta wakeup prompt does not swallow the owner\'s next prompt', r4c.sessions[0].reasons.map((x) => x.code), ['answer-stale']);
    // The real shape of a /loop wakeup (measured on 127 fires): a meta note, the command, the skill body, then the reply.
    tr(1, [
      { type: 'system', subtype: 'scheduled_task_fire', timestamp: iso(NOW - 600), content: 'Claude resuming /loop wakeup' },
      { type: 'user', timestamp: iso(NOW - 600), isMeta: true, message: { content: '[1 prior /loop wakeup found nothing active]' } },
      { type: 'user', timestamp: iso(NOW - 599), message: { content: '<command-message>cc-loop</command-message>\n<command-name>/cc-loop</command-name>\n<command-args>resume</command-args>' } },
      { type: 'user', timestamp: iso(NOW - 599), isMeta: true, message: { content: [{ type: 'text', text: '# /cc-loop — skill body' }] } },
      { type: 'assistant', timestamp: iso(NOW - 500), message: { content: [{ type: 'text', text: 'Resuming.' }] } },
    ]);
    const r4d = await check({ configRepo: null, repo, session: sid(1) }, deps({ cwds: () => cwds2 }));
    eq('a /loop wakeup of the real shape (meta note, command, skill body) does not make the answer stale', r4d.sessions[0].reasons, []);
    for (const [bad, name] of [[{ verdict: 'maybe', at: iso(NOW) }, 'a verdict other than yes or no'], [{ verdict: 'yes', at: 'soon' }, 'a time that does not parse']]) {
      const f = path.join(closeDir(), `${sid(1)}.json`);
      const keep1 = fs.readFileSync(f, 'utf8');
      fs.writeFileSync(f, JSON.stringify({ sessionId: sid(1), ...bad }));
      const rb = await check({ configRepo: null, repo, session: sid(1) }, deps({ cwds: () => cwds2 }));
      eq(`an answer with ${name} is no answer`, rb.sessions[0].reasons.map((x) => x.code), ['answer-missing']);
      fs.writeFileSync(f, keep1);
    }
    tr(1, [{ type: 'attachment', timestamp: iso(NOW - 100), attachment: { type: 'queued_command', origin: { kind: 'human' }, prompt: 'x' } }]);
    record({ sessionId: sid(1), verdict: 'yes', now: NOW - 150 });
    const r4b = await check({ configRepo: null, repo, session: sid(1) }, deps({ cwds: () => cwds2 }));
    eq('a prompt the owner typed while a turn ran (a queued command) also makes the answer stale', r4b.sessions[0].reasons.map((x) => x.code), ['answer-stale']);
    record({ sessionId: sid(1), verdict: 'no', left: ['the owner must run npm publish'], now: NOW - 150 });
    const r5 = await check({ configRepo: null, repo, session: sid(1) }, deps({ cwds: () => cwds2 }));
    eq('a "no" answer is a reason with the session\'s words', [r5.sessions[0].reasons[0].code, /npm publish/.test(r5.sessions[0].reasons[0].text)], ['answer-no', true]);
    const kept = readJson(path.join(closeDir(), `${sid(1)}.json`));
    fs.writeFileSync(path.join(closeDir(), `${sid(1)}.json`), JSON.stringify({ ...kept, askedAt: iso(NOW - 5000) }));
    record({ sessionId: sid(1), verdict: 'yes', now: NOW });
    eq('record keeps askedAt', readJson(path.join(closeDir(), `${sid(1)}.json`)).askedAt, iso(NOW - 5000));
    eq('sessionOfPid reads ~/.claude/sessions/<pid>.json first, then claude agents', [(() => { write(path.join(cfg, 'sessions', '104.json'), JSON.stringify({ sessionId: sid(4) })); return sessionOfPid(104, deps()); })(), sessionOfPid(103, deps())], [sid(4), sid(3)]);

    // A session with no ticket that said yes is still "maybe": only it can confirm, and its words are shown.
    record({ sessionId: sid(4), verdict: 'yes', now: NOW });
    const r5b = await check({ configRepo: null, repo, session: sid(4) }, deps());
    eq('no ticket and a fresh "yes": still maybe, with the session\'s answer in the note', [r5b.sessions[0].verdict, /said yes/.test(r5b.sessions[0].followUps[0].text)], ['maybe', true]);

    // Which ticket, when the evidence disagrees or the key has more digits.
    const extra = [9, 10, 11, 12, 13].map((n) => ({ pid: 100 + n, cwd: repo, kind: 'interactive', sessionId: sid(n), name: `s${n}`, status: 'idle' }));
    const bindThenSet = [
      { type: 'assistant', timestamp: iso(NOW - 9000), message: { content: [{ type: 'tool_use', name: 'mcp__noesis__backlog_bind', input: { key: 'TCK-1' } }] } },
      { type: 'assistant', timestamp: iso(NOW - 8000), message: { content: [{ type: 'tool_use', name: 'mcp__noesis__backlog_set_status', input: { key: 'TCK-2', status: 'shipped' } }] } },
    ];
    write(path.join(cfg, 'tck-bindings', `${sid(9)}.json`), JSON.stringify({ key: 'TCK-3', status: 'ready_to_merge' }));
    tr(9, bindThenSet);
    tr(10, bindThenSet);
    tr(11, [{ type: 'attachment', timestamp: iso(NOW - 7000), attachment: { type: 'hook_additional_context', content: ['[tck-session] This session is bound to TCK-10 (status: implementing on mac).'] } }]);
    const loop12 = path.join(root, 'twelve-LOOP-STATE.md');
    write(loop12, '# x\n**Loop-state: COMPLETE**\nTicket: TCK-10 bound at kickoff\n');
    write(path.join(cfg, 'loop-supervisor', `${sid(12)}.json`), JSON.stringify({ sessionId: sid(12), cwd: repo, stateFile: loop12 }));
    write(path.join(cfg, 'tck-bindings', `${sid(13)}.json`), JSON.stringify({ key: 'TCK-4', status: 'deploying' }));
    const rx = await check({ configRepo: null, repo, all: true }, deps({ agents: () => [...agents, ...extra], cwds: () => cwds2 }));
    const keyOf = (n) => { const s = rx.sessions.find((x) => x.sessionId === sid(n)); return s.ticket && s.ticket.key; };
    eq('the binding cache wins over the transcript; the transcript\'s last key wins over its first', [keyOf(9), keyOf(10)], ['TCK-3', 'TCK-2']);
    eq('TCK-10 in a [tck-session] line and in a loop state file is TCK-10, not TCK-1', [keyOf(11), keyOf(12)], ['TCK-10', 'TCK-10']);
    eq('a ticket at Deploying is open, not closed', rx.sessions.find((x) => x.sessionId === sid(13)).reasons[0].text, 'TCK-4 is at deploying');

    // ── ask and close (INC-3), with a fake iTerm, processes and API ──
    const rule = '─'.repeat(40);
    const paneOf = (composer, bar = '  ⏵⏵ bypass permissions on (shift+tab to cycle)') => ['✻ Cooked for 1m', rule, `❯ ${composer}`, rule, '  🎯 x · y', bar].join('\n');
    eq('composerText: the empty prompt, its dim suggestion, typed text, and no prompt box', [composerText(paneOf('')), composerText(paneOf('Try "write a test for <filepath>"')), composerText(paneOf('half typed')), composerText(paneOf('Try "x" and more')), composerText('no box here')], ['', '', 'half typed', 'Try "x" and more', null]);
    eq('backgroundWork: shells and agents in the status bar', [backgroundWork(paneOf('', '  ⏵⏵ bypass permissions on · 1 shell · ← 2 agents')), backgroundWork(paneOf(''))], [{ shells: 1, agents: 2 }, { shells: 0, agents: 0 }]);
    eq('composerText reads the last prompt box, not an earlier rule in the output', composerText(['old output', rule, 'a table row', rule, '✻ done', rule, '❯ ', rule, '  bar'].join('\n')), '');
    eq('backgroundWork reads only the status bar below the prompt box', backgroundWork(['it said: · 3 shells running', rule, '❯ ', rule, '  ⏵⏵ bypass permissions on'].join('\n')), { shells: 0, agents: 0 });
    eq('the typing script sends the line without a newline, waits 1.5 s, then a bare Enter', [/write s text "x" newline no\n\s*delay 1\.5\n\s*write s text ""/.test(typeLineScript('U', 'x'))], [true]);
    eq('parseItermSessions', parseItermSessions(`ABC-1${US}1${RS2}DEF-2${US}2${RS2}`), [{ uid: 'ABC-1', inTab: 1 }, { uid: 'DEF-2', inTab: 2 }]);
    const acts = [];
    const actFake = (over = {}) => ({
      ...deps({ agents: () => [...agents, ...extra], cwds: () => cwds }),
      sessionStatus: () => 'idle',
      ttyOf: () => '/dev/ttys999',
      foreground: () => ['-zsh'],
      iterm: { sessionsOfTty: () => [{ uid: 'UID-1', inTab: 1 }], pane: () => paneOf(''), type: (uid, line) => { acts.push(['type', uid, line]); return 'typed'; }, close: (uid) => { acts.push(['close', uid]); return 'closed'; } },
      kill: (t, sig) => { acts.push(['kill', t, sig]); },
      alive: (pid) => !acts.some((a) => (a[0] === 'kill' && (a[1] === pid || a[1] === -pid || (ps.get(pid) && a[1] === -ps.get(pid).pgid))) || (a[0] === 'type' && a[2] === '/exit' && pid === 101)),
      run: () => ({ status: 0 }),
      waitFor: async (fn) => Boolean(await fn()),
      paused: async () => false,
      post: async (p2, body) => { acts.push(['post', p2, body]); return true; },
      closeTabs: async (ids) => { acts.push(['tabs', ids]); return { closed: ids.map((id) => ({ id })), refused: [] }; },
      ...over,
    });
    const typed = () => acts.filter((a) => a[0] === 'type');
    // s11 (TCK-10 shipped, idle, no answer): the ask is typed once, askedAt is written first.
    acts.length = 0;
    const a1 = await ask({ configRepo: null, repo, session: sid(11), selfPid: 1 }, actFake());
    eq('ask: an idle session with a closed ticket and no answer is asked, once', [a1.asked, typed().length, typed()[0] && typed()[0][2].startsWith(ASK_PHRASE), typed()[0] && typed()[0][2].includes(` --repo ${mainCheckout(repo)}`), Boolean((readJson(path.join(closeDir(), `${sid(11)}.json`)) || {}).askedAt)], [true, 1, true, true, true]);
    const a2 = await ask({ configRepo: null, repo, session: sid(11), selfPid: 1 }, actFake());
    fs.rmSync(path.join(closeDir(), `${sid(11)}.json`), { force: true });
    const a3 = await ask({ configRepo: null, repo, session: sid(11), selfPid: 1 }, actFake({ iterm: { ...actFake().iterm, type: () => 'gone' } }));
    eq('ask: when iTerm2 cannot type, it is not asked, and askedAt still stands (it is never asked twice)', [a3.asked, Boolean((readJson(path.join(closeDir(), `${sid(11)}.json`)) || {}).askedAt)], [false, true]);
    eq('ask: never twice (askedAt)', [a2.asked, /already asked/.test(a2.why), typed().length], [false, true, 1]);
    fs.rmSync(path.join(closeDir(), `${sid(11)}.json`));
    acts.length = 0;
    const am = await ask({ configRepo: null, repo, session: sid(11), selfPid: 1, byMessage: true }, actFake());
    const am2 = await ask({ configRepo: null, repo, session: sid(11), selfPid: 1, byMessage: true }, actFake());
    eq('ask --by-message: no keystroke, askedAt written, the line and the name returned; never twice', [am.asked, am.by, am.name, am.line.startsWith(ASK_PHRASE) && am.line.includes(' --repo '), typed().length, (readJson(path.join(closeDir(), `${sid(11)}.json`)) || {}).askedBy, am2.asked], [true, 'message', 's11', true, 0, 'message', false]);
    fs.rmSync(path.join(closeDir(), `${sid(11)}.json`));
    { const r = await ask({ configRepo: null, repo, session: sid(11), selfPid: 1, byMessage: true }, actFake({ sessionStatus: () => 'busy' })); eq('ask --by-message refuses a session that turned busy, and writes nothing', [r.asked, fs.existsSync(path.join(closeDir(), `${sid(11)}.json`))], [false, false]); }
    const refuseClose0 = async (name, n, re) => { acts.length = 0; const r = await closeSession({ configRepo: null, repo, session: sid(n), selfPid: 1 }, actFake()); eq(`close refuses ${name}, and changes nothing`, [r.closed, re.test(r.why || ''), acts.length], [false, true, 0]); };
    const refuseAsk = async (name, n, fake, re) => { acts.length = 0; const r = await ask({ configRepo: null, repo, session: sid(n), selfPid: 1 }, fake); eq(`ask refuses ${name}, and types nothing`, [r.asked, re.test(r.why || ''), typed().length], [false, true, 0]); };
    fs.rmSync(path.join(closeDir(), `${sid(11)}.json`), { force: true });
    await refuseAsk('a session whose prompt line has text', 11, actFake({ iterm: { ...actFake().iterm, pane: () => paneOf('my own words') } }), /prompt line shows text/);
    await refuseAsk('a session whose prompt line cannot be read', 11, actFake({ iterm: { ...actFake().iterm, pane: () => 'no box' } }), /cannot be read/);
    await refuseAsk('a session with two iTerm sessions on its tty', 11, actFake({ iterm: { ...actFake().iterm, sessionsOfTty: () => [{ uid: 'A', inTab: 1 }, { uid: 'B', inTab: 1 }] } }), /2 iTerm sessions/);
    await refuseAsk('a session with a background shell running', 11, actFake({ iterm: { ...actFake().iterm, pane: () => paneOf('', '  · 1 shell') } }), /background shell/);
    { acts.length = 0; const r = await ask({ configRepo: null, repo, session: sid(11), selfPid: 1 }, actFake({ iterm: { ...actFake().iterm, pane: () => paneOf('Try "write a test for <filepath>"', '  ⏵⏵ bypass permissions on · ← 1 agent') } })); eq('ask: the prompt\'s dim suggestion and the "← 1 agent" of a new session do not block', [r.asked, typed().length], [true, 1]); fs.rmSync(path.join(closeDir(), `${sid(11)}.json`)); }
    await refuseAsk('a session that turned busy just before', 11, actFake({ sessionStatus: () => 'busy' }), /status is now busy/);
    eq('a refused ask writes no askedAt', fs.existsSync(path.join(closeDir(), `${sid(11)}.json`)), false);
    // The only thing s11 lacks is its answer: close refuses it (the Chief asks first).
    await refuseClose0('a session whose only reason is that it has not answered', 11, /has not answered/);
    write(path.join(closeDir(), `${sid(11)}.json`), JSON.stringify({ sessionId: sid(11), verdict: 'yes', at: iso(NOW) }));
    await refuseAsk('a session that has already answered (the owner asked it)', 11, actFake(), /already answered/);
    fs.rmSync(path.join(closeDir(), `${sid(11)}.json`));
    write(loop12, '# x\n**Loop-state: RUNNING**\nTicket: TCK-10 bound at kickoff\n');
    await refuseAsk('an idle session whose loop still runs', 12, actFake(), /not done: its loop is still RUNNING/);
    write(loop12, '# x\n**Loop-state: COMPLETE**\nTicket: TCK-10 bound at kickoff\n');
    await refuseAsk('a busy session', 5, actFake(), /not idle/);
    await refuseAsk('a session with an open ticket', 3, actFake(), /not closed/);
    await refuseAsk('a session with no ticket', 4, actFake(), /no ticket/);
    { acts.length = 0; const r = await ask({ configRepo: null, repo, session: sid(11), selfPid: 111 }, actFake()); eq("ask refuses the Chief's own session (by pid)", [r.asked, typed().length], [false, 0]); }
    { acts.length = 0; const under = new Map([...ps, [111, { pid: 111, ppid: 1, pgid: 111, command: 'claude' }], [process.pid, { pid: process.pid, ppid: 111, pgid: 1, command: 'node coord-close.mjs ask' }]]); const r = await ask({ configRepo: null, repo, session: sid(11) }, actFake({ ps: () => under })); eq("ask without --self-pid refuses the claude process it runs under (the Chief's own session)", [r.asked, /Chief's own session/.test(r.why || ''), typed().length], [false, true, 0]); }
    { acts.length = 0; const under = new Map([...ps, [process.pid, { pid: process.pid, ppid: 101, pgid: 1, command: 'node coord-close.mjs close' }]]); const r = await closeSession({ configRepo: null, repo, session: sid(1) }, actFake({ ps: () => under })); eq("close without --self-pid refuses the claude process it runs under (the Chief's own session), and changes nothing", [r.closed, /Chief's own session/.test(r.why || ''), acts.length], [false, true, 0]); }
    { acts.length = 0; const r = await ask({ configRepo: null, repo, session: sid(11), selfPid: 1 }, actFake({ ps: () => null })); eq('ask refuses a session whose facts cannot be read (facts-failed)', [r.asked, /not done: the check could not read the processes/.test(r.why || ''), typed().length], [false, true, 0]); }
    // close s1 (TCK-1 shipped, a fresh yes): its processes are stopped (groups when the leader is one of them), /exit typed once, the iTerm tab closed, gone reported.
    acts.length = 0;
    const c1 = await closeSession({ configRepo: null, repo, session: sid(1), selfPid: 1 }, actFake());
    eq('close: a ready session is closed', [c1.closed, c1.resume], [true, `claude --resume ${sid(1)}`]);
    eq('close: its processes get SIGTERM, a group only when its leader is one of them, never the session\'s own group', acts.filter((a) => a[0] === 'kill').map((a) => a[1]), [203, -300, -302, -303]);
    eq('close: /exit is typed once, the iTerm session closed by its uid, gone reported with its full folder', [typed().map((a) => a[2]), acts.filter((a) => a[0] === 'close').map((a) => a[1]), acts.filter((a) => a[0] === 'post').map((a) => [a[1], a[2].state, a[2].session_id, a[2].cwd])], [['/exit'], ['UID-1'], [['/api/mcp/coordination/sessions/heartbeat', 'gone', sid(1), w1]]]);
    const refuseClose = async (name, n, fake, re) => { acts.length = 0; const r = await closeSession({ configRepo: null, repo, session: sid(n), selfPid: 1 }, fake); eq(`close refuses ${name}, and changes nothing`, [r.closed, re.test(r.why || ''), acts.filter((a) => a[0] !== 'post' || true).length], [false, true, 0]); };
    await refuseClose('while the owner\'s pause is in force', 1, actFake({ paused: async () => true }), /paused/);
    await refuseClose("when the owner's pause cannot be read", 1, actFake({ paused: async () => null }), /cannot be read/);
    { const got = []; acts.length = 0; await closeSession({ configRepo: null, repo, session: sid(1), selfPid: 104 }, actFake({ paused: async (id) => { got.push(id); return true; } })); eq("close reads the pause from the inbox of the Chief's own session", [got, acts.length], [[sid(4)], 0]); }
    await refuseClose('a session that shares its tab with another pane', 1, actFake({ iterm: { ...actFake().iterm, sessionsOfTty: () => [{ uid: 'UID-1', inTab: 2 }] } }), /shares its iTerm tab/);
    await refuseClose('a session with text in its prompt line', 1, actFake({ iterm: { ...actFake().iterm, pane: () => paneOf('wait') } }), /prompt line shows text/);
    await refuseClose('a busy session', 5, actFake(), /not idle/);
    await refuseClose('a waiting session', 6, actFake(), /not idle/);
    await refuseClose('a session whose check says no (an open ticket)', 3, actFake(), /check says no/);
    await refuseClose('a session that has not answered', 2, actFake(), /check says no/);
    { acts.length = 0; const r = await closeSession({ configRepo: null, repo, session: sid(1), selfPid: 101 }, actFake()); eq("close refuses the Chief's own session", [r.closed, acts.length], [false, 0]); }
    { let n = 0; acts.length = 0; const r = await closeSession({ configRepo: null, repo, session: sid(1), selfPid: 1 }, actFake({ sessionStatus: () => (++n === 1 ? 'idle' : 'busy') })); eq('close: the status is read again just before /exit: a session that turned busy gets no /exit', [r.closed, /status is now busy/.test(r.why || ''), typed().length], [false, true, 0]); }
    { acts.length = 0; const r = await closeSession({ configRepo: null, repo, session: sid(1), selfPid: 1 }, actFake({ ps: () => null })); eq('close: a fact the check cannot read (facts-failed) blocks it', [r.closed, /could not read the processes/.test(r.why || ''), acts.length], [false, true, 0]); }
    { acts.length = 0; const r = await closeSession({ configRepo: null, repo, session: sid(1), selfPid: 1 }, actFake({ get: async (p) => (p.endsWith('status=shipped') ? null : baseGet(p)) })); eq('close: an unreadable ticket status (fixer chief, but not one close fixes) blocks it', [r.closed, /could not read TCK-1/.test(r.why || ''), acts.length], [false, true, 0]); }
    { record({ sessionId: sid(3), verdict: 'yes', now: NOW }); acts.length = 0; const r = await closeSession({ configRepo: null, repo, session: sid(3), selfPid: 1 }, actFake()); eq('close: an open ticket blocks it even with a recorded yes', [r.closed, /Ready to merge/.test(r.why || ''), acts.length], [false, true, 0]); fs.rmSync(path.join(closeDir(), `${sid(3)}.json`)); }
    { acts.length = 0; const slotGet = async (p) => (p === '/api/mcp/coordination/allocations' ? { allocations: [], ports: [{ slot: 9, backend_port: 5709, frontend_port: 3709, host: 'tck-1.localhost', ticket: 'TCK-1', holder: 'h-1' }] } : baseGet(p)); const r = await closeSession({ configRepo: null, repo, session: sid(1), selfPid: 1 }, actFake({ get: slotGet, tabs: async () => ({ tabs: [{ id: 77, ticket: 'TCK-1', label: 'done', openedBy: null }], nonLocalBySession: {} }) })); eq('close: its port slot is released and its tabs go to the tab closer', [r.closed, acts.filter((a) => a[0] === 'post' && /port\/release/.test(a[1])).map((a) => a[2]), acts.filter((a) => a[0] === 'tabs').map((a) => a[1])], [true, [{ holder: 'h-1', ticket: 'TCK-1' }], [[77]]]); }
    { const seen = []; const d = actDeps({}, { ...realDeps({}), get: async (p) => { seen.push(p); return { pause: { paused: false } }; } }); eq('the real pause read asks the server for this session\'s inbox, and no session id reads as unknown', [await d.paused('abc-123'), await d.paused(null), seen], [false, null, ['/api/mcp/coordination/inbox?session=abc-123&limit=1']]); }
    eq('the iTerm scripts: by unique id, by tty, the tab count, and the shared-tab guard before close', [/if \(\(unique id of s\) as text\) is "U-1" then/.test(paneScript('U-1')), /if \(\(unique id of s\) as text\) is "U-1" then/.test(typeLineScript('U-1', 'x')), /if \(tty of s\) is "\/dev\/ttys1" then/.test(itermSessionsScript('/dev/ttys1')), /set n to count of sessions of t/.test(itermSessionsScript('/dev/ttys1')), /if \(count of sessions of t\) is not 1 then return "shared"\n\s*close s/.test(closeItermScript('U-1'))], [true, true, true, true, true]);
    { const fakePs = new Map([[process.pid, { pid: process.pid, ppid: 4242, pgid: 1, command: 'node coord-close.mjs' }], [4242, { pid: 4242, ppid: 1, pgid: 1, command: '/usr/local/bin/claude --resume x' }]]); eq("chiefPid: --self-pid first, else the claude process this script runs under, else none", [chiefPid({ selfPid: 7 }, { ps: () => fakePs }), chiefPid({}, { ps: () => fakePs }), chiefPid({}, { ps: () => null })], [7, 4242, null]); }
    eq('the ask line names the main checkout for the session\'s own check', askLine('/main/repo').includes('check --pid $PPID --repo /main/repo'), true);
    eq("the ask line quotes a path with a space or a quote as one shell word", [askLine('/a b/c').includes("--repo '/a b/c'"), shq("/it's"), shq('/plain/path-1.x')], [true, "'/it'\\''s'", '/plain/path-1.x']);
    eq('close itself fixes exactly these three reasons; every other reason blocks', FIXED_BY_CLOSE, ['process', 'port', 'tabs']);
    { acts.length = 0; const r = await closeSession({ configRepo: null, repo, session: sid(1), selfPid: 1 }, actFake({ tabs: async () => ({ tabs: [], nonLocalBySession: { [sid(1)]: 1 } }) })); eq('close: a tabs reason the session must fix (its own non-local tab) blocks it: only fixer chief goes on', [r.closed, /other Chrome tab/.test(r.why || ''), acts.length], [false, true, 0]); }
    { acts.length = 0; const r = await closeSession({ configRepo: null, repo, session: sid(1), selfPid: 1 }, actFake({ alive: (pid) => pid === 101 })); eq('close: a session that does not exit gets no second keystroke', [r.closed, /did not end/.test(r.why), typed().length], [false, true, 1]); }
    { acts.length = 0; const r = await closeSession({ configRepo: null, repo, session: sid(1), selfPid: 1 }, actFake({ foreground: () => ['-zsh', 'vim notes.txt'] })); eq('close: its iTerm tab stays open when something other than a shell runs there', [r.closed, acts.some((a) => a[0] === 'close'), r.steps.some((x) => /left its iTerm tab open/.test(x))], [true, false, true]); }
    { acts.length = 0; const r = await closeSession({ configRepo: null, repo, session: sid(1), selfPid: 1 }, actFake({ alive: () => true })); eq('close: a process that survives SIGTERM stops the close before /exit', [r.closed, /still running/.test(r.why), typed().length], [false, true, 0]); }
    { const moved = new Map([...cwds]); moved.set(303, `${root}/elsewhere`); let reads = 0; acts.length = 0; const r = await closeSession({ configRepo: null, repo, session: sid(1), selfPid: 1 }, actFake({ cwds: () => (++reads === 1 ? cwds : moved) })); eq('close: a process that moved out of the worktree between the two reads stops the close before any signal', [r.closed, /no longer runs from/.test(r.why || ''), acts.length], [false, true, 0]); }
    { const moved = new Map([...cwds]); moved.set(303, `${w1}-old`); let reads = 0; acts.length = 0; const r = await closeSession({ configRepo: null, repo, session: sid(1), selfPid: 1 }, actFake({ cwds: () => (++reads === 1 ? cwds : moved) })); eq('close: a process that moved to a sibling folder with the same name start (<worktree>-old) also stops the close', [r.closed, /no longer runs from/.test(r.why || ''), acts.length], [false, true, 0]); }
    { const changed = new Map([...ps]); changed.set(302, { ...ps.get(302), command: 'node /other/thing.js' }); let reads = 0; acts.length = 0; const r = await closeSession({ configRepo: null, repo, session: sid(1), selfPid: 1 }, actFake({ ps: () => (++reads === 1 ? ps : changed) })); eq('close: a process whose command changed stops the close before any signal', [r.closed, /another command/.test(r.why || ''), acts.length], [false, true, 0]); }

    // Own MCP work: a ticket whose commits changed the MCP source and the hook, with the version not on npm.
    write(path.join(sub, 'src', 'a.ts'), 'export const a = 2;\n'); write(path.join(sub, 'scripts', HOOK_SCRIPT), '// hook v3\n');
    write(path.join(sub, 'skill-templates', 'noesis-ticket.md'), 'ticket v2\n');
    sh(sub, 'add', '-A'); sh(sub, 'commit', '-q', '-m', 'feat(mcp): one more\n\nTicket: TCK-1');
    write(path.join(sub, 'scripts', 'other.mjs'), '// other\n');
    sh(sub, 'add', '-A'); sh(sub, 'commit', '-q', '-m', 'feat(mcp): another ticket\n\nTicket: TCK-10');
    const distDir = path.join(repo, MCP_DIR, 'dist');
    write(path.join(distDir, 'index.js'), '// old build\n');
    fs.utimesSync(path.join(distDir, 'index.js'), new Date(NOW - 86400_000), new Date(NOW - 86400_000));
    const r6 = await check({ configRepo: null, repo, session: sid(1) }, deps({ cwds: () => cwds2 }));
    eq('own MCP work: unpublished, stale build and stale hook are its reasons; the machine-wide list still names them once', [r6.sessions[0].reasons.map((x) => x.code), r6.followUps.map((f) => f.code)], [['mcp-unpublished', 'mcp-dist-stale', 'hook-stale', 'skill-stale'], ['npm', 'dist', 'hook', 'skills']]);
    eq('the stale skill is the one the ticket changed', r6.sessions[0].reasons.find((x) => x.code === 'skill-stale').text, 'the installed skill noesis-ticket.md differs from main\'s package');
    const r6b = await check({ configRepo: null, repo, session: sid(2) }, deps({ cwds: () => cwds2 }));
    eq('another ticket\'s session gets no MCP reason for TCK-1\'s work', r6b.sessions[0].reasons.some((x) => /^(mcp-|hook-|skill-)/.test(x.code)), false);
    const r6c = await check({ configRepo: null, repo, session: sid(11) }, deps({ agents: () => [...agents, ...extra], cwds: () => cwds2 }));
    eq('own MCP work that changed no src/ file: unpublished, but the stale build is not its reason', r6c.sessions[0].reasons.filter((x) => /^mcp-/.test(x.code)).map((x) => x.code), ['mcp-unpublished']);
    const r6d = await check({ configRepo: null, repo, session: sid(1) }, deps({ cwds: () => cwds2, npmLatest: () => null }));
    eq('own MCP work and npm cannot be read: a reason, never yes', [r6d.sessions[0].verdict, r6d.sessions[0].reasons.some((x) => x.code === 'mcp-npm-unknown')], ['no', true]);

    // claude-config drift for a file the ticket's commits changed.
    const cc = path.join(root, 'claude-config');
    fs.mkdirSync(cc); sh(cc, 'init', '-q', '-b', 'main'); sh(cc, 'config', 'user.email', 't@t'); sh(cc, 'config', 'user.name', 't'); sh(cc, 'config', 'commit.gpgsign', 'false');
    write(path.join(cc, 'commands', 'cc-loop.md'), 'loop v2\n');
    sh(cc, 'add', '-A'); sh(cc, 'commit', '-q', '-m', 'Merge loop/tck-1: the close check (TCK-1)');
    write(path.join(cc, 'commands', 'other.md'), 'other v2\n');
    sh(cc, 'add', '-A'); sh(cc, 'commit', '-q', '-m', 'Merge loop/tck-10: unrelated (TCK-10)');
    write(path.join(cfg, 'commands', 'cc-loop.md'), 'loop v1\n'); write(path.join(cfg, 'commands', 'other.md'), 'other v1\n');
    // claude-config's copy of noesis-chief.md equals the live one, and differs from the package template.
    write(path.join(cc, 'commands', 'noesis-chief.md'), 'chief v1\n');
    // TCK-1's claude-config worktree: one commit not on main, and an uncommitted file.
    const ccw = path.join(root, 'claude-config-tck-1');
    sh(cc, 'worktree', 'add', '-q', '-b', 'loop/tck-1', ccw, 'main');
    sh(ccw, 'commit', '-q', '--allow-empty', '-m', 'feat: the close rule (TCK-1)');
    write(path.join(ccw, 'commands', 'draft.md'), 'draft\n');
    const r7 = await check({ configRepo: null, repo, session: sid(1), configRepo: cc }, deps({ cwds: () => cwds2 }));
    eq('config drift counts only for files the ticket changed (TCK-10 is not TCK-1)', r7.sessions[0].reasons.filter((x) => x.code === 'config-drift').map((x) => x.path), ['commands/cc-loop.md']);
    eq('the ticket\'s claude-config worktree is checked too: uncommitted work and a commit not on main', r7.sessions[0].reasons.filter((x) => /claude-config-tck-1/.test(x.text)).map((x) => x.code), ['uncommitted', 'not-on-main']);
    eq('a skill with a claude-config copy is compared with that copy; the two sources differing is its own follow-up', r7.followUps.map((f) => f.code), ['npm', 'dist', 'hook', 'skills', 'skill-copies']);
    eq('noesis-chief.md (live equals claude-config\'s copy) is not listed as a stale install', /noesis-chief/.test(r7.followUps.find((f) => f.code === 'skills').text), false);

    // The local test-db lease, held by a process of s5.
    write(path.join(cfg, 'coord', 'locks', 'test-db', 'holder.json'), JSON.stringify({ pid: 401, startedAt: NOW, heartbeatAt: NOW }));
    const rLease = await check({ configRepo: null, repo, all: true }, deps());
    eq('the local test-db lease belongs to the session whose process holds it', rLease.sessions.filter((s) => s.reasons.some((x) => x.code === 'test-db-lease')).map((s) => s.name), ['five']);
    fs.rmSync(path.join(cfg, 'coord', 'locks'), { recursive: true, force: true });

    // Its Chrome tabs: a loop tab of its ticket, or one its own tools opened, keeps it open; an unreadable tab list is a reason.
    const tabsDeps = (t, nonLocalBySession = {}) => deps({ cwds: () => cwds2, tabs: async () => (t === null ? null : { tabs: t, nonLocalBySession }) });
    const rt = await check({ configRepo: null, repo, session: sid(1) }, tabsDeps([{ id: 11, ticket: 'TCK-1', label: 'done', openedBy: null }, { id: 12, ticket: 'TCK-9', label: 'in-use', openedBy: { sessionId: sid(1) } }, { id: 13, ticket: 'TCK-9', label: 'in-use', openedBy: null }]));
    eq('its tabs: the loop tab of its ticket and the tab it opened, not another loop\'s tab', [rt.sessions[0].reasons.filter((x) => x.code === 'tabs').length, (rt.sessions[0].reasons.find((x) => x.code === 'tabs') || {}).tabIds], [1, [11, 12]]);
    const rtn = await check({ configRepo: null, repo, session: sid(1) }, tabsDeps(null));
    eq('the Chrome tabs cannot be read: a reason, never yes', [rtn.sessions[0].verdict, rtn.sessions[0].reasons.some((x) => x.text === 'the check could not read the Chrome tabs')], ['no', true]);
    const rt0 = await check({ configRepo: null, repo, session: sid(1) }, tabsDeps([]));
    eq('no tabs: no tab reason', rt0.sessions[0].reasons.some((x) => x.code === 'tabs' || /Chrome tabs/.test(x.text)), false);
    const rtl = await check({ configRepo: null, repo, session: sid(1) }, tabsDeps([], { [sid(1)]: 2, [sid(2)]: 5 }));
    eq('its own non-local tabs: a count for the session to close, never named', (rtl.sessions[0].reasons.find((x) => x.code === 'tabs') || {}).nonLocal, 2);
    // check --all --save: what the scan reads. The loop tabs without fullUrl or window id; the other tabs only counted.
    {
      const loopTabs = [
        { id: 11, windowId: 5, ticket: 'TCK-1', status: 'shipped', label: 'done', sureOrphan: true, active: false, url: 'http://tck-1.localhost:3701/', title: 'one', openedBy: null, fullUrl: 'http://tck-1.localhost:3701/?long' },
        { id: 14, windowId: 5, ticket: 'TCK-99', status: 'shipped', label: 'done', sureOrphan: true, active: false, url: 'http://tck-99.localhost:3799/', title: 'ninety-nine', openedBy: null, fullUrl: 'http://tck-99.localhost:3799/' },
      ];
      const d = deps({ cwds: () => cwds2, tabs: async () => ({ tabs: loopTabs, nonLocalBySession: {}, otherLocal: 3, nonLocal: 4 }) });
      const ra = await check({ configRepo: null, repo, all: true }, d);
      const s2pid = ra.sessions.find((x) => x.sessionId === sid(2)).pid;
      const other = ra.sessions.find((x) => x.sessionId === sid(3)).pid;
      const sv = forScan(ra, other);
      const sv2 = forScan(ra, s2pid);
      const two = (v) => v.sessions.find((x) => x.sessionId === sid(2));
      const one = (v) => v.sessions.find((x) => x.sessionId === sid(1));
      eq("forScan: the Chief may ask s2 (idle, TCK-2 shipped, no answer), not s1 (it answered); as the Chief's own session s2 is never askable", [two(sv).askable, two(sv).self, one(sv).askable, two(sv2).askable, two(sv2).self], [true, false, false, false, true]);
      eq('forScan: askable is askRefusal(...) === null for every session', sv.sessions.every((x) => x.askable === (askRefusal(ra.sessions.find((y) => y.sessionId === x.sessionId), other) === null)), true);
      eq('forScan: the loop tabs, which no session owns, and the counts of the other tabs; no full URL or window id', [sv.tabs.loop.map((t) => t.id), sv.tabs.unowned, sv.tabs.otherLocal, sv.tabs.nonLocal, sv.tabs.loop.some((t) => 'fullUrl' in t || 'windowId' in t), sv.version, sv.checkedAt === ra.checkedAt, sv.followUps === ra.followUps], [[11, 14], [14], 3, 4, false, 1, true, true]);
      const rn = await check({ configRepo: null, repo, all: true }, tabsDeps(null));
      eq('forScan: unreadable tabs are null, not an empty list', forScan(rn, other).tabs, null);
      const file = path.join(cfg, 'coord', 'close-check.json');
      eq('saveCheck writes the whole file under ~/.claude/coord, and leaves no temporary file', [saveCheck(sv), closeCheckFile(), JSON.stringify(readJson(file)) === JSON.stringify(sv), fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith('.tmp'))], [file, file, true, []]);
      fs.rmSync(file);
      // No --self-pid: the Chief is the claude process this script runs under (here s2, pid 102), so --save marks s2 self and never askable.
      const underS2 = new Map([...ps, [process.pid, { pid: process.pid, ppid: 102, pgid: 1, command: 'node coord-close.mjs check --all --save' }]]);
      const rs = await checkAndSave({ configRepo: null, repo, all: true }, deps({ cwds: () => cwds2, ps: () => underS2, tabs: async () => ({ tabs: loopTabs, nonLocalBySession: {}, otherLocal: 3, nonLocal: 4 }) }));
      const savedS2 = (readJson(file) || { sessions: [] }).sessions.find((x) => x.sessionId === sid(2)) || {};
      eq("check --all --save without --self-pid: the claude process it runs under is the Chief's own session, saved self and never askable", [rs.savedTo, savedS2.self, savedS2.askable], [file, true, false]);
      fs.rmSync(file);
    }
    eq('the real tab path: AppleScript failure is null (a reason), never an empty list', await realDeps({}).tabs({}, () => { throw new Error('osascript failed'); }), null);

    // Failures fail closed.
    const r8 = await check({ configRepo: null, repo, session: sid(1) }, deps({ ps: () => null }));
    eq('ps failed: a reason, never yes', [r8.sessions[0].verdict, r8.sessions[0].reasons[0].code], ['no', 'facts-failed']);
    const r8b = await check({ configRepo: null, repo, session: sid(1) }, deps({ cwds: () => null }));
    eq('lsof failed: a reason, never yes', [r8b.sessions[0].verdict, r8b.sessions[0].reasons[0].code, /lsof/.test(r8b.sessions[0].reasons[0].text)], ['no', 'facts-failed', true]);
    eq('lsof with no output is a failure (null), not an empty list', [parseLsofCwd(''), parsePs('')], [null, null]);
    eq('lsof output: the first name of each pid is its folder', [...parseLsofCwd('p12\nfcwd\nn/a/b\np13\nn/c\n')], [[12, '/a/b'], [13, '/c']]);
    const r9 = await check({ configRepo: null, repo, all: true }, deps({ agents: () => null }));
    eq('claude agents failed: an error, no sessions', [Boolean(r9.error), r9.sessions.length], [true, 0]);
    const r10 = await check({ configRepo: null, repo, session: sid(1) }, deps({ get: async () => null }));
    eq('the server cannot be read: the ticket status, the port slots and the leases are reasons, never yes', [r10.sessions[0].verdict, ['ticket-unknown', 'facts-failed'].every((c) => r10.sessions[0].reasons.some((x) => x.code === c))], ['no', true]);
    for (const which of ['allocations', 'leases']) {
      const r10a = await check({ configRepo: null, repo, session: sid(1) }, deps({ cwds: () => cwds2, get: async (p) => (p.endsWith(`/coordination/${which}`) ? null : baseGet(p)) }));
      eq(`only the ${which} GET fails: a reason, never yes`, [r10a.sessions[0].verdict, (r10a.sessions[0].reasons.find((x) => x.code === 'facts-failed') || {}).text], ['no', 'the check could not read the port slots and leases from the server']);
    }
    // A detached main checkout: "not on main" still counts against main, never against the literal HEAD.
    sh(repo, 'checkout', '-q', '--detach');
    const r10f = await check({ configRepo: null, repo, session: sid(2) }, deps({ cwds: () => cwds2 }));
    sh(repo, 'checkout', '-q', 'main');
    eq('a detached main checkout: TCK-2\'s unmerged commit is still not on main', r10f.sessions[0].reasons.some((x) => x.text === '1 commit in repo-tck-2 is not on main'), true);
    const r10b = await check({ configRepo: null, repo, session: sid(1) }, deps({ cwds: () => cwds2, get: async (p) => (/issues\?status=/.test(p) ? { issues: [] } : baseGet(p)) }));
    eq('a ticket that is not on the board: a reason for the owner, never yes', [r10b.sessions[0].verdict, r10b.sessions[0].reasons[0].text, r10b.sessions[0].reasons[0].fixer], ['no', 'TCK-1 is not on the Jot board', 'owner']);
    const full = Array.from({ length: LIST_LIMIT }, (_, i) => ({ key: `TCK-${90000 + i}`, work_status: 'shipped' }));
    const r10c = await check({ configRepo: null, repo, session: sid(1) }, deps({ cwds: () => cwds2, get: async (p) => (p.endsWith('status=shipped') ? { issues: full } : /issues\?status=/.test(p) ? { issues: [] } : baseGet(p)) }));
    eq('a full list (500 rows) may be cut short: a ticket missing from it is unknown, not "not on the board"', r10c.sessions[0].reasons[0].text, 'the check could not read TCK-1\'s status');
    const r10d = await check({ configRepo: null, repo, session: sid(1) }, deps({ cwds: () => cwds2, get: async (p) => (p.endsWith('status=shipped') ? null : baseGet(p)) }));
    eq('one list call fails: every status is unknown, never "not on the board"', r10d.sessions[0].reasons[0].text, 'the check could not read TCK-1\'s status');
    // A worktree whose folder is gone: git cannot read it, which is a reason of its own.
    fs.renameSync(w3, `${w3}-moved`);
    const r10e = await check({ configRepo: null, repo, session: sid(6) }, deps({ cwds: () => cwds2 }));
    fs.renameSync(`${w3}-moved`, w3);
    eq('git cannot read the worktree: the status and the commit count are reasons', r10e.sessions[0].reasons.filter((x) => x.code === 'facts-failed').map((x) => x.text), ['the check could not read git status in repo-tck-3', 'the check could not count the commits in repo-tck-3']);
    const closedFile = path.join(root, 'closed.json');
    write(closedFile, JSON.stringify({ issues: [{ key: 'TCK-1', work_status: 'merged' }] }));
    const r11 = await check({ configRepo: null, repo, session: sid(1), closed: closedFile }, deps({ cwds: () => cwds2 }));
    eq('--closed gives the status first', r11.sessions[0].ticket.status, 'merged');
    eq('no check ever reads a ticket by its key (that GET marks the ticket as active on the board)', [calls.length > 0, calls.filter((c) => /\/backlog\/issues\/TCK-/.test(c))], [true, []]);

    // The loaders fail closed.
    const fail = () => ({ error: new Error('ENOENT'), status: null, stdout: '' });
    const empty = () => ({ status: 1, stdout: '' });
    eq('ps, lsof and claude agents that fail or print nothing give null, never an empty list', [loadPs(fail), loadPs(empty), loadCwds(fail), loadCwds(empty), loadPorts(fail), loadPorts(empty), loadAgents(null, fail), loadAgents(null, () => ({ status: 0, stdout: 'not json' }))], [null, null, null, null, null, null, null, null]);
    const npmArgs = [];
    eq('npm view: a failure gives null; it runs with --logs-max=0', [npmLatest(null, fail), npmLatest(null, (c, a) => { npmArgs.push(...a); return { status: 0, stdout: '2.15.0\n' }; }), npmArgs.includes('--logs-max=0')], [null, '2.15.0', true]);
    eq('selfSessionPid: the nearest claude process above this one, not the Bash tool\'s shell whose command names ~/.claude', selfSessionPid(new Map([[999, { pid: 999, ppid: 998, command: 'node coord-close.mjs candidates' }], [998, { pid: 998, ppid: 997, command: '/bin/zsh -c source /Users/x/.claude/shell-snapshots/snapshot-zsh-1.sh && eval node coord-close.mjs' }], [997, { pid: 997, ppid: 1, command: 'claude --chrome' }]]), 999), 997);

    // The dry run: the real CLI under --prove-read-only, where every side effect throws and is listed.
    // ps and lsof are this machine's own (read-only); the API address is closed, so each GET fails fast.
    const agentsFile = path.join(root, 'agents.json');
    write(agentsFile, JSON.stringify(agents));
    const env = { ...process.env, CLAUDE_CONFIG_DIR: cfg, NOESIS_API_TOKEN: 'selftest', NOESIS_API_URL: 'http://127.0.0.1:9' };
    const before = fs.readdirSync(closeDir()).sort();
    const self = fileURLToPath(import.meta.url);
    for (const cmd of ['check', 'candidates']) {
      const run = spawnSync(process.execPath, [self, cmd, '--all', '--json', '--prove-read-only', '--repo', repo, '--agents', agentsFile, '--npm-latest', '2.15.0', '--config-repo', cc], { encoding: 'utf8', env, timeout: 60_000 });
      let out = null;
      try { out = JSON.parse(run.stdout); } catch { /* reported below */ }
      eq(`the dry run of ${cmd} has no side effect`, [run.status, out && out.readOnly && out.readOnly.effects], [0, []]);
    }
    // With stdout sent to a file, console.log writes through fs.writeSync on fd 1: the report must still arrive.
    const outFile = path.join(root, 'dry-run.json');
    const fd = fs.openSync(outFile, 'w');
    const toFile = spawnSync(process.execPath, [self, 'check', '--all', '--json', '--prove-read-only', '--repo', repo, '--agents', agentsFile, '--npm-latest', '2.15.0'], { stdio: ['ignore', fd, 'pipe'], env, timeout: 60_000 });
    fs.closeSync(fd);
    eq('the dry run writes its report when stdout is a file', [toFile.status, (readJson(outFile) || {}).readOnly], [0, { effects: [] }]);
    eq('the dry runs wrote no answer file', fs.readdirSync(closeDir()).sort(), before);
    // record through the CLI, with --pid as a session runs it ($PPID is its Claude Code process).
    const rec = spawnSync(process.execPath, [self, 'record', '--pid', '104', '--verdict', 'no', '--left', 'the owner must publish 2.16.0'], { encoding: 'utf8', env, timeout: 30_000 });
    const recFile = readJson(path.join(closeDir(), `${sid(4)}.json`)) || {};
    eq('record --pid stores the answer for that pid\'s session', [rec.status, recFile.sessionId, recFile.verdict, recFile.left], [0, sid(4), 'no', ['the owner must publish 2.16.0']]);
    const listed = fs.readdirSync(closeDir()).sort();
    const recBad = spawnSync(process.execPath, [self, 'record', '--pid', '99999', '--verdict', 'yes'], { encoding: 'utf8', env: { ...env, PATH: '/nonexistent' }, timeout: 30_000 });
    eq('record --pid with no session for that pid fails and writes nothing', [recBad.status, fs.readdirSync(closeDir()).sort()], [1, listed]);
    // The spy itself: each kind of write, process, signal and request is refused and listed; reads pass.
    const scratch = path.join(root, 'spy');
    fs.mkdirSync(scratch);
    write(path.join(scratch, 'a.txt'), 'a\n');
    const probe = spawnSync(process.execPath, ['--input-type=module', '-e', `
      const m = await import(${JSON.stringify(self)});
      const effects = [];
      await m.installReadOnlySpy(effects);
      const fs = (await import('node:fs')).default;
      const http = (await import('node:http')).default;
      const { spawnSync, spawn, exec, execSync } = await import('node:child_process');
      const d = ${JSON.stringify(scratch)};
      const a = d + '/a.txt';
      const tries = [
        () => fs.writeFileSync(d + '/w', 'y'), () => fs.appendFileSync(a, 'y'), () => fs.renameSync(a, d + '/b'), () => fs.rmSync(a),
        () => fs.unlinkSync(a), () => fs.mkdirSync(d + '/m'), () => fs.copyFileSync(a, d + '/c'), () => fs.linkSync(a, d + '/l'),
        () => fs.symlinkSync(a, d + '/s'), () => fs.utimesSync(a, new Date(), new Date()), () => fs.openSync(d + '/o', 'w'),
        () => fs.createWriteStream(d + '/ws'), () => fs.writeSync(99, 'x'),
        () => fs.promises.writeFile(d + '/p', 'y'), () => fs.promises.open(d + '/po', 'w'), () => fs.promises.copyFile(a, d + '/pc'),
        () => process.kill(1, 'SIGTERM'),
        () => spawnSync('git', ['-C', d, 'commit', '-m', 'x']), () => spawnSync('git', ['-C', d, 'branch', '-D', 'x']),
        () => spawnSync('npm', ['install']), () => spawnSync('osascript', ['-e', 'tell application "Finder" to quit']),
        () => spawn('ls'), () => exec('ls'), () => execSync('ls'),
        () => fetch('http://127.0.0.1:9', { method: 'POST' }), () => fetch(new Request('http://127.0.0.1:9', { method: 'POST' })),
        () => http.request({ hostname: '127.0.0.1', port: 9, method: 'POST' }),
        () => new http.ClientRequest({ hostname: '127.0.0.1', port: 9, method: 'POST' }),
        () => spawnSync('git', ['-C', d, 'diff', '--output=' + d + '/g']),
      ];
      for (const f of tries) { try { await f(); } catch {} }
      const refused = effects.length;
      // Reads pass, and are not listed.
      process.kill(process.pid, 0);
      spawnSync('git', ['-C', d, 'status']);
      spawnSync('ps', ['-p', '1']);
      fs.readFileSync(a, 'utf8');
      fs.closeSync(fs.openSync(a, 'r'));
      console.log(JSON.stringify({ refused, after: effects.length, names: effects.map((e) => e.split(' ')[0]), left: fs.readdirSync(d) }));`], { encoding: 'utf8', timeout: 30_000 });
    const pr = (() => { try { return JSON.parse(probe.stdout.trim().split('\n').pop()); } catch { return { error: probe.stderr.slice(-300) }; } })();
    eq('the spy refuses all 29 kinds of side effect, and lets reads through unlisted', [pr.refused, pr.after], [29, 29]);
    eq('the refused calls, in order', pr.names, ['fs.writeFileSync', 'fs.appendFileSync', 'fs.renameSync', 'fs.rmSync', 'fs.unlinkSync', 'fs.mkdirSync', 'fs.copyFileSync', 'fs.linkSync', 'fs.symlinkSync', 'fs.utimesSync', 'fs.openSync', 'fs.createWriteStream', 'fs.writeSync', 'fs.promises.writeFile', 'fs.promises.open', 'fs.promises.copyFile', 'kill', 'spawnSync', 'spawnSync', 'spawnSync', 'spawnSync', 'spawn', 'exec', 'execSync', 'POST', 'POST', 'http.request', 'http.ClientRequest', 'spawnSync']);
    eq('no file appeared in the probe\'s folder', pr.left, ['a.txt']);

    // candidates: groups of at most 4, never the Chief itself, maybe apart.
    const fake = { sessions: Array.from({ length: 9 }, (_, i) => ({ sessionId: sid(i), name: `s${i}`, pid: 500 + i, folder: 'f', ticket: { key: `TCK-${i}` }, verdict: i < 7 ? 'yes' : 'maybe', followUps: [] })) };
    const c = candidatesOf(fake, 500);
    eq('candidates: 6 ready (the Chief\'s own pid left out) in groups of 4 and 2; 2 maybe', [c.ready.length, c.groups.map((g) => g.length), c.maybe.length], [6, [4, 2], 2]);

    // The transcript reader on its own.
    const t = readTranscript([
      line({ type: 'assistant', timestamp: iso(NOW - 10_000), message: { content: [{ type: 'tool_use', name: 'ScheduleWakeup', input: { delaySeconds: 5000 } }] } }),
    ].join('\n'), NOW);
    eq('a wakeup delay is clamped to 3600 s', t.wakeupAt, NOW - 10_000 + 3600_000);
    // The tab ids a session's own Chrome tools saw (tabs_create_mcp / tabs_context_mcp results).
    const tt = readTranscript([
      line({ type: 'assistant', timestamp: iso(NOW - 900), message: { content: [{ type: 'tool_use', id: 'tu1', name: 'mcp__claude-in-chrome__tabs_create_mcp', input: {} }, { type: 'tool_use', id: 'tu2', name: 'mcp__noesis__backlog_get', input: {} }, { type: 'tool_use', id: 'tu3', name: 'mcp__claude-in-chrome__navigate', input: {} }] } }),
      line({ type: 'user', timestamp: iso(NOW - 899), message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: '{"tabId":11586499,"url":"http://tck-7.localhost:3701/"}' }, { type: 'text', text: '  • tabId 11586500: "New Tab"' }] }, { type: 'tool_result', tool_use_id: 'tu2', content: '{"tabId":999999}' }, { type: 'tool_result', tool_use_id: 'tu3', content: 'Executed on tabId: 888888' }] } }),
    ].join('\n'), NOW);
    eq('tab ids come only from the results of the session\'s own Chrome tab tools', tt.tabIds, [11586499, 11586500]);
    eq('a stopped wakeup is not armed', readTranscript(line({ type: 'assistant', timestamp: iso(NOW - 10_000), message: { content: [{ type: 'tool_use', name: 'ScheduleWakeup', input: { stop: true } }] } }), NOW).wakeupAt, 0);
  } finally {
    if (savedCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = savedCfg;
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log(failed ? `\n${failed} FAILED` : '\nall ok');
  return failed ? 1 : 0;
}

// ── main ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { left: [] };
  const [cmd, ...rest] = argv;
  args.cmd = cmd;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const val = () => rest[++i];
    if (a === '--json') args.json = true;
    else if (a === '--all') args.all = true;
    else if (a === '--prove-read-only') args.proveReadOnly = true;
    else if (a === '--by-message') args.byMessage = true;
    else if (a === '--save') args.save = true;
    else if (a === '--session') args.session = val();
    else if (a === '--pid') args.pid = Number(val());
    else if (a === '--self-pid') args.selfPid = Number(val());
    else if (a === '--closed') args.closed = val();
    else if (a === '--repo') args.repo = val();
    else if (a === '--agents') args.agents = val();
    else if (a === '--npm-latest') args.npmLatest = val();
    else if (a === '--config-repo') args.configRepo = val();
    else if (a === '--verdict') args.verdict = val();
    else if (a === '--left') args.left.push(val());
    else throw new Error(`unknown argument ${a}`);
  }
  return args;
}

const USAGE = 'usage: coord-close.mjs ask --session <id> [--by-message] [--closed <file>] [--json] | close --session <id> [--closed <file>] [--json] | check [--session <id> | --pid <pid> | --all [--save]] [--closed <file>] [--repo <main checkout>] [--agents <file>] [--json] [--prove-read-only] | record (--pid <pid> | --session <id>) --verdict yes|no [--left <text>]... | candidates [--self-pid <pid>] [--json] [--prove-read-only] | --selftest';

/** The Claude Code process this script runs under (the nearest `claude` among its parents), or null. */
export function selfSessionPid(ps, from = process.pid) {
  if (!ps) return null;
  let p = ps.get(from);
  for (let i = 0; p && i < 64; i++, p = ps.get(p.ppid)) if (p.pid !== from && /(^|\/)claude(\s|$)/.test(p.command)) return p.pid;
  return null;
}

/** The Chief's own Claude Code process: --self-pid, else the claude process this script runs under. */
export function chiefPid(args, deps) {
  return args.selfPid || selfSessionPid(deps.ps());
}

// No top-level await: coord-tabs.mjs is imported while main runs, and it imports this file back.
async function main(argv) {
  if (argv[0] === '--selftest') return selftest();
  let args;
  try { args = parseArgs(argv); } catch (e) { console.error(`${e.message}\n${USAGE}`); return 2; }
  const deps = realDeps(args);
  // --prove-read-only: every side effect throws and is listed; exit 3 when there was one.
  const effects = [];
  if (args.proveReadOnly) {
    if (args.cmd !== 'check' && args.cmd !== 'candidates') { console.error('--prove-read-only works with check and candidates only'); return 2; }
    if (args.save) { console.error('--prove-read-only cannot --save: saving writes a file'); return 2; }
    await installReadOnlySpy(effects);
  }
  const proof = () => (args.proveReadOnly ? `\nread-only proof: ${effects.length} side effect${effects.length === 1 ? '' : 's'}${effects.map((e) => `\n  ${e}`).join('')}` : '');
  try {
    if (args.cmd === 'check') {
      if (args.save && (!args.all || args.session || args.pid)) { console.error('--save needs --all: the scan reads the whole picture'); return 2; }
      const r = args.save ? await checkAndSave(args, deps) : await check(args, deps);
      if (r.savedTo && !args.json) console.log(`saved for the scan: ${r.savedTo}`);
      if (args.proveReadOnly) r.readOnly = { effects };
      console.log(args.json ? JSON.stringify(r, null, 2) : render(r) + proof());
      return effects.length ? 3 : r.error ? 1 : 0;
    }
    if (args.cmd === 'candidates') {
      const r = await check({ ...args, all: true }, deps);
      if (r.error) { console.error(r.error); return 1; }
      // The Chief's own session is never a candidate: --self-pid, else the claude process this runs under.
      const self = chiefPid(args, deps);
      const c = candidatesOf(r, self);
      c.selfPid = self || null;
      if (args.proveReadOnly) c.readOnly = { effects };
      console.log(args.json ? JSON.stringify(c, null, 2) : [`Ready to close: ${c.ready.length}`, ...c.ready.map((s) => `  ${s.name || s.sessionId.slice(0, 8)} ${s.ticket || ''} (${s.folder})`), `Maybe (no ticket): ${c.maybe.length}`, ...c.maybe.map((s) => `  ${s.name || s.sessionId.slice(0, 8)} (${s.folder})`)].join('\n') + proof());
      return effects.length ? 3 : 0;
    }
    if (args.cmd === 'ask' || args.cmd === 'close') {
      if (!args.session) { console.error(`${args.cmd} needs --session <id>`); return 2; }
      const d = actDeps(args, deps);
      const r = args.cmd === 'ask' ? await ask(args, d) : await closeSession(args, d);
      console.log(args.json ? JSON.stringify(r, null, 2) : args.cmd === 'ask'
        ? (r.asked ? (r.by === 'message' ? `ready: send this to ${r.name} with SendMessage:\n${r.line}` : `asked ${r.name || r.sessionId}${r.confirmed ? ' (it arrived as a prompt)' : ' (not confirmed in its transcript within 60 s)'}`) : `not asked: ${r.why}`)
        : [r.closed ? `closed ${r.name || r.sessionId} (${r.folder}); to reopen it: ${r.resume}` : `not closed: ${r.why}`, ...r.steps.map((x) => `  ${x}`)].join('\n'));
      return args.cmd === 'ask' ? (r.asked ? 0 : 1) : r.closed ? 0 : 1;
    }
    if (args.cmd === 'record') {
      const sid = args.session || (args.pid ? sessionOfPid(args.pid, deps) : null);
      if (!sid) { console.error('record: no session found for that pid'); return 1; }
      console.log(`recorded ${args.verdict} for ${sid} in ${record({ sessionId: sid, verdict: args.verdict, left: args.left })}`);
      return 0;
    }
    console.error(USAGE);
    return 2;
  } catch (e) {
    console.error(`coord-close: ${e.message}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
