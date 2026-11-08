/**
 * Chief of Staff tools (TCK-1890): the request each client method sends, how each tool shapes its
 * arguments, which session it names, and that no tool can answer an owner gate. The server decides
 * every rule; what these tools must get right is the request, and that a refusal keeps its error_code.
 * The scanner moved here from claude-config: its own selftest must pass from this package.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
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

  it('registers exactly these tools, and none that answers, reviews or changes the policy', () => {
    expect([...handlers.keys()].sort()).toEqual([
      'coord_allocate_mcp_version', 'coord_decide', 'coord_decision_get', 'coord_decisions', 'coord_lease', 'coord_leases', 'coord_policy',
    ]);
    for (const name of handlers.keys()) expect(name).not.toMatch(/answer|review|approve|set_policy|force/);
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
    await run('coord_decisions', { status: 'pending' });
    await run('coord_decision_get', { id: 7 });
    await run('coord_policy', {});
    await run('coord_leases', {});
    expect(calls).toEqual([
      ['coordAllocateMcpVersion', { npm_latest: '2.12.0', ticket: 'TCK-9', holder: SESSION }],
      ['coordDecisions', { status: 'pending' }],
      ['coordDecisionGet', 7],
      ['coordPolicy'],
      ['coordLeases'],
    ]);
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
    expect(coord).toEqual(['coord_allocate_mcp_version', 'coord_decide', 'coord_decision_get', 'coord_decisions', 'coord_lease', 'coord_leases', 'coord_policy']);
  });
});
