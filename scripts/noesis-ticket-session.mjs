// noesis-ticket-session — the Noesis Jot ticket <-> this Claude Code session.
// Hook version 2 (@noesis-brain/mcp-server 2.7.0). `noesis-mcp setup --with-ticket-hook`
// copies this file to ~/.claude/hooks/ and runs it from UserPromptSubmit, PreToolUse (every
// tool), PostToolUse (ExitPlanMode, Bash, AskUserQuestion + the ticket tools) and SessionStart.
//
// The per-computer switch is ~/.claude/noesis-ticket.json, re-read on every event. When it is
// missing, or says "enabled": false, the hook does nothing at all: no output, no network.
// `setup --with-ticket-hook` writes {"enabled": true, "repos": []}. Its "repos" list (git
// remotes) turns on the "which ticket?" checkpoint in those repositories only:
//   - an UNBOUND session is denied ExitPlanMode and git commit / merge / push (and gh pr merge)
//     until the owner answers one AskUserQuestion with the header "Ticket". The hook reads the
//     answer itself (PostToolUse AskUserQuestion): "No ticket for this work" opens the gate for
//     the rest of the session (<sid>.gate.json); a ticket key or a new ticket means bind it.
//   - a BOUND session's commit gets a one-line confirmation note instead.
//   - never denied: sessions that started before "gateSince", subagents, unattended runs
//     (CLAUDE_CODE_SESSION_ATTENDED=0, e.g. claude -p), and the git commands of a running
//     /cc-loop (a loop-supervisor marker), which get a note instead.
//   - the owner's ship phrases ("ship it", "merge to main", "push it", "verify the deployment")
//     add the ship steps to a bound session's reminder, or ask which ticket an unbound one ships.
//   - after a bound session's first commit on a branch of a repo with a "deployBranch", the
//     ticket records that branch (PATCH branch), so a later merge can be traced to it.
//   - a push that moves a listed repo's deploy branch is read back (PreToolUse notes where the
//     remote-tracking branch was, PostToolUse compares): tickets whose "Ticket:" trailers or
//     recorded branches are in the new range are reported. The bound one moves to deploying by
//     itself; the others are listed for the owner to confirm, then backlog_ship.
//   - SessionStart (startup, resume, clear — never compact), in a listed repo, at most once every
//     6 hours: bindings of other sessions idle for 24 hours are reported (never released), and
//     tickets at ready_to_merge / deploying whose branch is already in the deploy branch are
//     listed for the owner (the reconcile). After /clear: the tickets bound to this folder.
// `node noesis-ticket-session.mjs --trailer-key` prints the key of the open ticket bound to
// CLAUDE_CODE_SESSION_ID, or nothing; the git prepare-commit-msg hook in scripts/git-hooks/
// uses it to add the trailer "Ticket: TCK-<n>" to that session's commits.
//
// The Jot page shows each ticket's work status and which session, on which computer, is
// working on it. The model keeps that true through the mcp__noesis__backlog_* tools; this
// hook makes the parts that must not depend on the model's memory deterministic:
//   - UserPromptSubmit, bound session: a short reminder of the ticket, its status and the
//     ladder (prose in CLAUDE.md drifts out of attention in long sessions). In plan mode, when
//     the ticket is already past Planning, one more line: a new plan that is not part of the
//     ticket follows the "New work in a bound session" procedure of /noesis-ticket.
//   - UserPromptSubmit, a ticket handed over ("TCK-12: ..." or "read TCK-12") while the
//     session holds none: a one-line bind nudge. A ticket merely mentioned gets nothing.
//   - The plan-mode steps, and nothing else: PreToolUse ExitPlanMode moves planning ->
//     ready_to_implement; PostToolUse ExitPlanMode (the plan was approved) moves
//     ready_to_implement -> implementing; any later tool or prompt still in plan mode while the
//     ticket says ready_to_implement moves it back to planning (the plan was rejected). A ticket
//     at any other status is left alone, so a plan never drags an Iterating ticket backwards.
//   - A Shipped or Dropped ticket never moves. The server refuses it too (TICKET_CLOSED), and
//     closing a ticket releases its binding, which drops this session's cache.
//
// Session ids: the MCP server stamps CLAUDE_CODE_SESSION_ID, which it read once at spawn, so
// after /clear it still names the pre-clear session while hook payloads carry the new id.
// The hook therefore NEVER sends its payload id: it sends the bound id it learned from the
// ticket tool's own response, cached per payload id in ~/.claude/tck-bindings/. After /clear
// the reminder is gone until `/noesis-ticket link TCK-<n>` re-links, which restores the cache.
// A status line can read the same cache file to show the bound ticket.
//
// Network: none unless the session is bound (or a status edge fires); every call aborts after
// 2.5 s and fails open. A cache older than one minute is re-checked on the next prompt, so a
// change on the page reaches the reminder (and a status line) soon. Subagent events
// (agent_id present) are ignored. Cache files untouched for 14 days are pruned.
// Config: NOESIS_API_URL / NOESIS_API_TOKEN, else the `noesis` MCP server entry in
// ~/.claude.json (user scope, or this project's local scope). Kill switch: TCK_SESSION_HOOK=off.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const HOOK_VERSION = 2;
const TIMEOUT_MS = 2500;
export const RECHECK_MS = 60 * 1000;
const PRUNE_MS = 14 * 24 * 60 * 60 * 1000;
const TICKET_TOOL = /^mcp__noesis__backlog_(bind|set_status|unbind|refine|ship)$/;
const CLOSED = ['shipped', 'dropped'];
/** Past Planning: a new plan in plan mode may be new work, not this ticket's. */
const PAST_PLANNING = ['implementing', 'iterating', 'ready_to_merge', 'deploying'];
const LADDER =
  'planning -> ready_to_implement (plan presented) -> implementing (plan approved) -> iterating (first version delivered, owner giving feedback) -> ready_to_merge (you judge the work complete) -> deploying (merge, push, verify) -> shipped (live)';

// "TCK-12: ..." is the Jot page's Copy format; "read/plan/run/do/work on TCK-12" or "let's do
// the ticket 12" is how the owner hands a ticket over in words. A number needs "TCK-" or the
// word "ticket" in front ("run 3 tests" is not a ticket). "is this like TCK-12?" is a mention.
// Each pattern captures the ticket NUMBER.
const HANDOVER = [
  /^\s*TCK-(\d+)\s*:/i,
  /\b(?:read|plan|run|do|build|work on|start|pick up|implement|investigate)\s+(?:the\s+)?(?:ticket\s+(?:TCK-)?|TCK-)(\d+)\b/i,
];

const isClosed = (status) => CLOSED.includes(status);
const closedLabel = (status) => (status === 'dropped' ? 'Dropped' : 'Shipped');

const ASK_HEADER = 'Ticket';
const NO_TICKET = 'No ticket for this work';
const NEW_TICKET = 'Create a new ticket from my words';
const OPEN = ['created', 'planning', 'ready_to_implement', 'implementing', 'iterating', 'ready_to_merge', 'deploying'];
// The owner's words for "start the ship step".
const SHIP_PHRASE = /\b(?:ship it|merge (?:it |this )?(?:in)?to main|push it|verify the deploy(?:ment)?)\b/i;

