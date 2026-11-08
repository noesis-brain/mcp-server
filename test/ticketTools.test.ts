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
  /** What every fake client method answers; a test may swap in a real-shaped response. */
  let reply: unknown = { ok: true };
  const saved ={ sid: process.env.CLAUDE_CODE_SESSION_ID, dir: process.env.CLAUDE_PROJECT_DIR, label: process.env.NOESIS_AGENT_LABEL };

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
      return reply;
    };
    const client = new Proxy({}, { get: (_t, prop) => record(String(prop)) });
    registerBacklogTools(server as never, client as never);
  });
  afterEach(() => {
    calls.length = 0;
    reply = { ok: true };
  });
  afterAll(() => {
    for (const [k, v] of [['CLAUDE_CODE_SESSION_ID', saved.sid], ['CLAUDE_PROJECT_DIR', saved.dir], ['NOESIS_AGENT_LABEL', saved.label]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const run = (name: string, args: Record<string, unknown>) => handlers.get(name)!(args);

  it('registers the seven ticket tools', () => {
    for (const t of ['backlog_bind', 'backlog_set_status', 'backlog_ship', 'backlog_merge', 'backlog_unbind', 'backlog_refine', 'backlog_set_gut']) expect(handlers.has(t)).toBe(true);
  });

  it('every ticket tool refuses to run without a Claude Code session id', async () => {
    delete process.env.CLAUDE_CODE_SESSION_ID;
    for (const [name, args] of [
      ['backlog_bind', { key: 'TCK-5' }],
      ['backlog_set_status', { key: 'TCK-5', status: 'implementing' }],
      ['backlog_unbind', { key: 'TCK-5' }],
      ['backlog_refine', { key: 'TCK-5', text: 'x' }],
      ['backlog_ship', { key: 'TCK-5', commit: 'abc1234' }],
      ['backlog_merge', { key: 'TCK-5', into: 'TCK-6' }],
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

  it('a fresh planning bind tells the session to refine before ExitPlanMode; a later unrefined bind, to refine now', async () => {
    const { bindNextHint, BIND_NEXT, BIND_NEXT_LINK, BIND_NEXT_LATER } = await import('../src/tools/backlog.js');
    expect(BIND_NEXT).toMatch(/before ExitPlanMode/);
    for (const hint of [BIND_NEXT, BIND_NEXT_LINK]) {
      expect(hint).toMatch(/backlog_refine/);
      expect(hint).toMatch(/70%–120%/);
    }
    expect(BIND_NEXT_LINK).toMatch(/already has a plan, refine this ticket once now/);
    expect(bindNextHint({ issue: { work_status: 'planning', refined_text: null } })).toBe(BIND_NEXT);
    expect(bindNextHint({ issue: { work_status: 'planning', refined_text: '   ' } })).toBe(BIND_NEXT);
    expect(bindNextHint({ issue: { work_status: 'implementing', refined_text: null } })).toBe(BIND_NEXT_LINK);
    expect(bindNextHint({ issue: { work_status: 'ready_to_implement' } })).toBe(BIND_NEXT_LINK);
    expect(bindNextHint({ issue: { work_status: 'planning', refined_text: 'already refined' } })).toBe(BIND_NEXT_LATER);
    expect(bindNextHint({ issue: { work_status: 'implementing', refined_text: 'already refined' } })).toBe(BIND_NEXT_LATER);
    expect(bindNextHint({ ok: true })).toBe(BIND_NEXT_LATER);
    for (const hint of [BIND_NEXT_LINK, BIND_NEXT_LATER]) expect(hint).not.toMatch(/ExitPlanMode/);
  });

  it('a ticket whose draft the owner kept ("Mark refined") is not refined again, and its gut is still asked for (TCK-1890)', async () => {
    const { bindNextHint, BIND_NEXT, BIND_NEXT_LINK, BIND_NEXT_KEPT, BIND_NEXT_LATER } = await import('../src/tools/backlog.js');
    const at = '2026-11-09T04:00:00Z';
    expect(bindNextHint({ issue: { work_status: 'planning', refined_text: null, refined_at: at } })).toBe(BIND_NEXT_KEPT);
    expect(bindNextHint({ issue: { work_status: 'implementing', refined_text: '  ', refined_at: at } })).toBe(BIND_NEXT_KEPT);
    // A Claude Code refinement (text and time) stays the "already refined" case.
    expect(bindNextHint({ issue: { work_status: 'planning', refined_text: 'already refined', refined_at: at } })).toBe(BIND_NEXT_LATER);
    expect(BIND_NEXT_KEPT).toMatch(/kept their draft as the ticket text/);
    expect(BIND_NEXT_KEPT).toMatch(/do not refine it with backlog_refine/);
    // backlog_refine is named once, only to say "do not"; nothing about refining later.
    expect(BIND_NEXT_KEPT.match(/backlog_refine/g)).toHaveLength(1);
    expect(BIND_NEXT_KEPT).not.toMatch(/ExitPlanMode/);
    expect(BIND_NEXT_KEPT).not.toMatch(/refine (it|this ticket) once/);
    expect(BIND_NEXT_KEPT).toMatch(/Write the team lead gut with backlog_set_gut if the ticket has none/);
    expect(BIND_NEXT_KEPT).not.toMatch(/70%–120%/);
    // The server always sends refined_at; null means no keep, so the older hints still apply.
    expect(bindNextHint({ issue: { work_status: 'planning', refined_text: null, refined_at: null } })).toBe(BIND_NEXT);
    expect(bindNextHint({ issue: { work_status: 'implementing', refined_text: null, refined_at: null } })).toBe(BIND_NEXT_LINK);
    // Every hint keeps its exact text: a refine request in other words must not slip into the kept hint.
    expect(BIND_NEXT_KEPT).toBe(
      'Bound. The owner kept their draft as the ticket text ("Mark refined"), so do not refine it with backlog_refine. ' +
      'Write the team lead gut with backlog_set_gut if the ticket has none (kind plan: how it can be built, at most 40 words, plus a difficulty). ' +
      'Keep the status current with backlog_set_status as you work.',
    );
    expect(BIND_NEXT).toBe(
      'Bound. When your plan is ready — before ExitPlanMode — refine this ticket once with backlog_refine ' +
      "(70%–120% of the draft's words, in the draft's language, plain sentences, no sections or increments), " +
      'and write the team lead gut with backlog_set_gut (kind plan: how it can be built, at most 40 words, plus a difficulty). ' +
      'Then keep the status current with backlog_set_status as you work.',
    );
    expect(BIND_NEXT_LINK).toBe(
      'Bound. If this session already has a plan, refine this ticket once now with backlog_refine ' +
      "(70%–120% of the draft's words, in the draft's language, plain sentences, no sections or increments), " +
      'and write the team lead gut with backlog_set_gut if the ticket has none. ' +
      'Keep the status current with backlog_set_status as you work.',
    );
    expect(BIND_NEXT_LATER).toBe('Bound. Keep the status current with backlog_set_status as you work; refine the ticket again only if the plan changes or the user asks.');
  });

  it('the bind tool reads the hint from the ticket the server returns', async () => {
    const { BIND_NEXT, BIND_NEXT_LINK, BIND_NEXT_LATER, BIND_NEXT_KEPT } = await import('../src/tools/backlog.js');
    process.env.CLAUDE_CODE_SESSION_ID = SESSION;
    const bind = async (issue: Record<string, unknown> | undefined) => {
      reply = issue ? { issue, released: null } : { ok: true };
      return JSON.parse((await run('backlog_bind', { key: 'TCK-7' })).content[0].text);
    };
    const fresh = await bind({ key: 'TCK-7', work_status: 'planning', refined_text: null, refined_at: null });
    expect(fresh.issue.key).toBe('TCK-7'); // the server response passes through
    expect(fresh.next).toBe(BIND_NEXT);
    expect((await bind({ key: 'TCK-7', work_status: 'implementing', refined_text: null, refined_at: null })).next).toBe(BIND_NEXT_LINK);
    // The owner kept the draft ("Mark refined", TCK-1890): no refine step.
    expect((await bind({ key: 'TCK-7', work_status: 'planning', refined_text: null, refined_at: '2026-11-09T04:00:00Z' })).next).toBe(BIND_NEXT_KEPT);
    expect((await bind({ key: 'TCK-7', work_status: 'planning', refined_text: 'Tidy jot.' })).next).toBe(BIND_NEXT_LATER);
    expect((await bind(undefined)).next).toBe(BIND_NEXT_LATER);
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

  it('TCK-1845: backlog_get with a key loads the pictures; images:false returns the text only', async () => {
    reply = { issue: { key: 'TCK-5', origin_jot: 'see ![p](/api/note-images/tok-1)', title: 't' }, messages: [] };
    const plain = await run('backlog_get', { key: 'TCK-5', images: false });
    expect(calls.map((c) => c[0])).toEqual(['backlogGet']);
    expect(plain.content).toHaveLength(1);
    expect(plain.content[0].type).toBe('text');
    calls.length = 0;
    await run('backlog_get', { key: 'TCK-5' });
    expect(calls.map((c) => c[0])).toEqual(['backlogGet', 'fetchTicketPicture']);
    expect(calls[1][1]).toBe('/api/note-images/tok-1');
  });

  it('TCK-1866: backlog_set_components and backlog_link need no session and send the key and the values', async () => {
    delete process.env.CLAUDE_CODE_SESSION_ID;
    await run('backlog_set_components', { key: 'TCK-5', components: ['Live Voice', 'MCP'] });
    await run('backlog_link', { key: 'TCK-5', other: 'TCK-9' });
    await run('backlog_link', { key: 'TCK-5', other: 'TCK-9', unlink: true });
    // TCK-1890: which of the two goes first, or null to remove the order.
    await run('backlog_link', { key: 'TCK-5', other: 'TCK-9', first: 'TCK-9' });
    await run('backlog_link', { key: 'TCK-5', other: 'TCK-9', first: null });
    expect(calls).toEqual([
      ['backlogSetComponents', 'TCK-5', ['Live Voice', 'MCP']],
      ['backlogLink', 'TCK-5', 'TCK-9', undefined],
      ['backlogUnlink', 'TCK-5', 'TCK-9'],
      ['backlogLink', 'TCK-5', 'TCK-9', 'TCK-9'],
      ['backlogLink', 'TCK-5', 'TCK-9', null],
    ]);
    const linkSchema = z.object(schemas.get('backlog_link')!);
    for (const first of ['TCK-9', null, undefined]) expect(linkSchema.safeParse({ key: 'TCK-5', other: 'TCK-9', first }).success).toBe(true);
    expect(linkSchema.safeParse({ key: 'TCK-5', other: 'TCK-9', first: 9 }).success).toBe(false);
    const comps = z.object(schemas.get('backlog_set_components')!);
    expect(comps.safeParse({ key: 'TCK-5', components: Array.from({ length: 9 }, (_, i) => `P${i}`) }).success).toBe(false);
    expect(comps.safeParse({ key: 'TCK-5', components: ['x'.repeat(41)] }).success).toBe(false);
    expect(comps.safeParse({ key: 'TCK-5', components: ['x'.repeat(40)] }).success).toBe(true);
  });

  it('TCK-1845: backlog_set_gut sends the caller, the text, the kind and the difficulty', async () => {
    process.env.CLAUDE_CODE_SESSION_ID = SESSION;
    await run('backlog_set_gut', { key: 'TCK-5', text: 'Reuse the upload route', kind: 'plan', difficulty: 'XL' });
    await run('backlog_set_gut', { key: 'TCK-5', text: 'Reused it', kind: 'built' });
    const who = { session_id: SESSION, machine: 'Test Machine', cwd: '/work/proj' };
    expect(calls).toEqual([
      ['backlogSetGut', 'TCK-5', { ...who, text: 'Reuse the upload route', kind: 'plan', difficulty: 'XL' }],
      ['backlogSetGut', 'TCK-5', { ...who, text: 'Reused it', kind: 'built' }],
    ]);
    const gut = z.object(schemas.get('backlog_set_gut')!);
    expect(gut.safeParse({ key: 'TCK-5', text: 'x', kind: 'later' }).success).toBe(false);
    expect(gut.safeParse({ key: 'TCK-5', text: 'x', kind: 'plan', difficulty: 'XXL' }).success).toBe(false);
    delete process.env.CLAUDE_CODE_SESSION_ID;
    const res = await run('backlog_set_gut', { key: 'TCK-5', text: 'x', kind: 'plan' });
    expect(res.isError).toBe(true);
  });

  it('TCK-1845: backlog_refine sends a headline only when one is given; upsert accepts size XL', async () => {
    process.env.CLAUDE_CODE_SESSION_ID = SESSION;
    await run('backlog_refine', { key: 'TCK-5', text: 'short jot', headline: 'Paste pictures' });
    const who = { session_id: SESSION, machine: 'Test Machine', cwd: '/work/proj' };
    expect(calls).toEqual([['backlogRefine', 'TCK-5', { ...who, text: 'short jot', headline: 'Paste pictures' }]]);
    expect(z.object(schemas.get('backlog_upsert_issue')!).safeParse({ key: 'TCK-5', size: 'XL' }).success).toBe(true);
  });

  it('TCK-1845: the bind hints tell Claude to write the gut', async () => {
    const { BIND_NEXT, BIND_NEXT_LINK } = await import('../src/tools/backlog.js');
    expect(BIND_NEXT).toMatch(/backlog_set_gut/);
    expect(BIND_NEXT_LINK).toMatch(/backlog_set_gut/);
  });

  it('TCK-1838: backlog_ship sends the caller and the merge commit to /shipped', async () => {
    process.env.CLAUDE_CODE_SESSION_ID = SESSION;
    await run('backlog_ship', { key: 'TCK-1831', commit: 'f50a6ea2' });
    expect(calls).toEqual([['backlogShip', 'TCK-1831', { session_id: SESSION, machine: 'Test Machine', cwd: '/work/proj', commit: 'f50a6ea2' }]]);
    const ship = z.object(schemas.get('backlog_ship')!);
    expect(ship.safeParse({ key: 'TCK-1' }).success).toBe(false); // the commit is required
  });

  it('TCK-1889: backlog_merge sends the caller and the surviving ticket to /merge', async () => {
    process.env.CLAUDE_CODE_SESSION_ID = SESSION;
    await run('backlog_merge', { key: 'TCK-1885', into: 'TCK-1886' });
    expect(calls).toEqual([['backlogMerge', 'TCK-1885', { session_id: SESSION, machine: 'Test Machine', cwd: '/work/proj', into: 'TCK-1886' }]]);
    const merge = z.object(schemas.get('backlog_merge')!);
    expect(merge.safeParse({ key: 'TCK-1' }).success).toBe(false); // the target is required
  });

  it('TCK-1889: merged is set only by backlog_merge, and backlog_get can list it', () => {
    const status = z.object(schemas.get('backlog_set_status')!);
    expect(status.safeParse({ key: 'TCK-1', status: 'merged' }).success).toBe(false);
    const bind = z.object(schemas.get('backlog_bind')!);
    expect(bind.safeParse({ key: 'TCK-1', status: 'merged' }).success).toBe(false);
    const get = z.object(schemas.get('backlog_get')!);
    expect(get.safeParse({ status: 'merged' }).success).toBe(true);
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
    ['backlogShip', 'POST', '/shipped', 'NOT_READY', { work_status: 'implementing' }],
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
    await c.backlogShip('TCK-1', {});
    await c.backlogList({ status: 'shipped' });
    expect(seen).toEqual([
      'POST https://example.test/api/mcp/backlog/issues/TCK-1/binding',
      'DELETE https://example.test/api/mcp/backlog/issues/TCK-1/binding',
      'POST https://example.test/api/mcp/backlog/issues/TCK-1/status',
      'PUT https://example.test/api/mcp/backlog/issues/TCK-1/refined',
      'POST https://example.test/api/mcp/backlog/issues/TCK-1/shipped',
      'GET https://example.test/api/mcp/backlog/issues?status=shipped',
    ]);
  });

  it('TCK-1866: the components and links requests — method, path and body', async () => {
    const seen: Array<{ req: string; body: string | undefined }> = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ req: `${init?.method} ${String(url)}`, body: typeof init?.body === 'string' ? init.body : undefined });
      return new Response('{"links":[]}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const { NoesisClient } = await import('../src/api/NoesisClient.js');
    const c = new NoesisClient('https://example.test', 'noe_x');
    await c.backlogSetComponents('TCK-1', ['Live Voice', 'MCP']);
    await c.backlogLink('TCK-1', 'TCK-2');
    await c.backlogUnlink('TCK-1', 'TCK-2');
    await c.backlogLink('TCK-1', 'TCK-2', 'TCK-2');
    await c.backlogLink('TCK-1', 'TCK-2', null);
    expect(seen).toEqual([
      { req: 'PUT https://example.test/api/mcp/backlog/issues/TCK-1/components', body: JSON.stringify({ components: ['Live Voice', 'MCP'] }) },
      { req: 'POST https://example.test/api/mcp/backlog/issues/TCK-1/links', body: JSON.stringify({ key: 'TCK-2' }) },
      { req: 'DELETE https://example.test/api/mcp/backlog/issues/TCK-1/links/TCK-2', body: undefined },
      { req: 'POST https://example.test/api/mcp/backlog/issues/TCK-1/links', body: JSON.stringify({ key: 'TCK-2', first: 'TCK-2' }) },
      { req: 'POST https://example.test/api/mcp/backlog/issues/TCK-1/links', body: JSON.stringify({ key: 'TCK-2', first: null }) },
    ]);
  });
});

describe('noesis-mcp setup installs the ticket skill and the v3 conventions block', () => {
  let home: string;
  const savedHome = process.env.HOME;
  beforeAll(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'noesis-setup-'));
  });
  afterAll(() => {
    process.env.HOME = savedHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('writes commands/noesis-ticket.md and a v4 block with the tickets section and the bound-session procedure', async () => {
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
    expect(md).toContain('<!-- noesis-mcp-server:start v6 -->');
    expect(md).toContain('### Noesis tickets (Jot page, TCK-<n>)');
    expect(md).toContain('New work in a bound session');
    expect(md).toContain('TICKET_CLOSED');
    expect(skill).toContain('## New work in a bound session');
    expect(skill).toMatch(/1\. Set the current ticket to the status it really reached[\s\S]*2\. Create the new ticket[\s\S]*3\. A short session: `backlog_bind\(new key, switch: true\)`/);
    // TCK-1838: the checkpoint and the ship step are documented in both
    expect(skill).toContain('## When the hook asks which ticket');
    expect(skill).toMatch(/header is exactly `Ticket`/);
    expect(skill).toContain('### `ship` — the ship step');
    expect(skill).toContain('backlog_ship(key, commit)');
    // TCK-1889: merging marks the other ticket Merged, in both
    expect(skill).toContain('## Merging two tickets');
    expect(skill).toContain('backlog_merge(key, into)');
    expect(md).toContain('mcp__noesis__backlog_merge(key, into)');
    expect(md).toContain('mcp__noesis__backlog_ship');
    expect(md).toContain('~/.claude/noesis-ticket.json');
    expect(md).not.toMatch(/Claude Code/); // client-neutral: the block also feeds Copilot
  });
});
