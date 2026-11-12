/**
 * Chief of Staff MCP tools (TCK-1890) — a Claude Code session's view of /api/mcp/coordination.
 * Thin wrappers, like the backlog tools: every rule (the level, the outcome, the owner gates,
 * the lease queue, the version allocation) is decided by the server. These tools shape the
 * request and return compact JSON text a session can parse.
 *
 * Owner gates have NO tool to answer them: answering a Decision Card, reviewing a judgment call
 * and changing the policy are the owner's, on the Jot page or in the owner's own session. The
 * server answers 409 OWNER_GATE to the API token anyway; leaving the tools out keeps a session
 * from even trying. Pausing and continuing sessions is the owner's too, so coord_message sends
 * only plain messages.
 *
 * Sessions report in (coord_heartbeat) and read their inbox (coord_inbox); the Chief reads the
 * sessions, sends messages, and posts the scanner's findings (coord_report).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NoesisClient } from '../api/NoesisClient.js';
import { currentSessionRef } from './claudeSessions.js';

const CATEGORY_ENUM = z.enum([
  'ship-order', 'rebase', 'scope', 'cleanup', 'pick', 'other',
  'ship', 'prod-schema', 'mcp-publish', 'merge-tickets', 'stop-session',
]);
const STATUS_ENUM = z.enum(['auto', 'review', 'pending', 'answered', 'reverted']);
const RESOURCE_ENUM = z.enum(['ship', 'test-db', 'mcp-publish', 'prod-schema']);
const SESSION_STATE_ENUM = z.enum(['running', 'idle', 'waiting', 'paused', 'gone']);
const SESSION_ID = z.string().regex(/^[A-Za-z0-9._:-]{1,100}$/);

/** The scanner ships in this package: dist/tools/coord.js and src/tools/coord.ts both sit two levels below the root. */
export const COORD_SCANNER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'coord-scan.mjs');
const SCAN_FILE_MAX_BYTES = 5_000_000;

const RUBRIC = z.object({
  reversible: z.boolean().describe('true when the undo step restores the state before the decision (a two-way door)'),
  shared: z.boolean().describe('true when it touches shared files, main or another ticket, not only this ticket\'s worktree'),
  userVisible: z.boolean().describe('true when users see it, or it is costly to undo'),
  touches: z.array(z.enum(['production', 'npm', 'money', 'security'])).describe('what a one-way door touches; [] when none'),
  confidence: z.enum(['high', 'low']),
  evidence: z.enum(['measured', 'unmeasured']),
});

const CARD = z.object({
  question: z.string().describe('One question, at most 25 words'),
  recommended: z.enum(['A', 'B', 'C', 'D']),
  reason: z.string().describe('Why the recommended option, 3 to 25 words'),
  options: z.array(z.object({ label: z.string(), ifChosen: z.string(), undo: z.string() })).min(2).max(4),
  blocks: z.array(z.object({ key: z.string(), waitingMin: z.number().int().nullable().optional() })).optional(),
  whyNotDecided: z.string().describe('The rule that makes this the owner\'s decision'),
  words: z.array(z.object({ term: z.string(), meaning: z.string() })).optional(),
  proof: z.array(z.string()).min(1).max(10).describe('URLs, ticket keys, commits or file paths'),
});

function jsonText(data: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function errText(e: unknown): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  const msg = e instanceof Error ? e.message : String(e);
  return { content: [{ type: 'text' as const, text: `Coordination tool failed: ${msg}` }], isError: true };
}

/** This session's id, when there is one: decisions and leases name the session that made or holds them. */
function sessionId(): string | null {
  return currentSessionRef()?.ref.id ?? null;
}

const NO_SESSION = 'No session: run inside a Claude Code session (CLAUDE_CODE_SESSION_ID).';

/** The characters the server refuses in any text it stores (control, format, invisible, line and paragraph separators). */
const UNSAFE_TEXT_RE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;

/** A field the server checks is sent only when it passes: a longer or unsafe folder name is left out rather than
 *  cut, so one odd folder never costs the whole heartbeat. */
const fits = (v: string | undefined, max: number): v is string =>
  typeof v === 'string' && v.length > 0 && Array.from(v).length <= max && !UNSAFE_TEXT_RE.test(v);