// ── The per-computer switch ─────────────────────────────────────────────────────────────

function switchPath() {
  return process.env.NOESIS_TICKET_CONFIG || path.join(os.homedir(), '.claude', 'noesis-ticket.json');
}

/** A git remote as host/owner/repo: https, ssh and scp forms of one repository compare equal. */
export function normRemote(url) {
  let s = String(url || '').trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // scheme
  s = s.replace(/^[^@/]+@/, ''); // user@ (or a token)
  s = s.replace(/^([^/:]+):\d+\//, '$1/'); // host:port/
  s = s.replace(/^([^/:]+):/, '$1/'); // scp form host:path
  return s.replace(/\/+$/, '').replace(/\.git$/, '');
}

/** The switch file, or null when the hook is off on this computer (missing, unreadable, enabled: false). */
export function loadSwitch() {
  let c;
  try {
    c = JSON.parse(fs.readFileSync(switchPath(), 'utf8'));
  } catch {
    return null;
  }
  if (!c || typeof c !== 'object' || c.enabled === false || String(c.enabled).toLowerCase() === 'false') return null;
  const repos = (Array.isArray(c.repos) ? c.repos : [])
    .filter((r) => r && typeof r.remote === 'string' && r.remote.trim())
    .map((r) => ({ remote: normRemote(r.remote), deployBranch: typeof r.deployBranch === 'string' ? r.deployBranch : null }));
  const since = Date.parse(c.gateSince);
  const home = os.homedir();
  const loopDir = typeof c.loopMarkerDir === 'string' ? c.loopMarkerDir.replace(/^~(?=[/\\]|$)/, home) : path.join(home, '.claude', 'loop-supervisor');
  return { repos, gateSince: Number.isFinite(since) ? since : 0, loopMarkerDir: loopDir };
}

function git(dir, args) {
  try {
    return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000, windowsHide: true }).trim();
  } catch {
    return '';
  }
}

const repoMemo = new Map();
/** The listed repository a folder belongs to (matched by its origin remote), or null. */
export function repoOf(dir, sw) {
  if (!dir || !sw || sw.repos.length === 0) return null;
  if (!repoMemo.has(dir)) repoMemo.set(dir, normRemote(git(dir, ['remote', 'get-url', 'origin'])));
  const remote = repoMemo.get(dir);
  const hit = remote ? sw.repos.find((r) => r.remote === remote) : null;
  return hit ? { ...hit, dir } : null;
}

// ── Which git calls a shell command makes ───────────────────────────────────────────────

/** Heredoc bodies blanked, so a commit message that says "git push" is never read as a command. */
function dropHeredocs(cmd) {
  return String(cmd).replace(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g, ' ');
}

/** A command split into simple commands (word arrays), honouring quotes and \ escapes. */
export function simpleCommands(cmd) {
  const s = dropHeredocs(cmd);
  const all = [];
  let words = [];
  let w = '';
  let inWord = false;
  let q = null;
  const endWord = () => {
    if (inWord) words.push(w);
    w = '';
    inWord = false;
  };
  const endCmd = () => {
    endWord();
    if (words.length) all.push(words);
    words = [];
  };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === q) q = null;
      else if (ch === '\\' && q === '"' && i + 1 < s.length) w += s[++i];
      else w += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      q = ch;
      inWord = true;
    } else if (ch === '\\' && i + 1 < s.length) {
      w += s[++i];
      inWord = true;
    } else if (';\n&|()`'.includes(ch)) endCmd();
    else if (ch === ' ' || ch === '\t' || ch === '\r') endWord();
    else {
      w += ch;
      inWord = true;
    }
  }
  endCmd();
  return all;
}

