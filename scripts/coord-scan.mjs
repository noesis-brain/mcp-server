#!/usr/bin/env node
// coord-scan.mjs — the Chief of Staff's conflict scanner for parallel ticket sessions (TCK-1890).
// The conditions and their rules are in references/chief-conflict-catalogue.md.
//
//   node coord-scan.mjs --board <tickets.json> [--repo <main checkout>] [--agents <agents.json>]
//                       [--npm-latest <version>] [--plans <plans.json>] [--json]
//   node coord-scan.mjs --selftest
//
// --board is the Jot board as `backlog_get` returns it ({"issues": [...]} or a plain array). The
// Chief writes it with its MCP tools, so this script holds no API token. --repo defaults to the
// main checkout of the git repository the current folder is in. --agents replaces
// `claude agents --json`, and --npm-latest replaces `npm view`, for tests. --plans maps ticket keys
// to plan files ({"TCK-7": "/path/plan.md"}); without it, a planning ticket's plan is the newest
// ~/.claude/plans/*.md its bound session's transcript names (C15).
//
// It only reads: git status, diff, rev-list and worktree list, the files of each worktree, the
// loop registry (~/.claude/loop-supervisor/<session>.json), the tail of a planning ticket's session
// transcript and its plan file, `claude agents --json`, `lsof` and
// `npm view`. `git merge-tree --write-tree` must write tree objects to compute a merge, so it runs
// with GIT_OBJECT_DIRECTORY set to a temporary folder (the repository's own objects are only read,
// as alternates). Every git call runs with GIT_OPTIONAL_LOCKS=0: a plain `git status` refreshes
// the index and writes it back under index.lock, which changes another ticket's worktree and can
// make that session's own `git commit` fail on the lock. No worktree, index, ref or object of the
// repository changes.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ACTIVE = ['planning', 'ready_to_implement', 'implementing', 'iterating', 'ready_to_merge', 'deploying'];
const MCP_DIR = 'md-manager-mcp-server';
const MCP_PACKAGE = '@noesis-brain/mcp-server';
// Files that nearly every ticket touches. An overlap here is re-merged at rebase (C3), not a conflict.
const LOW_RISK = [
  /^src\/frontend\/src\/i18n\/locales\/[^/]+\.json$/,
  /^src\/frontend\/src\/App\.tsx$/,
  /^src\/backend\/server\.ts$/,
  /^src\/backend\/database\/db\.ts$/,
  /^src\/backend\/services\/resourceAccess\.ts$/,
  /^src\/backend\/test\/unitProject\.ts$/,
];
// Working memory of loops and agents: never product files.
const IGNORED = [/(^|\/)[^/]*LOOP-STATE[^/]*\.md$/, /^loop-stack\//, /^\.loop\//, /^\.claude\/worktrees\//, /^\.claude-notes\//];
const PHASE_RE = /^scripts\/phase(\d+(?:\.\d+)?)-[^/]*\.sql$/;
const SEVERITY = { high: 0, medium: 1, low: 2 };
/** Tickets whose plan, not their diff, says what they will touch: C15 reads their plan file. */
const PLANNING = ['planning', 'ready_to_implement'];
const TRANSCRIPT_TAIL_BYTES = 4 * 1024 * 1024;

/** A pair of two tickets is always named in ticket-number order (as numbers: TCK-9 before TCK-10), so a change
 *  in the board order never turns one pair into "another" (the server keys a conflict by kind, a and b). Pairs
 *  with main, npm, all or a session keep their order: those sides never swap. */
export function orderPair(a, b) {
  const na = /^TCK-(\d+)$/.exec(a);
  const nb = /^TCK-(\d+)$/.exec(b);
  return na && nb && Number(nb[1]) < Number(na[1]) ? [b, a] : [a, b];
}

function git(cwd, args, env) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...(env || {}) }, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, code: r.status, out: (r.stdout || '').trim(), raw: r.stdout || '', err: (r.stderr || '').trim() };
}
const lines = (s) => s.split('\n').map((x) => x.trim()).filter(Boolean);
const keep = (f) => !IGNORED.some((re) => re.test(f));
const lowRisk = (f) => LOW_RISK.some((re) => re.test(f));

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

function loadAgents(file) {
  if (file) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const r = spawnSync('claude', ['agents', '--json'], { encoding: 'utf8', timeout: 20_000 });
  try { return JSON.parse(r.stdout); } catch { return []; }
}

function sidecar(sid) {
  try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'loop-supervisor', `${sid}.json`), 'utf8')); } catch { return null; }
}

// The worktree that holds a path, or null. The longest matching worktree path wins.
function worktreeOf(dir, wts) {
  if (!dir) return null;
  const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
  const d = real(dir);
  return wts.filter((w) => d === real(w.path) || d.startsWith(real(w.path) + path.sep)).sort((a, b) => b.path.length - a.path.length)[0] || null;
}

// Ticket -> worktree, in order: the bound session (agents cwd, then the loop registry's cwd), the
// worktree naming (branch tck-<n>, folder -tck-<n>), then the ticket's own worktree field. A session
// started in the main checkout says nothing about where the work is, so the main checkout is used
// only when nothing else matches.
function mapTicket(t, wts, main, agentsBySid) {
  const n = Number(String(t.key).replace(/^TCK-/i, ''));
  const tries = [];
  const sid = t.bound_session_id;
  const agent = sid ? agentsBySid.get(sid) : null;
  if (agent) tries.push(['session', worktreeOf(agent.cwd, wts)]);
  if (sid) { const sc = sidecar(sid); if (sc) tries.push(['loop-registry', worktreeOf(sc.cwd, wts)]); }
  tries.push(['name', wts.find((w) => ticketNumberOf(w) === n) || null]);
  if (t.worktree) tries.push(['ticket-field', worktreeOf(t.worktree, wts)]);
  const isMain = (w) => w && path.resolve(w.path) === path.resolve(main);
  const hit = tries.find(([, w]) => w && !isMain(w)) || tries.find(([, w]) => w);
  return { worktree: hit ? hit[1] : null, mapBy: hit ? hit[0] : null, session: agent || null, sessionId: sid || null };
}

function changedFiles(wt, base) {
  const committed = base ? lines(git(wt.path, ['diff', '--name-only', `${base}`, 'HEAD']).out) : [];
  // The raw output: "XY path" starts with a space when only the worktree changed, and a trim
  // would cut it off the first line.
  const raw = git(wt.path, ['status', '--porcelain=v1', '-uall']).raw.split('\n').filter(Boolean);
  const uncommitted = raw.map((l) => l.slice(3).replace(/^"|"$/g, '').split(' -> ').pop());
  return { committed: committed.filter(keep), uncommitted: uncommitted.filter(keep), statusLines: raw };
}

function tablesIn(file) {
  try {
    const sql = fs.readFileSync(file, 'utf8');
    const out = new Set();
    for (const m of sql.matchAll(/\b(?:CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?|ALTER\s+TABLE(?:\s+IF\s+EXISTS)?(?:\s+ONLY)?)\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi)) out.add(m[1].toLowerCase());
    return [...out];
  } catch { return []; }
}

function mcpVersion(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, MCP_DIR, 'package.json'), 'utf8')).version || null; } catch { return null; }
}

const verCmp = (a, b) => {
  const pa = String(a).split('.').map(Number); const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
};

