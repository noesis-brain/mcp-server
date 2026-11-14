/**
 * Live Chat review tools (TCK-1908): read the user's recorded Live conversations, find what went
 * wrong, and keep track of what was reviewed. The live-chat-review skill drives them:
 *   1. live_chat_list — unread first, each with its pages and notes and its problem signals;
 *   2. live_chat_get — one conversation's turns, in pages;
 *   3. live_chat_mark_read — after the review, with each conversation's `seen` mark, so turns saved
 *      while you read stay unread;
 *   4. live_chat_delete — only when the user asks; usage metering keeps the conversation's row;
 *   5. live_chat_recording — read or set the user's "Keep a record of my Live conversations" switch.
 * Every rule is the server's (/api/mcp/live-voice): the tools format its answers.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LiveChatEntry, LiveChatTurn, NoesisClient } from '../api/NoesisClient.js';

/** The `seen` mark the list and get return: the last save time, exact to the microsecond. */
const SEEN_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

const SIGNAL_NAMES: Array<[keyof LiveChatEntry['signals'], string]> = [
  ['tool_errors', 'tool errors'],
  ['empty_searches', 'searches that found nothing'],
  ['cut_off_replies', 'replies cut off'],
  ['no_answer', 'no answer'],
  ['reconnects', 'reconnects'],
  ['slow_first_words', 'slow first words'],
  ['tickets_added', 'tickets added'],
];

const errorResult = (what: string, err: unknown) => ({
  content: [{ type: 'text' as const, text: `${what}: ${(err as Error).message}` }],
  isError: true,
});

/** "Note 560 "Road map"", "Jot", "Note (locked)". */
function placeText(p: LiveChatEntry['places'][number]): string {
  if (p.note_id === undefined) return p.page || '(page)';
  return `${p.page} ${p.note_id}${p.title ? ` "${p.title}"` : ' (title unavailable)'}`;
}

/** The signals that are not zero, as words: "2 tool errors, error ending". Empty when none. */
export function signalText(s: LiveChatEntry['signals']): string {
  const parts = SIGNAL_NAMES.filter(([k]) => (s[k] as number) > 0).map(([k, name]) => `${s[k]} ${name}`);
  if (s.error_end) parts.push('ended with an error');
  return parts.join(', ');
}

/** One list line: id, start, length, turns, state, places, signals, seen mark. */
export function entryLine(c: LiveChatEntry): string {
  const state = [c.unread ? 'UNREAD' : 'read', c.in_progress ? 'in progress' : c.end_reason ? `ended: ${c.end_reason}` : 'no end'].join(' · ');
  const places = c.places.length ? c.places.map(placeText).join(' → ') : '(no page recorded)';
  const signals = signalText(c.signals);
  return [
    `- #${c.id} · ${c.started_at} · ${c.duration_seconds} s · ${c.turn_count} turns · ${state}`,
    `  places: ${places}`,
    `  signals: ${signals || 'none'}`,
    `  seen: ${c.seen ?? '(none)'}`,
  ].join('\n');
}

/** One transcript line. Tool turns show their name, status, arguments and result summary. */
export function turnLine(t: LiveChatTurn): string {
  const d = (t.data ?? {}) as Record<string, unknown>;
  const time = t.at.slice(11, 19);
  switch (t.kind) {
    case 'user':
      return `[${t.seq}] ${time} USER (${String(d.source ?? '?')}): ${t.text}`;
    case 'live': {
      const notes = [
        typeof d.firstWordsMs === 'number' ? `first words ${d.firstWordsMs} ms` : null,
        d.interrupted === true ? `CUT OFF after ${d.heardSeconds ?? '?'} s heard` : null,
      ].filter(Boolean);
      return `[${t.seq}] ${time} LIVE${notes.length ? ` (${notes.join(', ')})` : ''}: ${t.text}`;
    }
    case 'tool': {
      const err = d.status === 'error' && d.error ? ` — ${String(d.error)}` : '';
      const args = d.args ? ` args ${JSON.stringify(d.args)}` : '';
      const result = d.result ? ` → ${JSON.stringify(d.result)}` : '';
      return `[${t.seq}] ${time} TOOL ${String(d.name ?? '?')} ${String(d.status ?? '?')}${err}${args}${result}`;
    }
    case 'page': {
      const title = t.note_title === undefined ? '' : t.note_title ? ` "${t.note_title}"` : ' (title unavailable)';
      // A note still loading is recorded by its path only (noteId null): name its id from /notes/<id>.
      const fromPath = typeof d.path === 'string' ? /^\/notes\/(\d{1,10})(?:\/|$)/.exec(d.path)?.[1] : undefined;
      const noteId = typeof d.noteId === 'number' ? d.noteId : fromPath;
      const note = noteId !== undefined ? ` note ${noteId}` : '';
      return `[${t.seq}] ${time} PAGE ${String(d.page ?? '')}${note}${title}`;
    }
    case 'event': {
      const { type, ...rest } = d;
      return `[${t.seq}] ${time} EVENT ${String(type ?? '?')}${Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : ''}`;
    }
    default:
      return `[${t.seq}] ${time} ${t.kind.toUpperCase()}: ${t.text}`;
  }
}