const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
// Words that may stand before the program: `if git commit …; then git push; fi`, `! git …`, `{ git push; }`.
const SKIP_WORDS = new Set(['command', 'exec', 'time', 'nohup', 'if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '}']);
const GIT_OPT_WITH_ARG = new Set(['-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);

/** A folder word with $NAME, ${NAME} and a leading ~ expanded; null when a variable is unknown. */
function expandWord(word, vars) {
  let unknown = false;
  const out = String(word)
    .replace(/^~(?=[/\\]|$)/, vars.HOME || os.homedir())
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, a, b) => {
      const v = vars[a || b];
      if (v === undefined) unknown = true;
      return v ?? '';
    });
  // `cd "$(git rev-parse --show-toplevel)"`: a command substitution is a folder we cannot know.
  return unknown || /[$`]/.test(out) ? null : out;
}

/** The git commit / merge / push calls (and gh pr merge) in a command, each with its folder. */
export function gitCheckpoints(command, cwd) {
  const found = [];
  if (!/\b(?:git|gh)\b/.test(String(command || ''))) return found;
  const start = cwd || process.cwd();
  // Variables the command line sets itself (`WT=/x; git -C $WT push`, `export WT=/x`), on top
  // of the environment. A folder that names an unknown variable falls back to the session cwd.
  const vars = { ...process.env };
  let here = start;
  for (const words of simpleCommands(command)) {
    let i = 0;
    const isExport = words[0] === 'export';
    if (isExport || words.every((x) => ASSIGN.test(x))) {
      for (const a of words.slice(isExport ? 1 : 0)) {
        const eq = a.indexOf('=');
        if (eq <= 0) continue;
        const v = expandWord(a.slice(eq + 1), vars);
        if (v === null) delete vars[a.slice(0, eq)]; // unknown value: the variable stays unknown
        else vars[a.slice(0, eq)] = v;
      }
      continue;
    }
    while (i < words.length && ASSIGN.test(words[i])) i++;
    if (words[i] === 'env') {
      i++;
      while (i < words.length && (ASSIGN.test(words[i]) || words[i].startsWith('-'))) i++;
    }
    while (SKIP_WORDS.has(words[i])) i++;
    const prog = words[i];
    if (prog === 'cd' || prog === 'pushd') {
      const d = words[i + 1];
      if (d && d !== '-') {
        const e = expandWord(d, vars);
        here = e === null ? start : path.resolve(here, e);
      }
      continue;
    }
    if (prog === 'gh') {
      if (words[i + 1] === 'pr' && words[i + 2] === 'merge') found.push({ kind: 'merge', dir: here });
      continue;
    }
    if (prog !== 'git') continue;
    let dir = here;
    i++;
    while (i < words.length && words[i].startsWith('-')) {
      if (words[i] === '-C') {
        const e = expandWord(words[i + 1] || '.', vars);
        dir = e === null ? start : path.resolve(dir, e);
        i += 2;
      } else i += GIT_OPT_WITH_ARG.has(words[i]) ? 2 : 1;
    }
    const sub = words[i];
    const rest = words.slice(i + 1);
    if (sub === 'commit') found.push({ kind: 'commit', dir });
    else if (sub === 'merge' && !rest.some((a) => ['--abort', '--continue', '--quit'].includes(a))) found.push({ kind: 'merge', dir });
    else if (sub === 'push' && !rest.includes('--dry-run') && !rest.includes('-n')) found.push({ kind: 'push', dir, args: rest });
  }
  return found;
}

// ── The commit trailer and the branch record ────────────────────────────────────────────

const openEntry = (e) => !!e && typeof e.key === 'string' && /^TCK-\d+$/.test(e.key) && !isClosed(e.status);

/** The key of the open ticket bound to this Claude Code session (CLAUDE_CODE_SESSION_ID), or null.
 *  The cache file is named by the hook-payload id; after /clear that differs from the bound id,
 *  so an entry whose bound_session_id matches counts too (ids compared without case). */
export function trailerKey(env = process.env) {
  if (env.TCK_SESSION_HOOK === 'off' || !loadSwitch()) return null;
  const sid = String(env.CLAUDE_CODE_SESSION_ID || '').trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(sid)) return null;
  const own = readCache(sid);
  if (openEntry(own)) return own.key;
  const want = sid.toLowerCase();
  try {
    for (const name of fs.readdirSync(cacheDir())) {
      if (!/^[A-Za-z0-9_-]+\.json$/.test(name)) continue; // never <sid>.gate.json
      let e = null;
      try {
        e = JSON.parse(fs.readFileSync(path.join(cacheDir(), name), 'utf8'));
      } catch {
        continue;
      }
      if (openEntry(e) && String(e.bound_session_id || '').toLowerCase() === want) return e.key;
    }
  } catch {
    /* no cache dir */
  }
  return null;
}

/** After a bound session commits on a feature branch of a repo with a deploy branch, record the branch once. */
async function recordBranch(sessionId, entry, p, sw) {
  const hit = gitCheckpoints(p.tool_input && p.tool_input.command, p.cwd).find((c) => c.kind === 'commit' || c.kind === 'merge');
  const repo = hit && repoOf(hit.dir, sw);
  if (!repo || !repo.deployBranch) return;
  const branch = git(hit.dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!branch || branch === 'HEAD' || branch === repo.deployBranch || entry.branch === branch) return;
  const cfg = loadConfig(p.cwd);
  if (!cfg) return;
  try {
    await api(cfg, 'PATCH', keyPath(entry.key), { branch });
  } catch {
    return; // offline, or the ticket refuses edits: try again at the next commit
  }
  writeCache(sessionId, { ...entry, branch });
}

// ── The "which ticket?" checkpoint ──────────────────────────────────────────────────────

/** Every checkpoint of this tool call that is in a listed repository (the gate uses the first). */
function findCheckpoints(p, sw) {
  if (!sw || sw.repos.length === 0) return [];
  if (p.tool_name === 'ExitPlanMode') {
    const repo = repoOf(p.cwd, sw);
    return repo ? [{ kind: 'plan', dir: p.cwd, repo }] : [];
  }
  if (p.tool_name !== 'Bash') return [];
  const hits = [];
  for (const c of gitCheckpoints(p.tool_input && p.tool_input.command, p.cwd)) {
    const repo = repoOf(c.dir, sw);
    if (repo) hits.push({ ...c, repo });
  }
  return hits;
}

// ── Push sync: the deploy branch moved, so which tickets did it carry? ──────────────────

function gitOk(dir, args) {
  try {
    execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore', timeout: 3000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

const pushPath = (sessionId) => path.join(cacheDir(), `${String(sessionId).replace(/[^A-Za-z0-9_-]/g, '')}.push.json`);

const PUSH_OPT_WITH_ARG = new Set(['-o', '--push-option', '--receive-pack', '--exec']);
const PUSH_RECORD_MAX_MS = 15 * 60 * 1000;

/** The remote a `git push` names (the first word that is not an option or an option's value), else origin. */
export function pushRemote(args) {
  const a = args || [];
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith('--repo=')) return a[i].slice('--repo='.length) || 'origin';
    if (a[i] === '--repo') return a[i + 1] || 'origin';
    if (PUSH_OPT_WITH_ARG.has(a[i])) {
      i++;
      continue;
    }
    if (a[i].startsWith('-')) continue;
    return !a[i].includes(':') && !a[i].includes('/') ? a[i] : 'origin';
  }
  return 'origin';
}

/** Before a push: note where the remote-tracking deploy branch is, to compare after it. The
 *  record belongs to this one Bash call (tool_use_id): a push that fails or is refused never
 *  reaches PostToolUse, and its record must not be read back by a later, unrelated call. */
function notePush(sessionId, hit, toolUseId, command) {
  if (!hit || hit.kind !== 'push' || !hit.repo.deployBranch) return;
  const remote = pushRemote(hit.args);
  const ref = `refs/remotes/${remote}/${hit.repo.deployBranch}`;
  const before = git(hit.dir, ['rev-parse', '--verify', '-q', ref]);
  try {
    fs.mkdirSync(cacheDir(), { recursive: true });
    fs.writeFileSync(
      pushPath(sessionId),
      JSON.stringify({ dir: hit.dir, remote, deployBranch: hit.repo.deployBranch, before, at: Date.now(), tool_use_id: toolUseId || null, command: String(command || '') }),
    );
  } catch {
    /* fail open */
  }
}

/** Open tickets at ready_to_merge / deploying whose recorded branch is contained in `tip` (the
 *  reconcile). `fresh` = this push brought it in: it was not already in `before`. Only a fresh
 *  branch is evidence that moves the bound ticket; every merged one is listed for the owner. */
async function mergedTickets(cfg, dir, remote, deployBranch, tip, before) {
  const found = [];
  for (const status of ['ready_to_merge', 'deploying']) {
    let data;
    try {
      data = await api(cfg, 'GET', `/api/mcp/backlog/issues?status=${status}`);
    } catch {
      continue;
    }
    for (const i of (data && Array.isArray(data.issues) ? data.issues : [])) {
      if (!i || !i.key || typeof i.branch !== 'string' || !i.branch || i.branch === deployBranch) continue;
      const ref = [`refs/heads/${i.branch}`, `refs/remotes/${remote}/${i.branch}`].find((r) => git(dir, ['rev-parse', '--verify', '-q', r]));
      if (!ref || !gitOk(dir, ['merge-base', '--is-ancestor', ref, tip])) continue;
      found.push({ issue: i, fresh: !!before && !gitOk(dir, ['merge-base', '--is-ancestor', ref, before]) });
    }
  }
  return found;
}

/** What THIS push did to the deploy branch, from the remote-tracking branch's reflog: the
 *  "update by push" entries written since the record. A fetch or pull in the same command
 *  moves the same ref, but never with that subject, so other sessions' pushes are not counted.
 *  Without a reflog (core.logAllRefUpdates=false), the push's own "old..new  x -> <branch>" line. */
function pushedRange(rec, response) {
  const ref = `refs/remotes/${rec.remote}/${rec.deployBranch}`;
  const lines = git(rec.dir, ['reflog', 'show', '--date=unix', '--format=%H%x09%gd%x09%gs', ref]).split('\n').filter(Boolean);
  if (lines.length) {
    const entries = lines.map((l) => {
      const [sha, gd = '', subject = ''] = l.split('\t');
      return { sha, t: Number((gd.match(/@\{(\d+)\}/) || [])[1]), subject };
    });
    // The reflog is newest first. The updates made since the record are the entries above the
    // newest one that still holds the recorded value (all of them when the ref did not exist).
    let end = entries.length;
    if (rec.before) {
      end = entries.findIndex((e) => e.sha === rec.before);
      if (end < 0) {
        // The recorded value is gone from the reflog (expired or rewritten): fall back to time.
        const since = Math.floor((rec.at || 0) / 1000);
        end = entries.findIndex((e) => !(e.t >= since));
        if (end < 0) end = entries.length;
      }
    }
    let newest = -1;
    let oldest = -1;
    for (let i = 0; i < end; i++) {
      if (!/^update by push/.test(entries[i].subject)) continue;
      if (newest < 0) newest = i;
      oldest = i;
    }
    if (newest < 0) return null; // this call did not push the deploy branch
    return { before: entries[oldest + 1] ? entries[oldest + 1].sha : null, after: entries[newest].sha };
  }
  const text = response && typeof response === 'object' ? `${response.stdout || ''}\n${response.stderr || ''}` : String(response || '');
  const esc = rec.deployBranch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = text.match(new RegExp(`([0-9a-f]{7,40})\\.{2,3}([0-9a-f]{7,40})\\s+\\S+\\s+->\\s+(?:refs/heads/)?${esc}\\b`));
  if (!m) return null;
  const full = (x) => git(rec.dir, ['rev-parse', '--verify', '-q', `${x}^{commit}`]) || null;
  const after = full(m[2]);
  return after ? { before: full(m[1]), after } : null;
}

/** After a push: if this push moved the deploy branch, move the bound ticket and list the others. */
async function afterPush(sessionId, entry, rec, cwd, response) {
  const moved = pushedRange(rec, response);
  if (!moved) return null;
  const { before, after } = moved;
  const range = before ? [`${before}..${after}`] : ['-n', '1', after];
  const trailerKeys = new Set(
    git(rec.dir, ['log', '--format=%(trailers:key=Ticket,valueonly)', ...range])
      .split(/\s+/)
      .filter((k) => /^TCK-\d+$/i.test(k))
      .map((k) => k.toUpperCase()),
  );
  const cfg = loadConfig(cwd);
  const merged = cfg ? await mergedTickets(cfg, rec.dir, rec.remote, rec.deployBranch, after, before) : [];
  const status = new Map(merged.map((m) => [m.issue.key, m.issue.work_status]));
  const short = after.slice(0, 12);
  const lines = [];
  const live = openEntry(entry) ? entry : null;
  // The bound ticket moves only on evidence in THIS push, and only when the push's start is known.
  const evidence = !!live && !!before && (trailerKeys.has(live.key) || merged.some((m) => m.fresh && m.issue.key === live.key));
  if (evidence) {
    const now = await setStatus(sessionId, live, 'deploying', cwd);
    lines.push(
      now
        ? `[tck-session] The push moved ${rec.deployBranch} to ${short}, and it holds the work of ${live.key}, so ${live.key} is ${now}. Verify the live deployment; then, with the owner's yes, set ${live.key} to shipped (mcp__noesis__backlog_set_status).`
        : `[tck-session] The push moved ${rec.deployBranch} to ${short}, and it holds the work of ${live.key}, but the hook could not set ${live.key} to deploying (the server refused or did not answer). Set it yourself (mcp__noesis__backlog_set_status), verify the live deployment, then set it to shipped with the owner's yes.`,
    );
  }
  const keys = [...new Set([...trailerKeys, ...merged.map((m) => m.issue.key)])].filter((k) => !(live && k === live.key)).slice(0, 10);
  const looked = await Promise.all(
    keys.map(async (key) => {
      if (status.has(key)) return [key, status.get(key)];
      if (!cfg) return [key, null];
      try {
        const res = await api(cfg, 'GET', keyPath(key));
        return [key, res && res.issue ? res.issue.work_status : null];
      } catch {
        return [key, null];
      }
    }),
  );
  const others = looked.filter(([, st]) => st && !isClosed(st)).map(([key, st]) => `${key} (${st})`);
  if (others.length) {
    lines.push(
      `[tck-session] ${rec.deployBranch} (${short}) also holds the work of ${others.join(', ')}, not bound to this session. Ask the owner whether to mark each one Shipped; on a yes, call mcp__noesis__backlog_ship(key, commit: "${after}").`,
    );
  }
  return lines.length ? lines.join('\n') : null;
}

