/**
 * Noesis Local Agent daemon — the runtime for ai_mode = 'claude-subscription'.
 *
 * Polls the Noesis agent-job queue with the user's `noe_` API token, claims a job,
 * runs it through the user's OWN Claude subscription via the Claude Agent SDK
 * (ambient Claude Code login — no Anthropic credential ever leaves this machine or
 * reaches Noesis), streams partial output back as events, and completes it.
 *
 * Fencing: /claim returns a `lease`; every /events + /complete echoes it, so a job
 * that was stale-requeued and re-claimed by another worker rejects this worker (409).
 * A keepalive (empty /events) holds the lease during long quiet model steps.
 *
 * FOOTGUN GUARD: if ANTHROPIC_API_KEY is set, the Agent SDK bills the metered API
 * instead of the subscription — so we delete it (and warn) before any query().
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkWebFetchUrl, webFetchEnvWarnings, type UrlVerdict } from './webGuard.js';
import { resolveIdentity, type DaemonIdentity } from './identity.js';
import { TokenGate, applyStartupCheck, checkToken, classifyRefusal } from './tokenState.js';

const POLL_INTERVAL_MS = 2000;      // idle poll cadence
const CHUNK_FLUSH_MS = 500;         // batch streamed deltas before POST /events
const KEEPALIVE_MS = 30_000;        // hold the lease during quiet stretches (< server's 120s stale)
const MAX_CONCURRENCY = 2;

/**
 * NOESIS_AGENT_FAKE: '1' (or 'canned') answers every job with canned text; 'rate_limit'
 * and 'auth' replay what the Claude Agent SDK emits on a subscription usage limit / a
 * revoked login, through the SAME stream handling as a real run, until
 * NOESIS_AGENT_FAKE_RESET_MIN minutes after start — then they answer like 'canned'.
 * For testing the server's fallback and recovery without spending real quota.
 */
export type FakeMode = 'canned' | 'rate_limit' | 'auth';

export interface AgentConfig {
  apiBaseUrl: string;
  apiToken: string;
  concurrency: number;
  fake: boolean; // any NOESIS_AGENT_FAKE mode → no Claude login involved
  fakeMode?: FakeMode;
  fakeResetAt?: number; // epoch ms when a rate_limit/auth fake starts succeeding
  fakeWordMs?: number; // delay between canned words (NOESIS_AGENT_FAKE_WORD_MS)
}

function parseFakeMode(raw: string | undefined): FakeMode | undefined {
  const v = (raw || '').trim().toLowerCase();
  if (v === '1' || v === 'canned') return 'canned';
  if (v === 'rate_limit' || v === 'auth') return v;
  return undefined;
}

function nonNegative(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return raw !== undefined && raw !== '' && Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function resolveAgentConfig(): AgentConfig {
  const apiBaseUrl = (process.env.NOESIS_API_URL || '').replace(/\/$/, '');
  const apiToken = process.env.NOESIS_API_TOKEN || '';
  if (!apiBaseUrl || !apiToken) {
    throw new Error('NOESIS_API_URL and NOESIS_API_TOKEN are required to run the agent daemon.');
  }
  let concurrency = parseInt(process.env.NOESIS_AGENT_CONCURRENCY || '1', 10);
  if (!Number.isFinite(concurrency) || concurrency < 1) concurrency = 1;
  if (concurrency > MAX_CONCURRENCY) concurrency = MAX_CONCURRENCY;
  const fakeMode = parseFakeMode(process.env.NOESIS_AGENT_FAKE);
  return {
    apiBaseUrl,
    apiToken,
    concurrency,
    fake: fakeMode !== undefined,
    fakeMode,
    fakeResetAt: Date.now() + nonNegative(process.env.NOESIS_AGENT_FAKE_RESET_MIN, 3) * 60_000,
    fakeWordMs: nonNegative(process.env.NOESIS_AGENT_FAKE_WORD_MS, 15),
  };
}

interface ClaimedJob {
  jobId: string;
  kind: string;
  payload: JobPayload;
  lease: string;
}

interface JobPayload {
  // Composed server-side (Option 2/B4): the daemon is a dumb executor.
  prompt?: string;
  system?: string;
  allowedTools?: string[];
  maxTurns?: number;
  images?: Array<{ mimeType: string; data: string }>;
}

/**
 * The ONLY tools the server may pre-approve — a literal allowlist, not a namespace
 * prefix. Everything named here runs under this machine's ambient Claude Code login
 * with no further prompt, so the boundary must be the exact set, not `mcp__noesis__*`:
 * that namespace also contains mutating tools (`pull_notes` writes to an arbitrary
 * local path with an overwrite flag, `add_root` + `sync_notes` ingest local files),
 * which would hand a compromised server a filesystem primitive it otherwise lacks.
 * Read-only Noesis lookups only.
 */
const ALLOWED_TOOLS = new Set([
  'mcp__noesis__search_notes',
  'mcp__noesis__search_semantic',
  'mcp__noesis__get_note',
  'mcp__noesis__list_notes',
]);

/**
 * Claude Code built-ins a server may request: network-only, no filesystem access. This is
 * the ONLY route by which the SDK's `tools` option is ever non-empty (see buildQueryOptions).
 *
 * A separate list from ALLOWED_TOOLS on purpose, and never pre-approved: every call goes
 * through buildCanUseTool, where a WebFetch URL must pass webGuard, because this daemon
 * runs on the user's own machine and "fetch http://192.168.1.1" would reach their LAN.
 * The backend asks for these only for a Navi whose Web Search toggle is on.
 */
const ALLOWED_WEB_TOOLS = ['WebFetch', 'WebSearch'] as const;

/** Highest turn budget a server may request; a tool loop otherwise burns the subscription. */
const MAX_TURNS_CEILING = 12;

/** Drop anything the server asked for that is not on the read-only allowlist. */
export function clampAllowedTools(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const kept = raw.filter((t): t is string => typeof t === 'string' && ALLOWED_TOOLS.has(t));
  const dropped = (raw as unknown[]).length - kept.length;
  if (dropped > 0) console.error(`[noesis-agent] dropped ${dropped} tool name(s) not on the read-only allowlist`);
  return kept;
}

/** The web built-ins this job asked for, in a fixed order. Nothing else can come out. */
export function clampWebTools(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return ALLOWED_WEB_TOOLS.filter((t) => raw.includes(t));
}

/** Clamp the server-requested turn budget into a sane range. */
export function clampMaxTurns(raw: unknown): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : 1;
  if (n < 1) return 1;
  return Math.min(n, MAX_TURNS_CEILING);
}

