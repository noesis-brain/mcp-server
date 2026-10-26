// noesis-ticket-session — the Noesis Jot ticket <-> this Claude Code session.
// Hook version 2 (@noesis-brain/mcp-server 2.7.0). `noesis-mcp setup --with-ticket-hook`
// copies this file to ~/.claude/hooks/ and runs it from UserPromptSubmit, PreToolUse (every
// tool) and PostToolUse (ExitPlanMode, AskUserQuestion + the ticket tools).
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
const TICKET_TOOL = /^mcp__noesis__backlog_(bind|set_status|unbind|refine)$/;
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
  return unknown ? null : out;
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
        if (eq > 0) vars[a.slice(0, eq)] = expandWord(a.slice(eq + 1), vars) ?? '';
      }
      continue;
    }
    while (i < words.length && ASSIGN.test(words[i])) i++;
    if (words[i] === 'env') {
      i++;
      while (i < words.length && (ASSIGN.test(words[i]) || words[i].startsWith('-'))) i++;
    }
    while (['command', 'exec', 'time', 'nohup'].includes(words[i])) i++;
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

// ── The "which ticket?" checkpoint ──────────────────────────────────────────────────────

/** The first checkpoint of this tool call that is in a listed repository, or null. */
function findCheckpoint(p, sw) {
  if (!sw || sw.repos.length === 0) return null;
  if (p.tool_name === 'ExitPlanMode') {
    const repo = repoOf(p.cwd, sw);
    return repo ? { kind: 'plan', dir: p.cwd, repo } : null;
  }
  if (p.tool_name !== 'Bash') return null;
  for (const c of gitCheckpoints(p.tool_input && p.tool_input.command, p.cwd)) {
    const repo = repoOf(c.dir, sw);
    if (repo) return { ...c, repo };
  }
  return null;
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
  `[tck-session] This commit belongs to ${entry.key} (status: ${entry.status}); it will carry the trailer "Ticket: ${entry.key}". If it is other work, stop and tell the owner before you commit.`;

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

export async function decide(p) {
  if (process.env.TCK_SESSION_HOOK === 'off') return null;
  if (!p || p.agent_id || !p.session_id) return null;
  const sw = loadSwitch();
  if (!sw) return null; // off on this computer
  const sid = p.session_id;
  const event = p.hook_event_name;
  const plan = p.permission_mode === 'plan';
  const cwd = p.cwd;

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
    const hit = findCheckpoint(p, sw);
    if (hit && !live && !gateOpen(sid) && gateApplies(p, sw)) {
      if (hit.kind !== 'plan' && loopSession(sid, sw)) return pre({ additionalContext: loopNote(hit) });
      return pre({ permissionDecision: 'deny', permissionDecisionReason: gateReason(hit, await candidates(loadConfig(cwd), hit.dir)) });
    }
    if (!entry) return null;
    if (p.tool_name === 'ExitPlanMode') await setStatus(sid, entry, 'ready_to_implement', cwd);
    else if (plan && entry.status === 'ready_to_implement') await setStatus(sid, entry, 'planning', cwd);
    if (hit && live && hit.kind === 'commit') return pre({ additionalContext: commitNote(live) });
    return null;
  }

  if (event === 'PostToolUse') {
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
        writeCache(sid, {
          key: issue.key,
          status: issue.work_status,
          bound_session_id: issue.bound_session_id,
          machine: issue.bound_machine ?? null,
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

if (isMain) {
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