export function registerLiveChatTools(server: McpServer, client: NoesisClient): void {
  server.tool(
    'live_chat_list',
    "List the user's recorded Live conversations (Live-Chat history), unread first, then newest. Each entry shows its start, length, turn count, whether it is unread or still in progress, the pages and notes visited, and problem signals (tool errors, searches that found nothing, replies cut off, no answer, reconnects, slow first words, an error ending, tickets added). Keep each entry's `seen` mark for live_chat_mark_read.",
    {
      unread_only: z.boolean().optional().describe('Only unread conversations (default false)'),
      limit: z.number().int().min(1).max(50).optional().describe('How many (default 20, at most 50)'),
      offset: z.number().int().min(0).max(10000).optional().describe('Skip this many, for the next page'),
    },
    async (args) => {
      try {
        const list = await client.listLiveChats({ limit: args.limit, offset: args.offset, unreadOnly: args.unread_only });
        const lines = [
          `${list.total} recorded conversation(s), ${list.unread_total} unread. Showing ${list.conversations.length}${args.offset ? ` from ${args.offset}` : ''}.`,
          ...list.conversations.map(entryLine),
        ];
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (err) {
        return errorResult('Could not list the Live conversations', err);
      }
    },
  );

  server.tool(
    'live_chat_get',
    "Read one recorded Live conversation: its summary and its turns in order — the user's words (spoken, typed or wake word), Live's words (with the time to first words, and replies the user cut off), each tool call with its arguments and result, page and note changes, and events (no answer, reconnects, renewals, half duplex). Long conversations come in pages: call again with after_seq.",
    {
      id: z.number().int().min(1).max(2147483647).describe('The conversation id from live_chat_list'),
      after_seq: z.number().int().min(-1).optional().describe('Start after this turn number (default: from the start)'),
      limit: z.number().int().min(1).max(500).optional().describe('Turns per page (default 200, at most 500)'),
    },
    async (args) => {
      try {
        const page = await client.getLiveChat(args.id, { afterSeq: args.after_seq, limit: args.limit });
        const lines = [entryLine(page.conversation), '', ...page.turns.map(turnLine)];
        if (page.next_after_seq !== null) lines.push('', `More turns: call live_chat_get again with after_seq=${page.next_after_seq}.`);
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (err) {
        return errorResult(`Could not read conversation ${args.id}`, err);
      }
    },
  );

  server.tool(
    'live_chat_mark_read',
    "Mark recorded Live conversations read (after reviewing them) or unread. Pass each conversation's `seen` mark from live_chat_list or live_chat_get: turns saved after you read it then keep it unread. All or nothing: an id that is not the user's conversation changes nothing.",
    {
      conversations: z
        .array(
          z.object({
            id: z.number().int().min(1).max(2147483647),
            seen: z.string().regex(SEEN_RE, 'the seen mark exactly as live_chat_list or live_chat_get returned it').optional(),
          }),
        )
        .min(1)
        .max(100),
      read: z.boolean().optional().describe('true = read (default), false = unread'),
    },
    async (args) => {
      try {
        const read = args.read ?? true;
        const { updated } = await client.markLiveChats(read, args.conversations);
        return { content: [{ type: 'text', text: `Marked ${updated} conversation(s) ${read ? 'read' : 'unread'}.` }] };
      } catch (err) {
        return errorResult('Nothing was marked', err);
      }
    },
  );

  server.tool(
    'live_chat_delete',
    "Delete one recorded Live conversation's turns (its words, tool calls and events). Only when the user asks for it. The conversation's row stays, so usage metering keeps working; it leaves the list. A conversation that is still running saves its new turns again afterwards.",
    { id: z.number().int().min(1).max(2147483647).describe('The conversation id from live_chat_list') },
    async (args) => {
      try {
        const { deleted_turns } = await client.deleteLiveChat(args.id);
        return { content: [{ type: 'text', text: `Deleted ${deleted_turns} turn(s) of conversation ${args.id}. Its usage row stays.` }] };
      } catch (err) {
        return errorResult(`Conversation ${args.id} was not deleted`, err);
      }
    },
  );

  server.tool(
    'live_chat_recording',
    "Read or set the user's \"Keep a record of my Live conversations\" switch (on by default). Without `on`, it only reads. Switched off, Live records nothing new (the audio is never recorded either way).",
    { on: z.boolean().optional().describe('true = record, false = stop recording; leave out to read') },
    async (args) => {
      try {
        const { on } = args.on === undefined ? await client.getLiveChatRecording() : await client.setLiveChatRecording(args.on);
        const verb = args.on === undefined ? 'is' : 'is now';
        return { content: [{ type: 'text', text: `Recording of Live conversations ${verb} ${on ? 'on' : 'off'}.` }] };
      } catch (err) {
        return errorResult('Could not read or set the recording switch', err);
      }
    },
  );
}