/** When the session's transcript began: the earliest "timestamp" in its first 64 KB. */
function transcriptStart(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(65536);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    let min = Infinity;
    for (const line of buf.toString('utf8', 0, n).split('\n')) {
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue; // the cut-off last line, or not JSON
      }
      const t = rec && typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : NaN;
      if (Number.isFinite(t) && t < min) min = t;
    }
    if (Number.isFinite(min)) return min;
    const st = fs.statSync(file);
    return st.birthtimeMs || st.mtimeMs;
  } catch {
    return null; // no transcript yet: a new session
  }
}

/** Whether this session may be stopped to ask the owner. */
function gateApplies(p, sw) {
  if (process.env.CLAUDE_CODE_SESSION_ATTENDED === '0') return false; // claude -p, SDK runs: nobody to ask
  if (sw.gateSince && p.transcript_path) {
    const t = transcriptStart(p.transcript_path);
    if (t != null && t < sw.gateSince) return false; // began before the checkpoint existed
  }
  return true;
}

const gatePath = (sessionId) => path.join(cacheDir(), `${String(sessionId).replace(/[^A-Za-z0-9_-]/g, '')}.gate.json`);

function gateOpen(sessionId) {
  try {
    return JSON.parse(fs.readFileSync(gatePath(sessionId), 'utf8')).noTicket === true;
  } catch {
    return false;
  }
}

function writeGate(sessionId, entry) {
  fs.mkdirSync(cacheDir(), { recursive: true });
  fs.writeFileSync(gatePath(sessionId), JSON.stringify({ ...entry, at: Date.now() }));
}

const loopSession = (sessionId, sw) => fs.existsSync(path.join(sw.loopMarkerDir, `${String(sessionId).replace(/[^A-Za-z0-9_-]/g, '')}.json`));

const MOMENT = { plan: 'approving this plan', commit: 'this git commit', merge: 'this merge', push: 'this push' };

