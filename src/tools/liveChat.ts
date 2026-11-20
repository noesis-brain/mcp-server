/**
 * Live Chat review tools (TCK-1908): read the user's recorded Live conversations, find what went
 * wrong, and keep track of what was reviewed. The live-chat-review skill drives them:
 *   1. live_chat_list — unread first, each with its pages and notes and its problem signals;
 *   2. live_chat_get — one conversation's turns, in pages;
 *   3. live_chat_mark_read — after the review, with each conversation's `seen` mark, so turns saved
 *      while you read stay unread;
 *   4. live_chat_delete — only when the user asks; usage metering keeps the conversation's row;
 *   5. live_chat_recording — read or set the user's "Keep a record of my Live conversations" switch.
 * live_chat_speech (TCK-1949) downloads only the user's own words, joined into utterances, oldest
 * conversation first: the /cc-english-speech-note skill corrects their English from it.
 * Every rule is the server's (/api/mcp/live-voice): the tools format its answers.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LiveChatEntry, LiveChatTurn, LiveSpeechPage, LiveUtterance, NoesisClient } from '../api/NoesisClient.js';

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

const pad = (n: number) => String(n).padStart(2, '0');

/** This computer's time zone name, as the speech answer labels its times. */
export function localZoneName(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'this computer\'s time zone';
}

/** "2026-11-16 16:51" in this computer's time zone; the text as it came when it is not a time. */
export function localDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "16:51:13" in this computer's time zone. */
export function localClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * A `since` or `until` value as the server takes it. A day (YYYY-MM-DD) is a day in this computer's time
 * zone: since is its first moment, and until is the next day's first moment, so the whole day is included.
 * Any other text goes as it is, and the server checks it. Null for a day that does not exist.
 */
export function speechTimeArg(value: string, which: 'since' | 'until'): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return value;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // Checked at noon, so a clock change at midnight cannot move the day.
  const check = new Date(2000, 0, 1, 12);
  check.setFullYear(y, mo - 1, d);
  if (y < 1 || check.getFullYear() !== y || check.getMonth() !== mo - 1 || check.getDate() !== d) return null;
  // The first moment of the day (of the next day for until), built fresh: where midnight does not exist
  // because the clock jumps, JavaScript gives the first time that does.
  const start = new Date(2000, 0, 1);
  start.setFullYear(y, mo - 1, d + (which === 'until' ? 1 : 0));
  start.setHours(0, 0, 0, 0);
  return start.toISOString();
}

/** One thing the user said: "[13-16] 16:52:50 spoken: <text>", then Live's words before it, indented. */
export function utteranceLines(u: LiveUtterance): string[] {
  const seqs = u.seq_from === u.seq_to ? String(u.seq_from) : `${u.seq_from}-${u.seq_to}`;
  const lines = [`[${seqs}] ${localClock(u.at)} ${u.source}: ${u.text}`];
  if (u.live_before) lines.push(`    Live before: "${u.live_before}"`);
  return lines;
}

/**
 * The whole speech answer as text. `asked` is what the call asked for: with `id` the answer holds that one
 * conversation only, so it says how to go on to the ones after it instead of "No more conversations".
 */