function npmLatest(given) {
  if (given) return given;
  const r = spawnSync('npm', ['view', MCP_PACKAGE, 'version'], { encoding: 'utf8', timeout: 20_000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

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

// Conflicting paths of a two-branch merge, computed in a throwaway object directory.
function mergeConflicts(main, a, b) {
  const objects = git(main, ['rev-parse', '--path-format=absolute', '--git-path', 'objects']).out;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-scan-objects-'));
  try {
    const r = git(main, ['merge-tree', '--write-tree', '--name-only', '--no-messages', a, b], { GIT_OBJECT_DIRECTORY: tmp, GIT_ALTERNATE_OBJECT_DIRECTORIES: objects });
    if (r.code === 0) return [];
    if (r.code === 1) return lines(r.out).slice(1).filter(keep);
    return null;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

function listeners() {
  const r = spawnSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn'], { encoding: 'utf8', timeout: 10_000 });
  const out = [];
  let cur = null;
  for (const line of (r.stdout || '').split('\n')) {
    if (line.startsWith('p')) { cur = { pid: Number(line.slice(1)), command: '', ports: [] }; out.push(cur); } else if (cur && line.startsWith('c')) cur.command = line.slice(1);
    else if (cur && line.startsWith('n')) { const m = /:(\d+)$/.exec(line); if (m && !cur.ports.includes(Number(m[1]))) cur.ports.push(Number(m[1])); }
  }
  for (const l of out) {
    const c = spawnSync('lsof', ['-a', '-p', String(l.pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8', timeout: 5_000 });
    l.cwd = ((c.stdout || '').split('\n').find((x) => x.startsWith('n')) || '').slice(1) || null;
  }
  return out.filter((l) => /node|tsx|vite/i.test(l.command));
}

/** The newest plan file a session's transcript names (Claude Code writes plans to ~/.claude/plans/<name>.md), or null. */
function planFromTranscript(sid) {
  if (!sid || !/^[A-Za-z0-9-]{8,64}$/.test(sid)) return null;
  const cfg = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const root = path.join(cfg, 'projects');
  // A plan path as Claude Code writes it: under the config folder, absolute, or as ~/.claude/plans/.
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const homeForm = path.resolve(cfg) === path.join(os.homedir(), '.claude') ? '|~\\/\\.claude' : '';
  const planRe = new RegExp(`(?:${esc(path.resolve(cfg))}${homeForm})\\/plans\\/[A-Za-z0-9._-]+\\.md`, 'g');
  let file = null;
  try {
    for (const d of fs.readdirSync(root)) {
      const f = path.join(root, d, `${sid}.jsonl`);
      if (fs.existsSync(f)) { file = f; break; }
    }
  } catch { return null; }
  if (!file) return null;
  try {
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    const len = Math.min(size, TRANSCRIPT_TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    const hits = buf.toString('utf8').match(planRe);
    if (!hits) return null;
    const last = hits[hits.length - 1].replace(/^~/, os.homedir());
    return fs.existsSync(last) ? last : null;
  } catch { return null; }
}

/**
 * The repository files a plan names: the backticked paths under its "Critical files" heading, or,
 * when it has no such heading, every backticked path in it. A path here has a folder and a file
 * name (`src/x.ts`, `scripts/phase77.sql`); a trailing slash names a folder.
 */
export function planFiles(markdown) {
  const text = String(markdown || '');
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^#{1,6}\s.*critical files/i.test(l));
  let section = text;
  if (start >= 0) {
    const level = lines[start].match(/^#+/)[0].length;
    const end = lines.findIndex((l, i) => i > start && /^#{1,6}\s/.test(l) && l.match(/^#+/)[0].length <= level);
    section = lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
  }
  const out = new Set();
  for (const m of section.matchAll(/`([^`\s]+)`/g)) {
    const t = m[1].replace(/^\.\//, '').replace(/[:#].*$/, '');
    // A relative path with a folder: the first segment cannot be empty (an absolute path) or start with ~.
    if (/^[A-Za-z0-9._@-]+(\/[A-Za-z0-9._@-]+)*\/?$/.test(t) && t.includes('/')) out.add(t);
  }
  return [...out];
}

/** Whether a changed file is one a plan names: the same path, or inside a folder the plan names. */
const namedBy = (planned, file) => planned.some((p) => (p.endsWith('/') ? file.startsWith(p) : file === p));

export function scan({ repo, board, agents, npm, plans = {}, withProcesses = true }) {
  const main = mainCheckout(repo);
  if (!main) throw new Error(`not a git repository: ${repo}`);
  const mainRef = git(main, ['rev-parse', '--abbrev-ref', 'HEAD']).out || 'main';
  const wts = worktrees(main);
  const agentsBySid = new Map((Array.isArray(agents) ? agents : []).filter((a) => a.sessionId).map((a) => [a.sessionId, a]));
  const issues = (Array.isArray(board) ? board : board.issues || []).filter((t) => ACTIVE.includes(t.work_status));
  const mainPhases = fs.existsSync(path.join(main, 'scripts')) ? fs.readdirSync(path.join(main, 'scripts')).map((f) => `scripts/${f}`).filter((f) => PHASE_RE.test(f)) : [];
  const mainVersion = mcpVersion(main);
  const distFile = path.join(main, MCP_DIR, 'dist', 'index.js');
  const dist = fs.existsSync(distFile) ? { builtAt: fs.statSync(distFile).mtimeMs, newestSource: newestMtime(path.join(main, MCP_DIR, 'src')) } : null;

  const tickets = issues.map((t) => {
    const m = mapTicket(t, wts, main, agentsBySid);
    const atMain = Boolean(m.worktree) && path.resolve(m.worktree.path) === path.resolve(main);
    const own = m.worktree && !atMain ? m.worktree : null;
    const row = { key: t.key, status: t.work_status, sessionId: m.sessionId, sessionState: m.session ? (m.session.status || m.session.state || null) : (m.sessionId ? 'not running' : null), waitingFor: m.session ? m.session.waitingFor || null : null, worktree: own ? own.path : null, branch: own ? own.branch : null, mapBy: own ? m.mapBy : null, note: atMain ? 'its session runs in the main checkout; no worktree of its own was found' : own ? null : 'no worktree found' };
    if (!own) return { ...row, files: [], committed: [], uncommitted: [], phases: [], tables: [], mcp: null, mcpCheckout: null, behind: null, mainMovedOn: [], mainConflicts: [] };
    m.worktree = own;
    const base = git(m.worktree.path, ['merge-base', 'HEAD', mainRef]).out || null;
    const f = changedFiles(m.worktree, base);
    const files = [...new Set([...f.committed, ...f.uncommitted])];
    const phases = files.filter((x) => PHASE_RE.test(x) && !mainPhases.includes(x));
    const tables = [...new Set(phases.flatMap((p) => tablesIn(path.join(m.worktree.path, p))))];
    const mcpTouched = files.some((x) => x === MCP_DIR || x.startsWith(`${MCP_DIR}/`)) || f.statusLines.some((l) => l.slice(3) === MCP_DIR);
    const behind = Number(git(m.worktree.path, ['rev-list', '--count', `HEAD..${mainRef}`]).out) || 0;
    const mainMovedOn = base ? lines(git(main, ['diff', '--name-only', base, mainRef]).out).filter((x) => files.includes(x)) : [];
    // The merge this ticket faces when it ships: its committed branch into main as it is now.
    const mainConflicts = behind && m.worktree.branch ? (mergeConflicts(main, mainRef, m.worktree.branch) || []) : [];
    const checkout = mcpVersion(m.worktree.path);
    return { ...row, base, files, committed: f.committed, uncommitted: f.uncommitted, phases, tables, mcp: mcpTouched ? { version: checkout } : null, mcpCheckout: checkout, behind, mainMovedOn, mainConflicts, lockfile: files.includes('package-lock.json') };
  });

  const conflicts = [];
  const add = (kind, severity, a, b, detail, evidence) => {
    [a, b] = orderPair(a, b);
    conflicts.push({ kind, severity, a, b, detail, evidence });
  };
  const same = (x, y) => x.worktree && y.worktree && path.resolve(x.worktree) === path.resolve(y.worktree);
  // When tickets share a worktree, one ticket stands for it in the pairwise checks: the one whose
  // live session works there, else the first on the board. C13 reports the sharing itself.
  const RANK = { session: 0, 'loop-registry': 1, name: 2, 'ticket-field': 3 };
  const primary = new Set();
  for (const t of [...tickets].sort((x, y) => (RANK[x.mapBy] ?? 9) - (RANK[y.mapBy] ?? 9))) {
    if (t.worktree && !tickets.some((o) => primary.has(o.key) && same(o, t))) primary.add(t.key);
  }
  const lead = tickets.filter((t) => primary.has(t.key));

  // C13: two active tickets in one worktree.
  for (let i = 0; i < tickets.length; i++) for (let j = i + 1; j < tickets.length; j++) {
    if (same(tickets[i], tickets[j])) add('C13', 'high', tickets[i].key, tickets[j].key, `both tickets work in ${tickets[i].worktree}`, { mapBy: [tickets[i].mapBy, tickets[j].mapBy] });
  }
  // C4: one phase number, two files.
  const byNumber = new Map();
  for (const p of mainPhases) { const k = PHASE_RE.exec(p)[1]; (byNumber.get(k) || byNumber.set(k, []).get(k)).push({ owner: 'main', file: p }); }
  for (const t of lead) {
    for (const p of t.phases) { const k = PHASE_RE.exec(p)[1]; (byNumber.get(k) || byNumber.set(k, []).get(k)).push({ owner: t.key, file: p, state: t.committed.includes(p) ? 'committed' : 'uncommitted' }); }
  }
  const used = [...byNumber.keys()].map(Number).filter((x) => Number.isInteger(x));
  const mainMax = Math.max(0, ...used);
  for (const [k, owners] of byNumber) {
    const ticketOwners = owners.filter((o) => o.owner !== 'main');
    if (owners.length < 2 || !ticketOwners.length) continue;
    for (let i = 0; i < owners.length; i++) for (let j = i + 1; j < owners.length; j++) {
      if (owners[i].owner === 'main' && owners[j].owner === 'main') continue;
      const where = (o) => `${o.file}${o.owner === 'main' ? ' on main' : ` (${o.owner}, ${o.state})`}`;
      add('C4', 'medium', owners[i].owner, owners[j].owner, `phase${k} is used by ${where(owners[i])} and ${where(owners[j])}; the next free number is phase${mainMax + 1}`, { files: [owners[i], owners[j]] });
    }
  }
  // C5: one table, two tickets.
  const byTable = new Map();
  for (const t of lead) for (const tb of t.tables) (byTable.get(tb) || byTable.set(tb, []).get(tb)).push(t);
  for (const [tb, ts] of byTable) for (let i = 0; i < ts.length; i++) for (let j = i + 1; j < ts.length; j++) {
    if (!same(ts[i], ts[j])) add('C5', 'high', ts[i].key, ts[j].key, `both tickets create or alter table ${tb}`, { table: tb });
  }
  // C2 and C3: files that two tickets both change; committed conflicts from merge-tree.
  for (let i = 0; i < lead.length; i++) for (let j = i + 1; j < lead.length; j++) {
    const a = lead[i]; const b = lead[j];
    const both = a.files.filter((x) => b.files.includes(x));
    const risky = both.filter((x) => !lowRisk(x));
    const shared = both.filter(lowRisk);
    // A line-level merge of two branches is only meaningful when both start from the same main
    // commit. Otherwise it also reports main's own changes; those show as C16 per ticket.
    const textual = a.branch && b.branch && a.base && a.base === b.base ? mergeConflicts(main, a.branch, b.branch) : null;
    if (risky.length || (textual && textual.some((x) => !lowRisk(x)))) add('C2', 'high', a.key, b.key, `both change ${risky.length} file(s) outside the shared list${textual && textual.length ? `; a merge of the committed branches conflicts in ${textual.length} file(s)` : ''}`, { files: risky.slice(0, 20), mergeConflicts: textual });
    const locales = shared.filter((x) => /\/i18n\/locales\//.test(x)).length;
    if (shared.length) add('C3', 'low', a.key, b.key, `both change ${shared.length} shared file(s) (${locales} locale file(s)${shared.length > locales ? ' and registries' : ''}); the later ticket re-merges them at rebase`, { files: shared });
  }
  // C7: MCP changes and versions.
  const mcpTickets = lead.filter((t) => t.mcp);
  // Tickets that share one MCP version: the first keeps it, and each later one gets its own next
  // version, above npm, main and every ticket's version (number order, not text order).
  const taken = [npm, mainVersion, ...mcpTickets.map((t) => t.mcp.version)].filter(Boolean);
  const bump = () => {
    const top = [...taken].sort(verCmp).pop();
    const [ma, mi] = String(top).split('.').map(Number);
    const v = `${ma}.${(mi || 0) + 1}.0`;
    taken.push(v);
    return v;
  };
  const reassign = new Map();
  const byVersion = new Map();
  // Group by the same comparison the pair check uses (verCmp reads three numbers), so "2.13" and
  // "2.13.0", or two prereleases of 2.13.0, are one group and both get a decision.
  const vkey = (v) => { const parts = String(v).split(/[.-]/); return [0, 1, 2].map((i) => Number(parts[i]) || 0).join('.'); };
  for (const t of mcpTickets) if (t.mcp.version) { const k = vkey(t.mcp.version); (byVersion.get(k) || byVersion.set(k, []).get(k)).push(t); }
  for (const group of byVersion.values()) for (const t of group.slice(1)) reassign.set(t.key, bump());
  for (let i = 0; i < mcpTickets.length; i++) for (let j = i + 1; j < mcpTickets.length; j++) {
    const a = mcpTickets[i]; const b = mcpTickets[j];
    const va = a.mcp.version; const vb = b.mcp.version;
    if (va && vb && verCmp(va, vb) === 0) {
      const later = reassign.has(b.key) ? b : a;
      add('C7', 'high', a.key, b.key, `both change ${MCP_DIR} at the same version ${va}; only one can publish it, so ${later.key} takes ${reassign.get(later.key)}`, { versions: [va, vb], later: later.key, next: reassign.get(later.key) });
    } else add('C7', 'medium', a.key, b.key, `both change ${MCP_DIR} (${va || '?'} and ${vb || '?'}); their publishes must be ordered`, { versions: [va, vb] });
  }
  for (const t of lead) {
    if (!t.mcp && npm && t.mcpCheckout && verCmp(t.mcpCheckout, npm) < 0) add('C7', 'low', t.key, 'npm', `its ${MCP_DIR} checkout is at ${t.mcpCheckout}, below npm latest ${npm}; an MCP change made here starts from an old version`, { version: t.mcpCheckout, npm });
  }
  for (const t of mcpTickets) {
    if (npm && t.mcp.version && verCmp(t.mcp.version, npm) <= 0) add('C7', 'medium', t.key, 'npm', `its ${MCP_DIR} is at ${t.mcp.version}, which is not above npm latest ${npm}; it needs a new version before a publish`, { version: t.mcp.version, npm });
    else if (npm && t.mcp.version) add('C7', 'low', t.key, 'npm', `it changes ${MCP_DIR} at ${t.mcp.version} (npm latest ${npm}); its publish is an owner gate`, { version: t.mcp.version, npm });
  }
  // C16: base behind main, and the files main changed that the ticket also changes.
  for (const t of lead) {
    if (!t.behind) continue;
    const hard = t.mainConflicts.filter((x) => !lowRisk(x));
    const sev = hard.length ? 'high' : t.mainMovedOn.length ? 'medium' : 'low';
    add('C16', sev, t.key, 'main', `${t.behind} commit(s) behind ${mainRef}${t.mainMovedOn.length ? `; main changed ${t.mainMovedOn.length} file(s) this ticket also changes` : ''}${t.mainConflicts.length ? `; merging it into main now conflicts in ${t.mainConflicts.length} file(s)` : ''}`, { behind: t.behind, files: t.mainMovedOn.slice(0, 20), mainConflicts: t.mainConflicts });
  }
  // C15: a ticket still being planned, whose plan names a file main changed after the plan was written
  // (the incident: "pull first, TCK-1881 is shipping and may affect you"). Its diff says nothing yet.
  for (const t of tickets) {
    if (!PLANNING.includes(t.status)) continue;
    const plan = plans[t.key] || planFromTranscript(t.sessionId);
    if (!plan || !fs.existsSync(plan)) continue;
    const planned = planFiles(fs.readFileSync(plan, 'utf8'));
    if (!planned.length) continue;
    const since = new Date(fs.statSync(plan).mtimeMs).toISOString();
    // Ships arrive as merges: walk main's first-parent line and diff each merge against main as it
    // was, so a merged branch counts by the date it reached main, not by its own commit dates.
    const shipped = [...new Set(lines(git(main, ['log', '--first-parent', '--diff-merges=first-parent', `--since=${since}`, '--name-only', '--format=', mainRef]).out))];
    const hit = shipped.filter((f) => namedBy(planned, f));
    if (hit.length) add('C15', 'medium', t.key, 'main', `main changed ${hit.length} file(s) its plan names since the plan was written; re-read them before building`, { plan: path.basename(plan), since, files: hit.slice(0, 20) });
  }
  // C12: a lockfile change.
  for (const t of lead) if (t.lockfile) add('C12', 'low', t.key, 'all', 'it changes package-lock.json; after it ships, every other worktree needs npm install', {});
  // C8: the main checkout's MCP build is older than its source.
  if (dist && dist.newestSource > dist.builtAt) add('C8', 'medium', 'main', 'all', `${MCP_DIR}/dist is older than its src; sessions run old MCP tools until it is rebuilt and /mcp is run`, { builtAt: new Date(dist.builtAt).toISOString(), newestSource: new Date(dist.newestSource).toISOString() });
  // C17: a bound session that is waiting or gone.
  // A session that is idle or gone while its ticket is being built: its loop has stopped and waits
  // for "continue" (the stall the owner had to ping 7 times in one loop, 2026-11-05 to 07).
  const BUILDING = ['implementing', 'iterating'];
  for (const t of tickets) {
    if (!t.sessionId || !t.sessionState || t.sessionState === 'busy') continue;
    const stopped = BUILDING.includes(t.status) && (t.sessionState === 'idle' || t.sessionState === 'not running');
    const detail = stopped ? `its session is ${t.sessionState} while the ticket is ${t.status}: its loop has stopped and needs "continue"` : `its session is ${t.sessionState}${t.waitingFor ? ` (${t.waitingFor})` : ''}`;
    add('C17', stopped || t.sessionState === 'not running' ? 'medium' : 'low', t.key, t.sessionId.slice(0, 8), detail, { state: t.sessionState, stopped });
  }

  // C10: local servers by worktree (observe only: a cleanup is never decided here).
  let processes = [];
  if (withProcesses) {
    processes = listeners().map((l) => {
      const wt = worktreeOf(l.cwd, wts);
      const owner = wt ? lead.find((t) => path.resolve(t.worktree) === path.resolve(wt.path)) : null;
      return { pid: l.pid, command: l.command, ports: l.ports, cwd: l.cwd, worktree: wt ? wt.path : null, ticket: owner ? owner.key : null, orphan: Boolean(wt) && !owner && path.resolve(wt.path) !== path.resolve(main) };
    });
  }
  conflicts.sort((x, y) => SEVERITY[x.severity] - SEVERITY[y.severity] || x.kind.localeCompare(y.kind));
  return { generatedAt: new Date().toISOString(), main: { path: main, ref: mainRef, phases: mainPhases.length, nextPhase: mainMax + 1, mcpVersion: mainVersion, npmLatest: npm, distStale: Boolean(dist && dist.newestSource > dist.builtAt) }, tickets, conflicts, processes };
}

function report(r) {
  const out = [];
  out.push(`coord-scan ${r.generatedAt} · main ${r.main.path} (${r.main.ref}) · next free phase ${r.main.nextPhase} · MCP main ${r.main.mcpVersion || '?'}, npm ${r.main.npmLatest || '?'}${r.main.distStale ? ' · dist STALE' : ''}`);
  const held = r.tickets.filter((t) => t.phases.length).map((t) => `${t.phases.map((p) => /phase(\d+(?:\.\d+)?)/.exec(p)[1]).join('+')} ${t.key}`);
  if (held.length) out.push(`phase numbers held by active tickets: ${held.join(', ')}`);
  out.push('', 'Tickets:');
  for (const t of r.tickets) {
    out.push(`  ${t.key} ${t.status} · session ${t.sessionId ? `${t.sessionId.slice(0, 8)} ${t.sessionState || '?'}` : 'none'} · ${t.worktree ? `${path.basename(t.worktree)} (${t.branch || 'detached'}, by ${t.mapBy})` : t.note}${t.behind ? ` · ${t.behind} behind` : ''}`);
    if (t.worktree) out.push(`      ${t.committed.length} committed + ${t.uncommitted.length} uncommitted file(s)${t.phases.length ? ` · phases ${t.phases.map((p) => path.basename(p)).join(', ')}` : ''}${t.mcp ? ` · MCP changed, ${t.mcp.version || '?'}` : t.mcpCheckout ? ` · MCP checkout ${t.mcpCheckout}` : ''}`);
  }
  out.push('', r.conflicts.length ? 'Conflicts:' : 'Conflicts: none');
  for (const c of r.conflicts) out.push(`  [${c.severity}] ${c.kind} ${c.a} <-> ${c.b}: ${c.detail}`);
  const orphans = r.processes.filter((p) => p.orphan);
  if (r.processes.length) out.push('', `Local servers: ${r.processes.length} (${orphans.length} in a worktree with no active ticket)`);
  for (const p of r.processes) out.push(`  pid ${p.pid} ${p.command} :${p.ports.join(',')} ${p.worktree ? path.basename(p.worktree) : p.cwd || '?'}${p.ticket ? ` (${p.ticket})` : p.orphan ? ' (no active ticket)' : ''}`);
  return out.join('\n');
}

// ── selftest ─────────────────────────────────────────────────────────────────

function selftest() {
  let failed = 0;
  const eq = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
  };
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coord-scan-test-')));
  const repo = path.join(root, 'repo');
  const sh = (cwd, ...args) => { const r = git(cwd, args); if (!r.ok) throw new Error(`git ${args.join(' ')}: ${r.err}`); return r.out; };
  const write = (dir, file, text) => { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), text); };
  try {
    fs.mkdirSync(repo);
    sh(repo, 'init', '-q', '-b', 'main');
    sh(repo, 'config', 'user.email', 't@t'); sh(repo, 'config', 'user.name', 't'); sh(repo, 'config', 'commit.gpgsign', 'false');
    write(repo, 'scripts/phase75-main.sql', 'CREATE TABLE a (id int);\n');
    write(repo, 'src/frontend/src/i18n/locales/en.json', '{\n  "a": "A",\n  "z": "Z"\n}\n');
    write(repo, `${MCP_DIR}/package.json`, '{ "version": "2.12.0" }\n');
    write(repo, `${MCP_DIR}/src/a.ts`, 'export const a = 1;\n');
    write(repo, 'src/x.ts', 'export const x = 1;\n');
    sh(repo, 'add', '-A'); sh(repo, 'commit', '-q', '-m', 'base');
    const wt = (n) => { const p = path.join(root, `repo-tck-${n}`); sh(repo, 'worktree', 'add', '-q', '-b', `loop/tck-${n}`, p, 'main'); return p; };
    const w1 = wt(1); const w2 = wt(2); const w3 = wt(3);
    // TCK-1: a committed phase75 (taken on main), a locale key, an MCP change at an old version.
    write(w1, 'scripts/phase75-one.sql', 'CREATE TABLE one (id int);\n');
    write(w1, 'src/frontend/src/i18n/locales/en.json', '{\n  "a": "A",\n  "one": "1",\n  "z": "Z"\n}\n');
    write(w1, `${MCP_DIR}/package.json`, '{ "version": "2.11.1" }\n');
    sh(w1, 'add', '-A'); sh(w1, 'commit', '-q', '-m', 'one');
    // TCK-2: a staged phase76 that creates table foo, an uncommitted locale change, a committed src/x.ts change, an MCP change.
    write(w2, 'src/x.ts', 'export const x = 2;\n'); write(w2, `${MCP_DIR}/src/a.ts`, 'export const a = 2;\n');
    sh(w2, 'add', '-A'); sh(w2, 'commit', '-q', '-m', 'two');
    write(w2, 'scripts/phase76-two.sql', 'CREATE TABLE IF NOT EXISTS foo (id int);\n'); sh(w2, 'add', 'scripts/phase76-two.sql');
    write(w2, 'src/frontend/src/i18n/locales/en.json', '{\n  "a": "A",\n  "two": "2",\n  "z": "Z"\n}\n');
    // TCK-3: an untracked phase76 that alters foo, a committed src/x.ts change that conflicts with TCK-2, and loop working memory.
    write(w3, 'src/x.ts', 'export const x = 3;\n'); sh(w3, 'add', '-A'); sh(w3, 'commit', '-q', '-m', 'three');
    write(w3, 'scripts/phase76-three.sql', 'ALTER TABLE foo ADD COLUMN b int;\n');
    write(w3, 'TCK-3-LOOP-STATE.md', 'state'); write(w3, 'loop-stack/x.log', 'log');
    // An unstaged change to a tracked file: its status line starts with a space.
    write(w3, 'src/frontend/src/i18n/locales/en.json', '{\n  "a": "A",\n  "three": "3",\n  "z": "Z"\n}\n');
    // Main moves on after the worktrees were cut: TCK-3 is behind, and main changed src/x.ts.
    write(repo, 'src/x.ts', 'export const x = 0;\n'); sh(repo, 'commit', '-q', '-am', 'main moves');
    // TCK-7 is cut after main moved and never touches src/x.ts. A merge of its branch with TCK-2's
    // would still conflict there, through main's own change: that is not a TCK-2/TCK-7 conflict.
    const w7 = wt(7); write(w7, 'src/seven.ts', 'export const s = 7;\n'); sh(w7, 'add', '-A'); sh(w7, 'commit', '-q', '-m', 'seven');
    const before = [w1, w2, w3, w7, repo].map((d) => git(d, ['status', '--porcelain=v1', '-uall']).out);
    // A tracked file whose date changed but whose content did not: a plain `git status` would now
    // rewrite that worktree's index. Hash every index before the scan.
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(w7, 'src', 'seven.ts'), later, later);
    fs.utimesSync(path.join(w1, 'scripts', 'phase75-one.sql'), later, later);
    const indexFile = (d) => git(d, ['rev-parse', '--path-format=absolute', '--git-path', 'index']).out;
    const hashOf = (f) => { try { return createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return null; } };
    const indexBefore = [w1, w2, w3, w7, repo].map((d) => hashOf(indexFile(d)));
    const objectsBefore = git(repo, ['count-objects', '-v']).out;
    const refsOf = () => git(repo, ['for-each-ref', '--format=%(refname) %(objectname)']).out;
    const refsBefore = refsOf();
    const board = { issues: [
      { key: 'TCK-1', work_status: 'implementing' }, { key: 'TCK-2', work_status: 'implementing' },
      { key: 'TCK-3', work_status: 'iterating' }, { key: 'TCK-4', work_status: 'implementing', bound_session_id: 'sid-4' },
      { key: 'TCK-5', work_status: 'shipped' }, { key: 'TCK-6', work_status: 'implementing', bound_session_id: 'sid-6' },
      { key: 'TCK-7', work_status: 'implementing' },
    ] };
    const agents = [{ sessionId: 'sid-4', cwd: path.join(w1, 'src'), status: 'waiting', waitingFor: 'input needed' }, { sessionId: 'sid-6', cwd: repo, status: 'busy' }];
    const r = scan({ repo: w2, board, agents, npm: '2.12.0', withProcesses: false });
    const kinds = (k) => r.conflicts.filter((c) => c.kind === k).map((c) => [c.a, c.b]);
    eq('main checkout is found from a worktree', r.main.path, repo);
    eq('only active tickets are scanned', r.tickets.map((t) => t.key), ['TCK-1', 'TCK-2', 'TCK-3', 'TCK-4', 'TCK-6', 'TCK-7']);
    eq('mapping: naming for TCK-1..3, the session for TCK-4, none for a session in the main checkout', r.tickets.map((t) => t.mapBy), ['name', 'name', 'name', 'session', null, 'name']);
    eq('branches from different main commits are not merged with each other', r.conflicts.some((c) => c.kind === 'C2' && (c.a === 'TCK-7' || c.b === 'TCK-7')), false);
    eq('a ticket cut from the newest main is not behind', r.tickets[5].behind, 0);
    eq('a session in the main checkout gets no worktree and a note', [r.tickets[4].worktree, /main checkout/.test(r.tickets[4].note)], [null, true]);
    eq('a ticket in the main checkout is in no pair', r.conflicts.some((c) => c.a === 'TCK-6' || c.b === 'TCK-6'), false);
    eq('a status line that starts with a space keeps its whole path', r.tickets[2].uncommitted.includes('src/frontend/src/i18n/locales/en.json'), true);
    eq('C13: TCK-4 works in TCK-1\'s worktree', kinds('C13'), [['TCK-1', 'TCK-4']]);
    eq('a shared worktree is scanned once, for the ticket whose session works there', r.tickets.filter((t) => t.worktree === w1).map((t) => t.key), ['TCK-1', 'TCK-4']);
    eq('C4: phase75 against main, phase76 staged against untracked', kinds('C4'), [['main', 'TCK-4'], ['TCK-2', 'TCK-3']]);
    eq('C4: the next free number counts every ticket, not only main', r.conflicts.find((c) => c.kind === 'C4').detail.includes('the next free number is phase77'), true);
    eq('C4: a staged file is named as uncommitted', r.conflicts.some((c) => c.kind === 'C4' && c.detail.includes('(TCK-2, uncommitted)')), true);
    eq('C5: table foo in TCK-2 and TCK-3', kinds('C5'), [['TCK-2', 'TCK-3']]);
    eq('C2: TCK-2 and TCK-3 both change src/x.ts and their merge conflicts', r.conflicts.filter((c) => c.kind === 'C2').map((c) => [c.a, c.b, c.evidence.files, c.evidence.mergeConflicts]), [['TCK-2', 'TCK-3', ['src/x.ts'], ['src/x.ts']]]);
    eq('C3: the locale file is shared, not a C2 conflict', kinds('C3'), [['TCK-2', 'TCK-3'], ['TCK-2', 'TCK-4'], ['TCK-3', 'TCK-4']]);
    eq('C3: the locale files are counted', r.conflicts.find((c) => c.kind === 'C3').detail.includes('1 locale file(s)'), true);
    eq('the report lists the phase numbers each ticket holds', /phase numbers held by active tickets: .*76 TCK-2/.test(report(r)), true);
    eq('C7: two MCP changes, and neither is above npm', kinds('C7'), [['TCK-2', 'TCK-4'], ['TCK-2', 'npm'], ['TCK-4', 'npm']]);
    eq('C7: the old version is named', r.conflicts.some((c) => c.kind === 'C7' && c.detail.includes('2.11.1')), true);
    eq('C7: different versions are medium', r.conflicts.filter((c) => c.kind === 'C7' && c.b !== 'npm').map((c) => c.severity), ['medium']);
    eq('C17: a waiting session on an implementing ticket is low; an idle one is a stopped loop (medium)', [r.conflicts.find((c) => c.kind === 'C17').severity, (() => { const r2 = scan({ repo: w2, board, agents: [{ ...agents[0], status: 'idle', waitingFor: undefined }, agents[1]], npm: '2.12.0', withProcesses: false }); const c = r2.conflicts.find((x) => x.kind === 'C17'); return [c.severity, /loop has stopped/.test(c.detail)]; })()], ['low', ['medium', true]]);
    eq('C16: TCK-2 and TCK-3 conflict with main in src/x.ts (high); TCK-4 is only behind', r.conflicts.filter((c) => c.kind === 'C16').map((c) => [c.a, c.severity, c.evidence.mainConflicts]), [['TCK-2', 'high', ['src/x.ts']], ['TCK-3', 'high', ['src/x.ts']], ['TCK-4', 'low', []]]);
    eq('C17: a waiting session is reported', r.conflicts.filter((c) => c.kind === 'C17').map((c) => c.detail), ['its session is waiting (input needed)']);
    eq('loop working memory is not a product file', r.tickets[2].files.includes('TCK-3-LOOP-STATE.md') || r.tickets[2].files.some((f) => f.startsWith('loop-stack/')), false);
    eq('staged and untracked phase files are seen', [r.tickets[1].phases, r.tickets[2].phases], [['scripts/phase76-two.sql'], ['scripts/phase76-three.sql']]);
    eq('read-only: no worktree changed', [w1, w2, w3, w7, repo].map((d) => git(d, ['status', '--porcelain=v1', '-uall']).out), before);
    eq('read-only: the repository gained no objects', git(repo, ['count-objects', '-v']).out, objectsBefore);
    eq('read-only: no index was rewritten, even for files with a new date', [w1, w2, w3, w7, repo].map((d) => hashOf(indexFile(d))), indexBefore);
    eq('read-only: no ref changed', refsOf(), refsBefore);
    // The state of every worktree, index, object and ref, for the read-only checks of the later scans.
    const snapAll = () => JSON.stringify([[w1, w2, w3, w7, repo].map((d) => [git(d, ['status', '--porcelain=v1', '-uall']).out, hashOf(indexFile(d))]), git(repo, ['count-objects', '-v']).out, refsOf()]);
    // C15: a ticket still being planned, whose plan names a file main changed after the plan was written.
    const snapC15 = snapAll();
    const planOld = path.join(root, 'plan-old.md');
    fs.writeFileSync(planOld, '# Plan\n\n## Critical files\n- `src/x.ts`\n- `scripts/nothing.sql`\n\n## Other\n- `src/elsewhere.ts`\n');
    const past = new Date(Date.now() - 3600_000);
    fs.utimesSync(planOld, past, past);
    const planNew = path.join(root, 'plan-new.md');
    fs.writeFileSync(planNew, '## Critical files\n- `src/x.ts`\n');
    const future = new Date(Date.now() + 3600_000);
    fs.utimesSync(planNew, future, future);
    const planPrefix = path.join(root, 'plan-prefix.md');
    fs.writeFileSync(planPrefix, '## Critical files\n- `src/x.t`\n- `script/`\n');
    fs.utimesSync(planPrefix, past, past);
    const planBoard = { issues: [{ key: 'TCK-11', work_status: 'planning' }, { key: 'TCK-12', work_status: 'ready_to_implement' }, { key: 'TCK-13', work_status: 'implementing' }, { key: 'TCK-14', work_status: 'planning' }, { key: 'TCK-17', work_status: 'ready_to_implement' }, { key: 'TCK-18', work_status: 'planning' }] };
    const rp = scan({ repo: w2, board: planBoard, agents: [], npm: '2.12.0', plans: { 'TCK-11': planOld, 'TCK-12': planNew, 'TCK-13': planOld, 'TCK-14': path.join(root, 'missing.md'), 'TCK-17': planOld, 'TCK-18': planPrefix }, withProcesses: false });
    const planFolder = path.join(root, 'plan-folder.md');
    fs.writeFileSync(planFolder, '## Critical files\n- `scripts/`\n- `scripts-other/x.sql`\n');
    fs.utimesSync(planFolder, past, past);
    const rf = scan({ repo: w2, board: { issues: [{ key: 'TCK-16', work_status: 'planning' }] }, agents: [], npm: '2.12.0', plans: { 'TCK-16': planFolder }, withProcesses: false });
    eq('C15: a folder the plan names covers the files main changed inside it', rf.conflicts.filter((c) => c.kind === 'C15').map((c) => c.evidence.files), [['scripts/phase75-main.sql']]);
    eq('C15: planning and ready tickets whose plan names a file main changed since get it; a newer plan, a building ticket, a missing plan or a mere name prefix does not', rp.conflicts.filter((c) => c.kind === 'C15').map((c) => [c.a, c.b, c.severity, c.evidence.files, c.evidence.plan]), [['TCK-11', 'main', 'medium', ['src/x.ts'], 'plan-old.md'], ['TCK-17', 'main', 'medium', ['src/x.ts'], 'plan-old.md']]);
    // Without --plans: the plan is the newest ~/.claude/plans/*.md the bound session's transcript names.
    const cfg = path.join(root, 'claude-config');
    const plansDir = path.join(cfg, 'plans');
    fs.mkdirSync(plansDir, { recursive: true });
    fs.mkdirSync(path.join(cfg, 'projects', '-work-x'), { recursive: true });
    const viaTranscript = path.join(plansDir, 'tck-15-plan.md');
    fs.copyFileSync(planOld, viaTranscript);
    fs.utimesSync(viaTranscript, past, past);
    const older = path.join(plansDir, 'older.md');
    fs.writeFileSync(older, '## Critical files\n- `src/never.ts`\n');
    const sid15 = 'aaaabbbb-1111-2222-3333-444455556666';
    fs.writeFileSync(path.join(cfg, 'projects', '-work-x', `${sid15}.jsonl`), [
      JSON.stringify({ type: 'user', message: `see ${older}` }),
      JSON.stringify({ type: 'assistant', message: `plan written to ${viaTranscript}` }),
    ].join('\n') + '\n');
    const savedCfg = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = cfg;
    let r15;
    try {
      r15 = scan({ repo: w2, board: { issues: [{ key: 'TCK-15', work_status: 'planning', bound_session_id: sid15 }] }, agents: [], npm: '2.12.0', withProcesses: false });
    } finally {
      if (savedCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = savedCfg;
    }
    eq('C15: the plan comes from the session transcript (the newest one it names)', r15.conflicts.filter((c) => c.kind === 'C15').map((c) => [c.a, c.evidence.plan]), [['TCK-15', 'tck-15-plan.md']]);
    // A long transcript: only its last 4 MB is read, where the newest plan is; the default config folder's ~/.claude form.
    const home = path.join(root, 'home');
    const homePlans = path.join(home, '.claude', 'plans');
    fs.mkdirSync(homePlans, { recursive: true });
    fs.mkdirSync(path.join(home, '.claude', 'projects', '-w'), { recursive: true });
    fs.copyFileSync(planOld, path.join(homePlans, 'newest.md'));
    fs.utimesSync(path.join(homePlans, 'newest.md'), past, past);
    fs.writeFileSync(path.join(homePlans, 'first.md'), '## Critical files\n- `src/never.ts`\n');
    const sid19 = 'ccccdddd-1111-2222-3333-444455556666';
    fs.writeFileSync(path.join(home, '.claude', 'projects', '-w', `${sid19}.jsonl`), [
      JSON.stringify({ type: 'user', message: 'the plan is ~/.claude/plans/first.md' }),
      JSON.stringify({ type: 'assistant', message: 'x'.repeat(4.5 * 1024 * 1024) }),
      JSON.stringify({ type: 'assistant', message: 'now ~/.claude/plans/newest.md' }),
    ].join('\n') + '\n');
    const savedHome = process.env.HOME;
    const savedCfg2 = process.env.CLAUDE_CONFIG_DIR;
    process.env.HOME = home;
    delete process.env.CLAUDE_CONFIG_DIR;
    let r19;
    try {
      r19 = scan({ repo: w2, board: { issues: [{ key: 'TCK-19', work_status: 'planning', bound_session_id: sid19 }] }, agents: [], npm: '2.12.0', withProcesses: false });
    } finally {
      process.env.HOME = savedHome;
      if (savedCfg2 === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = savedCfg2;
    }
    eq('C15: a long transcript is read from its end; the ~/.claude/plans form resolves', r19.conflicts.filter((c) => c.kind === 'C15').map((c) => [c.a, c.evidence.plan]), [['TCK-19', 'newest.md']]);
    eq('planFiles: only the Critical files section; folders kept; bare words, absolute and home paths skipped', planFiles('## Critical files\n- `src/a.ts` and `src/b/`\n- `npm test` `/abs/x.ts` `~/x/y.ts` `noslash.ts`\n### A sub-heading inside\n- `src/sub.ts`\n## Next\n- `src/c.ts`'), ['src/a.ts', 'src/b/', 'src/sub.ts']);
    eq('planFiles: without the heading, every backticked path, without a line number or anchor', planFiles('Touch `src/a.ts` then `scripts/x.sql:12` and `docs/a.md#top`.'), ['src/a.ts', 'scripts/x.sql', 'docs/a.md']);
    eq('read-only: the C15 scans write nothing', snapAll(), snapC15);
    const pairs = (res) => res.conflicts.map((c) => `${c.kind} ${c.a} ${c.b}`).sort();
    const reversed = scan({ repo: w2, board: { issues: [...board.issues].reverse() }, agents, npm: '2.12.0', withProcesses: false });
    eq('pair order: the same pairs, named the same way, whatever the board order', pairs(reversed), pairs(r));
    eq('pair order: ticket numbers compare as numbers, not as text', [orderPair('TCK-10', 'TCK-9'), orderPair('TCK-9', 'TCK-10'), orderPair('TCK-1890', 'TCK-26'), orderPair('TCK-26', 'TCK-1890')], [['TCK-9', 'TCK-10'], ['TCK-9', 'TCK-10'], ['TCK-26', 'TCK-1890'], ['TCK-26', 'TCK-1890']]);
    eq('pair order: main, npm, all and a session keep their side', [orderPair('main', 'TCK-1'), orderPair('TCK-9', 'npm'), orderPair('TCK-9', 'all'), orderPair('TCK-9', 'b2070484'), orderPair('TCK-9', 'TCK-9')], [['main', 'TCK-1'], ['TCK-9', 'npm'], ['TCK-9', 'all'], ['TCK-9', 'b2070484'], ['TCK-9', 'TCK-9']]);
    eq('pair order: two tickets are named in ticket-number order', r.conflicts.filter((c) => /^TCK-\d+$/.test(c.a) && /^TCK-\d+$/.test(c.b)).every((c) => Number(c.a.slice(4)) < Number(c.b.slice(4))), true);
    eq('severity order: high first', r.conflicts.map((c) => SEVERITY[c.severity]).every((v, i, a) => i === 0 || a[i - 1] <= v), true);
    eq('the report names every conflict kind', ['C2', 'C3', 'C4', 'C5', 'C7', 'C13', 'C16', 'C17'].every((k) => report(r).includes(` ${k} `)), true);
    eq('tables: CREATE and ALTER are read', tablesIn(path.join(w3, 'scripts/phase76-three.sql')), ['foo']);
    // Two tickets change the MCP package at one version (the TCK-1894 / TCK-1866 clash of
    // 2026-11-07 22:45): high, with the next version nobody holds.
    write(w3, `${MCP_DIR}/src/b.ts`, 'export const b = 3;\n');
    let snap = snapAll();
    const r3 = scan({ repo: w2, board, agents, npm: '2.12.0', withProcesses: false });
    eq('read-only: the same-version scan writes nothing', snapAll(), snap);
    const clash = r3.conflicts.find((c) => c.kind === 'C7' && c.severity === 'high');
    eq('C7: one MCP version in two tickets is high and names the next free version', clash ? [clash.a, clash.b, /same version 2\.12\.0/.test(clash.detail), clash.evidence.next] : null, ['TCK-2', 'TCK-3', true, '2.13.0']);
    // The real case of 2026-11-07: tickets above npm (npm 2.12.0, tickets at 2.13.0 → 2.14.0); npm
    // as the highest (2.15.0 → 2.16.0); number order, not text order (npm 2.9.0 is below 2.13.0).
    write(w2, `${MCP_DIR}/package.json`, '{ "version": "2.13.0" }\n');
    write(w3, `${MCP_DIR}/package.json`, '{ "version": "2.13.0" }\n');
    snap = snapAll();
    const nextFor = (npmV) => { const c = scan({ repo: w2, board, agents, npm: npmV, withProcesses: false }).conflicts.find((x) => x.kind === 'C7' && x.severity === 'high'); return c ? c.evidence.next : null; };
    eq('C7: the next version is above the tickets, npm and main, in number order', [nextFor('2.12.0'), nextFor('2.15.0'), nextFor('2.9.0')], ['2.14.0', '2.16.0', '2.14.0']);
    eq('read-only: the next-version scans write nothing', snapAll(), snap);
    // Main's own version counts: with main at 2.20.0 the new version is 2.21.0.
    write(repo, `${MCP_DIR}/package.json`, '{ "version": "2.20.0" }\n');
    snap = snapAll();
    eq('C7: main\'s version is counted', nextFor('2.12.0'), '2.21.0');
    eq('read-only: the main-version scan writes nothing', snapAll(), snap);
    write(repo, `${MCP_DIR}/package.json`, '{ "version": "2.12.0" }\n');
    // "2.13" and "2.13.0" are one version for the comparison, so they get a decision, not "undefined".
    write(w3, `${MCP_DIR}/package.json`, '{ "version": "2.13" }\n');
    eq('C7: 2.13 and 2.13.0 are one version and get a real new version', nextFor('2.12.0'), '2.14.0');
    write(w3, `${MCP_DIR}/package.json`, '{ "version": "2.13.0" }\n');
    // Three tickets at one version: each later one gets its own new version.
    write(w1, `${MCP_DIR}/package.json`, '{ "version": "2.13.0" }\n');
    snap = snapAll();
    const r4 = scan({ repo: w2, board, agents, npm: '2.12.0', withProcesses: false });
    eq('C7: three tickets at one version get two different new versions', [...new Map(r4.conflicts.filter((x) => x.kind === 'C7' && x.severity === 'high').map((x) => [x.evidence.later, x.evidence.next]))].sort(), [['TCK-3', '2.14.0'], ['TCK-4', '2.15.0']]);
    // Two different versions, the lower one first in the board's order: medium, never high.
    write(w1, `${MCP_DIR}/package.json`, '{ "version": "2.14.5" }\n');
    const r4b = scan({ repo: w2, board, agents, npm: '2.12.0', withProcesses: false });
    eq('C7: a lower version first and a higher one second is medium', (r4b.conflicts.find((x) => x.kind === 'C7' && x.a === 'TCK-2' && x.b === 'TCK-4') || {}).severity, 'medium');
    // A ticket whose MCP package.json has no version: medium, never high.
    write(w1, `${MCP_DIR}/package.json`, '{ "name": "x" }\n');
    const r4c = scan({ repo: w2, board, agents, npm: '2.12.0', withProcesses: false });
    eq('C7: a missing version is medium', (r4c.conflicts.find((x) => x.kind === 'C7' && x.a === 'TCK-2' && x.b === 'TCK-4') || {}).severity, 'medium');
    eq('read-only: the version-order scans write nothing', snapAll(), (write(w1, `${MCP_DIR}/package.json`, '{ "name": "x" }\n'), snapAll()));
    // C17 in its other states: idle on an iterating ticket and a gone session on an implementing one
    // are stopped loops; idle on a planning ticket stays low.
    const board5 = { issues: [...board.issues, { key: 'TCK-8', work_status: 'iterating', bound_session_id: 'sid-8' }, { key: 'TCK-9', work_status: 'planning', bound_session_id: 'sid-9' }, { key: 'TCK-10', work_status: 'implementing', bound_session_id: 'sid-10' }] };
    const agents5 = [...agents, { sessionId: 'sid-8', cwd: w7, status: 'idle' }, { sessionId: 'sid-9', cwd: w7, status: 'idle' }];
    const r5 = scan({ repo: w2, board: board5, agents: agents5, npm: '2.12.0', withProcesses: false });
    const c17 = (k) => { const c = r5.conflicts.find((x) => x.kind === 'C17' && x.a === k); return c ? [c.severity, c.evidence.stopped] : null; };
    eq('C17: idle while iterating and gone while implementing are stopped loops; idle while planning is low', [c17('TCK-8'), c17('TCK-10'), c17('TCK-9')], [['medium', true], ['medium', true], ['low', false]]);
    eq('read-only: the later scans write nothing', snapAll(), snap);
    eq('versions compare numerically', [verCmp('2.13.0', '2.12.0') > 0, verCmp('2.11.1', '2.12.0') < 0, verCmp('2.10.0', '2.9.0') > 0], [true, true, true]);
    // C15 through a merge, the way this repository ships: the branch's commit is older than the plan,
    // the merge into main is newer. Main also changed a file before the plan, and the branch synced
    // that in after the plan: main's first-parent line must not count it again. (Last: it moves main.)
    const old3h = new Date(Date.now() - 3 * 3600_000).toISOString();
    const old1h = new Date(Date.now() - 1 * 3600_000).toISOString();
    const dated = (args, when) => {
      const r = git(repo, args, { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when });
      if (!r.ok) throw new Error(`git ${args[0]}: ${r.err}`);
    };
    sh(repo, 'checkout', '-q', '-b', 'ship-x', 'main');
    write(repo, 'src/merged.ts', 'export const m = 1;\n');
    sh(repo, 'add', 'src/merged.ts');
    dated(['commit', '-q', '-m', 'old work'], old3h);
    sh(repo, 'checkout', '-q', 'main');
    write(repo, 'src/early.ts', 'export const e = 1;\n');
    sh(repo, 'add', 'src/early.ts');
    dated(['commit', '-q', '-m', 'main work before the plan'], old3h);
    sh(repo, 'checkout', '-q', 'ship-x');
    dated(['merge', '-q', '--no-ff', '-m', 'sync main in', 'main'], old1h);
    sh(repo, 'checkout', '-q', 'main');
    sh(repo, 'merge', '-q', '--no-ff', '-m', 'ship x', 'ship-x');
    const planMerge = path.join(root, 'plan-merge.md');
    fs.writeFileSync(planMerge, '## Critical files\n- `src/merged.ts`\n- `src/early.ts`\n');
    const old2h = new Date(Date.now() - 2 * 3600_000);
    fs.utimesSync(planMerge, old2h, old2h);
    const rm = scan({ repo, board: { issues: [{ key: 'TCK-20', work_status: 'planning' }] }, agents: [], npm: '2.12.0', plans: { 'TCK-20': planMerge }, withProcesses: false });
    eq('C15: a ship by merge counts, by the date it reached main; a sync merge on the branch does not', rm.conflicts.filter((c) => c.kind === 'C15').map((c) => c.evidence.files), [['src/merged.ts']]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log(failed ? `${failed} FAILED` : 'all passed');
  return failed ? 1 : 0;
}

// ── main ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--') && ['repo', 'board', 'agents', 'npm-latest', 'plans'].includes(a.slice(2))) { out[a.slice(2)] = next; i++; } else out[a.slice(2)] = true;
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (args.selftest) process.exit(selftest());
  if (!args.board || !fs.existsSync(args.board)) {
    console.error('usage: coord-scan.mjs --board <tickets.json> [--repo <main checkout>] [--agents <agents.json>] [--npm-latest <version>] [--plans <{"TCK-n": "plan.md"}>] [--json] | --selftest');
    process.exit(2);
  }
  const plans = args.plans ? JSON.parse(fs.readFileSync(args.plans, 'utf8')) : {};
  const result = scan({ repo: path.resolve(args.repo || process.cwd()), board: JSON.parse(fs.readFileSync(args.board, 'utf8')), agents: loadAgents(args.agents), npm: npmLatest(args['npm-latest']), plans });
  console.log(args.json ? JSON.stringify(result, null, 2) : report(result));
}
