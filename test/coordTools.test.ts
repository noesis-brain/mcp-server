/**
 * Chief of Staff tools (TCK-1890): the request each client method sends, how each tool shapes its
 * arguments, which session it names, and that no tool can answer an owner gate. The server decides
 * every rule; what these tools must get right is the request, and that a refusal keeps its error_code.
 * The scanner moved here from claude-config: its own selftest must pass from this package, and
 * coord_report posts only the conflicts of its --json output.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

const SESSION = '3f0c1d2e-4a5b-4c6d-8e7f-a1b2c3d4e5f6';
type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

describe('coordination client methods: method, path and body', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('each method calls its route', async () => {
    const seen: Array<{ req: string; body: string | undefined }> = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ req: `${init?.method} ${String(url)}`, body: typeof init?.body === 'string' ? init.body : undefined });
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const { NoesisClient } = await import('../src/api/NoesisClient.js');
    const c = new NoesisClient('https://example.test', 'noe_x');
    await c.coordDecide({ category: 'rebase', choice: 'x' });
    await c.coordDecisionGet(42);
    await c.coordDecisions({ status: 'pending', ticket: 'TCK-1', limit: 5, category: undefined });
    await c.coordDecisions();
    await c.coordPolicy();
    await c.coordLease('test-db', 'acquire', { holder: 'h', ttl_seconds: 60 });
    await c.coordLease('test-db', 'heartbeat', { holder: 'h' });
    await c.coordLease('ship', 'release', { holder: 'h' });
    await c.coordLeases();
    await c.coordAllocateMcpVersion({ npm_latest: '2.12.0', ticket: 'TCK-1' });
    await c.coordSessionHeartbeat({ session_id: 's', state: 'running' });
    await c.coordSessions();
    await c.coordMessage({ body: 'hi', to_session: 's' });
    await c.coordInbox('s 1/x');
    await c.coordInbox('s', { since: 7, limit: 20 });
    await c.coordReport([{ kind: 'C2' }]);
    await c.coordConflicts();
    await c.coordConflicts(true);
    await c.coordPort('get', { holder: 'h', ticket: 'TCK-1' });
    await c.coordPort('release', { holder: 'h' });
    expect(seen).toEqual([
      { req: 'POST https://example.test/api/mcp/coordination/decisions', body: JSON.stringify({ category: 'rebase', choice: 'x' }) },
      { req: 'GET https://example.test/api/mcp/coordination/decisions/42', body: undefined },
      { req: 'GET https://example.test/api/mcp/coordination/decisions?status=pending&ticket=TCK-1&limit=5', body: undefined },
      { req: 'GET https://example.test/api/mcp/coordination/decisions', body: undefined },
      { req: 'GET https://example.test/api/mcp/coordination/policy', body: undefined },
      { req: 'POST https://example.test/api/mcp/coordination/leases/test-db/acquire', body: JSON.stringify({ holder: 'h', ttl_seconds: 60 }) },
      { req: 'POST https://example.test/api/mcp/coordination/leases/test-db/heartbeat', body: JSON.stringify({ holder: 'h' }) },
      { req: 'POST https://example.test/api/mcp/coordination/leases/ship/release', body: JSON.stringify({ holder: 'h' }) },
      { req: 'GET https://example.test/api/mcp/coordination/leases', body: undefined },
      { req: 'POST https://example.test/api/mcp/coordination/allocations/mcp-version', body: JSON.stringify({ npm_latest: '2.12.0', ticket: 'TCK-1' }) },
      { req: 'POST https://example.test/api/mcp/coordination/sessions/heartbeat', body: JSON.stringify({ session_id: 's', state: 'running' }) },
      { req: 'GET https://example.test/api/mcp/coordination/sessions', body: undefined },
      { req: 'POST https://example.test/api/mcp/coordination/messages', body: JSON.stringify({ body: 'hi', to_session: 's' }) },
      { req: 'GET https://example.test/api/mcp/coordination/inbox?session=s+1%2Fx', body: undefined },
      { req: 'GET https://example.test/api/mcp/coordination/inbox?session=s&since=7&limit=20', body: undefined },
      { req: 'POST https://example.test/api/mcp/coordination/report', body: JSON.stringify({ conflicts: [{ kind: 'C2' }] }) },
      { req: 'GET https://example.test/api/mcp/coordination/conflicts', body: undefined },
      { req: 'GET https://example.test/api/mcp/coordination/conflicts?all=true', body: undefined },
      { req: 'POST https://example.test/api/mcp/coordination/allocations/port', body: JSON.stringify({ holder: 'h', ticket: 'TCK-1' }) },
      { req: 'POST https://example.test/api/mcp/coordination/allocations/port/release', body: JSON.stringify({ holder: 'h' }) },
    ]);
  });

  it('every method keeps a refusal\'s error_code and details (LEASE_LOST, NOT_FOUND, OWNER_GATE reach the session)', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'no', error_code: 'LEASE_LOST', details: { why: 'ttl' } }), { status: 409, headers: { 'Content-Type': 'application/json' } }),
    ) as typeof fetch;
    const { NoesisClient } = await import('../src/api/NoesisClient.js');
    const c = new NoesisClient('https://example.test', 'noe_x');
    const calls: Array<[string, () => Promise<unknown>]> = [
      ['coordDecide', () => c.coordDecide({})],
      ['coordDecisionGet', () => c.coordDecisionGet(1)],
      ['coordDecisions', () => c.coordDecisions({ status: 'pending' })],
      ['coordPolicy', () => c.coordPolicy()],
      ['coordLease', () => c.coordLease('test-db', 'heartbeat', { holder: 'h' })],
      ['coordLeases', () => c.coordLeases()],
      ['coordAllocateMcpVersion', () => c.coordAllocateMcpVersion({ npm_latest: '2.13.0' })],
      ['coordSessionHeartbeat', () => c.coordSessionHeartbeat({ session_id: 's', state: 'idle' })],
      ['coordSessions', () => c.coordSessions()],
      ['coordMessage', () => c.coordMessage({ body: 'x' })],
      ['coordInbox', () => c.coordInbox('s')],
      ['coordReport', () => c.coordReport([])],
      ['coordConflicts', () => c.coordConflicts(true)],
      ['coordPort', () => c.coordPort('get', { holder: 'h' })],
    ];
    for (const [name, call] of calls) await expect(call(), name).rejects.toThrow(/\[LEASE_LOST\].*"why":"ttl"/);
  });

  it('paths and queries are encoded', async () => {
    const seen: string[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      seen.push(String(url));
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const { NoesisClient } = await import('../src/api/NoesisClient.js');
    const c = new NoesisClient('https://example.test', 'noe_x');
    await c.coordLease('a/b', 'acquire', { holder: 'h' });
    await c.coordDecisions({ ticket: 'TCK-1&status=auto#x' });
    expect(seen).toEqual([
      'https://example.test/api/mcp/coordination/leases/a%2Fb/acquire',
      'https://example.test/api/mcp/coordination/decisions?ticket=TCK-1%26status%3Dauto%23x',
    ]);
  });

  it('a refusal keeps its error_code and details, so the session can tell CARD_REQUIRED from LEASE_LOST', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'needs a card', error_code: 'CARD_REQUIRED', details: { level: 2 } }), { status: 400, headers: { 'Content-Type': 'application/json' } }),
    ) as typeof fetch;
    const { NoesisClient } = await import('../src/api/NoesisClient.js');
    const c = new NoesisClient('https://example.test', 'noe_x');
    await expect(c.coordDecide({})).rejects.toThrow(/\[CARD_REQUIRED\].*"level":2/);
  });
});

describe('coordination tools → client', () => {
  const handlers = new Map<string, Handler>();
  const schemas = new Map<string, Record<string, z.ZodTypeAny>>();
  const calls: Array<[string, ...unknown[]]> = [];
  const saved = { sid: process.env.CLAUDE_CODE_SESSION_ID, dir: process.env.CLAUDE_PROJECT_DIR };
  const rubric = { reversible: true, shared: false, userVisible: false, touches: [], confidence: 'high', evidence: 'measured' };

  beforeAll(async () => {
    process.env.CLAUDE_PROJECT_DIR = '/work/proj';
    const { registerCoordTools } = await import('../src/tools/coord.js');
    const server = {
      tool: (name: string, _desc: string, schema: Record<string, z.ZodTypeAny>, handler: Handler) => {
        handlers.set(name, handler);
        schemas.set(name, schema);
      },
    };
    const client = new Proxy({}, { get: (_t, prop) => async (...args: unknown[]) => (calls.push([String(prop), ...args]), { ok: true }) });
    registerCoordTools(server as never, client as never);
  });
  afterEach(() => {
    calls.length = 0;
  });
  afterAll(() => {
    for (const [k, v] of [['CLAUDE_CODE_SESSION_ID', saved.sid], ['CLAUDE_PROJECT_DIR', saved.dir]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  const run = (name: string, args: Record<string, unknown>) => handlers.get(name)!(args);

  it('registers exactly these tools, and none that answers, reviews, changes the policy, pauses or continues', () => {
    expect([...handlers.keys()].sort()).toEqual([
      'coord_allocate_mcp_version', 'coord_conflicts', 'coord_decide', 'coord_decision_get', 'coord_decisions', 'coord_heartbeat', 'coord_inbox',
      'coord_lease', 'coord_leases', 'coord_message', 'coord_policy', 'coord_port', 'coord_report', 'coord_sessions',
    ]);
    for (const name of handlers.keys()) expect(name).not.toMatch(/answer|review|approve|set_policy|force|pause|continue/);
    // coord_message has no kind: it cannot send a pause or a continue.
    expect(Object.keys(schemas.get('coord_message')!).sort()).toEqual(['as_chief', 'body', 'ticket', 'to_session']);
  });

  it('coord_decide sends the session, the actor and only the fields given', async () => {
    process.env.CLAUDE_CODE_SESSION_ID = SESSION.toUpperCase();
    await run('coord_decide', { category: 'rebase', rubric, choice: 'Rebase TCK-1' });
    await run('coord_decide', { category: 'ship', rubric, choice: 'Ship TCK-1', ticket: 'TCK-1', as_chief: true, card: { question: 'q' }, reason: 'r' });
    expect(calls).toEqual([
      ['coordDecide', { category: 'rebase', rubric, choice: 'Rebase TCK-1', actor: 'session', session_id: SESSION }],
      ['coordDecide', { category: 'ship', rubric, choice: 'Ship TCK-1', actor: 'chief', reason: 'r', ticket: 'TCK-1', card: { question: 'q' }, session_id: SESSION }],
    ]);
  });

  it('without a session, a decision is still recorded, but names no session', async () => {
    delete process.env.CLAUDE_CODE_SESSION_ID;
    await run('coord_decide', { category: 'scope', rubric, choice: 'x' });
    expect(calls).toEqual([['coordDecide', { category: 'scope', rubric, choice: 'x', actor: 'session' }]]);
  });

  it('coord_lease: the holder defaults to this session; note and time to live go only with acquire', async () => {
    process.env.CLAUDE_CODE_SESSION_ID = SESSION;
    await run('coord_lease', { resource: 'test-db', action: 'acquire', note: 'full suite', ttl_seconds: 600 });
    await run('coord_lease', { resource: 'test-db', action: 'heartbeat', note: 'ignored', ttl_seconds: 600 });
    await run('coord_lease', { resource: 'test-db', action: 'release', holder: 'chief' });
    expect(calls).toEqual([
      ['coordLease', 'test-db', 'acquire', { holder: SESSION, note: 'full suite', ttl_seconds: 600 }],
      ['coordLease', 'test-db', 'heartbeat', { holder: SESSION }],
      ['coordLease', 'test-db', 'release', { holder: 'chief' }],
    ]);
    calls.length = 0;
    // A release carries only the holder: the server's release body is strict.
    await run('coord_lease', { resource: 'ship', action: 'release', note: 'x', ttl_seconds: 60 });
    expect(calls).toEqual([['coordLease', 'ship', 'release', { holder: SESSION }]]);
  });

  it('coord_decide passes the optional fields it is given', async () => {
    process.env.CLAUDE_CODE_SESSION_ID = SESSION;
    await run('coord_decide', { category: 'scope', rubric, choice: 'x', alternatives: ['y', 'z'], evidence: ['TCK-1', 'src/a.ts'], undo: 'revert it' });
    expect(calls).toEqual([['coordDecide', { category: 'scope', rubric, choice: 'x', actor: 'session', alternatives: ['y', 'z'], evidence: ['TCK-1', 'src/a.ts'], undo: 'revert it', session_id: SESSION }]]);
  });

  it('coord_lease without a session and without a holder refuses, and calls nothing', async () => {
    delete process.env.CLAUDE_CODE_SESSION_ID;
    const res = await run('coord_lease', { resource: 'ship', action: 'acquire' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('CLAUDE_CODE_SESSION_ID');
    expect(calls).toEqual([]);
  });

  it('coord_allocate_mcp_version, coord_decisions, coord_decision_get, coord_policy, coord_leases', async () => {
    process.env.CLAUDE_CODE_SESSION_ID = SESSION;
    await run('coord_allocate_mcp_version', { npm_latest: '2.12.0', ticket: 'TCK-9' });
    await run('coord_allocate_mcp_version', { npm_latest: '2.12.0', ticket: 'TCK-9', in_branches: ['2.13.0', '2.15.0'] });
    await run('coord_decisions', { status: 'pending' });
    await run('coord_decision_get', { id: 7 });
    await run('coord_policy', {});
    await run('coord_leases', {});
    expect(calls).toEqual([
      ['coordAllocateMcpVersion', { npm_latest: '2.12.0', ticket: 'TCK-9', holder: SESSION }],
      ['coordAllocateMcpVersion', { npm_latest: '2.12.0', ticket: 'TCK-9', in_branches: ['2.13.0', '2.15.0'], holder: SESSION }],
      ['coordDecisions', { status: 'pending' }],
      ['coordDecisionGet', 7],
      ['coordPolicy'],
      ['coordLeases'],
    ]);
  });

  it('coord_heartbeat sends this session, its folder and its machine, and only the fields given', async () => {
    process.env.CLAUDE_CODE_SESSION_ID = SESSION.toUpperCase();
    await run('coord_heartbeat', { state: 'running', ticket: 'TCK-3', note: 'INC-2' });
    await run('coord_heartbeat', { state: 'waiting' });
    expect(calls).toEqual([
      ['coordSessionHeartbeat', { session_id: SESSION, state: 'running', machine: os.hostname(), cwd: '/work/proj', ticket: 'TCK-3', note: 'INC-2' }],
      ['coordSessionHeartbeat', { session_id: SESSION, state: 'waiting', machine: os.hostname(), cwd: '/work/proj' }],
    ]);
  });

  it('coord_heartbeat leaves out a folder the server would refuse (too long, a tab, an invisible character), rather than cutting it', async () => {
    process.env.CLAUDE_CODE_SESSION_ID = SESSION;
    for (const dir of [`/${'d'.repeat(600)}`, '/work/a\tb', `/work/a${String.fromCodePoint(0x200b)}b`]) {
      process.env.CLAUDE_PROJECT_DIR = dir;
      try {
        await run('coord_heartbeat', { state: 'idle' });
      } finally {
        process.env.CLAUDE_PROJECT_DIR = '/work/proj';
      }
    }
    const want = ['coordSessionHeartbeat', { session_id: SESSION, state: 'idle', machine: os.hostname() }];
    expect(calls).toEqual([want, want, want]);
    // A folder with two spaces is fine: the server keeps it as it is.
    process.env.CLAUDE_PROJECT_DIR = '/work/My  Projects';
    try {
      await run('coord_heartbeat', { state: 'idle' });
    } finally {
      process.env.CLAUDE_PROJECT_DIR = '/work/proj';
    }
    expect(calls[3]).toEqual(['coordSessionHeartbeat', { session_id: SESSION, state: 'idle', machine: os.hostname(), cwd: '/work/My  Projects' }]);
  });

  it('coord_heartbeat leaves out a machine name the server would refuse', async () => {
    process.env.CLAUDE_CODE_SESSION_ID = SESSION;
    // The session code imports os as a namespace: syncBuiltinESMExports copies the patched built-in into it.
    const { syncBuiltinESMExports } = await import('node:module');
    const host = vi.spyOn(os, 'hostname').mockReturnValue('host\twith-a-tab');
    syncBuiltinESMExports();
    try {
      await run('coord_heartbeat', { state: 'idle' });
    } finally {
      host.mockRestore();
      syncBuiltinESMExports();
    }
    expect(calls).toEqual([['coordSessionHeartbeat', { session_id: SESSION, state: 'idle', cwd: '/work/proj' }]]);
  });

  it('coord_message names the sender session; coord_inbox reads this session by default', async () => {
    process.env.CLAUDE_CODE_SESSION_ID = ` ${SESSION.toUpperCase()} `;
    await run('coord_message', { body: 'Rebase on main.', to_session: 'b2070484', ticket: 'TCK-1', as_chief: true });
    await run('coord_message', { body: 'Run /mcp.' });
    await run('coord_inbox', { since: 12 });
    await run('coord_inbox', { session: 'other-session', limit: 5 });
    await run('coord_sessions', {});
    await run('coord_conflicts', {});
    await run('coord_conflicts', { all: true });
    expect(calls).toEqual([
      ['coordMessage', { body: 'Rebase on main.', to_session: 'b2070484', ticket: 'TCK-1', as_chief: true, from_session: SESSION }],
      ['coordMessage', { body: 'Run /mcp.', from_session: SESSION }],
      ['coordInbox', SESSION, { since: 12, limit: undefined }],
      ['coordInbox', 'other-session', { since: undefined, limit: 5 }],
      ['coordSessions'],
      ['coordConflicts', false],
      ['coordConflicts', true],
    ]);
  });

  it('without a session: a message still goes, unsigned; the heartbeat and the inbox refuse and call nothing', async () => {
    // No id at all, and an id that is not a session id: both count as no session.
    for (const sid of [undefined, 'not-a-session-id']) {
      if (sid === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
      else process.env.CLAUDE_CODE_SESSION_ID = sid;
      await run('coord_message', { body: 'x' });
      expect(calls, String(sid)).toEqual([['coordMessage', { body: 'x' }]]);
      calls.length = 0;
      for (const [tool, args] of [['coord_heartbeat', { state: 'idle' }], ['coord_inbox', {}]] as const) {
        const res = await run(tool, args);
        expect(res.isError, `${tool} ${sid}`).toBe(true);
        expect(res.content[0].text).toContain('CLAUDE_CODE_SESSION_ID');
      }
      expect(calls, String(sid)).toEqual([]);
    }
  });

  it('a real session with a transcript: the heartbeat sends its folder, and still not its branch or title', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-transcript-'));
    const savedDir = process.env.CLAUDE_CONFIG_DIR;
    try {
      fs.mkdirSync(path.join(dir, 'projects', '-work-real'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'projects', '-work-real', `${SESSION}.jsonl`),
        [
          { type: 'user', cwd: '/work/real-session', gitBranch: 'loop/tck-9', sessionId: SESSION, timestamp: new Date().toISOString() },
          { type: 'ai-title', aiTitle: 'A private session title' },
        ].map((l) => JSON.stringify(l)).join('\n') + '\n',
      );
      process.env.CLAUDE_CONFIG_DIR = dir;
      process.env.CLAUDE_CODE_SESSION_ID = SESSION;
      await run('coord_heartbeat', { state: 'running' });
      expect(calls).toEqual([['coordSessionHeartbeat', { session_id: SESSION, state: 'running', machine: os.hostname(), cwd: '/work/real-session' }]]);
    } finally {
      if (savedDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = savedDir;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('coord_report posts only the conflicts of a coord-scan --json file, or the conflicts given', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-report-'));
    try {
      const conflicts = [{ kind: 'C5', severity: 'high', a: 'TCK-1', b: 'TCK-2', detail: 'both alter t', evidence: { table: 't' } }];
      const scan = path.join(dir, 'scan.json');
      fs.writeFileSync(scan, JSON.stringify({ generatedAt: 'now', main: { path: '/secret/main' }, tickets: [{ key: 'TCK-1' }], conflicts, processes: [{ pid: 1 }] }));
      await run('coord_report', { scan_file: scan });
      await run('coord_report', { conflicts });
      await run('coord_report', { conflicts: [] });
      expect(calls).toEqual([['coordReport', conflicts], ['coordReport', conflicts], ['coordReport', []]]);
      calls.length = 0;
      const notScan = path.join(dir, 'board.json');
      fs.writeFileSync(notScan, JSON.stringify({ issues: [] }));
      const broken = path.join(dir, 'broken.json');
      fs.writeFileSync(broken, '{"conflicts": [');
      // A file over 5 MB is refused before it is read: a scan of this machine is about 50 KB.
      const huge = path.join(dir, 'huge.json');
      fs.writeFileSync(huge, JSON.stringify({ conflicts: [], pad: 'x'.repeat(5_000_001) }));
      const reads = vi.spyOn(fs, 'readFileSync');
      const hugeRes = await run('coord_report', { scan_file: huge });
      expect(hugeRes.content[0].text).toMatch(/larger than 5000000 bytes/);
      // Refused before it is read: the 5 MB never enter memory.
      expect(reads.mock.calls.some(([f]) => String(f) === huge)).toBe(false);
      reads.mockRestore();
      // Exactly at the cap is fine; a folder (or a pipe) is never read.
      const atCap = path.join(dir, 'at-cap.json');
      const head = JSON.stringify({ conflicts: [], pad: '' });
      fs.writeFileSync(atCap, `${head.slice(0, -2)}${'x'.repeat(5_000_000 - head.length)}"}`);
      expect(fs.statSync(atCap).size).toBe(5_000_000);
      await run('coord_report', { scan_file: atCap });
      expect(calls).toEqual([['coordReport', []]]);
      calls.length = 0;
      expect((await run('coord_report', { scan_file: dir })).content[0].text).toMatch(/is not a regular file/);
      for (const args of [{}, { scan_file: scan, conflicts }, { scan_file: notScan }, { scan_file: broken }, { scan_file: path.join(dir, 'missing.json') }]) {
        const res = await run('coord_report', args);
        expect(res.isError, JSON.stringify(args)).toBe(true);
      }
      expect(calls).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('coord_port: this session holds it by default, a ticket keys it, release gives it back; without a session it refuses', async () => {
    process.env.CLAUDE_CODE_SESSION_ID = SESSION;
    await run('coord_port', {});
    await run('coord_port', { ticket: 'TCK-7' });
    await run('coord_port', { action: 'release', ticket: 'TCK-7' });
    await run('coord_port', { holder: 'chief' });
    expect(calls).toEqual([
      ['coordPort', 'get', { holder: SESSION }],
      ['coordPort', 'get', { holder: SESSION, ticket: 'TCK-7' }],
      ['coordPort', 'release', { holder: SESSION, ticket: 'TCK-7' }],
      ['coordPort', 'get', { holder: 'chief' }],
    ]);
    calls.length = 0;
    delete process.env.CLAUDE_CODE_SESSION_ID;
    const res = await run('coord_port', {});
    expect(res.isError).toBe(true);
    expect(calls).toEqual([]);
  });

  it('coord_report names the scanner that ships in this package', async () => {
    const { COORD_SCANNER } = await import('../src/tools/coord.js');
    expect(fs.existsSync(COORD_SCANNER)).toBe(true);
    expect(path.basename(COORD_SCANNER)).toBe('coord-scan.mjs');
  });

  it('the schemas refuse what the server would refuse anyway: unknown categories, resources, letters', () => {
    const parse = (tool: string, args: Record<string, unknown>) => z.object(schemas.get(tool)!).safeParse(args).success;
    expect(parse('coord_decide', { category: 'banana', rubric, choice: 'x' })).toBe(false);
    expect(parse('coord_decide', { category: 'ship', rubric: { ...rubric, touches: ['moon'] }, choice: 'x' })).toBe(false);
    expect(parse('coord_lease', { resource: 'gpu', action: 'acquire' })).toBe(false);
    expect(parse('coord_lease', { resource: 'ship', action: 'steal' })).toBe(false);
    expect(parse('coord_lease', { resource: 'ship', action: 'acquire', holder: 'has space' })).toBe(false);
    expect(parse('coord_lease', { resource: 'ship', action: 'acquire', ttl_seconds: 5 })).toBe(false);
    expect(parse('coord_decide', { category: 'ship', rubric, choice: 'x', card: { question: 'q', recommended: 'E', reason: 'r', options: [], whyNotDecided: 'w', proof: ['TCK-1'] } })).toBe(false);
    expect(parse('coord_decide', { category: 'rebase', rubric, choice: 'x' })).toBe(true);
    expect(parse('coord_heartbeat', { state: 'asleep' })).toBe(false);
    expect(parse('coord_message', { body: '' })).toBe(false);
    expect(parse('coord_message', { body: 'x'.repeat(4001) })).toBe(false);
    expect(parse('coord_message', { body: 'x', to_session: 'has space' })).toBe(false);
    expect(parse('coord_inbox', { since: -1 })).toBe(false);
    expect(parse('coord_inbox', { since: 2147483648 })).toBe(false);
    expect(parse('coord_report', { conflicts: Array.from({ length: 201 }, () => ({})) })).toBe(false);
  });

  it('the lists match the server\'s: 11 categories, 5 statuses, 4 resources', () => {
    const options = (tool: string, field: string) => (schemas.get(tool)![field] as unknown as { unwrap?: () => { options: string[] }; options?: string[] });
    const opts = (tool: string, field: string) => {
      const f = options(tool, field);
      return [...(f.options ?? f.unwrap!().options)].sort();
    };
    expect(opts('coord_decide', 'category')).toEqual(['cleanup', 'mcp-publish', 'merge-tickets', 'other', 'pick', 'prod-schema', 'rebase', 'scope', 'ship', 'ship-order', 'stop-session']);
    expect(opts('coord_decisions', 'category')).toEqual(opts('coord_decide', 'category'));
    expect(opts('coord_decisions', 'status')).toEqual(['answered', 'auto', 'pending', 'reverted', 'review']);
    expect(opts('coord_lease', 'resource')).toEqual(['mcp-publish', 'prod-schema', 'ship', 'test-db']);
  });
});

describe('the Chief\'s rules ship in this package', () => {
  it('scripts/coord-rules.mjs passes its own selftest from here', () => {
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'coord-rules.mjs'), '--selftest'], { encoding: 'utf8', timeout: 60_000 });
    expect(r.status, `${r.stdout}\n${r.stderr}`.slice(-2000)).toBe(0);
    expect(r.stdout).toMatch(/all passed/);
  });
});

describe('the incident replay ships in this package', () => {
  const harness = path.join(__dirname, '..', 'scripts', 'coord-mock-sessions.mjs');
  it('scripts/coord-mock-sessions.mjs passes its selftest and refuses an API that is not on this machine', () => {
    const r = spawnSync(process.execPath, [harness, '--selftest'], { encoding: 'utf8', timeout: 60_000 });
    expect(r.status, `${r.stdout}\n${r.stderr}`.slice(-2000)).toBe(0);
    expect(r.stdout).toMatch(/isLocalApi: only this machine/);
    expect(r.stdout).toMatch(/the 25 incident rows need 15 conditions/);
    // The refusal comes before any request. The host cannot exist, so even a broken guard signs up nowhere.
    const remote = spawnSync(process.execPath, [harness, '--api', 'https://chief-refusal.invalid'], { encoding: 'utf8', timeout: 60_000 });
    expect(remote.status).toBe(3);
    expect(remote.stderr).toMatch(/refused: https:\/\/chief-refusal\.invalid is not a local API/);
  });

  // A fake fetch: signup answers, the next request fails, so run() stops right after the account file.
  const fakeFetch = () => {
    const calls: string[] = [];
    const f = async (url: string) => {
      calls.push(url);
      if (url.endsWith('/api/auth/signup')) return new Response(JSON.stringify({ accessToken: 'jwt' }), { status: 200 });
      return new Response('nope', { status: 500 });
    };
    return { calls, f };
  };
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'acct-'));

  it('--account-file writes the API, email and password with mode 600, also over an old readable file', async () => {
    const { run } = await import(harness);
    for (const old of [false, true]) {
      const dir = tmp(); const file = path.join(dir, 'account.json');
      if (old) fs.writeFileSync(file, 'old secret', { mode: 0o644 });
      const { calls, f } = fakeFetch();
      vi.stubGlobal('fetch', f);
      try {
        await expect(run({ api: 'http://127.0.0.1:1', accountFile: file, log: () => {} })).rejects.toThrow(/API token: HTTP 500/);
      } finally { vi.unstubAllGlobals(); }
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      expect(Object.keys(saved).sort()).toEqual(['api', 'email', 'password']);
      expect(saved.api).toBe('http://127.0.0.1:1');
      expect(saved.email).toMatch(/^chief-mock-.+@example\.test$/);
      expect(saved.password.length).toBeGreaterThanOrEqual(20);
      expect(calls[0]).toBe('http://127.0.0.1:1/api/auth/signup');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a refused API writes no account file and sends nothing; without the flag no file is written', async () => {
    const { run } = await import(harness);
    const dir = tmp(); const file = path.join(dir, 'account.json');
    const { calls, f } = fakeFetch();
    vi.stubGlobal('fetch', f);
    try {
      await expect(run({ api: 'https://chief-refusal.invalid', accountFile: file, log: () => {} })).rejects.toThrow(/refused/);
      expect(calls).toEqual([]);
      expect(fs.existsSync(file)).toBe(false);
      await expect(run({ api: 'http://127.0.0.1:1', log: () => {} })).rejects.toThrow(/API token: HTTP 500/);
      expect(fs.readdirSync(dir)).toEqual([]);
    } finally { vi.unstubAllGlobals(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('a flag with no value is a usage error, never the next flag taken as a file name', () => {
    for (const args of [['--account-file', '--keep'], ['--json'], ['--account-file']]) {
      const r = spawnSync(process.execPath, [harness, '--api', 'http://127.0.0.1:1', ...args], { encoding: 'utf8', timeout: 30_000 });
      expect(r.status, args.join(' ')).toBe(2);
      expect(r.stderr).toMatch(/usage:/);
    }
  });
});

describe('the scanner moved into this package', () => {
  // The selftest builds throwaway git repos: about 4 s alone, more next to the other test files.
  it('scripts/coord-scan.mjs passes its own selftest from here', { timeout: 150_000 }, () => {
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'coord-scan.mjs'), '--selftest'], { encoding: 'utf8', timeout: 120_000 });
    expect(r.status, `${r.stdout}\n${r.stderr}`.slice(-2000)).toBe(0);
    expect(r.stdout).toMatch(/\bok\b/);
  });
});

describe('a client refusal reaches the session through every tool', () => {
  const savedSid = process.env.CLAUDE_CODE_SESSION_ID;
  afterAll(() => {
    if (savedSid === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = savedSid;
  });

  it('each tool answers isError with the [CODE] text', async () => {
    process.env.CLAUDE_CODE_SESSION_ID = SESSION;
    const { registerCoordTools } = await import('../src/tools/coord.js');
    const handlers = new Map<string, Handler>();
    const server = { tool: (name: string, _d: string, _s: unknown, h: Handler) => handlers.set(name, h) };
    const client = new Proxy({}, { get: () => async () => { throw new Error('refused [CARD_REQUIRED] {"level":2}'); } });
    registerCoordTools(server as never, client as never);
    const rubric = { reversible: true, shared: false, userVisible: false, touches: [], confidence: 'high', evidence: 'measured' };
    const args: Record<string, Record<string, unknown>> = {
      coord_decide: { category: 'ship', rubric, choice: 'x' },
      coord_decision_get: { id: 1 },
      coord_decisions: {},
      coord_policy: {},
      coord_lease: { resource: 'ship', action: 'acquire' },
      coord_leases: {},
      coord_allocate_mcp_version: { npm_latest: '2.13.0' },
      coord_heartbeat: { state: 'running' },
      coord_sessions: {},
      coord_message: { body: 'x' },
      coord_inbox: {},
      coord_report: { conflicts: [] },
      coord_conflicts: {},
      coord_port: {},
    };
    expect([...handlers.keys()].sort()).toEqual(Object.keys(args).sort());
    for (const [name, a] of Object.entries(args)) {
      const res = await handlers.get(name)!(a);
      expect(res.isError, name).toBe(true);
      expect(res.content[0].text, name).toContain('[CARD_REQUIRED]');
    }
  });
});

describe('the package registers the coordination tools', () => {
  it('registerTools adds each coord_* tool exactly once', async () => {
    const { registerTools } = await import('../src/tools/index.js');
    const names: string[] = [];
    const server = new Proxy({}, {
      get: (_t, prop) => (prop === 'tool' ? (name: string) => { names.push(name); } : () => undefined),
    });
    const client = new Proxy({}, { get: () => async () => ({}) });
    registerTools(server as never, { client } as never);
    const coord = names.filter((n) => n.startsWith('coord_')).sort();
    expect(coord).toEqual([
      'coord_allocate_mcp_version', 'coord_conflicts', 'coord_decide', 'coord_decision_get', 'coord_decisions', 'coord_heartbeat', 'coord_inbox',
      'coord_lease', 'coord_leases', 'coord_message', 'coord_policy', 'coord_port', 'coord_report', 'coord_sessions',
    ]);
  });
});

describe('the /noesis-chief skill ships in this package (TCK-1890)', () => {
  const template = fs.readFileSync(path.join(__dirname, '..', 'skill-templates', 'noesis-chief.md'), 'utf8');

  it('names only the coord tools this package registers, and only scripts that exist here', async () => {
    const names = new Set<string>();
    const { registerCoordTools } = await import('../src/tools/coord.js');
    registerCoordTools({ tool: (name: string) => names.add(name) } as never, {} as never);
    const used = [...new Set(template.match(/\bcoord_[a-z_]+\b/g) ?? [])];
    expect(used.length).toBeGreaterThan(6);
    for (const n of used) expect([...names], n).toContain(n);
    const scripts = [...template.matchAll(/\$S\/([\w-]+\.mjs)/g)].map((m) => m[1]);
    expect(scripts).toEqual(expect.arrayContaining(['coord-scan.mjs', 'coord-rules.mjs']));
    for (const s of scripts) expect(fs.existsSync(path.join(__dirname, '..', 'scripts', s)), s).toBe(true);
  });

  it('keeps the owner gates with the owner, records picks as parallel or after a ship, and has a report-only mode', () => {
    expect(template).toContain('# /noesis-chief — the Chief of Staff, version 1');
    expect(template).toContain('Answer an owner gate (the server refuses it with `OWNER_GATE`)');
    expect(template).toContain('In server mode, do not ask the owner the cards in the terminal.');
    expect(template).toContain('"Start TCK-<n> next, in parallel" or "Start TCK-<n> after TCK-x ships"');
    expect(template).toContain('**report-only mode**');
    expect(template).toContain('`as_chief: true`');
  });

  it('states each contract as the code defines it: tool parameters, server outcomes, the pick evidence and the default order', async () => {
    const schemas = new Map<string, Record<string, unknown>>();
    const { registerCoordTools } = await import('../src/tools/coord.js');
    registerCoordTools({ tool: (name: string, _d: string, schema: Record<string, unknown>) => schemas.set(name, schema) } as never, {} as never);
    const params: Array<[string, string]> = [
      ['coord_report', 'scan_file'], ['coord_allocate_mcp_version', 'npm_latest'], ['coord_allocate_mcp_version', 'in_branches'],
      ['coord_message', 'to_session'], ['coord_message', 'ticket'], ['coord_message', 'as_chief'],
      ['coord_decide', 'evidence'], ['coord_decide', 'as_chief'], ['coord_decide', 'card'], ['coord_decide', 'ticket'],
    ];
    for (const [tool, p] of params) {
      expect(Object.keys(schemas.get(tool) ?? {}), `${tool} has ${p}`).toContain(p);
      expect(template, `the text names ${p}`).toContain('`' + p);
    }
    expect(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'coord-scan.mjs'), 'utf8')).toContain('npmLatest: npm');
    expect(fs.readFileSync(path.join(__dirname, '..', 'src', 'tools', 'coord.ts'), 'utf8')).toContain('CARD_REQUIRED');
    for (const phrase of [
      'with `scan_file` set to the absolute path of `scan.json`',
      "`npm_latest` = `main.npmLatest` from `scan.json`, and `in_branches` = the action's `inBranches`",
      'Leave out `to_session` when it is null (the message then goes to every session), and leave out `ticket` when it is null',
      "The server answers `proceed` (auto mode, within the owner's highest level) or `review` (observe mode",
      'The error `CARD_REQUIRED` means the server decided that the call waits for the owner',
      "the category's mode is off, or the call's level is above the highest level the owner lets you decide alone",
      'ticket keys only, best first (at most 9)',
      'not a Draft first, then marked up next (pinned), then priority, then the newest.',
    ]) expect(template).toContain(phrase);
  });

  it('keeps every limit of the role and of the report-only mode word for word', () => {
    for (const row of [
      "| Edit product code, or any file in a ticket's worktree |",
      '| Merge, push, publish to npm, or apply SQL to production |',
      '| Stop a process or a session (`stop-session` is an owner gate) |',
      '| Carry out an answered card: the session that owns the ticket does it |',
    ]) expect(template).toContain(row);
    for (const phrase of [
      'Do steps 1, 2 and 3, but skip `coord_report` and carry out no action.',
      'run `~/.claude/tools/coord-scan.mjs` with the same arguments',
      'Do step 5 without `coord_decide`',
      'This is the only mode that asks in the terminal.',
      'followed by "I will send your answer to <session>."',
      '- Send only the approved messages',
      'Never carry it out yourself.',
      'In server mode, do not ask the owner the cards in the terminal.',
      "Never send a message other than the actions' messages and the C9 message.",
      'only inside `node\n~/.claude/tools/coord-lease.mjs run test-db -- <command>`',
    ]) expect(template).toContain(phrase);
  });

  it('pins each instruction whole, not only its opening words', () => {
    for (const sentence of [
      "Call `coord_decide` with `category`, `rubric`, `choice`, `reason`, `evidence` and `as_chief: true`, and `ticket` when it is not null.",
      "When `main.npmLatest` is null (`npm view` failed), skip it this pass and leave its key out of `done.json`.",
      "or `review` (observe mode: it goes to the owner's review list and does not wait).",
      "Write a card (step 4) and call again with it. Nothing is stored before that.",
      "   - `ticket` = the first ticket, and `evidence` = the next tickets in order, ticket keys only, best first (at most 9).",
      "Check the card first (step 4), then call `coord_decide` with the card. It waits on the Chief view until the owner answers.",
      "When `$S/coord-rules.mjs` does not exist, sort the findings yourself by the catalogue's columns: rules become proposed messages, judgment calls go to the report's review list, owner gates become cards.",
      "Then one batched question for the proposed messages, the C9 message of step 3 included (\"Send all of them\", \"Send none\", \"Let me pick\").",
      "Then call `coord_report` with `scan_file` set to the absolute path of `scan.json` (expand `~`: the tool does not).",
    ]) expect(template).toContain(sentence);
  });

  it('noesis-mcp setup installs it into ~/.claude/commands unchanged', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'noesis-chief-setup-'));
    const savedHome = process.env.HOME;
    process.env.HOME = home;
    vi.resetModules();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { runSetup } = await import('../src/cli/setup.js');
      await runSetup([]);
      expect(fs.readFileSync(path.join(home, '.claude', 'commands', 'noesis-chief.md'), 'utf8')).toBe(template);
    } finally {
      log.mockRestore();
      process.env.HOME = savedHome;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('the scan watcher ships in this package (TCK-1890)', () => {
  const watcher = path.join(__dirname, '..', 'scripts', 'coord-watch.mjs');
  const template = fs.readFileSync(path.join(__dirname, '..', 'skill-templates', 'noesis-chief.md'), 'utf8');

  it('scripts/coord-watch.mjs passes its own selftest from here', () => {
    const r = spawnSync(process.execPath, [watcher, '--selftest'], { encoding: 'utf8', timeout: 60_000 });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/(\d+)\/\1 passed/);
  });

  it('wakes the Chief with the line /noesis-chief watch mode answers, and the template starts it the way it parses', async () => {
    const mod = await import('../scripts/coord-watch.mjs');
    expect(mod.WAKE_LINE).toBe('/noesis-chief watch');
    expect(template).toContain('`ScheduleWakeup` with 1800 seconds and the prompt `/noesis-chief watch`');
    expect(template).toContain('S=<repo>/md-manager-mcp-server/scripts\nnode $S/coord-watch.mjs --start --chief-pid $PPID --repo <repo>');
    expect(template).toContain('There is no scan watcher in this mode: use only the `ScheduleWakeup` wake of Watch mode.');
    expect(mod.ACTIVE_STATUSES).toEqual(['planning', 'ready_to_implement', 'implementing', 'iterating', 'ready_to_merge', 'deploying']);
  });

  it('pins each new sentence of the text whole', () => {
    for (const sentence of [
      "- Add the `C9|lease|<date>` key to `done.json` whether the owner approved the C9 message or not, so a later pass that day does not ask again.",
      "- Then one multiSelect question for the review list, with the header `Review`: \"Which of my choices do you agree with?\". Each choice that is not ticked counts as a disagree; write the owner's reason into `~/.claude/coord/<date>-review.md`.",
      "- The report's Ship order part comes from the scan's C1 lines, because `coord_leases` needs the server.",
      "`components`. A Planning ticket with no session bound also waits to start, so step 5 ranks it\nwith these fields.",
      "(the list gives only `link_count`: read the ticket's `links[].first` with `mcp__noesis__backlog_get` and its key).",
      "`/noesis-chief watch` into this session, but only when this session is idle: never at a question\nor a permission prompt. It stops when this session ends, and it starts nothing while another\nwatcher serves a live Chief.",
      "`priority`, `size`, `created_at`, `refined_text`, `refined_at`, `open_question_count`,",
    ]) expect(template).toContain(sentence);
  });

  it('refuses to run without the Chief pid, before it reads any API setting', () => {
    const env = { ...process.env, NOESIS_API_URL: 'http://127.0.0.1:9', NOESIS_API_TOKEN: 'dead' };
    for (const argv of [['--once'], ['--once', '--chief-pid', '1'], ['--start']]) {
      const r = spawnSync(process.execPath, [watcher, ...argv], { encoding: 'utf8', timeout: 30_000, env });
      expect(r.status, argv.join(' ')).toBe(2);
      expect(r.stderr).toContain('--chief-pid <the Chief session pid> is required');
    }
  });
});

describe('the pick replay ships in this package (TCK-1890, AC10)', () => {
  const replay = path.join(__dirname, '..', 'scripts', 'coord-pick-replay.mjs');

  it('scripts/coord-pick-replay.mjs passes its own selftest from here', () => {
    const r = spawnSync(process.execPath, [replay, '--selftest'], { encoding: 'utf8', timeout: 60_000 });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/(\d+)\/\1 passed/);
  });

  it('ranks by the order the template states, and reports the AC10 verdict on an export', () => {
    const template = fs.readFileSync(path.join(__dirname, '..', 'skill-templates', 'noesis-chief.md'), 'utf8');
    expect(template).toContain('not a Draft first, then marked up next (pinned), then priority, then the newest.');
    expect(fs.readFileSync(replay, 'utf8')).toContain('not a Draft first, then marked up next, then priority, then the newest');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pick-replay-'));
    const at = (d: number) => new Date(Date.UTC(2026, 10, d)).toISOString();
    const file = path.join(dir, 'export.json');
    fs.writeFileSync(file, JSON.stringify({
      exported_at: at(10),
      issues: [1, 2, 3].map((id) => ({ id, created_at: at(id), work_status: 'created', priority: null, pinned_at: null })),
      events: [{ id: 1, issue_id: 3, type: 'binding.set', created_at: at(5), payload: {} }],
    }));
    try {
      const r = spawnSync(process.execPath, [replay, '--export', file, '--json'], { encoding: 'utf8', timeout: 30_000 });
      expect(r.status, r.stderr).toBe(0);
      const out = JSON.parse(r.stdout);
      expect([out.picks, out.top1, out.top3, out.cases[0].key, out.cases[0].rank]).toEqual([1, 1, 1, 'TCK-3', 1]);
      // The oldest of five waiting tickets is picked: rank 5, so the top-3 rate is 0 and the exit is 1.
      fs.writeFileSync(file, JSON.stringify({
        exported_at: at(10),
        issues: [1, 2, 3, 4, 5].map((id) => ({ id, created_at: at(id), work_status: 'created', priority: null, pinned_at: null })),
        events: [{ id: 1, issue_id: 1, type: 'binding.set', created_at: at(6), payload: {} }],
      }));
      const unmet = spawnSync(process.execPath, [replay, '--export', file], { encoding: 'utf8', timeout: 30_000 });
      expect(unmet.status).toBe(1);
      expect(unmet.stdout).toContain('AC10 needs the top-3 rate at 50% or more: NOT met.');
      expect(unmet.stdout).toContain('TCK-1  rank 5 of 5');
      // Exactly half in the top 3 meets AC10 ("at least half"): exit 0.
      fs.writeFileSync(file, JSON.stringify({
        exported_at: at(10),
        issues: [1, 2, 3, 4, 5, 6].map((id) => ({ id, created_at: at(id), work_status: 'created', priority: null, pinned_at: null })),
        events: [{ id: 1, issue_id: 6, type: 'binding.set', created_at: at(7), payload: {} }, { id: 2, issue_id: 1, type: 'binding.set', created_at: at(8), payload: {} }],
      }));
      const half = spawnSync(process.execPath, [replay, '--export', file], { encoding: 'utf8', timeout: 30_000 });
      expect(half.stdout).toContain('top-3 1/2 (50%)');
      expect(half.status).toBe(0);
      // Each flag reaches the replay: the two binds of this export (days 7 and 8) change with each one.
      const picks = (...flags: string[]) => JSON.parse(spawnSync(process.execPath, [replay, '--export', file, '--json', ...flags], { encoding: 'utf8', timeout: 30_000 }).stdout).picks;
      expect(picks()).toBe(2);
      expect(picks('--days', '2')).toBe(1); // only day 8 is within 2 days of day 10
      expect(picks('--now', at(7) + '')).toBe(1); // day 8 is after now
      expect(picks('--burst-seconds', '100000')).toBe(0); // the two binds, 1 day apart, are a batch
      expect(picks('--min-wait-minutes', String(2 * 24 * 60))).toBe(1); // TCK-6 (created day 6, bound day 7) waited 1 day
      const missing = spawnSync(process.execPath, [replay], { encoding: 'utf8', timeout: 30_000 });
      expect(missing.status).toBe(2);
      expect(missing.stderr).toContain('--export <export.json> is required');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