export function speechText(page: LiveSpeechPage, asked: { id?: number; afterSeq?: number } = {}): string {
  const lines: string[] = [];
  const n = page.conversations.length;
  lines.push(`The user's words in ${n} recorded Live conversation(s), oldest first. Times are in ${localZoneName()}.`);
  if (page.in_progress_left_out > 0) lines.push(`${page.in_progress_left_out} conversation(s) still in progress were left out.`);
  for (const c of page.conversations) {
    const places = c.places.length ? c.places.map(placeText).join(' → ') : '(no page recorded)';
    const running = c.in_progress ? ' · still in progress: more words may come' : '';
    lines.push('', `#${c.id} · ${localDateTime(c.started_at)} · ${c.duration_seconds} s · ${c.utterances.length} utterance(s)${running}`, `  places: ${places}`);
    if (c.utterances.length === 0) {
      lines.push(asked.afterSeq !== undefined && asked.afterSeq >= 0 ? `  (nothing more after turn ${asked.afterSeq})` : '  (the user said nothing in this conversation)');
    }
    for (const u of c.utterances) lines.push(...utteranceLines(u));
  }
  lines.push('');
  const cut = page.next_in_conversation;
  if (cut) lines.push(`Conversation #${cut.id} was cut here to keep this answer small. Continue it: call live_chat_speech with id=${cut.id} and after_seq=${cut.after_seq}. Then go on with after=${cut.id}.`);
  const held = page.held_back_from;
  if (held !== null) {
    const again = page.next_after !== null ? ` with after=${page.next_after}` : '';
    lines.push(`Conversation #${held} is still in progress, so this answer stops before it. When it has ended, call live_chat_speech again${again} to get it and the ones after it.`);
  } else if (!cut && page.next_after !== null) lines.push(`More conversations: call live_chat_speech again with after=${page.next_after}.`);
  const only = asked.id !== undefined ? page.conversations[0]?.id ?? asked.id : undefined;
  if (!cut && only !== undefined) lines.push(`This answer holds only conversation #${only}. For the conversations after it, call live_chat_speech with after=${only}.`);
  else if (!cut && page.next_after === null && page.held_back_from === null) lines.push('No more conversations.');
  if (n > 0) lines.push(`Newest conversation in this answer: #${page.conversations[n - 1].id}.`);
  else if (held === null) lines.push('No recorded conversation matched. If you expected some, check live_chat_recording: when it is off, Live records nothing.');
  return lines.join('\n');
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

  server.tool(
    'live_chat_speech',
    "Download the user's own words from their recorded Live conversations, for example to correct their English: each conversation, oldest first, with what the user said (spoken, typed, or the question that woke Live), joined across pauses in speech, and Live's last words before each. No tool calls, pages or events, and no audio (Live never keeps it). It never marks a conversation read. Use `after` with the newest conversation id you already have, or `since`/`until` (a day YYYY-MM-DD in this computer's time zone, or an ISO 8601 time). Conversations still in progress are left out, and the answer stops before the first one. A long answer is cut: it says how to continue.",
    {
      after: z.number().int().min(0).max(2147483647).optional().describe('Only conversations after this id: the newest conversation you already have'),
      since: z.string().min(1).max(40).optional().describe('From this day (YYYY-MM-DD, this computer\'s time zone) or ISO 8601 time'),
      until: z.string().min(1).max(40).optional().describe('Up to this day (YYYY-MM-DD: the whole day is included) or before this ISO 8601 time'),
      id: z.number().int().min(1).max(2147483647).optional().describe('Only this conversation (not with after, since or until)'),
      after_seq: z.number().int().min(-1).max(1000000).optional().describe('With id: continue a cut conversation after this turn'),
      limit: z.number().int().min(1).max(50).optional().describe('Conversations per answer (default 10, at most 50)'),
    },
    async (args) => {
      const since = args.since === undefined ? undefined : speechTimeArg(args.since, 'since');
      const until = args.until === undefined ? undefined : speechTimeArg(args.until, 'until');
      if (since === null || until === null) {
        return { content: [{ type: 'text', text: `There is no such day: ${since === null ? args.since : args.until}. Use YYYY-MM-DD or an ISO 8601 time.` }], isError: true };
      }
      try {
        const page = await client.getLiveSpeech({ after: args.after, id: args.id, afterSeq: args.after_seq, since, until, limit: args.limit });
        return { content: [{ type: 'text', text: speechText(page, { id: args.id, afterSeq: args.after_seq }) }] };
      } catch (err) {
        return errorResult("Could not download the user's words", err);
      }
    },
  );
}
