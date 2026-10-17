/**
 * The token handling wired into the REAL daemon loop (runAgentDaemon) and MCP client,
 * with a stubbed global fetch and fake timers: startup outcomes, one shared gate across
 * workers, the 60 s backoff while refused, and the once-a-day warning shared between the
 * startup check and the claim answers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfig } from '../src/agent/runner.js';

const DAY = 86_400_000;
const cfg = (concurrency = 2): AgentConfig => ({ apiBaseUrl: 'https://x.test', apiToken: 'noe_test', concurrency, fake: true, fakeMode: 'canned' });
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

let lines: string[];
let claims: number;

/** A fresh runner module per test: its shared TokenGate must not leak between tests. */
async function freshRunner() {
  vi.resetModules();
  return import('../src/agent/runner.js');
}

function stubServer(answer: { token: () => Response; claim: () => Response }) {
  claims = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/api/agent/token')) return answer.token();
    if (url.endsWith('/api/agent/jobs/claim')) { claims += 1; return answer.claim(); }
    throw new Error(`unexpected ${url}`);
  }));
}

beforeEach(() => {
  process.env.NOESIS_AGENT_ID = 'test-token-daemon'; // identity from env: no daemon-id file is written
  lines = [];
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(new Date('2026-10-17T03:00:00.000Z'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.NOESIS_AGENT_ID;
});

describe('runAgentDaemon — startup token check', () => {
  it('a revoked token ends the daemon before any claim', async () => {
    stubServer({ token: () => json(401, { error_code: 'API_TOKEN_REVOKED', tokenName: 'Win' }), claim: () => json(200, { job: null }) });
    const { runAgentDaemon } = await freshRunner();
    await expect(runAgentDaemon(cfg())).rejects.toThrow(/"Win" was revoked/);
    expect(claims).toBe(0);
  });

  it('an unknown token ends the daemon before any claim — current code or older text', async () => {
    for (const body of [
      { error: 'Invalid API token', error_code: 'API_TOKEN_INVALID' },
      { error: 'Invalid API token (sent: noe_abcd...wxyz) — token not found in database' },
    ]) {
      stubServer({ token: () => json(401, body), claim: () => json(200, { job: null }) });
      const { runAgentDaemon } = await freshRunner();
      await expect(runAgentDaemon(cfg())).rejects.toThrow(/did not recognise this API token/);
      expect(claims).toBe(0);
    }
  });

  it('a token that expires WHILE the daemon runs is explained as expired, with its name and date', async () => {
    let expired = false;
    const claim = () => (expired
      ? json(401, { error_code: 'API_TOKEN_EXPIRED', tokenName: 'Mac', expiresAt: '2026-10-17T03:00:01.000Z' })
      : json(200, { job: null }));
    stubServer({ token: () => json(200, { name: 'Mac', expiresAt: '2026-10-17T03:00:01.000Z', daysLeft: 0 }), claim });
    const { runAgentDaemon } = await freshRunner();
    const controller = new AbortController();
    const running = runAgentDaemon(cfg(2), controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(lines.some((l) => /expired on|recognise/.test(l))).toBe(false); // accepted at startup
    expired = true;
    await vi.advanceTimersByTimeAsync(2_500);
    const refusals = lines.filter((l) => /expired on|recognise|revoked/.test(l));
    expect(refusals).toEqual([expect.stringMatching(/"Mac" expired on 2026-10-17 03:00 UTC\. Extend it in Settings → API Tokens/)]);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    await running;
  });

  it('an expired token: ONE line across startup and both workers, and no re-claim before the 60 s backoff', async () => {
    const expired = () => json(401, { error_code: 'API_TOKEN_EXPIRED', tokenName: 'Mac', expiresAt: '2026-10-14T04:08:24.939Z' });
    stubServer({ token: expired, claim: expired });
    const { runAgentDaemon } = await freshRunner();
    const controller = new AbortController();
    const running = runAgentDaemon(cfg(2), controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(claims).toBe(2); // each worker tried once
    expect(lines.filter((l) => l.includes('expired on'))).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(claims).toBe(2); // still backing off (a 2 s poll would have claimed ~58 more times)
    await vi.advanceTimersByTimeAsync(1_500);
    expect(claims).toBe(4);
    expect(lines.filter((l) => l.includes('expired on'))).toHaveLength(1);
    controller.abort(); // the backoff sleep wakes at once on shutdown
    await vi.advanceTimersByTimeAsync(0);
    await expect(running).resolves.toBeUndefined();
  });

  it('after an Extend the next claim is accepted: one "accepted again" line, normal polling resumes', async () => {
    let extended = false;
    const tokenAnswer = () => (extended
      ? json(200, { job: null }, { 'X-Noesis-Token-Expires': new Date(Date.now() + 90 * DAY).toISOString() })
      : json(401, { error_code: 'API_TOKEN_EXPIRED', tokenName: 'Mac' }));
    stubServer({ token: tokenAnswer, claim: tokenAnswer });
    const { runAgentDaemon } = await freshRunner();
    const controller = new AbortController();
    const running = runAgentDaemon(cfg(2), controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    extended = true;
    await vi.advanceTimersByTimeAsync(60_500);
    expect(lines.filter((l) => l.includes('accepted again'))).toHaveLength(1);
    const after = claims;
    await vi.advanceTimersByTimeAsync(4_500);
    expect(claims - after).toBeGreaterThanOrEqual(2); // back to the 2 s poll
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    await running;
  });

  it('the startup warning and the claim answers share one warning a day', async () => {
    const soon = new Date(Date.now() + 3 * DAY + 3_600_000).toISOString();
    stubServer({
      token: () => json(200, { name: 'Mac', expiresAt: soon, daysLeft: 3 }),
      claim: () => json(200, { job: null }, { 'X-Noesis-Token-Expires': soon }),
    });
    const { runAgentDaemon } = await freshRunner();
    const controller = new AbortController();
    const running = runAgentDaemon(cfg(2), controller.signal);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(claims).toBeGreaterThanOrEqual(4);
    expect(lines.filter((l) => l.includes('expires in 3 days'))).toHaveLength(1);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    await running;
  });

  it('an older server without the check (its JWT layer answers TOKEN_INVALID) starts normally', async () => {
    stubServer({ token: () => json(401, { error: 'Invalid token', error_code: 'TOKEN_INVALID' }), claim: () => json(200, { job: null }) });
    const { runAgentDaemon } = await freshRunner();
    const controller = new AbortController();
    const running = runAgentDaemon(cfg(1), controller.signal);
    await vi.advanceTimersByTimeAsync(4_500);
    expect(claims).toBeGreaterThanOrEqual(2);
    expect(lines.some((l) => /recognise|revoked|expired/.test(l))).toBe(false);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    await running;
  });
});

describe('NoesisClient — expired-token hint on real calls', () => {
  it('request() errors carry where to extend an expired token', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(401, { error: 'API token has expired (name: "Mac", expired: 2026-10-14T04:08:24.939Z, sent: x)', error_code: 'API_TOKEN_EXPIRED' })));
    const { NoesisClient } = await import('../src/api/NoesisClient.js');
    await expect(new NoesisClient('https://x.test', 'noe_t').getRoots()).rejects.toThrow(/extend it in Noesis Settings → API Tokens/);
  });

  it('the exam path (its own error handling) carries it too', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(401, { error: 'API token has expired', error_code: 'API_TOKEN_EXPIRED' })));
    const { NoesisClient } = await import('../src/api/NoesisClient.js');
    const client = new NoesisClient('https://x.test', 'noe_t');
    const exam = {
      title: 'Sample Exam', date: '2026-07-31', totalPoints: 5,
      sections: [{ title: 'Section I', instructions: 'Answer.', points: 5,
        questions: [{ type: 'short-answer', id: 'sa-1', questionNum: 1, prompt: 'What is 2+2?', referenceAnswer: '4' }] }],
    };
    await expect(client.createExamFromData(exam as never)).rejects.toThrow(/extend it in Noesis Settings → API Tokens/);
  });
});
