/**
 * Live Chat review tools (TCK-1908): exactly the six tools, each calling the right client method with
 * the right arguments, the list and the transcript showing what a review needs (the seen mark, the
 * signals, a cut-off reply, a tool error, the next page), a server refusal as an error result, and the
 * schemas refusing what the server would refuse anyway. live_chat_speech (TCK-1949): the user's own
 * words, with local times, a local day turned into the server's time range, and how to go on.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
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

  it('registers exactly the six live_chat tools', () => {
    expect([...handlers.keys()].sort()).toEqual(['live_chat_delete', 'live_chat_get', 'live_chat_list', 'live_chat_mark_read', 'live_chat_recording', 'live_chat_speech']);
  });

  describe('live_chat_speech', () => {
    const realTz = process.env.TZ;
    beforeAll(() => {
      process.env.TZ = 'Asia/Taipei';
    });
    afterAll(() => {
      if (realTz === undefined) delete process.env.TZ;
      else process.env.TZ = realTz;
    });
    const conversationOf = (id: number, utterances: unknown[], extra: Record<string, unknown> = {}) => ({
      ...ENTRY,
      id,
      started_at: '2026-11-16T08:51:07.248Z',
      duration_seconds: 732,
      utterances,
      cut: false,
      ...extra,
    });
    const page = (extra: Record<string, unknown> = {}) => ({ conversations: [], next_after: null, next_in_conversation: null, in_progress_left_out: 0, held_back_from: null, ...extra });

    it('after, id, after_seq and limit reach the client; ISO times go as typed', async () => {
      reply = page();
      await run('live_chat_speech', { after: 421, limit: 5 });
      await run('live_chat_speech', { id: 421, after_seq: 16 });
      await run('live_chat_speech', { since: '2026-11-16T00:00:00+08:00', until: '2026-11-17T00:00Z' });
      expect(calls).toEqual([
        ['getLiveSpeech', { after: 421, id: undefined, afterSeq: undefined, since: undefined, until: undefined, limit: 5 }],
        ['getLiveSpeech', { after: undefined, id: 421, afterSeq: 16, since: undefined, until: undefined, limit: undefined }],
        ['getLiveSpeech', { after: undefined, id: undefined, afterSeq: undefined, since: '2026-11-16T00:00:00+08:00', until: '2026-11-17T00:00Z', limit: undefined }],
      ]);
    });

    it("a day is a day in this computer's time zone: since is its first moment, until takes in the whole day", async () => {
      reply = page();
      await run('live_chat_speech', { since: '2026-11-16', until: '2026-11-16' });
      await run('live_chat_speech', { until: '2026-12-31' });
      await run('live_chat_speech', { since: '2024-02-29' });
      expect(calls.map((c) => [(c[1] as { since?: string }).since, (c[1] as { until?: string }).until])).toEqual([
        ['2026-11-15T16:00:00.000Z', '2026-11-16T16:00:00.000Z'],
        [undefined, '2026-12-31T16:00:00.000Z'],
        ['2024-02-28T16:00:00.000Z', undefined],
      ]);
    });

    it('text that is not exactly YYYY-MM-DD goes to the server as typed', async () => {
      reply = page();
      for (const v of ['12026-11-16', '26-11-16', '2026-11-16x', 'x2026-11-16', '2026-1-16', 'yesterday']) await run('live_chat_speech', { since: v, until: v });
      expect(calls.map((c) => [(c[1] as { since?: string }).since, (c[1] as { until?: string }).until])).toEqual(
        ['12026-11-16', '26-11-16', '2026-11-16x', 'x2026-11-16', '2026-1-16', 'yesterday'].map((v) => [v, v]),
      );
    });

    it('a clock change at midnight does not move the day: until is the first moment of the next day', async () => {
      process.env.TZ = 'America/Santiago';
      try {
        reply = page();
        // In Chile the clock jumped from 00:00 to 01:00 on 2026-09-06.
        await run('live_chat_speech', { since: '2026-09-06', until: '2026-09-06' });
        await run('live_chat_speech', { since: '2026-09-07' });
        const [[, a], [, b]] = calls as Array<[string, { since?: string; until?: string }]>;
        expect(a.until).toBe(b.since);
        expect(new Date(a.since!).getHours()).toBe(1);
        expect(new Date(a.until!).getHours()).toBe(0);
      } finally {
        process.env.TZ = 'Asia/Taipei';
      }
    });

    it('a day that does not exist is refused before the server is asked', async () => {
      for (const args of [{ since: '2026-02-30' }, { until: '2026-13-01' }, { since: '2023-02-29' }, { until: '2026-11-00' }, { since: '0000-01-01' }]) {
        const out = await run('live_chat_speech', args);
        expect(out.isError, JSON.stringify(args)).toBe(true);
        expect(out.content[0].text).toContain('There is no such day');
        expect(out.content[0].text).toContain(String(Object.values(args)[0]));
      }
      expect(calls).toEqual([]);
    });

    it('the words with local times and the zone name, Live before each, and the places', async () => {
      reply = page({
        conversations: [
          conversationOf(421, [
            { seq_from: 1, seq_to: 1, at: '2026-11-16T08:51:13.000Z', source: 'spoken', text: 'Hi Emma, are you there?', live_before: null },
            { seq_from: 13, seq_to: 16, at: '2026-11-16T08:52:50.000Z', source: 'spoken', text: 'is an important understanding', live_before: 'Would you like me to open one?' },
            { seq_from: 20, seq_to: 20, at: '2026-11-16T08:59:01.000Z', source: 'typed', text: 'TCK-1946', live_before: '…you for the ticket.' },
          ]),
          conversationOf(422, [], { started_at: '2026-11-16T09:03:52.977Z', duration_seconds: 343, places: [] }),
        ],
      });
      const text = (await run('live_chat_speech', {})).content[0].text;
      expect(text).toContain("The user's words in 2 recorded Live conversation(s), oldest first. Times are in Asia/Taipei.");
      expect(text).toContain('#421 · 2026-11-16 16:51 · 732 s · 3 utterance(s)');
      expect(text).toContain('  places: Note 560 "Loop test note" → Jot → Note 9 (title unavailable)');
      expect(text).toContain('[1] 16:51:13 spoken: Hi Emma, are you there?');
      expect(text).toContain('[13-16] 16:52:50 spoken: is an important understanding\n    Live before: "Would you like me to open one?"');
      expect(text).toContain('[20] 16:59:01 typed: TCK-1946\n    Live before: "…you for the ticket."');
      expect(text).not.toMatch(/\[1\] 16:51:13 spoken: Hi Emma, are you there\?\n    Live before/);
      expect(text).toContain('#422 · 2026-11-16 17:03 · 343 s · 0 utterance(s)\n  places: (no page recorded)\n  (the user said nothing in this conversation)');
      expect(text).toContain('No more conversations.');
      expect(text).toContain('Newest conversation in this answer: #422.');
      expect(text).not.toContain('in progress');
      expect(text).not.toContain('No recorded conversation matched');
    });

    it('single-digit months, days, hours and minutes keep their leading zero', async () => {
      reply = page({
        conversations: [
          conversationOf(7, [{ seq_from: 2, seq_to: 2, at: '2026-03-04T23:05:06.000Z', source: 'wake', text: 'Hey Noesis', live_before: null }], {
            started_at: '2026-03-04T23:01:02.000Z',
          }),
        ],
      });
      const text = (await run('live_chat_speech', {})).content[0].text;
      expect(text).toContain('#7 · 2026-03-05 07:01 · 732 s · 1 utterance(s)');
      expect(text).toContain('[2] 07:05:06 wake: Hey Noesis');
    });

    it('with id: only that conversation, how to go on after it, and whether it is still in progress', async () => {
      const u = { seq_from: 7, seq_to: 9, at: '2026-11-16T08:55:00.000Z', source: 'spoken', text: 'the rest', live_before: null };
      reply = page({ conversations: [conversationOf(416, [u])] });
      let text = (await run('live_chat_speech', { id: 416, after_seq: 5 })).content[0].text;
      expect(text).toContain('This answer holds only conversation #416. For the conversations after it, call live_chat_speech with after=416.');
      expect(text).not.toContain('No more conversations.');

      reply = page({ conversations: [conversationOf(416, [])] });
      text = (await run('live_chat_speech', { id: 416, after_seq: 9 })).content[0].text;
      expect(text).toContain('(nothing more after turn 9)');
      expect(text).not.toContain('the user said nothing');
      // The boundary: after turn 0 is a continuation; after_seq -1 (from the start) is not.
      text = (await run('live_chat_speech', { id: 416, after_seq: 0 })).content[0].text;
      expect(text).toContain('(nothing more after turn 0)');
      text = (await run('live_chat_speech', { id: 416, after_seq: -1 })).content[0].text;
      expect(text).toContain('(the user said nothing in this conversation)');
      expect(text).not.toContain('nothing more after turn');

      reply = page({ conversations: [conversationOf(430, [u], { in_progress: true })] });
      text = (await run('live_chat_speech', { id: 430 })).content[0].text;
      expect(text).toContain('#430 · 2026-11-16 16:51 · 732 s · 1 utterance(s) · still in progress: more words may come');
      expect(text).toContain('This answer holds only conversation #430.');

      // Cut again while continuing: the cut line says how to go on, and nothing else does.
      reply = page({ conversations: [conversationOf(416, [u], { cut: true })], next_in_conversation: { id: 416, after_seq: 9 } });
      text = (await run('live_chat_speech', { id: 416, after_seq: 5 })).content[0].text;
      expect(text).toContain('call live_chat_speech with id=416 and after_seq=9. Then go on with after=416.');
      expect(text).not.toContain('This answer holds only');
      expect(text).not.toContain('No more conversations.');
    });

    it('how to go on: the next page, a cut conversation, a conversation still in progress', async () => {
      const u = { seq_from: 3, seq_to: 5, at: '2026-11-16T08:51:35.000Z', source: 'spoken', text: 'x', live_before: null };
      reply = page({ conversations: [conversationOf(415, [u])], next_after: 415 });
      let text = (await run('live_chat_speech', {})).content[0].text;
      expect(text).toContain('More conversations: call live_chat_speech again with after=415.');
      expect(text).not.toContain('No more conversations.');

      // Cut, with conversations after it (next_after set too): only the cut line says how to go on.
      reply = page({ conversations: [conversationOf(416, [u], { cut: true })], next_in_conversation: { id: 416, after_seq: 5 }, next_after: 416 });
      text = (await run('live_chat_speech', {})).content[0].text;
      expect(text).toContain('Conversation #416 was cut here to keep this answer small. Continue it: call live_chat_speech with id=416 and after_seq=5. Then go on with after=416.');
      expect(text).not.toContain('No more conversations.');
      expect(text).not.toContain('More conversations:');

      // The last conversation cut (nothing after it): the cut line, and no "No more conversations".
      reply = page({ conversations: [conversationOf(417, [u], { cut: true })], next_in_conversation: { id: 417, after_seq: 5 } });
      text = (await run('live_chat_speech', {})).content[0].text;
      expect(text).toContain('call live_chat_speech with id=417 and after_seq=5.');
      expect(text).not.toContain('No more conversations.');
      expect(text).not.toContain('More conversations:');

      // Held back, with next_after naming the conversation before it: wait, then go on from there.
      reply = page({ conversations: [conversationOf(418, [u])], in_progress_left_out: 2, held_back_from: 420, next_after: 418 });
      text = (await run('live_chat_speech', {})).content[0].text;
      expect(text).toContain('2 conversation(s) still in progress were left out.');
      expect(text).toContain('Conversation #420 is still in progress, so this answer stops before it. When it has ended, call live_chat_speech again with after=418 to get it and the ones after it.');
      expect(text).toContain('Newest conversation in this answer: #418.');
      expect(text).not.toContain('No more conversations.');
      expect(text).not.toContain('More conversations:');

      // Held back with nothing before it in the range, and an older server without next_after.
      reply = page({ in_progress_left_out: 1, held_back_from: 420, next_after: 419 });
      text = (await run('live_chat_speech', { after: 419 })).content[0].text;
      expect(text).toContain('When it has ended, call live_chat_speech again with after=419 to get it');
      expect(text).not.toContain('No recorded conversation matched');
      reply = page({ conversations: [conversationOf(418, [u])], in_progress_left_out: 1, held_back_from: 420 });
      text = (await run('live_chat_speech', {})).content[0].text;
      expect(text).toContain('When it has ended, call live_chat_speech again to get it and the ones after it.');
    });

    it('nothing matched: says so, and where to look', async () => {
      reply = page();
      const text = (await run('live_chat_speech', { after: 9999 })).content[0].text;
      expect(text).toContain("The user's words in 0 recorded Live conversation(s)");
      expect(text).toContain('No recorded conversation matched. If you expected some, check live_chat_recording');
      expect(text).not.toContain('Newest conversation');
    });

    it("a server refusal is an error result with the server's words", async () => {
      fail = new Error('since must be an ISO 8601 time with Z or an offset [VALIDATION]');
      const out = await run('live_chat_speech', { since: 'yesterday' });
      expect(out.isError).toBe(true);
      expect(out.content[0].text).toBe("Could not download the user's words: since must be an ISO 8601 time with Z or an offset [VALIDATION]");
    });

    it('the schema refuses what the server would refuse anyway', () => {
      expect(valid('live_chat_speech', {})).toBe(true);
      expect(valid('live_chat_speech', { after: 0, limit: 50, since: '2026-11-16', until: '2026-11-17T00:00:00.123456+08:00' })).toBe(true);
      expect(valid('live_chat_speech', { id: 2147483647, after_seq: -1 })).toBe(true);
      for (const args of [{ after: -1 }, { after: 2147483648 }, { after: 1.5 }, { id: 0 }, { limit: 0 }, { limit: 51 }, { after_seq: -2 }, { after_seq: 1000001 }, { since: '' }, { until: 'x'.repeat(41) }]) {
        expect(valid('live_chat_speech', args), JSON.stringify(args)).toBe(false);
      }
    });
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
    await c.getLiveSpeech();
    await c.getLiveSpeech({ after: 0, limit: 5 });
    await c.getLiveSpeech({ id: 421, afterSeq: -1 });
    await c.getLiveSpeech({ since: '2026-11-16T00:00:00+08:00', until: '2026-11-16T16:00:00.000Z' });
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
      { req: 'GET https://example.test/api/mcp/live-voice/speech', body: undefined },
      { req: 'GET https://example.test/api/mcp/live-voice/speech?after=0&limit=5', body: undefined },
      { req: 'GET https://example.test/api/mcp/live-voice/speech?id=421&after_seq=-1', body: undefined },
      { req: 'GET https://example.test/api/mcp/live-voice/speech?since=2026-11-16T00%3A00%3A00%2B08%3A00&until=2026-11-16T16%3A00%3A00.000Z', body: undefined },
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
      ['getLiveSpeech', () => c.getLiveSpeech({ id: 1 })],
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
    expect(names.filter((n) => n.startsWith('live_chat_')).sort()).toEqual(['live_chat_delete', 'live_chat_get', 'live_chat_list', 'live_chat_mark_read', 'live_chat_recording', 'live_chat_speech']);
  });
});
