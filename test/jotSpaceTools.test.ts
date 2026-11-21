/**
 * Jot space tools (2.22.0, TCK-1950) → client calls. The fake server records each tool's handler; the fake client
 * records each method call, so a test checks exactly what reaches the Noesis API. Every rule (ownership, unique
 * names, the default space) is the server's; these tests pin the request shapes and the tools' own refusals.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import type { z } from 'zod';

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

describe('Jot space tools → client', () => {
  const handlers = new Map<string, Handler>();
  const schemas = new Map<string, Record<string, z.ZodTypeAny>>();
  const calls: Array<[string, ...unknown[]]> = [];

  beforeAll(async () => {
    const { registerBacklogTools } = await import('../src/tools/backlog.js');
    const server = {
      tool: (name: string, _desc: string, schema: Record<string, z.ZodTypeAny>, handler: Handler) => {
        handlers.set(name, handler);
        schemas.set(name, schema);
      },
    };
    const record = (name: string) => async (...args: unknown[]) => {
      calls.push([name, ...args]);
      // A number names a space by id: the tools look its name up in the space list first.
      if (name === 'backlogSpaces') return { spaces: [{ id: 7, name: '7' }, { id: 12, name: 'Seagull' }] };
      return { ok: true };
    };
    const client = new Proxy({}, { get: (_t, prop) => record(String(prop)) });
    registerBacklogTools(server as never, client as never);
  });
  afterEach(() => {
    calls.length = 0;
  });

  const run = (name: string, args: Record<string, unknown>) => handlers.get(name)!(args);

  it('registers the four space tools', () => {
    for (const t of ['backlog_spaces', 'backlog_upsert_space', 'backlog_delete_space', 'backlog_move_tickets']) {
      expect(handlers.has(t)).toBe(true);
    }
  });

  it('backlog_spaces lists the spaces', async () => {
    await run('backlog_spaces', {});
    expect(calls).toEqual([['backlogSpaces']]);
  });

  it('backlog_upsert_space creates with a name, or updates the named space with only the fields given', async () => {
    await run('backlog_upsert_space', { name: 'Seagull', description: 'Work tickets', color: '#E03E3E' });
    await run('backlog_upsert_space', { space: 'seagull', description: null });
    await run('backlog_upsert_space', { space: 12, name: 'Seagull work' });
    expect(calls).toEqual([
      ['backlogCreateSpace', { name: 'Seagull', description: 'Work tickets', color: '#E03E3E' }],
      ['backlogUpdateSpace', 'seagull', { description: null }],
      // The id 12 goes as its space's exact name.
      ['backlogSpaces'],
      ['backlogUpdateSpace', 'Seagull', { name: 'Seagull work' }],
    ]);
  });

  it('backlog_upsert_space refuses a create without a name and an update with nothing to change', async () => {
    const noName = await run('backlog_upsert_space', { description: 'x' });
    expect(noName.isError).toBe(true);
    const nothing = await run('backlog_upsert_space', { space: 'Seagull' });
    expect(nothing.isError).toBe(true);
    expect(calls).toEqual([]);
  });

  it('backlog_delete_space names the space', async () => {
    await run('backlog_delete_space', { space: 'Seagull' });
    await run('backlog_delete_space', { space: 12 });
    expect(calls).toEqual([['backlogDeleteSpace', 'Seagull'], ['backlogSpaces'], ['backlogDeleteSpace', 'Seagull']]);
  });

  it('a number is an id, never a name: the id 7 is not the space named "7", and an unknown id is refused', async () => {
    // The space list holds a space NAMED "7" with id 7, and the space with id 12 named "Seagull".
    await run('backlog_delete_space', { space: 12 });
    expect(calls.at(-1)).toEqual(['backlogDeleteSpace', 'Seagull']);
    calls.length = 0;
    const missing = await run('backlog_delete_space', { space: 99 });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain('SPACE_NOT_FOUND');
    expect(calls).toEqual([['backlogSpaces']]);
  });

  it('backlog_move_tickets moves keys or a whole space, never both and never neither', async () => {
    await run('backlog_move_tickets', { space: 'Seagull', keys: ['TCK-1', 'TCK-2'] });
    await run('backlog_move_tickets', { space: 'default', from_space: 'Seagull' });
    expect(calls).toEqual([
      ['backlogMoveTickets', { space: 'Seagull', keys: ['TCK-1', 'TCK-2'] }],
      ['backlogMoveTickets', { space: 'default', from_space: 'Seagull' }],
    ]);
    calls.length = 0;
    expect((await run('backlog_move_tickets', { space: 'Seagull' })).isError).toBe(true);
    expect((await run('backlog_move_tickets', { space: 'Seagull', keys: ['TCK-1'], from_space: 'Main' })).isError).toBe(true);
    expect(calls).toEqual([]);
  });

  it('backlog_get passes the space filter as text, and leaves it out when not given', async () => {
    await run('backlog_get', { space: 'Seagull' });
    await run('backlog_get', { space: 12, status: 'created', stage: 'jot', query: 'jira' });
    await run('backlog_get', {});
    expect(calls).toEqual([
      ['backlogList', { stage: undefined, status: undefined, q: undefined, space: 'Seagull' }],
      ['backlogSpaces'],
      ['backlogList', { stage: 'jot', status: 'created', q: 'jira', space: 'Seagull' }],
      ['backlogList', { stage: undefined, status: undefined, q: undefined, space: undefined }],
    ]);
  });

  it('an id stays a JSON number in the move and create bodies (the server reads a number as an id)', async () => {
    await run('backlog_move_tickets', { space: 12, keys: ['TCK-1'] });
    await run('backlog_move_tickets', { space: 'default', from_space: 12 });
    await run('backlog_upsert_issue', { title: 'into 12', space: 12 });
    expect(calls).toEqual([
      ['backlogMoveTickets', { space: 12, keys: ['TCK-1'] }],
      ['backlogMoveTickets', { space: 'default', from_space: 12 }],
      ['backlogCreate', { title: 'into 12', space: 12 }],
    ]);
  });

  it('backlog_upsert_issue sends the space on create and refuses it on update', async () => {
    await run('backlog_upsert_issue', { title: 'A Seagull ticket', space: 'Seagull' });
    expect(calls).toEqual([['backlogCreate', { title: 'A Seagull ticket', space: 'Seagull' }]]);
    calls.length = 0;
    const res = await run('backlog_upsert_issue', { key: 'TCK-5', space: 'Seagull' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('backlog_move_tickets');
    expect(calls).toEqual([]);
  });

  it('a space is an id, a name or "default", in the schema of every tool that takes one', () => {
    for (const [tool, field] of [
      ['backlog_get', 'space'], ['backlog_upsert_issue', 'space'], ['backlog_upsert_space', 'space'],
      ['backlog_delete_space', 'space'], ['backlog_move_tickets', 'space'], ['backlog_move_tickets', 'from_space'],
    ] as const) {
      const schema = schemas.get(tool)![field];
      expect(schema.safeParse('Seagull').success).toBe(true);
      expect(schema.safeParse(7).success).toBe(true);
      expect(schema.safeParse('x'.repeat(60)).success).toBe(true);
      for (const bad of ['', 'x'.repeat(61), -1, 0, 1.5]) expect(schema.safeParse(bad).success, `${tool} ${JSON.stringify(bad)}`).toBe(false);
    }
  });
});

describe('Jot space requests from the real client (2.22.0)', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('each space call: method, path (a name is encoded) and body', async () => {
    const seen: Array<{ req: string; body: string | undefined }> = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ req: `${init?.method} ${String(url)}`, body: typeof init?.body === 'string' ? init.body : undefined });
      return new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const { NoesisClient } = await import('../src/api/NoesisClient.js');
    const c = new NoesisClient('https://example.test', 'noe_x');
    await c.backlogList({ space: 'A/B c?', status: 'created' });
    await c.backlogList({ status: 'created' });
    await c.backlogSpaces();
    await c.backlogCreateSpace({ name: 'Seagull', description: 'Work' });
    await c.backlogUpdateSpace('A/B c?', { description: null });
    await c.backlogDeleteSpace('A/B c?');
    await c.backlogMoveTickets({ space: 'default', keys: ['TCK-1'] });
    expect(seen).toEqual([
      { req: 'GET https://example.test/api/mcp/backlog/issues?status=created&space=A%2FB+c%3F', body: undefined },
      { req: 'GET https://example.test/api/mcp/backlog/issues?status=created', body: undefined },
      { req: 'GET https://example.test/api/mcp/backlog/spaces', body: undefined },
      { req: 'POST https://example.test/api/mcp/backlog/spaces', body: JSON.stringify({ name: 'Seagull', description: 'Work' }) },
      { req: 'PATCH https://example.test/api/mcp/backlog/spaces/A%2FB%20c%3F', body: JSON.stringify({ description: null }) },
      { req: 'DELETE https://example.test/api/mcp/backlog/spaces/A%2FB%20c%3F', body: undefined },
      { req: 'POST https://example.test/api/mcp/backlog/move', body: JSON.stringify({ space: 'default', keys: ['TCK-1'] }) },
    ]);
  });

  it('a refusal keeps its error code on every space call', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'refused', error_code: 'SPACE_NAME_TAKEN' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;
    const { NoesisClient } = await import('../src/api/NoesisClient.js');
    const c = new NoesisClient('https://example.test', 'noe_x');
    for (const call of [
      () => c.backlogSpaces(),
      () => c.backlogCreateSpace({ name: 'x' }),
      () => c.backlogUpdateSpace('x', { name: 'y' }),
      () => c.backlogDeleteSpace('x'),
      () => c.backlogMoveTickets({ space: 'x', keys: ['TCK-1'] }),
    ]) {
      await expect(call()).rejects.toThrow('[SPACE_NAME_TAKEN]');
    }
  });
});

describe('the description limit matches the server (2.22.0)', () => {
  it('counts characters after the trim: 2000 emoji pass, 2001 characters do not', async () => {
    const { registerBacklogTools } = await import('../src/tools/backlog.js');
    const schemas = new Map<string, Record<string, z.ZodTypeAny>>();
    registerBacklogTools({ tool: (name: string, _d: string, schema: Record<string, z.ZodTypeAny>) => { schemas.set(name, schema); } } as never, {} as never);
    const description = schemas.get('backlog_upsert_space')!.description;
    expect(description.safeParse('😀'.repeat(2000)).success).toBe(true);
    expect(description.safeParse(`  ${'語'.repeat(2000)}  `).success).toBe(true);
    expect(description.safeParse('語'.repeat(2001)).success).toBe(false);
    expect(description.safeParse(null).success).toBe(true);
  });
});
