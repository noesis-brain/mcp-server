/**
 * Backlog v2 MCP tools — the loop's view of /api/mcp/backlog. Thin wrappers:
 * every rule (stage legality, OWNER_GATE, freeze, park guards) is enforced
 * server-side; these tools shape requests and return compact JSON text that a
 * driving loop can parse. The owner-only acts (approve / cancel, and reject of
 * anything UN-parked) have NO tool here by design — they exist only on the
 * owner's page. The one disposal this surface carries is the owner-instructed
 * reject of a PARKED item: ambiguous|superseded -> rejected, reason required.
 *
 * 2.5.0 adds the Jot ticket tools (backlog_bind / set_status / unbind / refine): the
 * page's work status and its binding to ONE Claude Code session on one computer. They
 * send this session's id (CLAUDE_CODE_SESSION_ID), the computer name (machineLabel.ts)
 * and the working folder; the server decides who may change what.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NoesisClient } from '../api/NoesisClient.js';
import { currentSessionRef } from './claudeSessions.js';
import { machineLabel } from '../machineLabel.js';

// 'rejected' rides along for set_stage's parked disposal and as a backlog_get
// list filter; it is NOT a stage the loop may reach from un-parked items.
const STAGE_ENUM = z.enum(['jot', 'ambiguous', 'superseded', 'refined', 'materialized', 'approved', 'running', 'implemented', 'shipped', 'rejected']);
const KIND_ENUM = z.enum(['feature', 'bug', 'design', 'process', 'research']);
const SIZE_ENUM = z.enum(['S', 'M', 'L']);

// Jot work status (2.5.0) — how far a Claude Code session has got with a ticket.
// Separate from the old `stage` above, which belongs to the retired groom/run workflow.
const WORK_STATUS_ENUM = z.enum([
  'created', 'planning', 'ready_to_implement', 'implementing', 'iterating',
  'ready_to_merge', 'deploying', 'shipped', 'dropped',
]);
// created and dropped are the user's decisions (a new jot, an abandoned idea): OWNER_GATE.
const CLAUDE_STATUS_ENUM = z.enum([
  'planning', 'ready_to_implement', 'implementing', 'iterating', 'ready_to_merge', 'deploying', 'shipped',
]);

/** The status ladder, said the same way in every tool description and in the skill. */
export const STATUS_LADDER =
  'planning = reading the ticket and the code, writing a plan (plan mode) · ' +
  'ready_to_implement = the plan is presented, waiting for the user to approve it · ' +
  'implementing = building the approved plan · ' +
  'iterating = the first version is delivered; the user is testing it and asking for changes · ' +
  'ready_to_merge = YOU judge the work complete (all feedback done, or a /cc-loop reached LOOP COMPLETE); waiting for the user to say ship it · ' +
  'deploying = merging, pushing and verifying the deployment · ' +
  'shipped = the change is live in production. ' +
  'created and dropped are the user\'s to set.';

/** Who is calling: this Claude Code session, this computer, this folder. */
export function ticketCaller(): { session_id: string; machine: string; cwd: string } | null {
  const ref = currentSessionRef();
  if (!ref) return null;
  return { session_id: ref.ref.id, machine: machineLabel(), cwd: ref.ref.cwd };
}

const NO_SESSION =
  'No Claude Code session id (CLAUDE_CODE_SESSION_ID is not set). Ticket binding works only inside a Claude Code session.';

function jsonText(data: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function errText(e: unknown): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  const msg = e instanceof Error ? e.message : String(e);
  return { content: [{ type: 'text' as const, text: `Backlog tool failed: ${msg}` }], isError: true };
}

