import { describe, it, expect } from 'vitest';
import {
  consumeAgentStream,
  TURN_LIMIT_NOTE,
  AgentRunError,
  claimBody,
  completionErrorBody,
  fakeSdk,
  formatResetLikeCli,
  runSdkQuery,
  resolveAgentConfig,
} from '../src/agent/runner.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * How the daemon turns an SDK message stream into the saved reply. Web research makes
 * multi-turn runs the norm — "let me read both pages" -> tools -> the answer — so the
 * shapes below are what a real WebFetch job emits (see the 2026-09-27 spike transcripts).
 */
const start = () => ({ type: 'stream_event', event: { type: 'message_start', message: {} } });
const delta = (text: string) => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
const assistant = (...content: unknown[]) => ({ type: 'assistant', message: { content } });
const toolUse = (name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id: `t-${name}`, name, input });
const result = (subtype = 'success') => ({ type: 'result', subtype });

async function* fromArray(messages: unknown[]) {
  for (const m of messages) yield m;
}

function sink(closeAfter = Infinity) {
  const pushed: string[] = [];
  return {
    pushed,
    push(text: string) { pushed.push(text); },
    isClosed() { return pushed.length >= closeAfter; },
  };
}

const quiet = () => {};

describe('consumeAgentStream', () => {
  it('passes a single-turn reply through unchanged', async () => {
    const out = sink();
    const text = await consumeAgentStream(fromArray([start(), delta('Hello'), delta(' world'), assistant({ type: 'text', text: 'Hello world' }), result()]), out, quiet);
    expect(text).toBe('Hello world');
    expect(out.pushed.join('')).toBe('Hello world');
  });

  // Without the break the saved reply read "讓我先擷取兩個頁面的資訊：成功取得兩個產品的資訊！".
  it('separates the narration turn from the answer turn with one paragraph break', async () => {
    const out = sink();
    const text = await consumeAgentStream(fromArray([
      start(), delta('Let me read both pages:'), assistant({ type: 'text', text: 'Let me read both pages:' }, toolUse('WebFetch', { url: 'https://a.example/' })),
      start(), delta('Here is the comparison.'), result(),
    ]), out, quiet);
    expect(text).toBe('Let me read both pages:\n\nHere is the comparison.');
    expect(out.pushed.join('')).toBe(text); // the live stream and the saved text agree
  });

  it('adds exactly one break across a tool-only turn in between', async () => {
    const text = await consumeAgentStream(fromArray([
      start(), delta('A'),
      start(), assistant(toolUse('WebSearch', { query: 'q' })),       // tool-only turn: no text
      start(), delta('B'),
    ]), sink(), quiet);
    expect(text).toBe('A\n\nB');
  });

  it('adds no break before the first text, even after tool-only turns', async () => {
    const text = await consumeAgentStream(fromArray([
      start(), assistant(toolUse('WebFetch', { url: 'https://a.example/' })),
      start(), delta('Answer'),
    ]), sink(), quiet);
    expect(text).toBe('Answer');
  });

  it('does not stack breaks when the earlier turn already ended with one', async () => {
    expect(await consumeAgentStream(fromArray([start(), delta('A\n'), start(), delta('B')]), sink(), quiet)).toBe('A\n\nB');
    expect(await consumeAgentStream(fromArray([start(), delta('A\n\n'), start(), delta('B')]), sink(), quiet)).toBe('A\n\nB');
  });

  it('falls back to terminal assistant text when no deltas arrive, one paragraph per turn', async () => {
    const out = sink();
    const text = await consumeAgentStream(fromArray([
      assistant({ type: 'text', text: 'First' }, toolUse('WebFetch', { url: 'https://a.example/' })),
      assistant({ type: 'text', text: 'Second' }),
      result(),
    ]), out, quiet);
    expect(text).toBe('First\n\nSecond');
    expect(out.pushed).toEqual(['First\n\nSecond']);
  });

  it('never emits the reply twice when both deltas and terminal messages arrive', async () => {
    const text = await consumeAgentStream(fromArray([start(), delta('Once'), assistant({ type: 'text', text: 'Once' }), result()]), sink(), quiet);
    expect(text).toBe('Once');
  });

  it('says so when the run hit the turn limit, instead of saving narration as the answer', async () => {
    const out = sink();
    const text = await consumeAgentStream(fromArray([start(), delta('Let me check the official page.'), assistant(toolUse('WebFetch', { url: 'https://a.example/' })), result('error_max_turns')]), out, quiet);
    expect(text).toBe(`Let me check the official page.${TURN_LIMIT_NOTE}`);
    expect(out.pushed.join('')).toBe(text);
  });

  it('shows the limit note without leading blank lines when nothing else was said', async () => {
    const text = await consumeAgentStream(fromArray([start(), assistant(toolUse('WebSearch', { query: 'q' })), result('error_max_turns')]), sink(), quiet);
    expect(text).toBe(TURN_LIMIT_NOTE.trimStart());
  });

  it('adds no note to a run that finished normally', async () => {
    const text = await consumeAgentStream(fromArray([start(), delta('Done'), result('success')]), sink(), quiet);
    expect(text).toBe('Done');
  });

  // canUseTool never sees WebFetch to the ~85 doc hosts the CLI pre-approves itself, so the
  // stream is the only complete record of what a Navi fetched.
  it('logs every tool call from the stream with its URL or query', async () => {
    const calls: Array<[string, string | undefined]> = [];
    await consumeAgentStream(fromArray([
      start(),
      assistant(
        toolUse('WebFetch', { url: 'https://docs.python.org/3/', prompt: 'x' }),
        toolUse('WebSearch', { query: 'BenQ ScreenBar Pro specs' }),
        toolUse('mcp__noesis__get_note', { id: 7 }),
      ),
    ]), sink(), (name, detail) => calls.push([name, detail]));
    expect(calls).toEqual([
      ['WebFetch', 'https://docs.python.org/3/'],
      ['WebSearch', 'BenQ ScreenBar Pro specs'],
      ['mcp__noesis__get_note', undefined],
    ]);
  });

  it('stops consuming once the sink is closed (lease lost)', async () => {
    const out = sink(1);
    const text = await consumeAgentStream(fromArray([start(), delta('A'), delta('B'), result('error_max_turns')]), out, quiet);
    expect(out.pushed).toEqual(['A']);
    expect(text).toBe('A');
  });
});