/** The `conflicts` of a `coord-scan --json` output file. */
function readScanConflicts(file: string): unknown[] {
  const full = path.resolve(file);
  const st = fs.statSync(full);
  // A pipe or a device reports size 0 and could be read without end: only a regular file is read.
  if (!st.isFile()) throw new Error(`${full} is not a regular file`);
  if (st.size > SCAN_FILE_MAX_BYTES) throw new Error(`${full} is larger than ${SCAN_FILE_MAX_BYTES} bytes`);
  const scan = JSON.parse(fs.readFileSync(full, 'utf8')) as { conflicts?: unknown };
  if (!Array.isArray(scan.conflicts)) throw new Error(`${full} has no conflicts list: is it the output of coord-scan --json?`);
  return scan.conflicts;
}

export function registerCoordTools(server: McpServer, client: NoesisClient): void {
  server.tool(
    'coord_decide',
    'Record a judgment call or an owner-gate decision with the Chief of Staff. Answer the rubric honestly; the server computes the risk level (L0-L3) and the outcome from the owner\'s policy, never from you. ' +
      'The answer\'s `result` says what to do next: proceed (decided, go on), review (go on; the owner reviews it later), or escalated (wait: the owner must answer the card; poll coord_decision_get). ' +
      'A decision that waits needs a Decision Card (card), and owner gates (ship, prod-schema, mcp-publish, merge-tickets, stop-session) always wait. ' +
      'Errors: CARD_REQUIRED (send again with a card; details give the level), INVALID_CARD (details list each field), INVALID_RUBRIC, VALIDATION, NOT_FOUND (the ticket is not the user\'s).',
    {
      category: CATEGORY_ENUM,
      rubric: RUBRIC,
      choice: z.string().describe('What was chosen or proposed, one line'),
      reason: z.string().optional(),
      alternatives: z.array(z.string()).max(4).optional(),
      evidence: z.array(z.string()).max(10).optional().describe('URLs, ticket keys, commits or file paths'),
      undo: z.string().optional().describe('How to undo it, one line'),
      ticket: z.string().optional().describe('The ticket the decision is about, like TCK-7'),
      as_chief: z.boolean().optional().describe('true when the Chief of Staff (not a ticket session) records it'),
      card: CARD.optional(),
    },
    async (args) => {
      try {
        const body: Record<string, unknown> = { category: args.category, rubric: args.rubric, choice: args.choice, actor: args.as_chief ? 'chief' : 'session' };
        for (const k of ['reason', 'alternatives', 'evidence', 'undo', 'ticket', 'card'] as const) if (args[k] !== undefined) body[k] = args[k];
        const sid = sessionId();
        if (sid) body.session_id = sid;
        return jsonText(await client.coordDecide(body));
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.tool(
    'coord_decision_get',
    'Read one decision: its status (auto, review, pending, answered, reverted), the level, the card text and, once the owner has answered, the chosen option letter. Read only: answering is the owner\'s. Errors: NOT_FOUND.',
    { id: z.number().int().positive() },
    async (args) => {
      try {
        return jsonText(await client.coordDecisionGet(args.id));
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.tool(
    'coord_decisions',
    'List the user\'s decisions, newest first, with the count per status. Filter by status (pending = cards waiting for the owner), category or ticket.',
    {
      status: STATUS_ENUM.optional(),
      category: CATEGORY_ENUM.optional(),
      ticket: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    async (args) => {
      try {
        return jsonText(await client.coordDecisions(args));
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.tool(
    'coord_policy',
    'Read the owner\'s policy per category: the mode (off, observe, auto), the maximum and minimum level, the written rules the owner added, and how often the owner agreed with past calls. Read only.',
    {},
    async () => {
      try {
        return jsonText(await client.coordPolicy());
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.tool(
    'coord_lease',
    'Take, keep or give back a lease on a shared resource: ship (until the deployment is verified), test-db (one full backend suite at a time on the shared noesis_test database), mcp-publish, prod-schema. ' +
      'acquire answers granted, or the current holder and your place in the queue (1 = next); ask again to keep your place and to take the lease when your turn comes. ' +
      'heartbeat keeps a lease or a place alive within its time to live (default 300 s); release gives it back. The holder name defaults to this session\'s id. ' +
      'Errors: LEASE_LOST (your lease or place expired; acquire again), VALIDATION, NOT_FOUND (an unknown resource).',
    {
      resource: RESOURCE_ENUM,
      action: z.enum(['acquire', 'heartbeat', 'release']),
      holder: z.string().regex(/^[A-Za-z0-9._:-]{1,100}$/).optional().describe('Defaults to this session\'s id'),
      note: z.string().max(200).optional().describe('acquire only: what you hold it for'),
      ttl_seconds: z.number().int().min(30).max(86400).optional().describe('acquire only: the time to live, default 300'),
    },
    async (args) => {
      try {
        const holder = args.holder ?? sessionId();
        if (!holder) return errText(new Error('No holder: pass holder, or run inside a Claude Code session (CLAUDE_CODE_SESSION_ID).'));
        const body: Record<string, unknown> = { holder };
        if (args.action === 'acquire') {
          if (args.note !== undefined) body.note = args.note;
          if (args.ttl_seconds !== undefined) body.ttl_seconds = args.ttl_seconds;
        }
        return jsonText(await client.coordLease(args.resource, args.action, body));
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.tool(
    'coord_leases',
    'List every shared resource\'s holder and queue (expired entries are marked expired).',
    {},
    async () => {
      try {
        return jsonText(await client.coordLeases());
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.tool(
    'coord_allocate_mcp_version',
    'Get the MCP package version for a ticket that changes md-manager-mcp-server: the next minor above npm\'s latest and above every version already handed out, so two tickets never publish the same version. ' +
      'Pass npm_latest from `npm view <package> version`, and in_branches: the versions the branches and the main checkout already hold (the scanner sees them; the server cannot). A ticket asking again keeps its version while it is above npm. Errors: NPM_UNKNOWN (npm_latest unreadable), VALIDATION (an in_branches entry is not a version), NOT_FOUND (the ticket is not the user\'s).',
    {
      npm_latest: z.string().describe('The version npm reports now, like 2.12.0'),
      ticket: z.string().optional().describe('The ticket that changes the package, like TCK-7'),
      in_branches: z.array(z.string()).max(50).optional().describe('Versions the branches and the main checkout already hold, like ["2.14.0"]: the next version skips them'),
    },
    async (args) => {
      try {
        const body: Record<string, unknown> = { npm_latest: args.npm_latest };
        if (args.ticket !== undefined) body.ticket = args.ticket;
        if (args.in_branches !== undefined) body.in_branches = args.in_branches;
        const sid = sessionId();
        if (sid) body.holder = sid;
        return jsonText(await client.coordAllocateMcpVersion(body));
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.tool(
    'coord_heartbeat',
    'Report this session to the Chief of Staff: its state (running, idle, waiting, paused, gone), its ticket and a short note. The folder and the machine come from this session; nothing else is sent. ' +
      'Send it when the state changes and at least every 10 minutes while working (a session not seen for 10 minutes shows as stale). Errors: VALIDATION, NOT_FOUND (the ticket is not the user\'s).',
    {
      state: SESSION_STATE_ENUM,
      ticket: z.string().optional().describe('The ticket this session works on, like TCK-7'),
      note: z.string().max(200).optional().describe('One line: what it is doing or waiting for'),
    },
    async (args) => {
      try {
        const current = currentSessionRef();
        if (!current) return errText(new Error(NO_SESSION));
        const body: Record<string, unknown> = { session_id: current.ref.id, state: args.state };
        if (fits(current.ref.machine_name, 100)) body.machine = current.ref.machine_name;
        if (fits(current.ref.cwd, 500)) body.cwd = current.ref.cwd;
        if (args.ticket !== undefined) body.ticket = args.ticket;
        if (args.note !== undefined) body.note = args.note;
        return jsonText(await client.coordSessionHeartbeat(body));
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.tool(
    'coord_sessions',
    'List the sessions that reported in during the last week, the newest first, with their state, ticket, folder, machine, the seconds since they were seen and whether they are stale (not seen for 10 minutes).',
    {},
    async () => {
      try {
        return jsonText(await client.coordSessions());
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.tool(
    'coord_message',
    'Send a plain message to one session (to_session), or to every session when to_session is left out. It reaches the session through its inbox. ' +
      'Messages are coordination (rebase, run /mcp, wait for a lease), never new scope. Pausing and continuing sessions is the owner\'s, so this tool cannot do it. ' +
      'Errors: VALIDATION (an empty body, over 4000 characters, or invisible characters), NOT_FOUND (the ticket is not the user\'s).',
    {
      body: z.string().min(1).max(4000).describe('The message; several lines are allowed'),
      to_session: SESSION_ID.optional().describe('The session id; leave it out to send to every session'),
      ticket: z.string().optional().describe('The ticket the message is about, like TCK-7'),
      as_chief: z.boolean().optional().describe('true when the Chief of Staff sends it'),
    },
    async (args) => {
      try {
        const body: Record<string, unknown> = { body: args.body };
        for (const k of ['to_session', 'ticket', 'as_chief'] as const) if (args[k] !== undefined) body[k] = args[k];
        const sid = sessionId();
        if (sid) body.from_session = sid;
        return jsonText(await client.coordMessage(body));
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.tool(
    'coord_inbox',
    'Read this session\'s inbox: the messages after `since` (oldest first) sent to it or to every session in the last day, the `cursor` to pass as `since` next time, `more` when another page waits, and `pause`. ' +
      'When pause.paused is true, the owner asked every session (or this one) to stop at a safe point: finish the current step, save the state, then wait and read the inbox again until a continue arrives.',
    {
      since: z.number().int().min(0).max(2147483647).optional().describe('The cursor from the last read; 0 or left out reads the last day'),
      limit: z.number().int().min(1).max(100).optional(),
      session: SESSION_ID.optional().describe('Defaults to this session'),
    },
    async (args) => {
      try {
        const session = args.session ?? sessionId();
        if (!session) return errText(new Error(NO_SESSION));
        return jsonText(await client.coordInbox(session, { since: args.since, limit: args.limit }));
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.tool(
    'coord_report',
    'Post the scanner\'s findings as the whole picture of the conflicts now: each reported pair is opened or refreshed, each open pair it no longer reports is resolved. ' +
      `Run the scanner first, read-only: node ${COORD_SCANNER} --board <board.json> --json > <scan.json>, then pass scan_file. Or pass conflicts directly (at most 200). ` +
      'The answer counts open, new, still and resolved pairs. Errors: VALIDATION (a malformed conflict: kind C1-C20, severity low|medium|high, the evidence an object).',
    {
      scan_file: z.string().optional().describe('The absolute path of a coord-scan --json output (a relative path is read from the MCP server\'s folder)'),
      conflicts: z.array(z.record(z.string(), z.unknown())).max(200).optional(),
    },
    async (args) => {
      try {
        if ((args.scan_file === undefined) === (args.conflicts === undefined)) return errText(new Error('Pass exactly one of scan_file and conflicts.'));
        const conflicts = args.scan_file !== undefined ? readScanConflicts(args.scan_file) : args.conflicts!;
        return jsonText(await client.coordReport(conflicts));
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.tool(
    'coord_port',
    'Get this loop\'s dev ports before starting a backend or a frontend: a backend port, a frontend port and a host name under .localhost (tck-<n>.localhost for a ticket), never ones another loop holds. ' +
      'Start the backend with BACKEND_PORT=<backend_port>, Vite with --port <frontend_port> --strictPort, and open http://<host>:<frontend_port> (a host of its own keeps the browser cookies apart). ' +
      'Asking again keeps the same slot. action "release" gives it back when the loop is done. Errors: NO_ROOM (all 40 slots are taken; the owner frees one), NOT_FOUND (the ticket is not the user\'s).',
    {
      action: z.enum(['get', 'release']).optional().describe('Defaults to get'),
      ticket: z.string().optional().describe('The ticket the loop works on, like TCK-7: the slot is the ticket\'s'),
      holder: z.string().regex(/^[A-Za-z0-9._:-]{1,100}$/).optional().describe('Defaults to this session\'s id'),
    },
    async (args) => {
      try {
        const holder = args.holder ?? sessionId();
        if (!holder) return errText(new Error('No holder: pass holder, or run inside a Claude Code session (CLAUDE_CODE_SESSION_ID).'));
        const body: Record<string, unknown> = { holder };
        if (args.ticket !== undefined) body.ticket = args.ticket;
        return jsonText(await client.coordPort(args.action ?? 'get', body));
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.tool(
    'coord_conflicts',
    'List the open conflicts the scanner reported, the most severe first, with the pair, the kind (C1-C20), the detail, the evidence and when it was first and last seen. all=true adds those resolved in the last week.',
    { all: z.boolean().optional() },
    async (args) => {
      try {
        return jsonText(await client.coordConflicts(args.all === true));
      } catch (e) {
        return errText(e);
      }
    }
  );
}