/** Open tickets most likely to be this work: the one named in the branch, then the ones bound to this folder, then the newest. */
async function candidates(cfg, dir) {
  if (!cfg) return { list: [], note: 'no Noesis token on this computer' };
  let data;
  try {
    data = await api(cfg, 'GET', '/api/mcp/backlog/issues');
  } catch {
    return { list: [], note: 'the Noesis server did not answer' };
  }
  const issues = (data && Array.isArray(data.issues) ? data.issues : []).filter((i) => i && OPEN.includes(i.work_status));
  const m = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).match(/tck-?(\d+)/i);
  const fromBranch = m ? `TCK-${m[1]}` : null;
  const here = (i) => !!i.bound_cwd && (dir === i.bound_cwd || String(dir).startsWith(i.bound_cwd + path.sep));
  const rank = (i) => (i.key === fromBranch ? 0 : here(i) ? 1 : i.bound_session_id ? 3 : 2);
  const list = issues
    .slice()
    .sort((a, b) => rank(a) - rank(b) || String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
    .slice(0, 5);
  return { list, note: list.length ? '' : 'no open ticket' };
}

function gateReason(hit, cands) {
  const fmt = (i) => {
    const title = String(i.title || '').replace(/\s+/g, ' ').trim();
    const where = i.bound_session_id ? `, bound on ${i.bound_machine || 'another session'}` : '';
    return `${i.key} (${i.work_status}${where}): ${title.length > 90 ? title.slice(0, 89) + '…' : title}`;
  };
  const lines = [
    `[tck-session] No Jot ticket is bound to this session, and ${MOMENT[hit.kind]} in ${hit.repo.remote} needs one. The owner decides which ticket this work belongs to; do not retry until the owner has answered.`,
    `Ask with AskUserQuestion: one question whose header is exactly "${ASK_HEADER}", with options: up to two likely tickets (label = the key, e.g. "TCK-12"), then "${NEW_TICKET}", then "${NO_TICKET}".`,
    cands.list.length
      ? `Likely tickets: ${cands.list.map(fmt).join(' · ')}. If none fits, search with mcp__noesis__backlog_get(query: …).`
      : `No likely ticket to list (${cands.note}); search with mcp__noesis__backlog_get(query: …) before you ask.`,
    `Then: a ticket -> mcp__noesis__backlog_bind(key, status: the status the work has really reached), and retry. A new ticket -> create it from the owner's words (mcp__noesis__backlog_upsert_issue), bind it, and retry. "${NO_TICKET}" -> retry; this hook records the answer. Never bind a ticket the owner did not choose, and never answer the question yourself.`,
  ];
  return lines.join('\n');
}

const loopNote = (hit) =>
  `[tck-session] No Jot ticket is bound to this /cc-loop session (${MOMENT[hit.kind]} in ${hit.repo.remote}). Go on without one: never bind a ticket the owner did not choose, and add a NEEDS-ATTENTION line to the loop state: "no Jot ticket was bound to this loop".`;

const commitNote = (entry) =>
  `[tck-session] This commit belongs to ${entry.key} (status: ${entry.status}); it will carry the trailer "Ticket: ${entry.key}". If it is other work, tell the owner; with their OK, commit it with NOESIS_TICKET=none in front of the command (no trailer).`;

/** The owner's answer to the hook's "Ticket" question, from an AskUserQuestion call. */
export function ticketAnswer(p) {
  const pick = (v) => {
    if (typeof v === 'string') {
      try {
        return JSON.parse(v);
      } catch {
        return null;
      }
    }
    return v && typeof v === 'object' ? v : null;
  };
  const res = pick(p.tool_response) || {};
  const input = pick(p.tool_input) || {};
  const qs = Array.isArray(res.questions) ? res.questions : Array.isArray(input.questions) ? input.questions : [];
  const answers = (res.answers && typeof res.answers === 'object' ? res.answers : input.answers) || {};
  const q = qs.find((x) => x && String(x.header || '').trim().toLowerCase() === ASK_HEADER.toLowerCase());
  if (!q) return null;
  const a = answers[q.question];
  return typeof a === 'string' ? a.trim() : null;
}

function answerNote(sessionId, answer) {
  const lower = answer.toLowerCase();
  if (lower === NO_TICKET.toLowerCase()) {
    writeGate(sessionId, { noTicket: true, answer });
    return `[tck-session] Recorded: the owner chose no ticket for this session's work. Retry the step that was blocked.`;
  }
  if (lower.startsWith(NEW_TICKET.toLowerCase())) {
    return `[tck-session] The owner wants a new ticket. Create it from the owner's own words (mcp__noesis__backlog_upsert_issue), bind it (mcp__noesis__backlog_bind), then retry the step that was blocked.`;
  }
  const keys = answer.match(/\bTCK-\d+\b/gi) || [];
  if (keys.length === 1) {
    const key = keys[0].toUpperCase();
    return `[tck-session] The owner chose ${key}. Bind it now: mcp__noesis__backlog_bind(key: "${key}", status: the status the work has really reached), then retry the step that was blocked.`;
  }
  return null; // free text: Claude reads it and acts on it
}

const shipNote = (entry) =>
  `The owner asked to ship. The ship steps for ${entry.key}: set it to deploying (mcp__noesis__backlog_set_status), merge and push, verify the live deployment, then set it to shipped — shipped only after the live check.`;

const unboundShipNote = () =>
  `[tck-session] The owner asked to ship, and no Jot ticket is bound to this session. Before you merge or push, ask the owner which ticket this ships: AskUserQuestion with the header "${ASK_HEADER}" (likely tickets, "${NEW_TICKET}", "${NO_TICKET}").`;

function cacheDir() {
  return process.env.TCK_BINDINGS_DIR || path.join(os.homedir(), '.claude', 'tck-bindings');
}

function cachePath(sessionId) {
  return path.join(cacheDir(), `${String(sessionId).replace(/[^A-Za-z0-9_-]/g, '')}.json`);
}

function readCache(sessionId) {
  try {
    return JSON.parse(fs.readFileSync(cachePath(sessionId), 'utf8'));
  } catch {
    return null;
  }
}

/** Delete other sessions' cache files untouched for PRUNE_MS (best effort). */
function prune(keep) {
  try {
    const dir = cacheDir();
    const cutoff = Date.now() - PRUNE_MS;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(dir, name);
      if (file === keep) continue;
      try {
        if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
      } catch {
        /* raced with another session */
      }
    }
  } catch {
    /* no dir yet */
  }
}

function writeCache(sessionId, entry) {
  fs.mkdirSync(cacheDir(), { recursive: true });
  const file = cachePath(sessionId);
  fs.writeFileSync(file, JSON.stringify({ ...entry, checkedAt: Date.now() }));
  prune(file);
}

function dropCache(sessionId) {
  try {
    fs.unlinkSync(cachePath(sessionId));
  } catch {
    /* already gone */
  }
}

/** The `noesis` MCP server's env: user scope first, then this project's local scope. */
function mcpEnv(cwd) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
    const user = cfg && cfg.mcpServers && cfg.mcpServers.noesis && cfg.mcpServers.noesis.env;
    if (user && user.NOESIS_API_TOKEN) return user;
    const proj = cwd && cfg && cfg.projects && cfg.projects[cwd];
    const local = proj && proj.mcpServers && proj.mcpServers.noesis && proj.mcpServers.noesis.env;
    return local || user || {};
  } catch {
    return {};
  }
}