// What SDK 0.1.77 / its bundled CLI emits on a subscription usage limit (traced in cli.js):
// an assistant message carrying `error: 'rate_limit'` and the limit text, a `success`
// result with is_error, then the CLI exits 1 and the SDK throws a bare exit-code error.
const LIMIT = "You've hit your session limit · resets 3pm (America/Los_Angeles)";
const apiErrorMsg = (text: string, error: string, extra: Record<string, unknown> = {}) => ({
  type: 'assistant',
  message: { content: [{ type: 'text', text }] },
  error,
  ...extra,
});
const errorResult = (text: string) => ({ type: 'result', subtype: 'success', is_error: true, result: text });

async function* thenThrow(messages: unknown[], err = new Error('Claude Code process exited with code 1')) {
  for (const m of messages) yield m;
  throw err;
}

describe('consumeAgentStream — Claude API failures', () => {
  it('a usage limit (SDK throws at the end) becomes AgentRunError with the limit text and code', async () => {
    const out = sink();
    const p = consumeAgentStream(thenThrow([{ type: 'system', subtype: 'init' }, apiErrorMsg(LIMIT, 'rate_limit'), errorResult(LIMIT)]), out, quiet);
    await expect(p).rejects.toBeInstanceOf(AgentRunError);
    await expect(p).rejects.toMatchObject({ message: LIMIT, code: 'rate_limit' });
    expect(out.pushed.join('')).not.toContain("hit your");
  });

  it('the same sequence WITHOUT a throw still fails — the limit text never completes as a reply', async () => {
    const out = sink();
    const p = consumeAgentStream(fromArray([apiErrorMsg(LIMIT, 'rate_limit'), errorResult(LIMIT)]), out, quiet);
    await expect(p).rejects.toMatchObject({ message: LIMIT, code: 'rate_limit' });
    expect(out.pushed).toEqual([]);
  });

  it('a revoked login reports authentication_failed', async () => {
    const t = 'OAuth token revoked · Please run /login';
    await expect(consumeAgentStream(thenThrow([apiErrorMsg(t, 'authentication_failed'), errorResult(t)]), sink(), quiet)).rejects.toMatchObject({
      message: t,
      code: 'authentication_failed',
    });
  });

  it('forwards a numeric reset when the message carries one', async () => {
    const msg = apiErrorMsg(LIMIT, 'rate_limit', { quotaLimits: { resetsAt: 1791640800 } });
    await expect(consumeAgentStream(fromArray([msg, errorResult(LIMIT)]), sink(), quiet)).rejects.toMatchObject({ resetsAt: 1791640800 });
  });

  it('an is_error result with no assistant error reports its own text as code unknown', async () => {
    await expect(consumeAgentStream(thenThrow([errorResult('API Error: 500 upstream')]), sink(), quiet)).rejects.toMatchObject({
      message: 'API Error: 500 upstream',
      code: 'unknown',
    });
  });

  it('an SDK throw with no failure message before it is rethrown unchanged', async () => {
    const boom = new Error('spawn ENOENT');
    await expect(consumeAgentStream(thenThrow([start(), delta('Hi')], boom), sink(), quiet)).rejects.toBe(boom);
  });

  it('a run that recovers after an error message (success result) returns the reply, without the error text', async () => {
    const out = sink();
    const text = await consumeAgentStream(fromArray([apiErrorMsg('Request timed out', 'unknown'), start(), delta('Answer'), result()]), out, quiet);
    expect(text).toBe('Answer');
    expect(out.pushed.join('')).toBe('Answer');
  });

  it('a failure on a later turn keeps the earlier streamed text out of the error but still fails', async () => {
    const out = sink();
    const p = consumeAgentStream(thenThrow([start(), delta('Let me look'), apiErrorMsg(LIMIT, 'rate_limit'), errorResult(LIMIT)]), out, quiet);
    await expect(p).rejects.toMatchObject({ code: 'rate_limit' });
    expect(out.pushed.join('')).toBe('Let me look');
  });
});

