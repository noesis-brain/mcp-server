/**
 * Chief of Staff MCP tools (TCK-1890) — a Claude Code session's view of /api/mcp/coordination.
 * Thin wrappers, like the backlog tools: every rule (the level, the outcome, the owner gates,
 * the lease queue, the version allocation) is decided by the server. These tools shape the
 * request and return compact JSON text a session can parse.
 *
 * Owner gates have NO tool to answer them: answering a Decision Card, reviewing a judgment call
 * and changing the policy are the owner's, on the Jot page or in the owner's own session. The
 * server answers 409 OWNER_GATE to the API token anyway; leaving the tools out keeps a session
 * from even trying.
 */
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
      'Pass npm_latest from `npm view <package> version`. A ticket asking again keeps its version while it is above npm. Errors: NPM_UNKNOWN (npm_latest unreadable), NOT_FOUND (the ticket is not the user\'s).',
    {
      npm_latest: z.string().describe('The version npm reports now, like 2.12.0'),
      ticket: z.string().optional().describe('The ticket that changes the package, like TCK-7'),
    },
    async (args) => {
      try {
        const body: Record<string, unknown> = { npm_latest: args.npm_latest };
        if (args.ticket !== undefined) body.ticket = args.ticket;
        const sid = sessionId();
        if (sid) body.holder = sid;
        return jsonText(await client.coordAllocateMcpVersion(body));
      } catch (e) {
        return errText(e);
      }
    }
  );
}
