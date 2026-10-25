/**
 * scripts/noesis-ticket-session.mjs — the Jot ticket <-> session hook that
 * `noesis-mcp setup --with-ticket-hook` installs.
 *
 * Each case spawns the real hook with an isolated HOME and points it at a fake Noesis
 * server in this process (env NOESIS_API_URL / NOESIS_API_TOKEN), so nothing touches the
 * live config, the live cache or a real backend. The first block is the owner's original
 * claude-config hook test, ported case for case; the TCK-1835 block adds the forward-only
 * rule, closed tickets, the one-minute re-check, the plan-mode line, the config fallback
 * and pruning.
 *
 * The RED cases matter most: the hook must send the BOUND session id (from the tool's
 * response), never its own payload id — after /clear the two differ — a mere mention of a
 * ticket must not produce a bind nudge, and a plan must never move a ticket backwards.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';

const HOOK = path.resolve(__dirname, '..', 'scripts', 'noesis-ticket-session.mjs');
const HOOK_SID = 'hook-session-after-clear-0001';
const BOUND_SID = '3f0c1d2e-4a5b-4c6d-8e7f-a1b2c3d4e5f6';

interface Req { method: string; url: string; body: any; auth: string | undefined }
type Reply = { status: number; body: unknown } | 'hang';

const requests: Req[] = [];
let respond: (method: string, url: string, body: any) => Reply = () => ({ status: 200, body: { issue: {} } });
const homes: string[] = [];

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ method: req.method!, url: req.url!, body, auth: req.headers.authorization });
    const r = respond(req.method!, req.url!, body);
    if (r === 'hang') return; // never answer: the hook must give up by itself
    res.writeHead(r.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r.body));
  });
});

const baseUrl = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

function sandbox(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tck-home-'));
  homes.push(home);
  return home;
}

function cacheFile(home: string, sid = HOOK_SID): string {
  return path.join(home, '.claude', 'tck-bindings', `${sid}.json`);
}

function seed(home: string, entry: Record<string, unknown>, sid = HOOK_SID): void {
  fs.mkdirSync(path.dirname(cacheFile(home, sid)), { recursive: true });
  fs.writeFileSync(cacheFile(home, sid), JSON.stringify({ checkedAt: Date.now(), ...entry }));
}

const readCacheFile = (home: string) => JSON.parse(fs.readFileSync(cacheFile(home), 'utf8'));

const BOUND = { key: 'TCK-12', status: 'planning', bound_session_id: BOUND_SID, machine: "Tester's Mac" };

interface Run { code: number | null; json: any; ms: number; ctx: string }

function run(home: string, payload: Record<string, unknown>, extraEnv: Record<string, string | undefined> = {}): Promise<Run> {
  return new Promise((resolve) => {
    const env: Record<string, string | undefined> = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      NOESIS_API_URL: baseUrl(),
      NOESIS_API_TOKEN: 'noe_test_token',
      ...extraEnv,
    };
    if (!('TCK_SESSION_HOOK' in extraEnv)) delete env.TCK_SESSION_HOOK;
    if (!('TCK_BINDINGS_DIR' in extraEnv)) delete env.TCK_BINDINGS_DIR;
    for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
    const started = Date.now();
    const child = spawn(process.execPath, [HOOK], { env: env as NodeJS.ProcessEnv });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.on('close', (code) => {
      let json: any = null;
      try {
        json = out.trim() ? JSON.parse(out) : null;
      } catch {
        json = { unparsable: out };
      }
      resolve({ code, json, ms: Date.now() - started, ctx: json?.hookSpecificOutput?.additionalContext ?? '' });
    });
    child.stdin.end(JSON.stringify({ session_id: HOOK_SID, ...payload }));
  });
}

const statusReply = (extra: Record<string, unknown> = {}) => (method: string, url: string, body: any): Reply =>
  method === 'POST' && url.endsWith('/status')
    ? { status: 200, body: { issue: { key: 'TCK-12', work_status: body.status, bound_session_id: BOUND_SID, bound_machine: "Tester's Mac", ...extra } } }
    : { status: 404, body: { error: 'nope' } };

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
});
afterAll(() => {
  server.close();
  for (const h of homes) fs.rmSync(h, { recursive: true, force: true });
});
beforeEach(() => {
  requests.length = 0;
  respond = () => ({ status: 200, body: { issue: {} } });
});

describe('ported from claude-config test/tck-session.test.js', () => {
  // ── UserPromptSubmit, no binding ───────────────────────────────────────────
  it('a plain prompt with no binding: no output, no network', async () => {
    const r = await run(sandbox(), { hook_event_name: 'UserPromptSubmit', prompt: 'fix the flaky test please' });
    expect(r.code).toBe(0);
    expect(r.json).toBeNull();
    expect(requests).toHaveLength(0);
  });

  it('the Copy format "TCK-12: ..." gets a bind nudge (no network)', async () => {
    const r = await run(sandbox(), { hook_event_name: 'UserPromptSubmit', permission_mode: 'plan', prompt: 'TCK-12: add a copy button to each ticket' });
    expect(r.ctx).toMatch(/handed you TCK-12/);
    expect(r.ctx).toMatch(/backlog_bind\(key: "TCK-12"\)/);
    expect(r.ctx).toMatch(/plan mode/);
    expect(requests).toHaveLength(0);
  });

  it('"read tck-7 please" gets a nudge with the key upper-cased', async () => {
    const r = await run(sandbox(), { hook_event_name: 'UserPromptSubmit', prompt: 'Could you read tck-7 please' });
    expect(r.ctx).toMatch(/handed you TCK-7/);
  });

  it('"run TCK-1836" (the usual way to start a loop on a ticket) gets a nudge', async () => {
    const r = await run(sandbox(), { hook_event_name: 'UserPromptSubmit', prompt: 'run TCK-1836' });
    expect(r.ctx).toMatch(/handed you TCK-1836/);
  });

  it('"Let\'s do the ticket 1835" (no TCK- prefix) gets a nudge for TCK-1835', async () => {
    const r = await run(sandbox(), { hook_event_name: 'UserPromptSubmit', prompt: "Let's do the ticket 1835" });
    expect(r.ctx).toMatch(/handed you TCK-1835/);
  });

  it('"build ticket TCK-42" gets a nudge for TCK-42', async () => {
    const r = await run(sandbox(), { hook_event_name: 'UserPromptSubmit', prompt: 'please build ticket TCK-42' });
    expect(r.ctx).toMatch(/handed you TCK-42\b/);
  });

  it('RED: a bare number is not a ticket ("run 3 tests")', async () => {
    const r = await run(sandbox(), { hook_event_name: 'UserPromptSubmit', prompt: 'run 3 tests again' });
    expect(r.json).toBeNull();
  });

  it('RED: "do the ticket review" has no ticket number', async () => {
    const r = await run(sandbox(), { hook_event_name: 'UserPromptSubmit', prompt: "let's do the ticket review first" });
    expect(r.json).toBeNull();
  });

  it('RED: "the run of TCK-12 failed" is a mention, not a handover', async () => {
    const r = await run(sandbox(), { hook_event_name: 'UserPromptSubmit', prompt: 'the last run of TCK-12 failed' });
    expect(r.json).toBeNull();
  });

  it('RED: a mere mention ("is this like TCK-12?") gets no nudge', async () => {
    const r = await run(sandbox(), { hook_event_name: 'UserPromptSubmit', prompt: 'is this bug like the one in TCK-12?' });
    expect(r.json).toBeNull();
  });

  it('RED: "TCK-12:" in the MIDDLE of a prompt is a mention, not the Copy format', async () => {
    const r = await run(sandbox(), { hook_event_name: 'UserPromptSubmit', prompt: 'this is the same as TCK-12: the copy button bug' });
    expect(r.json).toBeNull();
  });

  it('/noesis-ticket prompts are left to the skill', async () => {
    const r = await run(sandbox(), { hook_event_name: 'UserPromptSubmit', prompt: '/noesis-ticket link TCK-12 implementing' });
    expect(r.json).toBeNull();
  });

  // ── PostToolUse on the ticket tools: the cache and the /clear alias ────────
  it('PostToolUse backlog_bind caches the BOUND id under the payload id (the /clear alias)', async () => {
    const home = sandbox();
    const issue = { key: 'TCK-12', work_status: 'planning', bound_session_id: BOUND_SID, bound_machine: "Tester's Mac" };
    await run(home, { hook_event_name: 'PostToolUse', tool_name: 'mcp__noesis__backlog_bind', tool_response: [{ type: 'text', text: JSON.stringify({ issue, released: null }, null, 2) }] });
    expect(readCacheFile(home)).toMatchObject({ key: 'TCK-12', bound_session_id: BOUND_SID, status: 'planning', machine: "Tester's Mac" });
  });

  it('PostToolUse backlog_unbind (bound_session_id null) drops the cache for that ticket', async () => {
    const home = sandbox();
    seed(home, BOUND);
    await run(home, { hook_event_name: 'PostToolUse', tool_name: 'mcp__noesis__backlog_unbind', tool_response: [{ type: 'text', text: JSON.stringify({ issue: { key: 'TCK-12', work_status: 'planning', bound_session_id: null } }) }] });
    expect(fs.existsSync(cacheFile(home))).toBe(false);
  });

  it('an error response from a ticket tool leaves the cache alone', async () => {
    const home = sandbox();
    seed(home, BOUND);
    await run(home, { hook_event_name: 'PostToolUse', tool_name: 'mcp__noesis__backlog_set_status', tool_response: [{ type: 'text', text: 'Backlog tool failed: ... [OWNER_GATE]' }] });
    expect(fs.existsSync(cacheFile(home))).toBe(true);
  });

  // ── UserPromptSubmit, bound ────────────────────────────────────────────────
  it('a bound session gets a reminder of at most three lines, with no network when fresh', async () => {
    const home = sandbox();
    seed(home, BOUND);
    const r = await run(home, { hook_event_name: 'UserPromptSubmit', permission_mode: 'default', prompt: 'continue' });
    expect(r.ctx.split('\n').length).toBeLessThanOrEqual(3);
    expect(r.ctx).toMatch(/bound to TCK-12 \(status: planning on Tester's Mac\)/);
    expect(r.ctx).toMatch(/ready_to_merge/);
    expect(r.ctx).toMatch(/\/noesis-ticket link TCK-12/);
    expect(requests).toHaveLength(0);
  });

  it('a bound session handed ANOTHER ticket is told to switch only on purpose', async () => {
    const home = sandbox();
    seed(home, BOUND);
    const r = await run(home, { hook_event_name: 'UserPromptSubmit', prompt: 'TCK-99: something else' });
    expect(r.ctx).toMatch(/hands over TCK-99 while this session holds TCK-12/);
    expect(r.ctx).toMatch(/switch: true/);
  });

  it('a stale cache is re-checked; a reset on the page clears it and says so', async () => {
    const home = sandbox();
    seed(home, { ...BOUND, checkedAt: Date.now() - 10 * 60 * 1000 });
    respond = (method, url) =>
      method === 'GET' && url === '/api/mcp/backlog/issues/TCK-12'
        ? { status: 200, body: { issue: { key: 'TCK-12', work_status: 'planning', bound_session_id: null, bound_machine: null } } }
        : { status: 404, body: {} };
    const r = await run(home, { hook_event_name: 'UserPromptSubmit', prompt: 'continue' });
    expect(r.ctx).toMatch(/no longer bound to this session/);
    expect(r.ctx).toMatch(/unless the owner asks/);
    expect(fs.existsSync(cacheFile(home))).toBe(false);
    expect(requests).toHaveLength(1);
    expect(requests[0].auth).toBe('Bearer noe_test_token');
  });

  it('a stale cache that is still bound is refreshed with the server status', async () => {
    const home = sandbox();
    seed(home, { ...BOUND, checkedAt: 0 });
    respond = () => ({ status: 200, body: { issue: { key: 'TCK-12', work_status: 'iterating', bound_session_id: BOUND_SID, bound_machine: "Tester's Mac" } } });
    const r = await run(home, { hook_event_name: 'UserPromptSubmit', prompt: 'continue' });
    expect(r.ctx).toMatch(/status: iterating/);
    expect(readCacheFile(home).status).toBe('iterating');
  });

  // ── plan-mode edges ────────────────────────────────────────────────────────
  it('RED: PreToolUse ExitPlanMode sets ready_to_implement AS THE BOUND SESSION (never the payload id)', async () => {
    const home = sandbox();
    seed(home, BOUND);
    respond = statusReply();
    const r = await run(home, { hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode', permission_mode: 'plan' });
    expect(r.json).toBeNull(); // PreToolUse prints nothing (never blocks)
    expect(requests).toHaveLength(1);
    const q = requests[0];
    expect(`${q.method} ${q.url}`).toBe('POST /api/mcp/backlog/issues/TCK-12/status');
    expect(q.body.session_id).toBe(BOUND_SID);
    expect(q.body.session_id).not.toBe(HOOK_SID);
    expect(q.body).toMatchObject({ status: 'ready_to_implement', machine: "Tester's Mac" });
    expect(readCacheFile(home).status).toBe('ready_to_implement');
  });

  it('PostToolUse ExitPlanMode (plan approved) sets implementing', async () => {
    const home = sandbox();
    seed(home, { ...BOUND, status: 'ready_to_implement' });
    respond = statusReply();
    await run(home, { hook_event_name: 'PostToolUse', tool_name: 'ExitPlanMode', permission_mode: 'default' });
    expect(requests.map((q) => q.body.status)).toEqual(['implementing']);
  });

  it('a rejected plan: the next plan-mode tool moves ready_to_implement back to planning', async () => {
    const home = sandbox();
    seed(home, { ...BOUND, status: 'ready_to_implement' });
    respond = statusReply();
    await run(home, { hook_event_name: 'PreToolUse', tool_name: 'Read', permission_mode: 'plan' });
    expect(requests.map((q) => q.body.status)).toEqual(['planning']);
  });

  it('a rejected plan: a plan-mode prompt also moves it back, and the reminder says planning', async () => {
    const home = sandbox();
    seed(home, { ...BOUND, status: 'ready_to_implement' });
    respond = statusReply();
    const r = await run(home, { hook_event_name: 'UserPromptSubmit', permission_mode: 'plan', prompt: 'no, keep the old tabs' });
    expect(requests.map((q) => q.body.status)).toEqual(['planning']);
    expect(r.ctx).toMatch(/status: planning/);
  });

  it('RED: a prompt OUTSIDE plan mode never moves ready_to_implement back to planning', async () => {
    const home = sandbox();
    seed(home, { ...BOUND, status: 'ready_to_implement' });
    respond = statusReply();
    const r = await run(home, { hook_event_name: 'UserPromptSubmit', permission_mode: 'default', prompt: 'go ahead' });
    expect(requests).toHaveLength(0);
    expect(r.ctx).toMatch(/status: ready_to_implement/);
  });

  it('outside plan mode a ready_to_implement ticket is left alone', async () => {
    const home = sandbox();
    seed(home, { ...BOUND, status: 'ready_to_implement' });
    await run(home, { hook_event_name: 'PreToolUse', tool_name: 'Edit', permission_mode: 'default' });
    expect(requests).toHaveLength(0);
  });

  it('PreToolUse with no binding: no network (the fast path for every tool)', async () => {
    const r = await run(sandbox(), { hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode', permission_mode: 'plan' });
    expect(r.json).toBeNull();
    expect(requests).toHaveLength(0);
  });

  it('a 409 NOT_BOUND (owner reset) drops the cache', async () => {
    const home = sandbox();
    seed(home, BOUND);
    respond = () => ({ status: 409, body: { error: 'TCK-12 is not bound to this session', error_code: 'NOT_BOUND' } });
    await run(home, { hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode', permission_mode: 'plan' });
    expect(fs.existsSync(cacheFile(home))).toBe(false);
  });

  it('a hanging server: the hook gives up after ~2.5 s and fails open', async () => {
    const home = sandbox();
    seed(home, BOUND);
    respond = () => 'hang';
    const r = await run(home, { hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode', permission_mode: 'plan' });
    expect(r.code).toBe(0);
    // 2.5 s abort plus node start-up; a 5 s timeout must fail this.
    expect(r.ms).toBeLessThan(4000);
    expect(fs.existsSync(cacheFile(home))).toBe(true); // a timeout is not a reset
  }, 10_000);

  // ── switches ───────────────────────────────────────────────────────────────
  it('subagent events are ignored', async () => {
    const home = sandbox();
    seed(home, BOUND);
    const r = await run(home, { hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode', permission_mode: 'plan', agent_id: 'agent-1' });
    const r2 = await run(home, { hook_event_name: 'UserPromptSubmit', prompt: 'TCK-5: x', agent_id: 'agent-1' });
    expect(r.json).toBeNull();
    expect(r2.json).toBeNull();
    expect(requests).toHaveLength(0);
  });

  it('kill switch TCK_SESSION_HOOK=off', async () => {
    const home = sandbox();
    seed(home, BOUND);
    const r = await run(home, { hook_event_name: 'UserPromptSubmit', prompt: 'TCK-5: x' }, { TCK_SESSION_HOOK: 'off' });
    const r2 = await run(home, { hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode' }, { TCK_SESSION_HOOK: 'off' });
    expect(r.json).toBeNull();
    expect(r2.json).toBeNull();
    expect(requests).toHaveLength(0);
  });
});

describe('TCK-1835: forward only, closed tickets, re-check, plan-mode line, config', () => {
  for (const status of ['iterating', 'implementing', 'ready_to_merge', 'deploying', 'created']) {
    it(`RED: ExitPlanMode leaves a ${status} ticket alone (no request)`, async () => {
      const home = sandbox();
      seed(home, { ...BOUND, status });
      respond = statusReply();
      await run(home, { hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode', permission_mode: 'plan' });
      await run(home, { hook_event_name: 'PostToolUse', tool_name: 'ExitPlanMode', permission_mode: 'default' });
      expect(requests).toHaveLength(0);
      expect(readCacheFile(home).status).toBe(status);
    });
  }

  it('RED: an approved plan sets implementing only from ready_to_implement', async () => {
    const home = sandbox();
    seed(home, { ...BOUND, status: 'planning' });
    respond = statusReply();
    await run(home, { hook_event_name: 'PostToolUse', tool_name: 'ExitPlanMode', permission_mode: 'default' });
    expect(requests).toHaveLength(0);
  });

  for (const status of ['shipped', 'dropped']) {
    it(`RED: a cached ${status} ticket never moves, and the reminder says to release it`, async () => {
      const home = sandbox();
      seed(home, { ...BOUND, status });
      respond = statusReply();
      await run(home, { hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode', permission_mode: 'plan' });
      await run(home, { hook_event_name: 'PostToolUse', tool_name: 'ExitPlanMode', permission_mode: 'default' });
      await run(home, { hook_event_name: 'PreToolUse', tool_name: 'Read', permission_mode: 'plan' });
      const r = await run(home, { hook_event_name: 'UserPromptSubmit', permission_mode: 'plan', prompt: 'a new idea' });
      expect(requests).toHaveLength(0);
      expect(r.ctx).toMatch(new RegExp(`still bound to TCK-12, which is ${status === 'shipped' ? 'Shipped' : 'Dropped'}`));
      expect(r.ctx).toMatch(/backlog_unbind/);
      expect(r.ctx).not.toMatch(/Keep it current/);
    });
  }

  it('a 409 TICKET_CLOSED drops the cache', async () => {
    const home = sandbox();
    seed(home, BOUND);
    respond = () => ({ status: 409, body: { error: 'TCK-12 is Shipped', error_code: 'TICKET_CLOSED' } });
    await run(home, { hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode', permission_mode: 'plan' });
    expect(requests).toHaveLength(1);
    expect(fs.existsSync(cacheFile(home))).toBe(false);
  });

  it('a 409 with another code (OWNER_GATE) keeps the cache', async () => {
    const home = sandbox();
    seed(home, BOUND);
    respond = () => ({ status: 409, body: { error: 'nope', error_code: 'OWNER_GATE' } });
    await run(home, { hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode', permission_mode: 'plan' });
    expect(fs.existsSync(cacheFile(home))).toBe(true);
  });

  it('a status answer with no binding (the ticket was closed meanwhile) drops the cache', async () => {
    const home = sandbox();
    seed(home, BOUND);
    respond = statusReply({ bound_session_id: null });
    await run(home, { hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode', permission_mode: 'plan' });
    expect(fs.existsSync(cacheFile(home))).toBe(false);
  });

  it('re-checks after one minute (not five), and not before', async () => {
    const home = sandbox();
    respond = () => ({ status: 200, body: { issue: { key: 'TCK-12', work_status: 'planning', bound_session_id: BOUND_SID, bound_machine: "Tester's Mac" } } });
    seed(home, { ...BOUND, checkedAt: Date.now() - 30 * 1000 });
    await run(home, { hook_event_name: 'UserPromptSubmit', prompt: 'continue' });
    expect(requests).toHaveLength(0);
    seed(home, { ...BOUND, checkedAt: Date.now() - 90 * 1000 });
    await run(home, { hook_event_name: 'UserPromptSubmit', prompt: 'continue' });
    expect(requests.map((q) => `${q.method} ${q.url}`)).toEqual(['GET /api/mcp/backlog/issues/TCK-12']);
  });

  it('a re-check that finds the ticket closed and released says so (not "the owner reset it")', async () => {
    const home = sandbox();
    seed(home, { ...BOUND, checkedAt: 0 });
    respond = () => ({ status: 200, body: { issue: { key: 'TCK-12', work_status: 'shipped', bound_session_id: null, bound_machine: null } } });
    const r = await run(home, { hook_event_name: 'UserPromptSubmit', prompt: 'continue' });
    expect(r.ctx).toMatch(/TCK-12 was closed \(Shipped\)/);
    expect(r.ctx).not.toMatch(/owner reset/);
    expect(fs.existsSync(cacheFile(home))).toBe(false);
  });

  for (const status of ['implementing', 'iterating', 'ready_to_merge', 'deploying']) {
    it(`plan mode past Planning (${status}) adds the new-work line`, async () => {
      const home = sandbox();
      seed(home, { ...BOUND, status });
      const r = await run(home, { hook_event_name: 'UserPromptSubmit', permission_mode: 'plan', prompt: 'plan something' });
      const lines = r.ctx.split('\n');
      expect(lines).toHaveLength(3);
      expect(lines[2]).toMatch(new RegExp(`A new plan while TCK-12 is ${status}`));
      expect(lines[2]).toMatch(/New work in a bound session/);
      expect(lines[2]).toMatch(/set TCK-12 to planning first/);
    });
  }

  it('no new-work line outside plan mode, or in plan mode at planning', async () => {
    const home = sandbox();
    seed(home, { ...BOUND, status: 'iterating' });
    const r = await run(home, { hook_event_name: 'UserPromptSubmit', permission_mode: 'default', prompt: 'continue' });
    expect(r.ctx).not.toMatch(/New work in a bound session/);
    const home2 = sandbox();
    seed(home2, BOUND);
    const r2 = await run(home2, { hook_event_name: 'UserPromptSubmit', permission_mode: 'plan', prompt: 'plan' });
    expect(r2.ctx).not.toMatch(/New work in a bound session/);
  });

  it('config: with no env, the token comes from ~/.claude.json (user scope), then the project scope', async () => {
    const home = sandbox();
    seed(home, { ...BOUND, checkedAt: 0 });
    respond = () => ({ status: 200, body: { issue: { key: 'TCK-12', work_status: 'planning', bound_session_id: BOUND_SID } } });
    fs.writeFileSync(
      path.join(home, '.claude.json'),
      JSON.stringify({ mcpServers: { noesis: { env: { NOESIS_API_TOKEN: 'noe_user_scope', NOESIS_API_URL: baseUrl() } } } }),
    );
    await run(home, { hook_event_name: 'UserPromptSubmit', prompt: 'continue' }, { NOESIS_API_TOKEN: undefined, NOESIS_API_URL: undefined });
    expect(requests.map((q) => q.auth)).toEqual(['Bearer noe_user_scope']);

    requests.length = 0;
    seed(home, { ...BOUND, checkedAt: 0 });
    fs.writeFileSync(
      path.join(home, '.claude.json'),
      JSON.stringify({ projects: { '/work/proj': { mcpServers: { noesis: { env: { NOESIS_API_TOKEN: 'noe_project_scope', NOESIS_API_URL: baseUrl() } } } } } }),
    );
    await run(home, { hook_event_name: 'UserPromptSubmit', prompt: 'continue', cwd: '/work/proj' }, { NOESIS_API_TOKEN: undefined, NOESIS_API_URL: undefined });
    expect(requests.map((q) => q.auth)).toEqual(['Bearer noe_project_scope']);
  });

  it('no token anywhere: the reminder still shows from the cache and nothing is sent', async () => {
    const home = sandbox();
    seed(home, { ...BOUND, checkedAt: 0 });
    const r = await run(home, { hook_event_name: 'UserPromptSubmit', prompt: 'continue' }, { NOESIS_API_TOKEN: undefined, NOESIS_API_URL: undefined });
    expect(r.ctx).toMatch(/bound to TCK-12/);
    expect(requests).toHaveLength(0);
  });

  it('TCK_BINDINGS_DIR moves the cache; writing one prunes files older than 14 days', async () => {
    const home = sandbox();
    const dir = path.join(home, 'bindings');
    fs.mkdirSync(dir, { recursive: true });
    const old = path.join(dir, 'old-session.json');
    const recent = path.join(dir, 'recent-session.json');
    fs.writeFileSync(old, '{}');
    fs.writeFileSync(recent, '{}');
    const past = (Date.now() - 15 * 24 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(old, past, past);
    const issue = { key: 'TCK-12', work_status: 'planning', bound_session_id: BOUND_SID, bound_machine: null };
    await run(home, { hook_event_name: 'PostToolUse', tool_name: 'mcp__noesis__backlog_bind', tool_response: [{ type: 'text', text: JSON.stringify({ issue }) }] }, { TCK_BINDINGS_DIR: dir });
    expect(fs.existsSync(path.join(dir, `${HOOK_SID}.json`))).toBe(true);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(recent)).toBe(true);
    expect(fs.existsSync(cacheFile(home))).toBe(false); // not in the default dir
  });
});