describe('completionErrorBody', () => {
  it('adds the SDK code (and reset) for an AgentRunError, nothing extra otherwise', () => {
    expect(completionErrorBody('L', new AgentRunError(LIMIT, 'rate_limit', 1791640800))).toEqual({
      lease: 'L', error: LIMIT, errorCode: 'rate_limit', resetsAt: 1791640800,
    });
    expect(completionErrorBody('L', new AgentRunError('x', 'unknown'))).toEqual({ lease: 'L', error: 'x', errorCode: 'unknown' });
    expect(completionErrorBody('L', new Error('Claude Code process exited with code 1'))).toEqual({
      lease: 'L', error: 'Claude Code process exited with code 1',
    });
  });
});

describe('claimBody', () => {
  it('carries the machine identity next to workerId + agentVersion', () => {
    const body = claimBody('worker-2', { daemonId: 'mac-1', bootId: 'b-1', label: 'MacBook', platform: 'darwin' });
    expect(body).toMatchObject({ workerId: 'worker-2', daemonId: 'mac-1', bootId: 'b-1', label: 'MacBook', platform: 'darwin' });
    expect(typeof body.agentVersion).toBe('string');
  });
});

describe('formatResetLikeCli', () => {
  const now = Date.parse('2026-10-10T02:00:00Z'); // 10:00 Taipei
  it('prints "3pm (Zone)", minutes only when non-zero, and a date beyond a day', () => {
    expect(formatResetLikeCli(Date.parse('2026-10-10T07:00:00Z'), 'Asia/Taipei', now)).toBe('3pm (Asia/Taipei)');
    expect(formatResetLikeCli(Date.parse('2026-10-10T07:07:40Z'), 'Asia/Taipei', now)).toBe('3:07pm (Asia/Taipei)');
    expect(formatResetLikeCli(Date.parse('2026-10-12T07:00:00Z'), 'Asia/Taipei', now)).toBe('Oct 12, 3pm (Asia/Taipei)');
  });
});

describe('fake modes run through the real stream handling', () => {
  const base = { kind: 'chat', promptText: 'hello there', wordMs: 0, timeZone: 'Asia/Taipei' };
  const run = (mode: 'canned' | 'rate_limit' | 'auth', extra: Record<string, unknown> = {}) =>
    consumeAgentStream(runSdkQuery(fakeSdk(mode, { ...base, resetAt: Date.parse('2026-10-10T07:00:00Z'), now: () => Date.parse('2026-10-10T02:00:00Z'), ...extra }), {}, 'chat', () => ({})), sink(), quiet);

  it('rate_limit before its reset fails like a real limit, reset printed like the CLI', async () => {
    await expect(run('rate_limit')).rejects.toMatchObject({
      code: 'rate_limit',
      message: "You've hit your session limit · resets 3pm (Asia/Taipei)",
    });
  });

  it('rate_limit also fails in the normal-return variant', async () => {
    await expect(run('rate_limit', { throwAtEnd: false })).rejects.toMatchObject({ code: 'rate_limit' });
  });

  it('auth fails with authentication_failed', async () => {
    await expect(run('auth')).rejects.toMatchObject({ code: 'authentication_failed' });
  });

  it('after the reset a rate_limit fake answers with the canned text', async () => {
    const text = await run('rate_limit', { now: () => Date.parse('2026-10-10T07:00:01Z') });
    expect(text).toBe('Noesis local agent (fake mode) processed a "chat" job. Prompt was: hello there');
  });

  it('canned mode keeps its exact text (callers tell fake replies apart by it)', async () => {
    expect(await run('canned')).toBe('Noesis local agent (fake mode) processed a "chat" job. Prompt was: hello there');
  });
});

