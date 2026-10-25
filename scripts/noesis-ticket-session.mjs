// noesis-ticket-session — the Noesis Jot ticket <-> this Claude Code session.
// Hook version 1 (@noesis-brain/mcp-server 2.6.0). `noesis-mcp setup --with-ticket-hook`
// copies this file to ~/.claude/hooks/ and runs it from UserPromptSubmit, PreToolUse (every
// tool) and PostToolUse (ExitPlanMode + the four ticket tools).
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
import { fileURLToPath } from 'node:url';

export const HOOK_VERSION = 1;
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

export async function decide(p) {
  if (process.env.TCK_SESSION_HOOK === 'off') return null;
  if (!p || p.agent_id || !p.session_id) return null;
  const sid = p.session_id;
  const event = p.hook_event_name;
  const plan = p.permission_mode === 'plan';
  const cwd = p.cwd;

  if (event === 'UserPromptSubmit') {
    let entry = readCache(sid);
    if (!entry) {
      const key = handedOver(p.prompt);
      if (!key) return null;
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
    return out(event, reminder(entry, plan) + switchNote);
  }

  if (event === 'PreToolUse') {
    const entry = readCache(sid);
    if (!entry) return null;
    if (p.tool_name === 'ExitPlanMode') await setStatus(sid, entry, 'ready_to_implement', cwd);
    else if (plan && entry.status === 'ready_to_implement') await setStatus(sid, entry, 'planning', cwd);
    return null;
  }

  if (event === 'PostToolUse') {
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
