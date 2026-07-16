/**
 * Backlog v2 MCP tools — the loop's view of /api/mcp/backlog. Thin wrappers:
 * every rule (stage legality, OWNER_GATE, freeze, park guards) is enforced
 * server-side; these tools shape requests and return compact JSON text that a
 * driving loop can parse. The owner-only acts (approve / reject / cancel) have
 * NO tool here by design — they exist only on the owner's page.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NoesisClient } from '../api/NoesisClient.js';

const STAGE_ENUM = z.enum(['jot', 'ambiguous', 'superseded', 'refined', 'materialized', 'approved', 'running', 'implemented', 'shipped']);
const KIND_ENUM = z.enum(['feature', 'bug', 'design', 'process', 'research']);
const SIZE_ENUM = z.enum(['S', 'M', 'L']);

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
      query: z.string().optional().describe('List filter: title/body text search'),
    },
    async (args) => {
      try {
        const data = args.key
          ? await client.backlogGet(args.key)
          : await client.backlogList({ stage: args.stage, q: args.query });
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
    "Move an issue through its lifecycle on the loop surface: jot->refined, refined->materialized (send-back too), approved->running, running->approved (STOP-acknowledge), running->implemented, implemented->shipped; plus the groom detours: jot->ambiguous (reading forks; post the question FIRST), ambiguous->refined/jot (resolve/retract), and jot|refined|ambiguous->superseded (grooming believes it ALREADY SHIPPED — post the evidence question first; disposal is the owner's page Reject), superseded->jot/refined (retract/keep). Cannot approve/reject/cancel — those are the owner's page buttons (OWNER_GATE).",
    {
      key: z.string().describe('Issue key like TCK-7'),
      to: STAGE_ENUM.describe('Target stage (approve only as the running->approved stop-ack)'),
      reason: z.string().optional().describe('Reason for send-backs'),
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
}