describe('API failures — gaps the INC-4 checker found', () => {
  it('a recovered run WITHOUT deltas never lets the error text into the reply or the sink', async () => {
    const out = sink();
    const text = await consumeAgentStream(
      fromArray([apiErrorMsg(LIMIT, 'rate_limit'), assistant({ type: 'text', text: 'Answer' }), { type: 'result', subtype: 'success', is_error: false, result: 'Answer' }]),
      out,
      quiet,
    );
    expect(text).toBe('Answer');
    expect(out.pushed.join('')).toBe('Answer');
  });

  const opts = { kind: 'chat', promptText: 'p', wordMs: 0, timeZone: 'UTC', resetAt: 2000, now: () => 1000 };
  async function drain(it: AsyncIterable<unknown>) {
    const ms: unknown[] = [];
    for await (const m of it) ms.push(m);
    return ms;
  }

  it('the fake failure stream THROWS at the end by default, like the real SDK', async () => {
    await expect(drain(fakeSdk('rate_limit', opts).query({ prompt: '', options: {} }))).rejects.toThrow(
      'Claude Code process exited with code 1',
    );
  });

  it('with throwAtEnd:false it ends normally after init, the error message and the is_error result', async () => {
    const ms = (await drain(fakeSdk('rate_limit', { ...opts, throwAtEnd: false }).query({ prompt: '', options: {} }))) as Array<Record<string, unknown>>;
    expect(ms.map((m) => m.type)).toEqual(['system', 'assistant', 'result']);
    expect(ms[1].error).toBe('rate_limit');
    expect(ms[2].is_error).toBe(true);
  });

  it('at exactly resetAt the fake has recovered', async () => {
    const text = await consumeAgentStream(fakeSdk('rate_limit', { ...opts, now: () => 2000 }).query({ prompt: '', options: {} }), sink(), quiet);
    expect(text).toContain('fake mode');
  });
});

describe('fake-mode config (a typo must never fall through to the REAL SDK)', () => {
  const keys = ['NOESIS_API_URL', 'NOESIS_API_TOKEN', 'NOESIS_AGENT_FAKE', 'NOESIS_AGENT_FAKE_RESET_MIN', 'NOESIS_AGENT_FAKE_WORD_MS'] as const;
  function withEnv<T>(env: Partial<Record<(typeof keys)[number], string>>, fn: () => T): T {
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    try {
      for (const k of keys) delete process.env[k];
      Object.assign(process.env, { NOESIS_API_URL: 'http://x', NOESIS_API_TOKEN: 't' }, env);
      return fn();
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  }

  it('parses every fake mode, and nothing else', () => {
    expect(withEnv({ NOESIS_AGENT_FAKE: 'rate_limit' }, resolveAgentConfig)).toMatchObject({ fake: true, fakeMode: 'rate_limit' });
    expect(withEnv({ NOESIS_AGENT_FAKE: 'auth' }, resolveAgentConfig)).toMatchObject({ fake: true, fakeMode: 'auth' });
    expect(withEnv({ NOESIS_AGENT_FAKE: '1' }, resolveAgentConfig)).toMatchObject({ fake: true, fakeMode: 'canned' });
    expect(withEnv({ NOESIS_AGENT_FAKE: 'canned' }, resolveAgentConfig)).toMatchObject({ fake: true, fakeMode: 'canned' });
    expect(withEnv({}, resolveAgentConfig)).toMatchObject({ fake: false, fakeMode: undefined });
  });

  it('NOESIS_AGENT_FAKE_RESET_MIN and _WORD_MS are honoured', () => {
    const before = Date.now();
    const cfg = withEnv({ NOESIS_AGENT_FAKE: 'rate_limit', NOESIS_AGENT_FAKE_RESET_MIN: '7', NOESIS_AGENT_FAKE_WORD_MS: '40' }, resolveAgentConfig);
    expect(cfg.fakeResetAt! - before).toBeGreaterThanOrEqual(7 * 60_000);
    expect(cfg.fakeResetAt! - before).toBeLessThan(7 * 60_000 + 5_000);
    expect(cfg.fakeWordMs).toBe(40);
  });
});

describe('source fitness — the tested pieces are the ones the daemon actually uses', () => {
  const SRC = readFileSync(fileURLToPath(new URL('../src/agent/runner.ts', import.meta.url)), 'utf8');
  const body = (fn: string) => {
    const start = SRC.indexOf(fn);
    expect(start, `${fn} not found`).toBeGreaterThanOrEqual(0);
    return SRC.slice(start, SRC.indexOf('\n}\n', start));
  };

  it('runJob reports failures through completionErrorBody (so errorCode reaches the server)', () => {
    expect(body('async function runJob(')).toContain('completionErrorBody(job.lease, err)');
  });

  it('claim sends claimBody with the machine identity', () => {
    expect(body('async function claim(')).toContain('claimBody(workerId, daemonIdentity())');
  });

  it("executeJob's fake branch goes through runSdkQuery + consumeAgentStream like real traffic", () => {
    expect(body('async function executeJob(')).toMatch(/consumeAgentStream\(runSdkQuery\(fake,/);
  });
});
