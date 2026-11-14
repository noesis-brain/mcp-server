/**
 * Live Chat review tools (TCK-1908): exactly the five tools, each calling the right client method with
 * the right arguments, the list and the transcript showing what a review needs (the seen mark, the
 * signals, a cut-off reply, a tool error, the next page), a server refusal as an error result, and the
 * schemas refusing what the server would refuse anyway.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { z } from 'zod';

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

const ENTRY = {
  id: 377,
  started_at: '2026-11-14T15:22:21.000Z',
  ended_at: '2026-11-14T15:22:51.000Z',
  end_reason: 'stopped',
  duration_seconds: 30,
  turn_count: 3,
  unread: true,
  in_progress: false,
  reviewed_at: null,
  seen: '2026-11-14T15:22:51.507453Z',
  places: [{ page: 'Note', note_id: 560, title: 'Loop test note' }, { page: 'Jot' }, { page: 'Note', note_id: 9, title: null }],
  signals: { tool_errors: 2, empty_searches: 1, cut_off_replies: 1, no_answer: 0, reconnects: 0, slow_first_words: 0, error_end: true, tickets_added: 1 },
};

describe('live chat tools → client', () => {
  const handlers = new Map<string, Handler>();
  const schemas = new Map<string, Record<string, z.ZodTypeAny>>();
  const calls: Array<[string, ...unknown[]]> = [];
  let reply: unknown = {};
  let fail: Error | null = null;

  beforeAll(async () => {
    const { registerLiveChatTools } = await import('../src/tools/liveChat.js');
    const server = {
      tool: (name: string, _desc: string, schema: Record<string, z.ZodTypeAny>, handler: Handler) => {
        handlers.set(name, handler);
        schemas.set(name, schema);
      },
    };
    const client = new Proxy(
      {},
      {
        get: (_t, prop) => async (...args: unknown[]) => {
          calls.push([String(prop), ...args]);
          if (fail) throw fail;
          return reply;
        },
      },
    );
    registerLiveChatTools(server as never, client as never);
  });
  afterEach(() => {
    calls.length = 0;
    reply = {};
    fail = null;
  });

  const run = (name: string, args: Record<string, unknown>) => handlers.get(name)!(args);
  const valid = (name: string, args: Record<string, unknown>) => z.object(schemas.get(name)!).safeParse(args).success;

  it('registers exactly the five live_chat tools', () => {
    expect([...handlers.keys()].sort()).toEqual(['live_chat_delete', 'live_chat_get', 'live_chat_list', 'live_chat_mark_read', 'live_chat_recording']);
  });

  it('live_chat_list: unread_only, limit and offset reach the client; each entry shows its state, places, signals and seen mark', async () => {
    reply = { conversations: [ENTRY], total: 4, unread_total: 3 };
    const out = await run('live_chat_list', { unread_only: true, limit: 5, offset: 10 });
    expect(calls).toEqual([['listLiveChats', { limit: 5, offset: 10, unreadOnly: true }]]);
    const text = out.content[0].text;
    expect(text).toContain('4 recorded conversation(s), 3 unread');
    expect(text).toContain('#377');
    expect(text).toContain('UNREAD');
    expect(text).toContain('Note 560 "Loop test note" → Jot → Note 9 (title unavailable)');
    expect(text).toContain('2 tool errors, 1 searches that found nothing, 1 replies cut off, 1 tickets added, ended with an error');
    expect(text).toContain('seen: 2026-11-14T15:22:51.507453Z');
  });

  it('each entry shows its length and turn count, and read / in progress / ended states', async () => {
    reply = {
      conversations: [
        { ...ENTRY, id: 1, unread: false, in_progress: true, end_reason: null },
        { ...ENTRY, id: 2, unread: false, in_progress: false, end_reason: 'idle' },
        { ...ENTRY, id: 3, unread: true, in_progress: false, end_reason: null },
      ],
      total: 3,
      unread_total: 1,
    };
    const text = (await run('live_chat_list', {})).content[0].text;
    expect(text).toContain('- #1 · 2026-11-14T15:22:21.000Z · 30 s · 3 turns · read · in progress');
    expect(text).toContain('- #2 · 2026-11-14T15:22:21.000Z · 30 s · 3 turns · read · ended: idle');
    expect(text).toContain('- #3 · 2026-11-14T15:22:21.000Z · 30 s · 3 turns · UNREAD · no end');
  });

  it('live_chat_list with no signals says none', async () => {
    reply = { conversations: [{ ...ENTRY, signals: { ...ENTRY.signals, tool_errors: 0, empty_searches: 0, cut_off_replies: 0, tickets_added: 0, error_end: false } }], total: 1, unread_total: 1 };
    expect((await run('live_chat_list', {})).content[0].text).toContain('signals: none');
    expect(calls).toEqual([['listLiveChats', { limit: undefined, offset: undefined, unreadOnly: undefined }]]);
  });

  it('live_chat_get: id, after_seq and limit reach the client; the transcript shows each kind of turn and the next page', async () => {
    reply = {
      conversation: ENTRY,
      turns: [
        { seq: 0, at: '2026-11-14T15:22:21.100Z', kind: 'page', text: '', data: { page: 'Note', path: '/notes/560', noteId: 560 }, note_title: 'Loop test note' },
        { seq: 1, at: '2026-11-14T15:22:25.000Z', kind: 'user', text: 'Did you see the green sentence?', data: { source: 'spoken' } },
        { seq: 2, at: '2026-11-14T15:22:26.000Z', kind: 'live', text: 'I cannot see colours.', data: { firstWordsMs: 640, interrupted: true, heardSeconds: 1.2 } },
        { seq: 3, at: '2026-11-14T15:22:27.000Z', kind: 'tool', text: '', data: { name: 'scroll_note', status: 'error', error: 'No note open', args: { direction: 'down' } } },
        { seq: 4, at: '2026-11-14T15:22:28.000Z', kind: 'event', text: '', data: { type: 'reconnect', ms: 900 } },
        { seq: 5, at: '2026-11-14T15:22:29.000Z', kind: 'page', text: '', data: { page: 'Note' } },
        { seq: 6, at: '2026-11-14T15:22:30.000Z', kind: 'tool', text: '', data: { name: 'find_notes', status: 'ok', args: { request: 'green' }, result: { notes: 0 } } },
        { seq: 7, at: '2026-11-14T15:22:31.000Z', kind: 'page', text: '', data: { page: 'Note', path: '/notes/9', noteId: 9 }, note_title: null },
        { seq: 8, at: '2026-11-14T15:22:32.000Z', kind: 'page', text: '', data: { page: 'A note, open for editing or still loading', path: '/notes/560', noteId: null }, note_title: 'Loop test note' },
      ],
      next_after_seq: 5,
    };
    const out = await run('live_chat_get', { id: 377, after_seq: -1, limit: 6 });
    expect(calls).toEqual([['getLiveChat', 377, { afterSeq: -1, limit: 6 }]]);
    const text = out.content[0].text;
    expect(text).toContain('[0] 15:22:21 PAGE Note note 560 "Loop test note"');
    expect(text).toContain('[1] 15:22:25 USER (spoken): Did you see the green sentence?');
    expect(text).toContain('[2] 15:22:26 LIVE (first words 640 ms, CUT OFF after 1.2 s heard): I cannot see colours.');
    expect(text).toContain('[3] 15:22:27 TOOL scroll_note error — No note open args {"direction":"down"}');
    expect(text).toContain('[4] 15:22:28 EVENT reconnect {"ms":900}');
    expect(text).toContain('[5] 15:22:29 PAGE Note');
    expect(text).toContain('[6] 15:22:30 TOOL find_notes ok args {"request":"green"} → {"notes":0}');
    expect(text).toContain('[7] 15:22:31 PAGE Note note 9 (title unavailable)');
    expect(text).toContain('[8] 15:22:32 PAGE A note, open for editing or still loading note 560 "Loop test note"');
    expect(text).toContain('call live_chat_get again with after_seq=5');
  });

  it('live_chat_mark_read: read by default, with the seen marks; read false marks unread', async () => {
    reply = { updated: 2 };
    const items = [{ id: 377, seen: ENTRY.seen }, { id: 378 }];
    const out = await run('live_chat_mark_read', { conversations: items });
    expect(calls).toEqual([['markLiveChats', true, items]]);
    expect(out.content[0].text).toBe('Marked 2 conversation(s) read.');
    calls.length = 0;
    reply = { updated: 1 };
    expect((await run('live_chat_mark_read', { conversations: [{ id: 377 }], read: false })).content[0].text).toBe('Marked 1 conversation(s) unread.');
    expect(calls).toEqual([['markLiveChats', false, [{ id: 377 }]]]);
  });

  it('live_chat_delete calls deleteLiveChat with the id', async () => {
    reply = { deleted_turns: 3 };
    const out = await run('live_chat_delete', { id: 377 });
    expect(calls).toEqual([['deleteLiveChat', 377]]);
    expect(out.content[0].text).toContain('Deleted 3 turn(s) of conversation 377');
  });

  it('live_chat_recording reads without `on`, and sets with it', async () => {
    reply = { on: true };
    expect((await run('live_chat_recording', {})).content[0].text).toBe('Recording of Live conversations is on.');
    expect(calls).toEqual([['getLiveChatRecording']]);
    calls.length = 0;
    reply = { on: false };
    expect((await run('live_chat_recording', { on: false })).content[0].text).toBe('Recording of Live conversations is now off.');
    expect(calls).toEqual([['setLiveChatRecording', false]]);
    calls.length = 0;
    reply = { on: true };
    expect((await run('live_chat_recording', { on: true })).content[0].text).toBe('Recording of Live conversations is now on.');
    expect(calls).toEqual([['setLiveChatRecording', true]]);
  });

  it('a server refusal comes back as an error result with its message', async () => {
    fail = new Error('Conversation not found [NOT_FOUND]');
    for (const [name, args] of [
      ['live_chat_list', {}],
      ['live_chat_get', { id: 1 }],
      ['live_chat_mark_read', { conversations: [{ id: 1 }] }],
      ['live_chat_delete', { id: 1 }],
      ['live_chat_recording', { on: true }],
    ] as const) {
      const out = await run(name, args);
      expect(out.isError, name).toBe(true);
      expect(out.content[0].text, name).toContain('Conversation not found [NOT_FOUND]');
    }
  });

  it('the schemas refuse ids, limits and seen marks the server would refuse', () => {
    expect(valid('live_chat_get', { id: 377 })).toBe(true);
    for (const id of [0, -1, 2147483648, 1.5]) expect(valid('live_chat_get', { id }), String(id)).toBe(false);
    expect(valid('live_chat_get', { id: 1, limit: 501 })).toBe(false);
    expect(valid('live_chat_list', { limit: 51 })).toBe(false);
    expect(valid('live_chat_list', { offset: -1 })).toBe(false);
    expect(valid('live_chat_mark_read', { conversations: [] })).toBe(false);
    expect(valid('live_chat_mark_read', { conversations: Array.from({ length: 101 }, () => ({ id: 1 })) })).toBe(false);
    expect(valid('live_chat_mark_read', { conversations: [{ id: 1, seen: '2026-11-14T15:22:51Z' }] })).toBe(false);
    expect(valid('live_chat_mark_read', { conversations: [{ id: 1, seen: ENTRY.seen }] })).toBe(true);
    expect(valid('live_chat_delete', { id: 0 })).toBe(false);
    expect(valid('live_chat_delete', { id: 377 })).toBe(true);
    for (const args of [{}, { id: 1.5 }, { id: 2147483648 }, { id: -1 }]) expect(valid('live_chat_delete', args), JSON.stringify(args)).toBe(false);
    for (const id of [0, 2147483648, 1.5]) expect(valid('live_chat_mark_read', { conversations: [{ id }] }), String(id)).toBe(false);
    expect(valid('live_chat_mark_read', { conversations: [{ id: 1, seen: `${ENTRY.seen}x` }] })).toBe(false);
    expect(valid('live_chat_get', { id: 1, after_seq: -2 })).toBe(false);
    expect(valid('live_chat_get', { id: 1, after_seq: -1 })).toBe(true);
    expect(valid('live_chat_list', { offset: 10001 })).toBe(false);
    expect(valid('live_chat_list', { offset: 10000 })).toBe(true);
  });
});

describe('NoesisClient live chat methods → /api/mcp/live-voice', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('each method calls its route, with its query or body', async () => {
    const seen: Array<{ req: string; body: string | undefined }> = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ req: `${init?.method} ${String(url)}`, body: typeof init?.body === 'string' ? init.body : undefined });
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const { NoesisClient } = await import('../src/api/NoesisClient.js');
    const c = new NoesisClient('https://example.test', 'noe_x');
    await c.listLiveChats();
    await c.listLiveChats({ limit: 5, offset: 10, unreadOnly: true });
    await c.getLiveChat(377);
    await c.getLiveChat(377, { afterSeq: -1, limit: 50 });
    await c.getLiveChat(377, { afterSeq: 0 });
    await c.markLiveChats(true, [{ id: 377, seen: '2026-11-14T15:22:51.507453Z' }]);
    await c.markLiveChats(false, [{ id: 378 }]);
    await c.deleteLiveChat(377);
    await c.getLiveChatRecording();
    await c.setLiveChatRecording(false);
    await c.setLiveChatRecording(true);
    expect(seen).toEqual([
      { req: 'GET https://example.test/api/mcp/live-voice/conversations?unread=all', body: undefined },
      { req: 'GET https://example.test/api/mcp/live-voice/conversations?limit=5&offset=10&unread=only', body: undefined },
      { req: 'GET https://example.test/api/mcp/live-voice/conversations/377', body: undefined },
      { req: 'GET https://example.test/api/mcp/live-voice/conversations/377?after_seq=-1&limit=50', body: undefined },
      { req: 'GET https://example.test/api/mcp/live-voice/conversations/377?after_seq=0', body: undefined },
      { req: 'POST https://example.test/api/mcp/live-voice/conversations/read', body: JSON.stringify({ read: true, conversations: [{ id: 377, seen: '2026-11-14T15:22:51.507453Z' }] }) },
      { req: 'POST https://example.test/api/mcp/live-voice/conversations/read', body: JSON.stringify({ read: false, conversations: [{ id: 378 }] }) },
      { req: 'DELETE https://example.test/api/mcp/live-voice/conversations/377', body: undefined },
      { req: 'GET https://example.test/api/mcp/live-voice/recording', body: undefined },
      { req: 'PUT https://example.test/api/mcp/live-voice/recording', body: JSON.stringify({ on: false }) },
      { req: 'PUT https://example.test/api/mcp/live-voice/recording', body: JSON.stringify({ on: true }) },
    ]);
  });

  it("a refusal keeps the server's error code in the message", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'Conversation not found', error_code: 'NOT_FOUND' }), { status: 404, headers: { 'Content-Type': 'application/json' } }),
    ) as typeof fetch;
    const { NoesisClient } = await import('../src/api/NoesisClient.js');
    const c = new NoesisClient('https://example.test', 'noe_x');
    const calls: Array<[string, () => Promise<unknown>]> = [
      ['listLiveChats', () => c.listLiveChats()],
      ['getLiveChat', () => c.getLiveChat(1)],
      ['markLiveChats', () => c.markLiveChats(true, [{ id: 1 }])],
      ['deleteLiveChat', () => c.deleteLiveChat(1)],
      ['getLiveChatRecording', () => c.getLiveChatRecording()],
      ['setLiveChatRecording', () => c.setLiveChatRecording(true)],
    ];
    for (const [name, call] of calls) await expect(call(), name).rejects.toThrow('Conversation not found [NOT_FOUND]');
  });
});

describe('the package exposes the live chat tools', () => {
  it('registerTools adds each live_chat_* tool exactly once', async () => {
    const { registerTools } = await import('../src/tools/index.js');
    const names: string[] = [];
    const server = new Proxy({}, {
      get: (_t, prop) => (prop === 'tool' ? (name: string) => { names.push(name); } : () => undefined),
    });
    const client = new Proxy({}, { get: () => async () => ({}) });
    registerTools(server as never, { client } as never);
    expect(names.filter((n) => n.startsWith('live_chat_')).sort()).toEqual(['live_chat_delete', 'live_chat_get', 'live_chat_list', 'live_chat_mark_read', 'live_chat_recording']);
  });
});