export function registerBacklogTools(server: McpServer, client: NoesisClient): void {
  server.tool(
    'backlog_get',
    'Read the Backlog: without a key, list issues (+ per-stage counts and open_question_count, optionally filtered by stage or a text query); with a key (TCK-<n>), the full issue including increments, open owner questions, and the bounded message thread (questions + answers linked via answered_by_message_id — what RESOLVE reads).',
    {
      key: z.string().optional().describe('Issue key like TCK-7 (omit to list)'),
      stage: STAGE_ENUM.optional().describe('List filter: only this stage'),
      status: WORK_STATUS_ENUM.optional().describe('List filter: only this work status (the Jot page status)'),
      query: z.string().optional().describe('List filter: title/body text search'),
    },
    async (args) => {
      try {
        const data = args.key
          ? await client.backlogGet(args.key)
          : await client.backlogList({ stage: args.stage, status: args.status, q: args.query });
        return jsonText(data);
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.tool(
    'backlog_upsert_issue',
    'Create a Backlog issue (no key; groom may create in jot/refined/materialized) or update an existing one (with key; content fields only before approval, bookkeeping fields until terminal).',
    {
      key: z.string().optional().describe('Existing issue key to update; omit to create'),
      title: z.string().optional(),
      kind: KIND_ENUM.optional(),
      size: SIZE_ENUM.optional(),
      origin_jot: z.string().optional().describe('Verbatim original memo text'),
      body_md: z.string().optional().describe('Requirement markdown (Problem / Current / Proposed / Acceptance criteria / NOT-do)'),
      stage: z.enum(['jot', 'refined', 'materialized']).optional().describe('Create-only: initial stage'),
      branch: z.string().optional(),
      worktree: z.string().optional(),
      pr_number: z.number().int().optional(),
    },
    async (args) => {
      try {
        if (args.key) {
          const { key, stage: _ignored, ...patch } = args;
          const body = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
          return jsonText(await client.backlogPatch(key, body));
        }
        if (!args.title) return errText(new Error('title is required to create an issue'));
        const body = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));
        return jsonText(await client.backlogCreate(body));
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.tool(
    'backlog_set_stage',
    "Move an issue through its lifecycle on the loop surface: jot->refined, refined->materialized (send-back too), approved->running, running->approved (STOP-acknowledge), running->implemented, implemented->shipped; plus the groom detours: jot->ambiguous (reading forks; post the question FIRST), ambiguous->refined/jot (resolve/retract), and jot|refined|ambiguous|materialized->superseded (grooming believes it ALREADY SHIPPED — post the evidence question first), superseded->jot/refined (retract/keep). Parked disposal: ambiguous|superseded->rejected, ONLY on the owner's explicit instruction (in chat, or their answer to the park question) — reason REQUIRED and must record that instruction. Cannot approve/cancel, nor reject un-parked items — those are the owner's page buttons (OWNER_GATE).",
    {
      key: z.string().describe('Issue key like TCK-7'),
      to: STAGE_ENUM.describe('Target stage (approve only as the running->approved stop-ack)'),
      reason: z.string().optional().describe("Reason for send-backs; REQUIRED for rejected (record the owner's instruction)"),
    },
    async (args) => {
      try {
        return jsonText(await client.backlogSetStage(args.key, args.to, args.reason));
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.tool(
    'backlog_plan_increments',
    'Register or refresh the planned increment list for an issue (upsert by sequence; rows that already started are never rewritten).',
    {
      key: z.string(),
      increments: z
        .array(
          z.object({
            sequence: z.number().int().positive(),
            name: z.string(),
            type: z.enum(['spike', 'implementation', 'verification', 'refactor']).optional(),
          })
        )
        .min(1),
    },
    async (args) => {
      try {
        return jsonText(await client.backlogPlanIncrements(args.key, args.increments));
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.tool(
    'backlog_report_increment',
    "Report an increment lifecycle edge. phase 'start': marks it running, bumps attempts, stamps model/effort. phase 'finish': status passed|failed|parked|skipped + telemetry (verifier_verdict, gate_results, commits, evidence_md, obstacles_md); duration lands in the trace automatically.",
    {
      key: z.string(),
      sequence: z.number().int().positive(),
      phase: z.enum(['start', 'finish']),
      model: z.string().optional(),
      effort: z.string().optional(),
      status: z.enum(['passed', 'failed', 'parked', 'skipped']).optional(),
      verifier_verdict: z.enum(['pass', 'fail']).optional(),
      gate_results: z.record(z.string(), z.unknown()).optional(),
      commits: z.array(z.object({ sha: z.string(), message: z.string() })).optional(),
      evidence_md: z.string().optional(),
      obstacles_md: z.string().optional(),
    },
    async (args) => {
      try {
        const { key, sequence, ...body } = args;
        const clean = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
        return jsonText(await client.backlogReportIncrement(key, sequence, clean));
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.tool(
    'backlog_control',
    'The iteration-boundary poll: requested control state (run/pause/stop/cancel), stage, frozen vs CURRENT spec hash (both server-computed — compare the two strings; a mismatch means the requirement changed), unanswered owner questions, and discussion since a message cursor.',
    {
      key: z.string(),
      after_message_id: z.number().int().optional().describe('Return thread messages newer than this id'),
    },
    async (args) => {
      try {
        return jsonText(await client.backlogControl(args.key, args.after_message_id));
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.tool(
    'backlog_post_message',
    "The loop's voice on an issue: kind 'answer' + answer_to replies to an owner question WITHOUT stopping work; kind 'question' + parks_sequence asks the owner and parks that increment ([Q] park); kind 'question' WITHOUT parks_sequence is the issue-level groom question (pair it with set_stage to 'ambiguous' for reading forks, or 'superseded' for already-shipped evidence); kind 'comment' leaves a note.",
    {
      key: z.string(),
      body_md: z.string(),
      kind: z.enum(['answer', 'question', 'comment']),
      answer_to: z.number().int().optional().describe('Message id of the owner question being answered'),
      parks_sequence: z.number().int().optional().describe("With kind 'question': increment sequence to park"),
    },
    async (args) => {
      try {
        const { key, ...body } = args;
        const clean = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
        return jsonText(await client.backlogPostMessage(key, clean));
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.tool(
    'backlog_append_event',
    "Append a free-form trace event to an issue (dot-namespaced type like 'gate.result' or 'loop.note'; optional payload, actor claude|verifier|system, and increment sequence linkage).",
    {
      key: z.string(),
      type: z.string().describe('Dot-namespaced lowercase type, e.g. loop.note'),
      payload: z.record(z.string(), z.unknown()).optional(),
      actor: z.enum(['claude', 'verifier', 'system']).optional(),
      increment_seq: z.number().int().optional(),
    },
    async (args) => {
      try {
        const { key, ...body } = args;
        const clean = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
        return jsonText(await client.backlogAppendEvent(key, clean));
      } catch (e) {
        return errText(e);
      }
    }
  );

  // ── Jot work status + Claude Code binding + refinement (2.5.0) ─────────────────
  // The ticket tools are bookkeeping on the user's Noesis ticket, which the user asked
  // for: calling them in plan mode is expected. Rules are enforced server-side.

  server.tool(
    'backlog_bind',
    "Bind a Jot ticket to THIS Claude Code session: records the session id, this computer's name and the working folder, and sets the ticket's work status. Call it when the user hands you a ticket (pastes 'TCK-<n>: …', or asks you to read, plan or work on TCK-<n>), or links the running session to one (/noesis-ticket link). With no status the ticket is set to planning; when you link a session that is already further along, pass the status it has really reached. Errors: BOUND_ELSEWHERE — another session or computer holds it; take it over (force) only if the user asks. SESSION_BUSY — this session already holds another ticket; switch only if the user hands over this one. RESET_BY_OWNER — the user reset this session's binding on the page; bind again (force) only if the user asks. Status ladder: " + STATUS_LADDER,
    {
      key: z.string().describe('Ticket key like TCK-7'),
      status: CLAUDE_STATUS_ENUM.optional().describe('Status to set; omit to start at planning'),
      force: z.boolean().optional().describe('Take over a ticket bound elsewhere, or re-bind after an owner reset — only when the user asks'),
      switch: z.boolean().optional().describe('Release the ticket this session holds and bind this one — only when the user hands this one over'),
    },
    async (args) => {
      try {
        const who = ticketCaller();
        if (!who) return errText(new Error(NO_SESSION));
        const { key, ...rest } = args;
        const body = Object.fromEntries(Object.entries({ ...who, ...rest }).filter(([, v]) => v !== undefined));
        return jsonText(await client.backlogBind(key, body));
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.tool(
    'backlog_set_status',
    'Set the work status of the Jot ticket bound to THIS session (bind it first with backlog_bind). Keep it current as you work. Status ladder: ' + STATUS_LADDER + ' Errors: NOT_BOUND (bind first; if the user reset the binding, ask before binding again), BOUND_ELSEWHERE (another session holds it), OWNER_GATE (created/dropped are the user\'s).',
    {
      key: z.string().describe('Ticket key like TCK-7'),
      status: CLAUDE_STATUS_ENUM,
    },
    async (args) => {
      try {
        const who = ticketCaller();
        if (!who) return errText(new Error(NO_SESSION));
        return jsonText(await client.backlogSetStatus(args.key, { ...who, status: args.status }));
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.tool(
    'backlog_unbind',
    "Release this session's binding on a Jot ticket (the status stays). Use it when the user says to stop working the ticket here, or to reset the binding. force releases a binding held by another session — only when the user asks.",
    {
      key: z.string().describe('Ticket key like TCK-7'),
      force: z.boolean().optional(),
    },
    async (args) => {
      try {
        const who = ticketCaller();
        if (!who) return errText(new Error(NO_SESSION));
        const body = Object.fromEntries(Object.entries({ ...who, force: args.force }).filter(([, v]) => v !== undefined));
        return jsonText(await client.backlogUnbind(args.key, body));
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.tool(
    'backlog_refine',
    "Store your refinement of a Jot ticket's text (the ticket must be bound to this session). It must stay a jot: 70%–120% of the draft's word count (5 words of slack for short drafts; each Chinese, Japanese or Korean character counts as one word), in the draft's language, plain sentences or a short list — no headings, no code fences, no increments, acceptance criteria or plan sections. Refine once when your plan is ready (just before ExitPlanMode), and again only if the plan changes or the user asks. The user's draft is never changed; the page shows your text with the draft kept under it. Errors: REFINE_LENGTH (the details give draft_words, min, max and got — rewrite to fit), REFINE_FORMAT.",
    {
      key: z.string().describe('Ticket key like TCK-7'),
      text: z.string().describe('The refined ticket text, about as long as the draft'),
    },
    async (args) => {
      try {
        const who = ticketCaller();
        if (!who) return errText(new Error(NO_SESSION));
        return jsonText(await client.backlogRefine(args.key, { ...who, text: args.text }));
      } catch (e) {
        return errText(e);
      }
    }
  );
}