/** {token, baseUrl} from the environment, else the MCP server's own config; null = no token. */
export function loadConfig(cwd) {
  let token = process.env.NOESIS_API_TOKEN || '';
  let baseUrl = process.env.NOESIS_API_URL || '';
  if (!token || !baseUrl) {
    const env = mcpEnv(cwd);
    token = token || env.NOESIS_API_TOKEN || '';
    baseUrl = baseUrl || env.NOESIS_API_URL || '';
  }
  if (!token) return null;
  return { token, baseUrl: (baseUrl || 'https://noesisbrain.com').replace(/\/+$/, '') };
}

const CLIENT_OS = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux';

/** One API call with a short timeout. Throws { status, code } on a non-OK answer. */
async function api(cfg, method, p, body) {
  const res = await fetch(cfg.baseUrl + p, {
    method,
    headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json', 'X-Client-OS': CLIENT_OS },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty or not JSON */
  }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    err.code = data && typeof data.error_code === 'string' ? data.error_code : null;
    throw err;
  }
  return data;
}

const keyPath = (key) => `/api/mcp/backlog/issues/${encodeURIComponent(key)}`;

/** For each target status, the only status the hook may move a ticket from (never a closed one). */
const FORWARD = {
  ready_to_implement: ['planning'],
  implementing: ['ready_to_implement'],
  planning: ['ready_to_implement'], // a rejected plan
  deploying: ['implementing', 'iterating', 'ready_to_merge'], // its work reached the deploy branch
};

/** Set the bound ticket's status, as the bound session. Returns the new status or null. */
async function setStatus(sessionId, entry, status, cwd) {
  if (entry.status === status) return status;
  if (isClosed(entry.status) || !(FORWARD[status] || []).includes(entry.status)) return null;
  const cfg = loadConfig(cwd);
  if (!cfg) return null;
  try {
    const res = await api(cfg, 'POST', `${keyPath(entry.key)}/status`, {
      session_id: entry.bound_session_id,
      machine: entry.machine ?? null,
      status,
    });
    const issue = res && res.issue;
    if (issue && !issue.bound_session_id) {
      dropCache(sessionId);
      return null;
    }
    const now = (issue && issue.work_status) || status;
    writeCache(sessionId, { ...entry, status: now });
    return now;
  } catch (e) {
    // The owner reset the binding, another session took the ticket over, or it was closed.
    if (e && e.status === 409 && ['NOT_BOUND', 'BOUND_ELSEWHERE', 'TICKET_CLOSED'].includes(e.code)) dropCache(sessionId);
    return null;
  }
}

/** Re-check a stale cache against the server; returns the entry, or a note when it is gone. */
async function recheck(sessionId, entry, cwd) {
  if (Date.now() - (entry.checkedAt || 0) < RECHECK_MS) return { entry };
  const cfg = loadConfig(cwd);
  if (!cfg) return { entry };
  try {
    const res = await api(cfg, 'GET', keyPath(entry.key));
    const issue = res && res.issue;
    if (!issue || issue.bound_session_id !== entry.bound_session_id) {
      dropCache(sessionId);
      if (issue && isClosed(issue.work_status)) {
        return {
          entry: null,
          note: `[tck-session] ${entry.key} was closed (${closedLabel(issue.work_status)}), so its binding to this session was released. A closed ticket never moves: for new work, create a new ticket that names ${entry.key}.`,
        };
      }
      const where = issue && issue.bound_machine ? ` (now held on ${issue.bound_machine})` : '';
      return {
        entry: null,
        note: `[tck-session] ${entry.key} is no longer bound to this session${where} — the owner reset it on the Jot page or another session took it over. Do not bind it again unless the owner asks.`,
      };
    }
    const fresh = { ...entry, status: issue.work_status, machine: issue.bound_machine ?? entry.machine };
    writeCache(sessionId, fresh);
    return { entry: fresh };
  } catch {
    return { entry }; // fail open: keep the cached view
  }
}

export function reminder(entry, plan = false) {
  const on = entry.machine ? ` on ${entry.machine}` : '';
  if (isClosed(entry.status)) {
    return `[tck-session] This session is still bound to ${entry.key}, which is ${closedLabel(entry.status)}. A closed ticket never moves: before any new plan, release it (mcp__noesis__backlog_unbind) or create a new ticket and bind it with switch: true.`;
  }
  const lines = [
    `[tck-session] This session is bound to ${entry.key} (status: ${entry.status}${on}). Keep it current with mcp__noesis__backlog_set_status: ${LADDER}. created and dropped are the owner's.`,
    `Refine the ticket text once when the plan is ready (mcp__noesis__backlog_refine: 70%-120% of the draft's words, the draft's language, no sections or increments). After /clear, run /noesis-ticket link ${entry.key}.`,
  ];
  if (plan && PAST_PLANNING.includes(entry.status)) {
    lines.push(
      `A new plan while ${entry.key} is ${entry.status}: if it is part of ${entry.key}, set ${entry.key} to planning first. If it is not, follow "New work in a bound session" in /noesis-ticket: say why, set ${entry.key} to the status it really reached, create the new ticket, then switch or release.`,
    );
  }
  return lines.join('\n');
}

export function handedOver(prompt) {
  const text = String(prompt || '');
  if (/^\s*\/noesis-ticket\b/i.test(text)) return null; // the skill binds by itself
  for (const re of HANDOVER) {
    const m = text.match(re);
    if (m) return `TCK-${m[1]}`;
  }
  return null;
}

/** Pull the ticket JSON out of an MCP tool response (content blocks or a string). */
export function responseIssue(response) {
  const texts = [];
  const walk = (r) => {
    if (r == null) return;
    if (typeof r === 'string') texts.push(r);
    else if (Array.isArray(r)) r.forEach(walk);
    else if (typeof r === 'object') {
      if (r.issue) texts.push(JSON.stringify(r));
      else if (typeof r.text === 'string') texts.push(r.text);
      else if (r.content !== undefined) walk(r.content);
    }
  };
  walk(response);
  for (const t of texts) {
    try {
      const d = JSON.parse(t);
      if (d && d.issue && d.issue.key) return d.issue;
    } catch {
      /* not JSON — e.g. an error text */
    }
  }
  return null;
}

const out = (event, additionalContext) =>
  additionalContext ? { hookSpecificOutput: { hookEventName: event, additionalContext } } : null;
const pre = (fields) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...fields } });

// ── Session start: stale bindings, the reconcile, the /clear hint ──────────────────────────

const STALE_MS = 24 * 60 * 60 * 1000;
const START_CHECK_MS = 6 * 60 * 60 * 1000;
/** The stale check covers every binding on this computer: one stamp. The reconcile is per repository:
 *  one stamp each, so a start in one listed repo never uses up another's. */
