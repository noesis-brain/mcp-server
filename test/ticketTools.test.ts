/**
 * Jot ticket tools (2.5.0): the computer name, the request each tool sends, the error text
 * a Claude Code session sees, and what `noesis-mcp setup` installs.
 *
 * The server decides every rule (who may bind, which status, the word bounds). What these
 * tools must get right is WHO is calling — this session's id, this computer's name, this
 * folder — and that a refusal keeps its error_code, so the model can tell BOUND_ELSEWHERE
 * from SESSION_BUSY from REFINE_LENGTH.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { computeMachineLabel } from '../src/machineLabel.js';

const SESSION = '3f0c1d2e-4a5b-4c6d-8e7f-a1b2c3d4e5f6';

describe('computeMachineLabel', () => {
  const never = () => {
    throw new Error('should not run');
  };

  it('prefers NOESIS_AGENT_LABEL (the agent daemon override)', () => {
    expect(computeMachineLabel({ env: { NOESIS_AGENT_LABEL: '  Studio Mac  ' }, platform: 'darwin', execFile: never })).toBe('Studio Mac');
  });

  it('on macOS uses scutil ComputerName, not the network hostname', () => {
    const calls: string[][] = [];
    const label = computeMachineLabel({
      env: {},
      platform: 'darwin',
      hostname: () => 'Mac.hitronhub.home',
      execFile: (f, a) => {
        calls.push([f, ...a]);
        return "Chandler's MacBook Pro\n";
      },
    });
    expect(label).toBe("Chandler's MacBook Pro");
    expect(calls).toEqual([['scutil', '--get', 'ComputerName']]);
  });

  it('falls back to the hostname when scutil fails or is empty', () => {
    expect(computeMachineLabel({ env: {}, platform: 'darwin', hostname: () => 'Mac.local', execFile: never })).toBe('Mac.local');
    expect(computeMachineLabel({ env: {}, platform: 'darwin', hostname: () => 'Mac.local', execFile: () => '  ' })).toBe('Mac.local');
  });

  it('uses the hostname on Windows and Linux (scutil is never tried)', () => {
    expect(computeMachineLabel({ env: {}, platform: 'win32', hostname: () => 'DESKTOP-ABC', execFile: never })).toBe('DESKTOP-ABC');
    expect(computeMachineLabel({ env: {}, platform: 'linux', hostname: () => 'box', execFile: never })).toBe('box');
  });

  it('caps the label at 200 characters', () => {
    expect(computeMachineLabel({ env: { NOESIS_AGENT_LABEL: 'x'.repeat(300) } })).toHaveLength(200);
  });
});

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

describe('ticket tools → client', () => {
  const handlers = new Map<string, Handler>();
  const schemas = new Map<string, Record<string, z.ZodTypeAny>>();
  const calls: Array<[string, ...unknown[]]> = [];
  const saved = { sid: process.env.CLAUDE_CODE_SESSION_ID, dir: process.env.CLAUDE_PROJECT_DIR, label: process.env.NOESIS_AGENT_LABEL };

  beforeAll(async () => {
    process.env.NOESIS_AGENT_LABEL = 'Test Machine';
    process.env.CLAUDE_PROJECT_DIR = '/work/proj';
    const { registerBacklogTools } = await import('../src/tools/backlog.js');
    const server = {
      tool: (name: string, _desc: string, schema: Record<string, z.ZodTypeAny>, handler: Handler) => {
        handlers.set(name, handler);
        schemas.set(name, schema);
      },
    };
    const record = (name: string) => async (...args: unknown[]) => {
      calls.push([name, ...args]);
      return { ok: true };
    };
    const client = new Proxy({}, { get: (_t, prop) => record(String(prop)) });
    registerBacklogTools(server as never, client as never);
  });
  afterEach(() => {
    calls.length = 0;
  });
  afterAll(() => {
    for (const [k, v] of [['CLAUDE_CODE_SESSION_ID', saved.sid], ['CLAUDE_PROJECT_DIR', saved.dir], ['NOESIS_AGENT_LABEL', saved.label]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const run = (name: string, args: Record<string, unknown>) => handlers.get(name)!(args);

  it('registers the four ticket tools', () => {
    for (const t of ['backlog_bind', 'backlog_set_status', 'backlog_unbind', 'backlog_refine']) expect(handlers.has(t)).toBe(true);
  });

  it('every ticket tool refuses to run without a Claude Code session id', async () => {
    delete process.env.CLAUDE_CODE_SESSION_ID;
    for (const [name, args] of [
      ['backlog_bind', { key: 'TCK-5' }],
      ['backlog_set_status', { key: 'TCK-5', status: 'implementing' }],
      ['backlog_unbind', { key: 'TCK-5' }],
      ['backlog_refine', { key: 'TCK-5', text: 'x' }],
    ] as const) {
      const res = await run(name, args);
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('CLAUDE_CODE_SESSION_ID');
    }
    expect(calls).toEqual([]);
  });

  it('bind sends this session, this computer and this folder — and only the options given', async () => {
    process.env.CLAUDE_CODE_SESSION_ID = SESSION.toUpperCase();
    await run('backlog_bind', { key: 'TCK-5' });
    await run('backlog_bind', { key: 'TCK-6', status: 'implementing', force: true, switch: true });
    expect(calls).toEqual([
      ['backlogBind', 'TCK-5', { session_id: SESSION, machine: 'Test Machine', cwd: '/work/proj' }],
      ['backlogBind', 'TCK-6', { session_id: SESSION, machine: 'Test Machine', cwd: '/work/proj', status: 'implementing', force: true, switch: true }],
    ]);
  });

  it('a fresh planning bind tells the session to refine before ExitPlanMode; later binds do not', async () => {
    const { bindNextHint, BIND_NEXT, BIND_NEXT_LATER } = await import('../src/tools/backlog.js');
    expect(BIND_NEXT).toMatch(/before ExitPlanMode/);
    expect(BIND_NEXT).toMatch(/backlog_refine/);
    expect(BIND_NEXT).toMatch(/70%–120%/);
    expect(bindNextHint({ issue: { work_status: 'planning', refined_text: null } })).toBe(BIND_NEXT);
    expect(bindNextHint({ issue: { work_status: 'implementing', refined_text: null } })).toBe(BIND_NEXT_LATER);
    expect(bindNextHint({ issue: { work_status: 'planning', refined_text: 'already refined' } })).toBe(BIND_NEXT_LATER);
    expect(bindNextHint({ issue: { work_status: 'planning', refined_text: '   ' } })).toBe(BIND_NEXT);
    expect(BIND_NEXT_LATER).not.toMatch(/ExitPlanMode/);
    // the tool passes the server response through and adds the hint
    process.env.CLAUDE_CODE_SESSION_ID = SESSION;
    const res = await run('backlog_bind', { key: 'TCK-7' });
    const body = JSON.parse(res.content[0].text);
    expect(body.ok).toBe(true);
    expect(body.next).toBe(BIND_NEXT_LATER); // the fake response has no issue → no refine step
  });

  it('set_status, unbind and refine carry the same caller', async () => {
    process.env.CLAUDE_CODE_SESSION_ID = SESSION;
    await run('backlog_set_status', { key: 'TCK-5', status: 'iterating' });
    await run('backlog_unbind', { key: 'TCK-5' });
    await run('backlog_unbind', { key: 'TCK-5', force: true });
    await run('backlog_refine', { key: 'TCK-5', text: 'short jot' });
    const who = { session_id: SESSION, machine: 'Test Machine', cwd: '/work/proj' };
    expect(calls).toEqual([
      ['backlogSetStatus', 'TCK-5', { ...who, status: 'iterating' }],
      ['backlogUnbind', 'TCK-5', who],
      ['backlogUnbind', 'TCK-5', { ...who, force: true }],
      ['backlogRefine', 'TCK-5', { ...who, text: 'short jot' }],
    ]);
  });

  it('Claude Code cannot even ask for created or dropped', () => {
    const status = z.object(schemas.get('backlog_set_status')!);
    expect(status.safeParse({ key: 'TCK-1', status: 'dropped' }).success).toBe(false);
    expect(status.safeParse({ key: 'TCK-1', status: 'created' }).success).toBe(false);
    expect(status.safeParse({ key: 'TCK-1', status: 'ready_to_merge' }).success).toBe(true);
    const bind = z.object(schemas.get('backlog_bind')!);
    expect(bind.safeParse({ key: 'TCK-1', status: 'dropped' }).success).toBe(false);
  });

  it('backlog_get lists by work status', async () => {
    await run('backlog_get', { status: 'implementing' });
    expect(calls).toEqual([['backlogList', { stage: undefined, status: 'implementing', q: undefined }]]);
  });
});

describe('a refusal keeps its error_code and details', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('BOUND_ELSEWHERE names the code and the other computer; the body reaches the server', async () => {
    const seen: Array<{ url: string; method?: string; body?: string }> = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), method: init?.method, body: init?.body as string });
      return new Response(
        JSON.stringify({ error: 'TCK-5 is bound to another Claude Code session on DESKTOP-ABC', error_code: 'BOUND_ELSEWHERE', details: { bound_machine: 'DESKTOP-ABC' } }),
        { status: 409, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;
    const { NoesisClient } = await import('../src/api/NoesisClient.js');
    const client = new NoesisClient('https://example.test/', 'noe_x');
    await expect(client.backlogUnbind('TCK-5', { session_id: SESSION })).rejects.toThrow(
      /bound to another Claude Code session on DESKTOP-ABC \[BOUND_ELSEWHERE\] \{"bound_machine":"DESKTOP-ABC"\}/,
    );
    expect(seen).toEqual([{ url: 'https://example.test/api/mcp/backlog/issues/TCK-5/binding', method: 'DELETE', body: JSON.stringify({ session_id: SESSION }) }]);
  });

  it.each([
    ['backlogBind', 'POST', '/binding', 'SESSION_BUSY', { held_keys: ['TCK-4'] }],
    ['backlogSetStatus', 'POST', '/status', 'NOT_BOUND', undefined],
    ['backlogRefine', 'PUT', '/refined', 'REFINE_LENGTH', { draft_words: 18, min: 12, max: 23, got: 2 }],
    ['backlogUnbind', 'DELETE', '/binding', 'BOUND_ELSEWHERE', { bound_machine: 'DESKTOP-ABC' }],
  ] as const)('%s (%s …%s) keeps [%s] and its details', async (method, verb, suffix, code, details) => {
    let seen = '';
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      seen = `${init?.method} ${String(url)}`;
      return new Response(JSON.stringify({ error: 'refused', error_code: code, ...(details ? { details } : {}) }), {
        status: code === 'REFINE_LENGTH' ? 400 : 409,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    const { NoesisClient } = await import('../src/api/NoesisClient.js');
    const c = new NoesisClient('https://example.test', 'noe_x') as unknown as Record<string, (k: string, b: unknown) => Promise<unknown>>;
    const err = await c[method]('TCK-5', {}).then(() => null, (e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain(`[${code}]`);
    if (details) expect((err as Error).message).toContain(JSON.stringify(details));
    expect(seen).toBe(`${verb} https://example.test/api/mcp/backlog/issues/TCK-5${suffix}`);
  });

  it('the four routes and methods', async () => {
    const seen: string[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      seen.push(`${init?.method} ${String(url)}`);
      return new Response('{"issue":{}}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const { NoesisClient } = await import('../src/api/NoesisClient.js');
    const c = new NoesisClient('https://example.test', 'noe_x');
    await c.backlogBind('TCK-1', {});
    await c.backlogUnbind('TCK-1', {});
    await c.backlogSetStatus('TCK-1', {});
    await c.backlogRefine('TCK-1', {});
    await c.backlogList({ status: 'shipped' });
    expect(seen).toEqual([
      'POST https://example.test/api/mcp/backlog/issues/TCK-1/binding',
      'DELETE https://example.test/api/mcp/backlog/issues/TCK-1/binding',
      'POST https://example.test/api/mcp/backlog/issues/TCK-1/status',
      'PUT https://example.test/api/mcp/backlog/issues/TCK-1/refined',
      'GET https://example.test/api/mcp/backlog/issues?status=shipped',
    ]);
  });
});

describe('noesis-mcp setup installs the ticket skill and the v2 conventions block', () => {
  let home: string;
  const savedHome = process.env.HOME;
  beforeAll(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'noesis-setup-'));
  });
  afterAll(() => {
    process.env.HOME = savedHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('writes commands/noesis-ticket.md and a v2 block with the tickets section', async () => {
    process.env.HOME = home;
    vi.resetModules();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { runSetup } = await import('../src/cli/setup.js');
      await runSetup([]);
    } finally {
      log.mockRestore();
    }
    const skill = fs.readFileSync(path.join(home, '.claude', 'commands', 'noesis-ticket.md'), 'utf8');
    expect(skill).toContain('link TCK-<n> [status] [--force]');
    expect(skill).toContain('70%–120%');
    const md = fs.readFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'utf8');
    expect(md).toContain('<!-- noesis-mcp-server:start v2 -->');
    expect(md).toContain('### Noesis tickets (Jot page, TCK-<n>)');
    expect(md).not.toMatch(/Claude Code/); // client-neutral: the block also feeds Copilot
  });
});