/**
 * MCP server config for the tools above, built from the daemon's OWN config —
 * deliberately never from the job payload, so the server cannot point the model
 * at a different endpoint or hand it a different token.
 */
function noesisMcpServers(cfg: AgentConfig): Record<string, unknown> {
  const entry = fileURLToPath(new URL('../index.js', import.meta.url));
  return {
    noesis: {
      command: process.execPath,
      args: [entry],
      env: { ...process.env, NOESIS_API_TOKEN: cfg.apiToken, NOESIS_API_URL: cfg.apiBaseUrl },
    },
  };
}

async function api(cfg: AgentConfig, path: string, body: unknown): Promise<Response> {
  return fetch(`${cfg.apiBaseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiToken}` },
    body: JSON.stringify(body),
  });
}

/**
 * This daemon's own package version, reported at claim time so the server can
 * refuse to hand a job to a build too old for what that job needs. Read from
 * package.json rather than hard-coded, so a release cannot forget to bump it.
 */
export function agentVersion(): string {
  try {
    const pkg = fileURLToPath(new URL('../../package.json', import.meta.url));
    return JSON.parse(readFileSync(pkg, 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

let identity: DaemonIdentity | null = null;

/** This process's machine identity, resolved once (daemonId is stable; bootId is per process). */
function daemonIdentity(): DaemonIdentity {
  identity ??= resolveIdentity();
  return identity;
}

/**
 * What every claim sends. The server keeps one health record per machine (daemonId), tells
 * a restart from a second process by bootId, and shows label/platform in Settings. Older
 * servers read only workerId + agentVersion and ignore the rest.
 */
export function claimBody(workerId: string, id: DaemonIdentity): Record<string, unknown> {
  return { workerId, agentVersion: agentVersion(), daemonId: id.daemonId, bootId: id.bootId, label: id.label, platform: id.platform };
}

/** The token state every worker shares (see tokenState.ts). */
const tokenGate = new TokenGate();

/**
 * Read a claim answer. A 401 means the server refused this daemon's API token (expired,
 * revoked or unknown): the shared gate explains it once and the workers back off, instead
 * of retrying silently every 2 s. Any accepted answer clears that state and feeds the
 * token-expiry warning.
 */
export async function handleClaimResponse(res: Response, gate: TokenGate): Promise<ClaimedJob | null> {
  if (res.status === 401) {
    gate.refused(classifyRefusal(await res.json().catch(() => ({}))));
    return null;
  }
  if (!res.ok) return null;
  gate.accepted();
  gate.expiryHeader(res.headers.get('x-noesis-token-expires'));
  const data = (await res.json()) as { job: ClaimedJob | null };
  return data.job ?? null;
}

async function claim(cfg: AgentConfig, workerId: string): Promise<ClaimedJob | null> {
  const res = await api(cfg, '/api/agent/jobs/claim', claimBody(workerId, daemonIdentity()));
  return handleClaimResponse(res, tokenGate);
}

/** Sleep, but wake at once on shutdown — the refused-token backoff is a minute long. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** Buffers streamed text and flushes it as lease-fenced chunk events + keepalives. */
class EventSink {
  private buffer = '';
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private lastPost = Date.now();
  private closed = false;

  constructor(private cfg: AgentConfig, private jobId: string, private lease: string) {}

  start(): void {
    this.flushTimer = setInterval(() => void this.flush(), CHUNK_FLUSH_MS);
    // Hold the lease if the model goes quiet longer than the flush interval.
    this.keepaliveTimer = setInterval(() => {
      if (Date.now() - this.lastPost >= KEEPALIVE_MS && this.buffer.length === 0) {
        void this.postEvents([]); // empty batch = keepalive (bumps heartbeat, holds lease)
      }
    }, KEEPALIVE_MS);
  }

  push(text: string): void {
    this.buffer += text;
  }

  private async flush(): Promise<void> {
    if (this.closed || this.buffer.length === 0) return;
    const text = this.buffer;
    this.buffer = '';
    await this.postEvents([{ kind: 'chunk', data: { text } }]);
  }

  private async postEvents(events: Array<{ kind: string; data: unknown }>): Promise<void> {
    this.lastPost = Date.now();
    try {
      const res = await api(this.cfg, `/api/agent/jobs/${this.jobId}/events`, { lease: this.lease, events });
      if (res.status === 409) {
        // Lease superseded (job was requeued + re-claimed elsewhere) or terminal.
        // Stop streaming — this worker no longer owns the job.
        this.closed = true;
      }
    } catch {
      /* transient network error; next flush/keepalive retries */
    }
  }

  isClosed(): boolean {
    return this.closed;
  }

  async finish(): Promise<void> {
    await this.flush();
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
  }
}

/**
 * One Anthropic content block — a plain-text piece or a base64 image, the same
 * shape the SSE path's formatClaudeContent() already builds (main repo,
 * services/chatContextComposer.ts). Reimplemented here rather than imported: this
 * submodule cannot import from the main repo it is published independently of.
 */
type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

/**
 * `sdk.query()`'s `prompt` accepts a plain string OR an AsyncIterable<SDKUserMessage>
 * (verified directly against the shipped SDK, @anthropic-ai/claude-agent-sdk@0.1.77,
 * sdk.mjs) — the string branch is sugar that constructs exactly this one-message shape
 * itself before writing it to the transport, and the iterable branch goes through the
 * identical Query.streamInput(), which writes each yielded message then closes stdin
 * once the iterable ends. A generator yielding one message and returning is therefore
 * not a workaround; it is what the SDK already does for a plain string, generalized to
 * carry image content — which the string form has no structural room for.
 */
export async function* singleUserMessage(content: ContentBlock[]): AsyncGenerator<unknown> {
  yield {
    type: 'user',
    session_id: '',
    message: { role: 'user', content },
    parent_tool_use_id: null,
  };
}

/** Images first, text last — matches formatClaudeContent()'s ordering. */
export function buildImageContent(prompt: string, images: Array<{ mimeType: string; data: string }>): ContentBlock[] {
  const blocks: ContentBlock[] = images.map((img) => ({
    type: 'image',
    source: { type: 'base64', media_type: img.mimeType, data: img.data },
  }));
  // Claude requires at least one content block; an image-only send still needs text.
  blocks.push({ type: 'text', text: prompt || '(Image attached)' });
  return blocks;
}

/**
 * What `prompt` executeJob passes into sdk.query() — extracted so the branch
 * decision (and its two shapes) is directly testable without mocking the dynamic
 * SDK import. Kept conditional on `images` rather than switching every job onto
 * the generator form, to minimize the diff's blast radius on the far more common
 * text-only case even though the underlying SDK mechanism is confirmed equivalent.
 */
export function buildSdkPrompt(
  prompt: string,
  images: Array<{ mimeType: string; data: string }> | undefined,
): string | AsyncGenerator<unknown> {
  if (images && images.length > 0) return singleUserMessage(buildImageContent(prompt, images));
  return prompt;
}

/** What the SDK expects back from a canUseTool decision. */
type PermissionDecision =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

/**
 * SECOND, INDEPENDENT LAYER on the tool boundary.
 *
 * The `tools` option below (`[]`, or at most the two web tools) is the primary control, but
 * it works by way of the CLI's `--tools` flag, whose handling lives in a minified `cli.js`
 * we cannot audit. This callback is a
 * gate we own outright: the SDK routes every permission request through it
 * (`--permission-prompt-tool stdio`), and the request carries an `agentID`, so calls made
 * by a spawned `Task` SUBAGENT are covered too — which matters, because a subagent, not
 * the main loop, did the file reading in the 2026-08-14 incident.
 *
 * Deliberately fed from ALLOWED_TOOLS / ALLOWED_WEB_TOOLS (via the per-job clamps) so the
 * daemon has ONE definition of what may run.
 *
 * DO NOT DELETE THIS AS DEAD CODE. It is the ONLY daemon-owned control over MCP tools.
 * `tools: []` governs the SDK's BUILT-IN set and nothing else; the Noesis MCP server we
 * spawn registers ~55 tools, and their definitions are not filtered by `allowedTools`, so
 * the model can see and attempt every one of them — including `pull_notes`, which writes
 * to an arbitrary local path, plus `add_root`, `sync_notes`, `trash_note`, `move_note`.
 * For those, this callback is the whole boundary.
 *
 * MEASURED (30 runs, 2026-08-15), correcting an earlier comment that said the opposite:
 * the gate DOES fire — it denied `mcp__noesis__list_roots` and `mcp__noesis__list_codebases`
 * in real traffic, and the model received `is_error` results naming the refusal. An earlier
 * 2-job sample saw zero firings and wrongly concluded the gate was inert; a permission tool
 * is simply not consulted for calls that are already pre-approved, and that sample happened
 * to exercise only pre-approved tools.
 *
 * KNOWN GAP, stated rather than glossed: the SDK's cache-warming sidechain
 * (`isSidechain: true`) is a real model turn that emits genuine `Bash`/`Glob` calls against
 * the daemon's cwd, with only the RESULT stubbed. `tools: []` does not reach it and this
 * callback is never consulted there. Nothing executes — but that is Claude Code internal
 * behaviour we neither own nor test, which is why the daemon is rooted at a neutral cwd
 * (`scripts/start-agent.sh`), so the warmup probes an empty directory, not a source tree.
 *
 * WEB TOOLS: a permitted WebFetch is still refused unless its URL passes webGuard (public
 * http(s) host only). The job's permitted set is checked FIRST, so a job never cleared
 * for web cannot fetch even a public page. WebSearch needs no address check: the search
 * runs on Anthropic's side, not from this machine. One exception the gate cannot see: the
 * CLI itself pre-approves ~85 public documentation hosts for WebFetch and never asks. Those
 * are public by definition, and executeJob logs every tool call from the stream anyway.
 */
export function buildCanUseTool(
  /**
   * The tools permitted for THIS job — i.e. the output of `clampAllowedTools`, not the
   * module-wide `ALLOWED_TOOLS`. Required, deliberately: an earlier version closed over
   * `ALLOWED_TOOLS` and so turned a per-job clamp into a union. `clampAllowedTools`
   * narrows to (what the server asked for ∩ ALLOWED_TOOLS); the gate then re-allowed all
   * four regardless, so a job clamped to `get_note` could still execute `search_semantic`.
   * The sets happen to coincide for chat today, which is exactly why it would have gone
   * unnoticed until the first job kind with a narrower allowlist.
   */
  permitted: Iterable<string>,
  onDecision: (toolName: string, allowed: boolean, agentID?: string, detail?: string) => void = logToolDecision,
  checkUrl: (url: unknown) => Promise<UrlVerdict> = checkWebFetchUrl,
): (toolName: string, input?: unknown, ctx?: { agentID?: string }) => Promise<PermissionDecision> {
  const permittedSet = new Set(permitted);
  return async (toolName, input, ctx) => {
    if (!permittedSet.has(toolName)) {
      onDecision(toolName, false, ctx?.agentID);
      return { behavior: 'deny', message: `Tool "${toolName}" is not permitted for a Noesis job.` };
    }
    const args = (input ?? {}) as Record<string, unknown>;
    if (toolName === 'WebFetch') {
      const verdict = await checkUrl(args.url);
      if (!verdict.ok) {
        onDecision(toolName, false, ctx?.agentID, `${String(args.url)} (${verdict.reason})`);
        return {
          behavior: 'deny',
          message: `WebFetch refused: ${verdict.reason}. Only public internet addresses can be fetched.`,
        };
      }
    }
    onDecision(toolName, true, ctx?.agentID, toolCallDetail(toolName, args));
    return { behavior: 'allow', updatedInput: args };
  };
}

/** The URL or query a web tool call is about, for the log; undefined for other tools. */
function toolCallDetail(toolName: string, args: Record<string, unknown>): string | undefined {
  const value = toolName === 'WebFetch' ? args.url : toolName === 'WebSearch' ? args.query : undefined;
  return typeof value === 'string' ? value.slice(0, 300) : undefined;
}

/** Default sink: stderr, so the daemon log is the evidence for whether the gate ever fires. */
function logToolDecision(toolName: string, allowed: boolean, agentID?: string, detail?: string): void {
  console.error(
    `[noesis-agent] canUseTool ${allowed ? 'ALLOW' : 'DENY'} ${toolName}${detail ? ` ${detail}` : ''}${agentID ? ` (agent=${agentID})` : ''}`,
  );
}

/**
 * The `options` object handed to sdk.query() — extracted, like buildSdkPrompt above, so
 * the tool boundary is asserted by a test instead of resting on a comment. `tools` is the
 * security-relevant field: see the note at its assignment. Takes the MCP-server
 * factory as an argument so a test can supply a stub instead of a real spawn config.
 */
export function buildQueryOptions(
  payload: JobPayload,
  mcpServersFor: () => Record<string, unknown>,
): Record<string, unknown> {
  const requested = Array.isArray(payload.allowedTools) ? payload.allowedTools : [];
  const webTools = clampWebTools(requested);
  // Web names have their own clamp; keeping them out of this one stops it logging them as
  // "dropped" on every web job. What it keeps is unchanged: the four read-only lookups.
  const allowedTools = clampAllowedTools(requested.filter((t) => !webTools.includes(t)));
  return {
    ...(payload.system ? { systemPrompt: payload.system } : {}),
    // Suppress the SDK's built-in tool set (`--tools <list>`) down to at most the two web
    // tools. Without the option the CLI defaults to ALL built-ins — Bash, Read, Write,
    // Edit, Grep, WebSearch — and ALLOWED_TOOLS above does NOT stop them: `allowedTools`
    // is a PERMISSION allowlist, so unlisted tools are un-pre-approved, not absent, and
    // their definitions still reach the model. Worse, the read-only built-ins need no
    // approval at all, so they actually EXECUTE headless: on 2026-08-14 an English-coach
    // Navi grepped this daemon's cwd and returned ~100 strings from the user's source tree
    // (jobs 527/528); only the follow-up file Write stopped, at the permission gate.
    // So this is `[]` for every job that did not ask for web, and never more than
    // ALLOWED_WEB_TOOLS — network-only, no filesystem access. A server-supplied payload
    // still can never ask for a filesystem primitive. MCP tools travel a separate channel
    // (`--mcp-config`) and are unaffected: a `use_knowledge_base` Navi still calls
    // search_notes (verified).
    tools: webTools,
    // Independent second layer — see buildCanUseTool. Covers subagent (`Task`) calls too.
    // Web tools are deliberately left out of `allowedTools` below (never pre-approved),
    // so every WebFetch reaches this gate and its URL check.
    canUseTool: buildCanUseTool([...allowedTools, ...webTools]),
    allowedTools,
    // Only spawn the Noesis MCP server when a tool actually survived clamping.
    ...(allowedTools.length > 0 ? { mcpServers: mcpServersFor() } : {}),
    maxTurns: clampMaxTurns(payload.maxTurns),
    includePartialMessages: true,
  };
}

/** The prompt text for a job, with the fallback used when a payload carries none. */
export function resolveJobPrompt(payload: JobPayload, kindLabel: string): string {
  return payload.prompt ?? `(${kindLabel} job with empty prompt)`;
}

/** The minimum of the Agent SDK this daemon uses — enough for a test to substitute a fake. */
export interface SdkLike {
  query(args: { prompt: unknown; options: Record<string, unknown> }): AsyncIterable<unknown>;
}

/**
 * The ONE place the SDK is invoked. Exported so a test can pass a fake `sdk` and assert
 * what actually reaches `query()`.
 *
 * This exists because of a real gap: the suite pinned `buildQueryOptions` with a
 * power-set mutation battery, but NOTHING pinned the call. Restoring the pre-fix inline
 * options literal here — deleting `tools: []` and `canUseTool` outright — reverted the
 * entire tool boundary with all 79 tests still green. The builder being correct is
 * worthless if the caller stops using it, so both the seam below and the source-fitness
 * test in `agentToolClamp.test.ts` guard this.
 */
export function runSdkQuery(
  sdk: SdkLike,
  payload: JobPayload,
  kindLabel: string,
  mcpServersFor: () => Record<string, unknown>,
): AsyncIterable<unknown> {
  return sdk.query({
    prompt: buildSdkPrompt(resolveJobPrompt(payload, kindLabel), payload.images),
    options: buildQueryOptions(payload, mcpServersFor),
  });
}

/**
 * Execute a claimed job and stream its output through the sink. Returns the final
 * text. Real mode runs the Claude Agent SDK on the user's subscription; fake mode
 * emits a canned response so the queue plumbing can be verified without a login.
 */
async function executeJob(cfg: AgentConfig, job: ClaimedJob, sink: EventSink): Promise<string> {
  const prompt = resolveJobPrompt(job.payload, job.kind);

  if (cfg.fake) {
    const fake = fakeSdk(cfg.fakeMode ?? 'canned', {
      kind: job.kind,
      promptText: prompt,
      resetAt: cfg.fakeResetAt ?? 0,
      wordMs: cfg.fakeWordMs ?? 15,
    });
    return consumeAgentStream(runSdkQuery(fake, job.payload, job.kind, () => ({})), sink);
  }

  // Real path: the Agent SDK uses the ambient Claude Code subscription login.
  // Dynamically imported via a NON-LITERAL specifier so tsc doesn't require the
  // (optional, heavy) dependency at build time — fake mode builds/runs without it,
  // and a missing install surfaces a clear runtime error only here.
  const sdkModule = '@anthropic-ai/claude-agent-sdk';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sdk: any = await import(sdkModule).catch(() => {
    throw new Error('Install @anthropic-ai/claude-agent-sdk to run the Noesis local agent (real mode).');
  });
  const stream = runSdkQuery(sdk, job.payload, job.kind, () => noesisMcpServers(cfg));
  return consumeAgentStream(stream, sink);
}

/**
 * Appended when the SDK stops a run at maxTurns. Without it the saved reply would be only
 * the narration that came before the tool calls ("let me check the official page…"), with
 * nothing saying the answer was cut off.
 */
export const TURN_LIMIT_NOTE = '\n\n_(Stopped at the step limit before finishing. Ask me to continue.)_';

/**
 * Turn one SDK message stream into the reply text, pushing it to `out` as it arrives.
 * Extracted from executeJob so these rules are testable against a fake stream:
 *  - With includePartialMessages the stream carries BOTH incremental `stream_event` deltas
 *    AND a terminal `assistant` message holding the whole reply. Taking both would emit the
 *    answer twice, so deltas win and the terminal message is only a fallback for a stream
 *    that produced none (older SDK, or partials unsupported).
 *  - A multi-turn run (every web fetch or note lookup) gets a paragraph break between turns,
 *    so narration does not run into the answer. Only when the next turn actually has text,
 *    so a tool-only turn adds nothing.
 *  - Every tool call is logged, including WebFetch calls to the hosts the CLI pre-approves
 *    itself, which never reach canUseTool.
 *  - Hitting maxTurns appends TURN_LIMIT_NOTE.
 */
export async function consumeAgentStream(
  stream: AsyncIterable<unknown>,
  out: { push(text: string): void; isClosed(): boolean },
  logToolCall: (name: string, detail?: string) => void = logStreamToolCall,
): Promise<string> {
  let finalText = '';
  let sawDelta = false;
  let terminalText = '';
  let breakPending = false;
  let hitTurnLimit = false;
  // An API failure (usage limit, revoked login, …) arrives as an assistant message
  // carrying `error`, then a result with is_error, then the CLI exits 1 and the SDK
  // throws a bare "Claude Code process exited with code 1". Keep the failure's own text
  // and code — the server routes on them — and never let it become the reply.
  let apiError: { code: string; text: string; resetsAt?: number } | null = null;
  let failedResultText: string | null = null;
  let succeeded = false;
  const emit = (text: string) => {
    out.push(text);
    finalText += text;
  };
  const failure = (): AgentRunError | null => {
    if (apiError) return new AgentRunError(apiError.text, apiError.code, apiError.resetsAt);
    if (failedResultText !== null) return new AgentRunError(failedResultText || 'Claude run failed', 'unknown');
    return null;
  };
  try {
    for await (const message of stream) {
      if (out.isClosed()) break;
      const err = extractApiError(message);
      if (err) {
        apiError = err;
        continue;
      }
      const outcome = resultOutcome(message);
      if (outcome?.isError) failedResultText = outcome.text;
      else if (outcome) succeeded = true;
      if (isMessageStart(message)) {
        if (finalText) breakPending = true;
        continue;
      }
      const delta = extractStreamDelta(message);
      if (delta) {
        sawDelta = true;
        if (breakPending) {
          breakPending = false;
          const gap = paragraphGap(finalText);
          if (gap) emit(gap);
        }
        emit(delta);
        continue;
      }
      for (const call of extractToolUses(message)) logToolCall(call.name, call.detail);
      if (isTurnLimitResult(message)) hitTurnLimit = true;
      // Concatenate, don't overwrite: with tools the run is multi-turn, and a
      // stream that produced no deltas would otherwise keep only the LAST turn.
      const whole = extractTerminalText(message);
      if (whole) terminalText += (terminalText ? paragraphGap(terminalText) : '') + whole;
    }
  } catch (e) {
    throw failure() ?? e;
  }
  if (!succeeded) {
    const f = failure();
    if (f) throw f;
  }
  if (!sawDelta && terminalText) {
    out.push(terminalText);
    finalText = terminalText;
  }
  if (hitTurnLimit && !out.isClosed()) emit(finalText ? TURN_LIMIT_NOTE : TURN_LIMIT_NOTE.trimStart());
  return finalText;
}

/** A Claude API failure the daemon reports with its own text and SDK error code. */
export class AgentRunError extends Error {
  constructor(message: string, readonly code: string, readonly resetsAt?: number) {
    super(message);
    this.name = 'AgentRunError';
  }
}

/** An assistant message the SDK marked as an API failure (`error` set), or null. */
function extractApiError(message: unknown): { code: string; text: string; resetsAt?: number } | null {
  const m = message as Record<string, any> | null;
  if (m?.type !== 'assistant' || typeof m.error !== 'string' || !m.error) return null;
  const text = extractTerminalText(m) || `Claude API error (${m.error})`;
  const resetsAt = [m.resetsAt, m.message?.resetsAt, m.quotaLimits?.resetsAt, m.rateLimit?.resetsAt].find(
    (v) => typeof v === 'number' && Number.isFinite(v) && v > 0,
  );
  return { code: m.error, text, ...(resetsAt ? { resetsAt } : {}) };
}

/** A terminal `result` message: did the run fail, and with what text? Null for anything else. */
function resultOutcome(message: unknown): { isError: boolean; text: string } | null {
  const m = message as Record<string, any> | null;
  if (m?.type !== 'result') return null;
  if (m.is_error !== true) return { isError: false, text: '' };
  const text = typeof m.result === 'string' ? m.result : Array.isArray(m.errors) ? m.errors.join('; ') : '';
  return { isError: true, text };
}

/** What to insert after `text` so the next turn starts a new paragraph. */
function paragraphGap(text: string): string {
  if (text.endsWith('\n\n')) return '';
  return text.endsWith('\n') ? '\n' : '\n\n';
}

/** The start of a new model turn: one `message_start` per assistant message. */
function isMessageStart(message: unknown): boolean {
  const m = message as Record<string, any> | null;
  return m?.type === 'stream_event' && m.event?.type === 'message_start';
}

/** The SDK's terminal `result` when the run was stopped by maxTurns. */
function isTurnLimitResult(message: unknown): boolean {
  const m = message as Record<string, any> | null;
  return m?.type === 'result' && m.subtype === 'error_max_turns';
}

/** Tool calls in a complete `assistant` message, with the URL or query each is about. */
function extractToolUses(message: unknown): Array<{ name: string; detail?: string }> {
  const m = message as Record<string, any> | null;
  if (m?.type !== 'assistant' || !Array.isArray(m.message?.content)) return [];
  return m.message.content
    .filter((b: any) => b?.type === 'tool_use' && typeof b.name === 'string')
    .map((b: any) => ({ name: b.name as string, detail: toolCallDetail(b.name, b.input ?? {}) }));
}

/** Default sink: stderr, next to the canUseTool lines. */
function logStreamToolCall(name: string, detail?: string): void {
  console.error(`[noesis-agent] tool_use ${name}${detail ? ` ${detail}` : ''}`);
}

/**
 * Text carried by one streamed partial. Verified against the SDK (0.1.x): partials
 * arrive as `{type:'stream_event', event:{type:'content_block_delta',
 * delta:{type:'text_delta', text}}}`. The un-enveloped shape is accepted too, since
 * this is the field older versions used.
 */
function extractStreamDelta(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const m = message as Record<string, any>;
  if (m.type !== 'stream_event') return '';
  const ev = m.event;
  if (ev?.type === 'content_block_delta' && typeof ev?.delta?.text === 'string') return ev.delta.text;
  if (typeof m.delta?.text === 'string') return m.delta.text;
  return '';
}

/** Whole-reply text from the terminal assistant message. Never combined with deltas. */
function extractTerminalText(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const m = message as Record<string, any>;
  if (m.type === 'stream_event' || m.type === 'system' || m.type === 'result') return '';
  if (typeof m.text === 'string') return m.text;
  const content = m.message?.content ?? m.content;
  if (Array.isArray(content)) {
    return content.map((b: any) => (typeof b?.text === 'string' ? b.text : '')).join('');
  }
  return '';
}

/** The /complete body for a failed job: the message, plus the SDK's code when known. */
export function completionErrorBody(lease: string, err: unknown): Record<string, unknown> {
  const body: Record<string, unknown> = { lease, error: err instanceof Error ? err.message : String(err) };
  if (err instanceof AgentRunError) {
    body.errorCode = err.code;
    if (err.resetsAt) body.resetsAt = err.resetsAt;
  }
  return body;
}

export interface FakeSdkOptions {
  kind: string;
  promptText: string;
  /** Epoch ms after which rate_limit/auth answer like 'canned'. */
  resetAt: number;
  wordMs: number;
  /** End a failing run by throwing, as the real SDK does when the CLI exits 1 (default true). */
  throwAtEnd?: boolean;
  now?: () => number;
  timeZone?: string;
}

/**
 * A stand-in for the Agent SDK that emits the message sequences a real run does, so the
 * fake modes exercise consumeAgentStream exactly like real traffic.
 */
export function fakeSdk(mode: FakeMode, opts: FakeSdkOptions): SdkLike {
  return { query: () => fakeStream(mode, opts) };
}

async function* fakeStream(mode: FakeMode, opts: FakeSdkOptions): AsyncGenerator<unknown> {
  const now = (opts.now ?? Date.now)();
  if (mode !== 'canned' && now < opts.resetAt) {
    const text = mode === 'rate_limit'
      ? `You've hit your session limit · resets ${formatResetLikeCli(opts.resetAt, opts.timeZone, now)}`
      : 'OAuth token revoked · Please run /login';
    yield { type: 'system', subtype: 'init' };
    yield { type: 'assistant', message: { content: [{ type: 'text', text }] }, error: mode === 'rate_limit' ? 'rate_limit' : 'authentication_failed' };
    yield { type: 'result', subtype: 'success', is_error: true, result: text };
    if (opts.throwAtEnd !== false) throw new Error('Claude Code process exited with code 1');
    return;
  }
  const canned = `Noesis local agent (fake mode) processed a "${opts.kind}" job. Prompt was: ${opts.promptText.slice(0, 80)}`;
  yield { type: 'stream_event', event: { type: 'message_start', message: {} } };
  const words = canned.split(' ');
  for (let i = 0; i < words.length; i++) {
    yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: (i ? ' ' : '') + words[i] } } };
    if (opts.wordMs > 0) await new Promise((r) => setTimeout(r, opts.wordMs));
  }
  yield { type: 'assistant', message: { content: [{ type: 'text', text: canned }] } };
  yield { type: 'result', subtype: 'success', is_error: false, result: canned };
}

/**
 * A reset time the way the Claude CLI prints it in its limit message: "3pm (Zone)",
 * "3:07pm (Zone)", or "Oct 12, 3pm (Zone)" when more than a day away — minutes, no seconds.
 */
export function formatResetLikeCli(atMs: number, timeZone?: string, nowMs: number = Date.now()): string {
  const zone = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
  }).formatToParts(new Date(atMs));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const minute = get('minute');
  const time = `${get('hour')}${minute && minute !== '00' ? `:${minute}` : ''}${get('dayPeriod').toLowerCase()}`;
  const date = atMs - nowMs > 24 * 60 * 60 * 1000 ? `${get('month')} ${get('day')}, ` : '';
  return `${date}${time} (${zone})`;
}