const staleStampPath = () => path.join(cacheDir(), '.session-start-stale');
const reconcileStampPath = (repo) => path.join(cacheDir(), `.session-start-reconcile-${String(repo.remote).replace(/[^A-Za-z0-9_-]+/g, '_')}`);

/** True at most once every START_CHECK_MS per stamp; the stamp is written first, so parallel starts do not all run. */
function dueAndStamp(file) {
  try {
    if (Date.now() - fs.statSync(file).mtimeMs < START_CHECK_MS) return false;
  } catch {
    /* never ran */
  }
  try {
    fs.mkdirSync(cacheDir(), { recursive: true });
    fs.writeFileSync(file, String(Date.now()));
  } catch {
    /* fail open */
  }
  return true;
}

/** When a session was last active: its cache file or its transcript, whichever is newer. */
function lastActive(file, sessionId) {
  let t = 0;
  try {
    if (file) t = fs.statSync(file).mtimeMs;
  } catch {
    /* gone */
  }
  const projects = path.join(os.homedir(), '.claude', 'projects');
  let dirs = [];
  try {
    dirs = fs.readdirSync(projects);
  } catch {
    /* no projects folder */
  }
  for (const d of dirs) {
    try {
      const m = fs.statSync(path.join(projects, d, `${sessionId}.jsonl`)).mtimeMs;
      if (m > t) t = m;
    } catch {
      /* not this project */
    }
  }
  return t;
}

/** Bindings cached on this computer, idle for 24 hours and still bound on the server. One binding
 *  can have several cache files: /clear gives the session a new payload id (and a new file after
 *  /noesis-ticket link) while the binding keeps the old id. So a binding is judged by the NEWEST
 *  activity of all its files and their transcripts (and the bound id's own transcript), never by
 *  one file; and it is reported once. `skip` holds keys this start already names (the /clear hint). */
