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

const POLL_INTERVAL_MS = 2000;      // idle poll cadence
const CHUNK_FLUSH_MS = 500;         // batch streamed deltas before POST /events
const KEEPALIVE_MS = 30_000;        // hold the lease during quiet stretches (< server's 120s stale)
const MAX_CONCURRENCY = 2;

export interface AgentConfig {
  apiBaseUrl: string;
  apiToken: string;
  concurrency: number;
  fake: boolean; // NOESIS_AGENT_FAKE=1 → canned executor (queue-plumbing e2e, no Claude)
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
  return { apiBaseUrl, apiToken, concurrency, fake: process.env.NOESIS_AGENT_FAKE === '1' };
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
}

async function api(cfg: AgentConfig, path: string, body: unknown): Promise<Response> {
  return fetch(`${cfg.apiBaseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiToken}` },
    body: JSON.stringify(body),
  });
}

async function claim(cfg: AgentConfig, workerId: string): Promise<ClaimedJob | null> {
  const res = await api(cfg, '/api/agent/jobs/claim', { workerId });
  if (!res.ok) return null;
  const data = (await res.json()) as { job: ClaimedJob | null };
  return data.job ?? null;
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
 * Execute a claimed job and stream its output through the sink. Returns the final
 * text. Real mode runs the Claude Agent SDK on the user's subscription; fake mode
 * emits a canned response so the queue plumbing can be verified without a login.
 */
async function executeJob(cfg: AgentConfig, job: ClaimedJob, sink: EventSink): Promise<string> {
  const prompt = job.payload.prompt ?? `(${job.kind} job with empty prompt)`;

  if (cfg.fake) {
    const canned = `Noesis local agent (fake mode) processed a "${job.kind}" job. Prompt was: ${prompt.slice(0, 80)}`;
    for (const word of canned.split(' ')) {
      if (sink.isClosed()) break;
      sink.push(word + ' ');
      await new Promise((r) => setTimeout(r, 15));
    }
    return canned;
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
  let finalText = '';
  let sawDelta = false;
  let terminalText = '';
  const stream = sdk.query({
    prompt,
    options: {
      ...(job.payload.system ? { systemPrompt: job.payload.system } : {}),
      allowedTools: job.payload.allowedTools ?? [],
      maxTurns: job.payload.maxTurns ?? 1,
      includePartialMessages: true,
    },
  });
  // With includePartialMessages the stream carries BOTH incremental `stream_event`
  // deltas AND a terminal `assistant` message holding the whole reply. Taking both
  // would emit the answer twice, so deltas win and the terminal message is only a
  // fallback for a stream that produced none (older SDK, or partials unsupported).
  for await (const message of stream) {
    if (sink.isClosed()) break;
    const delta = extractStreamDelta(message);
    if (delta) {
      sawDelta = true;
      sink.push(delta);
      finalText += delta;
      continue;
    }
    const whole = extractTerminalText(message);
    if (whole) terminalText = whole;
  }
  if (!sawDelta && terminalText) {
    sink.push(terminalText);
    finalText = terminalText;
  }
  return finalText;
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
    await api(cfg, `/api/agent/jobs/${job.jobId}/complete`, {
      lease: job.lease,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Run the daemon loop until aborted. */
export async function runAgentDaemon(cfg: AgentConfig, signal?: AbortSignal): Promise<void> {
  // Footgun guard: keep billing on the subscription, not the metered API.
  if (process.env.ANTHROPIC_API_KEY) {
    console.error('[noesis-agent] WARNING: ANTHROPIC_API_KEY is set — unsetting it so the Claude Agent SDK uses your subscription, not the metered API.');
    delete process.env.ANTHROPIC_API_KEY;
  }
  console.error(`[noesis-agent] started (concurrency=${cfg.concurrency}${cfg.fake ? ', FAKE mode' : ''}) → ${cfg.apiBaseUrl}`);

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
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }
}