async function runJob(cfg: AgentConfig, job: ClaimedJob): Promise<void> {
  const sink = new EventSink(cfg, job.jobId, job.lease);
  sink.start();
  try {
    const text = await executeJob(cfg, job, sink);
    await sink.finish();
    if (sink.isClosed()) return; // lease lost; a fresh worker owns it now
    await api(cfg, `/api/agent/jobs/${job.jobId}/complete`, { lease: job.lease, result: { text } });
  } catch (err) {
    await sink.finish();
    if (sink.isClosed()) return;
    await api(cfg, `/api/agent/jobs/${job.jobId}/complete`, completionErrorBody(job.lease, err));
  }
}

/**
 * The daemon's startup banner line — pulled out of runAgentDaemon() so the printed
 * version string is directly unit-testable without starting the real (infinite) loop.
 */
export function startupBanner(cfg: AgentConfig): string {
  const fake = cfg.fake ? `, FAKE mode${cfg.fakeMode && cfg.fakeMode !== 'canned' ? ` (${cfg.fakeMode})` : ''}` : '';
  return `[noesis-agent] v${agentVersion()} started (concurrency=${cfg.concurrency}${fake}) → ${cfg.apiBaseUrl}`;
}

/** Run the daemon loop until aborted. */
export async function runAgentDaemon(cfg: AgentConfig, signal?: AbortSignal): Promise<void> {
  // Footgun guard: keep billing on the subscription, not the metered API.
  if (process.env.ANTHROPIC_API_KEY) {
    console.error('[noesis-agent] WARNING: ANTHROPIC_API_KEY is set — unsetting it so the Claude Agent SDK uses your subscription, not the metered API.');
    delete process.env.ANTHROPIC_API_KEY;
  }
  for (const warning of webFetchEnvWarnings(process.env)) console.error(warning);
  console.error(startupBanner(cfg));
  // Confirm the API token before polling: an expired token is explained and waited out
  // (it recovers after an Extend); a revoked or unknown one ends the process here.
  applyStartupCheck(await checkToken(cfg.apiBaseUrl, cfg.apiToken), tokenGate);

  const workers = Array.from({ length: cfg.concurrency }, (_, i) => workerLoop(cfg, `worker-${i + 1}`, signal));
  await Promise.all(workers);
}

async function workerLoop(cfg: AgentConfig, workerId: string, signal?: AbortSignal): Promise<void> {
  while (!signal?.aborted) {
    let job: ClaimedJob | null = null;
    try {
      job = await claim(cfg, workerId);
    } catch {
      /* transient; back off below */
    }
    if (job) {
      console.error(`[noesis-agent] ${workerId} claimed ${job.kind} job ${job.jobId.slice(0, 8)}`);
      await runJob(cfg, job);
    } else {
      await sleep(tokenGate.waitMs(POLL_INTERVAL_MS), signal);
    }
  }
}