async function staleBindings(cfg, ownSid, skip) {
  const found = [];
  let names = [];
  try {
    names = fs.readdirSync(cacheDir()).filter((n) => /^[A-Za-z0-9_-]+\.json$/.test(n));
  } catch {
    return found;
  }
  const groups = new Map(); // `${bound}|${key}` -> { key, bound, files: [{ file, sid }] }
  let own = null;
  for (const name of names) {
    const sessionId = name.slice(0, -'.json'.length);
    const file = path.join(cacheDir(), name);
    let e = null;
    try {
      e = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    if (!e || typeof e.key !== 'string' || typeof e.bound_session_id !== 'string') continue;
    const id = `${e.bound_session_id.toLowerCase()}|${e.key}`;
    if (sessionId === ownSid) own = id;
    if (!groups.has(id)) groups.set(id, { key: e.key, bound: e.bound_session_id, files: [] });
    groups.get(id).files.push({ file, sid: sessionId });
  }
  for (const [id, g] of groups) {
    if (id === own || skip.has(g.key)) continue; // this session's own binding, or named already
    const newest = Math.max(lastActive(null, g.bound), ...g.files.map((f) => lastActive(f.file, f.sid)));
    const idle = Date.now() - newest;
    if (idle < STALE_MS) continue;
    let issue = null;
    try {
      const res = await api(cfg, 'GET', keyPath(g.key));
      issue = res && res.issue;
    } catch (e) {
      if (!e || !e.status) break; // no answer from the server: stop here, look again next time
      if (e.status === 404) {
        // The ticket is gone (deleted on the page) or not this account's: forget the local copies.
        for (const f of g.files) {
          try {
            fs.unlinkSync(f.file);
          } catch {
            /* raced */
          }
        }
      }
      continue; // the server answered for this ticket: the next one may still be stale
    }
    if (!issue || String(issue.bound_session_id || '').toLowerCase() !== g.bound.toLowerCase() || isClosed(issue.work_status)) {
      // Released or closed meanwhile: forget this computer's copies (the server is not touched).
      for (const f of g.files) {
        try {
          fs.unlinkSync(f.file);
        } catch {
          /* raced */
        }
      }
      continue;
    }
    found.push({ key: g.key, status: issue.work_status, machine: issue.bound_machine, sid: g.bound, hours: Math.floor(idle / 3600000) });
  }
  return found;
}

/** The reconcile: tickets at ready_to_merge / deploying whose branch is already in the deploy branch. */
async function startReconcile(cfg, repo) {
  if (!repo.deployBranch) return { tip: null, list: [] };
  try {
    // Never prompt the owner for a password or passphrase from a hook.
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes' };
    execFileSync('git', ['-C', repo.dir, 'fetch', '--quiet', 'origin', repo.deployBranch], { stdio: 'ignore', timeout: 10000, windowsHide: true, env });
  } catch {
    /* offline: use the last fetched state */
  }
  const tip = git(repo.dir, ['rev-parse', '--verify', '-q', `refs/remotes/origin/${repo.deployBranch}`]);
  if (!tip) return { tip: null, list: [] };
  const merged = await mergedTickets(cfg, repo.dir, 'origin', repo.deployBranch, tip, null);
  return { tip, list: merged.map((m) => m.issue) };
}

/** After /clear: the open tickets bound to this folder, which this session may need to link again. */
async function boundHere(cfg, cwd) {
  let data;
  try {
    data = await api(cfg, 'GET', '/api/mcp/backlog/issues');
  } catch {
    return [];
  }
  return (data && Array.isArray(data.issues) ? data.issues : []).filter(
    (i) => i && i.bound_session_id && OPEN.includes(i.work_status) && i.bound_cwd && (cwd === i.bound_cwd || String(cwd).startsWith(i.bound_cwd + path.sep)),
  );
}

async function sessionStart(p, sw) {
  if (p.source === 'compact') return null;
  const repo = repoOf(p.cwd, sw);
  if (!repo) return null;
  const cfg = loadConfig(p.cwd);
  if (!cfg) return null;
  const lines = [];
  const named = new Set();
  if (p.source === 'clear' && !readCache(p.session_id)) {
    const here = await boundHere(cfg, p.cwd);
    for (const i of here) named.add(i.key);
    if (here.length) {
      lines.push(
        `[tck-session] After /clear this session has no ticket reminder. Bound to this folder: ${here
          .map((i) => `${i.key} (${i.work_status}, session ${String(i.bound_session_id).slice(0, 8)})`)
          .join(', ')}. If one of them is this session's work, run /noesis-ticket link <key>.`,
      );
    }
  }
  if (dueAndStamp(staleStampPath())) {
    const stale = await staleBindings(cfg, p.session_id, named);
    if (stale.length) {
      lines.push(
        `[tck-session] Bindings with no activity for 24 hours or more: ${stale
          .map((b) => `${b.key} (${b.status}, session ${b.sid.slice(0, 8)}${b.machine ? ` on ${b.machine}` : ''}, idle ${b.hours} h)`)
          .join(', ')}. Tell the owner. For each one that is not at ready_to_merge, ask whether to release it (mcp__noesis__backlog_unbind with force: true); a ready_to_merge one is only waiting for "ship it". Never release a binding without the owner's yes.`,
      );
    }
  }
  if (repo.deployBranch && dueAndStamp(reconcileStampPath(repo))) {
    const rec = await startReconcile(cfg, repo);
    if (rec.list.length) {
      lines.push(
        `[tck-session] These tickets still wait, but their branch is already in ${repo.deployBranch} (${rec.tip.slice(0, 12)}): ${rec.list
          .map((i) => `${i.key} (${i.work_status}, ${i.branch})`)
          .join(', ')}. Ask the owner whether to mark each one Shipped; on a yes, call mcp__noesis__backlog_ship(key, commit: "${rec.tip}").`,
      );
    }
  }
  return lines.length ? out('SessionStart', lines.join('\n')) : null;
}

export async function decide(p) {
  if (process.env.TCK_SESSION_HOOK === 'off') return null;
  if (!p || p.agent_id || !p.session_id) return null;
  const sw = loadSwitch();
  if (!sw) return null; // off on this computer
  const sid = p.session_id;
  const event = p.hook_event_name;
  const plan = p.permission_mode === 'plan';
  const cwd = p.cwd;

  if (event === 'SessionStart') return sessionStart(p, sw);

  if (event === 'UserPromptSubmit') {
    let entry = readCache(sid);
    if (!entry) {
      const key = handedOver(p.prompt);
      if (!key) {
        if (SHIP_PHRASE.test(String(p.prompt || '')) && !gateOpen(sid) && repoOf(cwd, sw) && gateApplies(p, sw)) return out(event, unboundShipNote());
        return null;
      }
      return out(
        event,
        `[tck-session] The owner handed you ${key}. Bind it to this session first: mcp__noesis__backlog_bind(key: "${key}") — it sets Planning and shows this session and computer on the Jot page. It is bookkeeping the owner asked for, so it is expected in plan mode.`,
      );
    }
    const checked = await recheck(sid, entry, cwd);
    if (!checked.entry) return out(event, checked.note);
    entry = checked.entry;
    if (plan && entry.status === 'ready_to_implement') {
      const now = await setStatus(sid, entry, 'planning', cwd);
      if (now) entry = { ...entry, status: now };
    }
    const other = handedOver(p.prompt);
    const switchNote =
      other && other !== entry.key
        ? `\nThe prompt hands over ${other} while this session holds ${entry.key}: bind ${other} with switch: true only if the owner means to move this session to it.`
        : '';
    const ship = SHIP_PHRASE.test(String(p.prompt || '')) && !isClosed(entry.status) ? `\n${shipNote(entry)}` : '';
    return out(event, reminder(entry, plan) + switchNote + ship);
  }

  if (event === 'PreToolUse') {
    const entry = readCache(sid);
    const live = entry && !isClosed(entry.status) ? entry : null;
    const hits = findCheckpoints(p, sw);
    const hit = hits[0] || null;
    if (hit && !live && !gateOpen(sid) && gateApplies(p, sw) && !(hit.kind !== 'plan' && loopSession(sid, sw))) {
      return pre({ permissionDecision: 'deny', permissionDecisionReason: gateReason(hit, await candidates(loadConfig(cwd), hit.dir)) });
    }
    // The first push into a repo WITH a deploy branch: `git -C <mcp> push && git push origin HEAD:main`
    // pushes a listed repo without one first, and that must not hide the deploy push.
    notePush(sid, hits.find((h) => h.kind === 'push' && h.repo.deployBranch), p.tool_use_id, p.tool_input && p.tool_input.command);
    if (hit && !live && hit.kind !== 'plan' && !gateOpen(sid) && gateApplies(p, sw)) return pre({ additionalContext: loopNote(hit) });
    if (!entry) return null;
    if (p.tool_name === 'ExitPlanMode') await setStatus(sid, entry, 'ready_to_implement', cwd);
    else if (plan && entry.status === 'ready_to_implement') await setStatus(sid, entry, 'planning', cwd);
    const noTicket = /(^|[\s;&|(])NOESIS_TICKET=none\b/.test(String((p.tool_input && p.tool_input.command) || ''));
    if (hit && live && hit.kind === 'commit' && !noTicket) return pre({ additionalContext: commitNote(live) });
    return null;
  }

  if (event === 'PostToolUse') {
    if (p.tool_name === 'Bash') {
      const entry = readCache(sid);
      if (openEntry(entry) && sw.repos.length) await recordBranch(sid, entry, p, sw);
      let rec = null;
      try {
        rec = JSON.parse(fs.readFileSync(pushPath(sid), 'utf8'));
        fs.unlinkSync(pushPath(sid)); // read once: a leftover never reaches a later call
      } catch {
        rec = null;
      }
      // Only the Bash call that wrote the record may read it back (same tool_use_id, or, without
      // ids, the same command), and only soon after; anything else is a stale record.
      const mine =
        rec &&
        rec.dir &&
        Date.now() - (rec.at || 0) < PUSH_RECORD_MAX_MS &&
        (rec.tool_use_id && p.tool_use_id ? rec.tool_use_id === p.tool_use_id : rec.command === String((p.tool_input && p.tool_input.command) || ''));
      const note = mine ? await afterPush(sid, readCache(sid), rec, cwd, p.tool_response) : null;
      return note ? out(event, note) : null;
    }
    if (p.tool_name === 'AskUserQuestion') {
      const answer = ticketAnswer(p);
      const note = answer ? answerNote(sid, answer) : null;
      return note ? out(event, note) : null;
    }
    if (p.tool_name === 'ExitPlanMode') {
      const entry = readCache(sid);
      if (entry) await setStatus(sid, entry, 'implementing', cwd);
      return null;
    }
    if (TICKET_TOOL.test(p.tool_name || '')) {
      const issue = responseIssue(p.tool_response);
      if (!issue) return null;
      const entry = readCache(sid);
      if (issue.bound_session_id) {
        // Keep the recorded branch (the server's, else the one this cache already holds for the
        // same ticket), so a status change never makes the next commit send the branch again.
        const branch = issue.branch || (entry && entry.key === issue.key ? entry.branch : undefined);
        writeCache(sid, {
          key: issue.key,
          status: issue.work_status,
          bound_session_id: issue.bound_session_id,
          machine: issue.bound_machine ?? null,
          ...(branch ? { branch } : {}),
        });
      } else if (entry && entry.key === issue.key) {
        dropCache(sid);
      }
    }
    return null;
  }
  return null;
}

const isMain = (() => {
  try {
    return process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain && process.argv.includes('--trailer-key')) {
  // For the git prepare-commit-msg hook: never read stdin (a git hook's stdin may stay open).
  try {
    const key = trailerKey();
    if (key) process.stdout.write(key);
  } catch {
    /* fail open: no trailer */
  }
  process.exit(0);
} else if (isMain) {
  let raw = '';
  process.stdin.on('data', (c) => (raw += c));
  process.stdin.on('end', async () => {
    try {
      const res = await decide(JSON.parse(raw || '{}'));
      if (res) process.stdout.write(JSON.stringify(res));
    } catch {
      /* fail open */
    }
    process.exit(0);
  });
}
