/**
 * The local agent's API-token handling (2.3.1): the startup check, the shared runtime
 * gate (one log line per change, 60 s backoff while refused, resume message), the
 * expires-soon warning, and the MCP client's hint for an expired token.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  REJECTED_BACKOFF_MS,
  TokenGate,
  applyStartupCheck,
  checkToken,
  classifyRefusal,
  describeRefusal,
} from '../src/agent/tokenState.js';
import { handleClaimResponse } from '../src/agent/runner.js';
import { explainTokenError } from '../src/api/NoesisClient.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-17T03:00:00.000Z');

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}
const OLD_EXPIRED_TEXT =
  'API token has expired (name: "MacBook-cc-Jul-16-2026", expired: 2026-10-14T04:08:24.939Z, sent: noe_befae4*****32136)';

describe('classifyRefusal', () => {
  it('reads the error_code a current server sends', () => {
    expect(classifyRefusal({ error_code: 'API_TOKEN_EXPIRED', tokenName: 'Mac', expiresAt: '2026-10-14T04:08:24.939Z' }))
      .toEqual({ kind: 'expired', name: 'Mac', expiresAt: '2026-10-14T04:08:24.939Z' });
    expect(classifyRefusal({ error_code: 'API_TOKEN_REVOKED', tokenName: 'Win' })).toEqual({ kind: 'revoked', name: 'Win' });
    expect(classifyRefusal({ error_code: 'API_TOKEN_INVALID' })).toEqual({ kind: 'invalid' });
  });

  it("falls back to an older server's text, name and date included", () => {
    expect(classifyRefusal({ error: OLD_EXPIRED_TEXT }))
      .toEqual({ kind: 'expired', name: 'MacBook-cc-Jul-16-2026', expiresAt: '2026-10-14T04:08:24.939Z' });
    expect(classifyRefusal({ error: 'API token has been revoked (name: "Win", sent: noe_x)' }))
      .toEqual({ kind: 'revoked', name: 'Win' });
    expect(classifyRefusal({ error: 'No authentication provided' })).toEqual({ kind: 'invalid' });
    expect(classifyRefusal(null)).toEqual({ kind: 'invalid' });
  });

  it('error_code wins over the text', () => {
    expect(classifyRefusal({ error_code: 'API_TOKEN_INVALID', error: OLD_EXPIRED_TEXT })).toEqual({ kind: 'invalid' });
  });
});

describe('describeRefusal', () => {
  it('says what happened, which token, when, and where to fix it', () => {
    const line = describeRefusal({ kind: 'expired', name: 'Mac', expiresAt: '2026-10-14T04:08:24.939Z' });
    expect(line).toContain('"Mac"');
    expect(line).toContain('expired on 2026-10-14 04:08 UTC');
    expect(line).toContain('Settings → API Tokens');
    expect(line).toContain('resumes by itself');
    expect(describeRefusal({ kind: 'revoked', name: 'Win' })).toContain('was revoked');
    expect(describeRefusal({ kind: 'invalid' })).toContain('did not recognise');
  });
});

describe('checkToken (startup)', () => {
  it('asks GET /api/agent/token with the token and returns its answer', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { name: 'Mac', expiresAt: '2027-01-12T10:31:06.072Z', daysLeft: 87 }));
    const check = await checkToken('https://x.test', 'noe_abc', fetchImpl as unknown as typeof fetch);
    expect(check).toEqual({ kind: 'ok', name: 'Mac', expiresAt: '2027-01-12T10:31:06.072Z', daysLeft: 87 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://x.test/api/agent/token');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer noe_abc');
  });

  it('a 401 is a refusal, classified', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(401, { error: OLD_EXPIRED_TEXT }));
    expect(await checkToken('https://x.test', 't', fetchImpl as unknown as typeof fetch))
      .toEqual({ kind: 'refused', refusal: { kind: 'expired', name: 'MacBook-cc-Jul-16-2026', expiresAt: '2026-10-14T04:08:24.939Z' } });
  });

  it("a 401 carrying another layer's code (an older server routes the path on to a JWT check) is skipped, not 'unknown token'", async () => {
    // Measured on the pre-2.3.1 backend: a VALID noe_ token gets {"error":"Invalid token","error_code":"TOKEN_INVALID"}.
    const fetchImpl = vi.fn(async () => jsonResponse(401, { error: 'Invalid token', error_code: 'TOKEN_INVALID' }));
    const check = await checkToken('https://x.test', 'noe_abc', fetchImpl as unknown as typeof fetch);
    expect(check.kind).toBe('skip');
  });

  it('an unknown token is refused, never skipped — whether the server says so by code or by its older text', async () => {
    for (const body of [
      { error: 'Invalid API token', error_code: 'API_TOKEN_INVALID' },
      { error: 'Invalid API token (sent: noe_abcd...wxyz) — token not found in database' }, // pre-2.3.1 backend
    ]) {
      const fetchImpl = vi.fn(async () => jsonResponse(401, body));
      expect(await checkToken('https://x.test', 'noe_abc', fetchImpl as unknown as typeof fetch))
        .toEqual({ kind: 'refused', refusal: { kind: 'invalid' } });
    }
  });

  it("a token without the noe_ prefix never reached the token layer: the JWT layer's TOKEN_INVALID is a refusal", async () => {
    // e.g. an unexpanded "${NOESIS_API_TOKEN}" in the config
    const fetchImpl = vi.fn(async () => jsonResponse(401, { error: 'Invalid token', error_code: 'TOKEN_INVALID' }));
    expect(await checkToken('https://x.test', '${NOESIS_API_TOKEN}', fetchImpl as unknown as typeof fetch))
      .toEqual({ kind: 'refused', refusal: { kind: 'invalid' } });
  });

  it('a server without the check (404), any other status or no network is skipped, never thrown', async () => {
    for (const fetchImpl of [
      vi.fn(async () => jsonResponse(404, { error: 'Not found' })),
      vi.fn(async () => jsonResponse(500, {})),
      vi.fn(async () => { throw new Error('ECONNREFUSED'); }),
      vi.fn(async () => jsonResponse(200, { name: 'x' })), // no expiresAt/daysLeft
    ]) {
      const check = await checkToken('https://x.test', 't', fetchImpl as unknown as typeof fetch);
      expect(check.kind).toBe('skip');
    }
  });
});

describe('applyStartupCheck', () => {
  const ok = (daysLeft: number) => ({ kind: 'ok' as const, name: 'Mac', expiresAt: new Date(NOW + daysLeft * DAY).toISOString(), daysLeft });

  it('a healthy token starts quietly; one expiring within 7 days warns, with its name', () => {
    const log = vi.fn();
    applyStartupCheck(ok(87), new TokenGate(log, () => NOW));
    expect(log).not.toHaveBeenCalled();
    applyStartupCheck(ok(7), new TokenGate(log, () => NOW));
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain('"Mac" expires in 7 days');
  });

  it('the startup warning and the claim answers share ONE warning a day', async () => {
    const log = vi.fn();
    const gate = new TokenGate(log, () => NOW);
    applyStartupCheck(ok(3), gate);
    await handleClaimResponse(
      jsonResponse(200, { job: null }, { 'X-Noesis-Token-Expires': new Date(NOW + 3 * DAY).toISOString() }),
      gate,
    );
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('an EXPIRED token is explained and waited out — the agent does not exit', () => {
    const log = vi.fn();
    const gate = new TokenGate(log);
    expect(() => applyStartupCheck({ kind: 'refused', refusal: { kind: 'expired', name: 'Mac' } }, gate)).not.toThrow();
    expect(gate.isRefused).toBe(true);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain('expired');
  });

  it('a revoked or unknown token ends the process with the reason', () => {
    expect(() => applyStartupCheck({ kind: 'refused', refusal: { kind: 'revoked', name: 'Win' } }, new TokenGate(vi.fn())))
      .toThrow(/was revoked/);
    expect(() => applyStartupCheck({ kind: 'refused', refusal: { kind: 'invalid' } }, new TokenGate(vi.fn())))
      .toThrow(/did not recognise/);
  });

  it('a skipped check starts normally', () => {
    const log = vi.fn();
    expect(() => applyStartupCheck({ kind: 'skip', reason: 'HTTP 404' }, new TokenGate(log))).not.toThrow();
    expect(log).not.toHaveBeenCalled();
  });
});

describe('TokenGate (shared by every worker)', () => {
  it('refusals log ONE line however many workers hit them, and slow polling to the backoff', () => {
    const log = vi.fn();
    const gate = new TokenGate(log);
    expect(gate.waitMs(2000)).toBe(2000);
    for (let i = 0; i < 6; i++) gate.refused({ kind: 'expired', name: 'Mac' }); // two workers, three polls each
    expect(log).toHaveBeenCalledTimes(1);
    expect(gate.waitMs(2000)).toBe(REJECTED_BACKOFF_MS);
    expect(REJECTED_BACKOFF_MS).toBe(60_000);
  });

  it('a different reason is logged again', () => {
    const log = vi.fn();
    const gate = new TokenGate(log);
    gate.refused({ kind: 'expired', name: 'Mac' });
    gate.refused({ kind: 'revoked', name: 'Mac' });
    expect(log).toHaveBeenCalledTimes(2);
  });

  it('acceptance after a refusal logs once and restores normal polling; acceptance alone logs nothing', () => {
    const log = vi.fn();
    const gate = new TokenGate(log);
    gate.accepted();
    expect(log).not.toHaveBeenCalled();
    gate.refused({ kind: 'expired' });
    gate.accepted();
    gate.accepted();
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[1][0]).toContain('accepted again');
    expect(gate.waitMs(2000)).toBe(2000);
    expect(gate.isRefused).toBe(false);
  });

  it('8 days left stays quiet; 7 days warns (header and startup alike)', () => {
    const log = vi.fn();
    const gate = new TokenGate(log, () => NOW);
    gate.expiryHeader(new Date(NOW + 8 * DAY + 3_600_000).toISOString());
    expect(log).not.toHaveBeenCalled();
    applyStartupCheck({ kind: 'ok', name: 'Mac', expiresAt: new Date(NOW + 8 * DAY + 3_600_000).toISOString(), daysLeft: 8 }, gate);
    expect(log).not.toHaveBeenCalled();
    gate.expiryHeader(new Date(NOW + 7 * DAY + 3_600_000).toISOString());
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('the expiry header warns within 7 days, at most once a day', () => {
    let now = NOW;
    const log = vi.fn();
    const gate = new TokenGate(log, () => now);
    gate.expiryHeader(new Date(NOW + 30 * DAY).toISOString());
    expect(log).not.toHaveBeenCalled();
    const soon = new Date(NOW + 3 * DAY + 3_600_000).toISOString();
    gate.expiryHeader(soon);
    gate.expiryHeader(soon);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain('expires in 3 days');
    now += DAY;
    gate.expiryHeader(soon);
    expect(log).toHaveBeenCalledTimes(2);
    gate.expiryHeader(null);
    gate.expiryHeader('not a date');
    expect(log).toHaveBeenCalledTimes(2);
  });
});

describe('handleClaimResponse (the claim path)', () => {
  it('a 401 refuses through the gate and claims nothing', async () => {
    const log = vi.fn();
    const gate = new TokenGate(log);
    const job = await handleClaimResponse(jsonResponse(401, { error_code: 'API_TOKEN_EXPIRED', tokenName: 'Mac' }), gate);
    expect(job).toBeNull();
    expect(gate.isRefused).toBe(true);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('a claim 401 is explained by what the body says — current code or older text', async () => {
    for (const [body, expected] of [
      [{ error_code: 'API_TOKEN_EXPIRED', tokenName: 'Mac', expiresAt: '2026-10-14T04:08:24.939Z' }, /"Mac" expired on 2026-10-14 04:08 UTC/],
      [{ error: OLD_EXPIRED_TEXT }, /"MacBook-cc-Jul-16-2026" expired on 2026-10-14 04:08 UTC/],
      [{ error_code: 'API_TOKEN_REVOKED', tokenName: 'Win' }, /"Win" was revoked/],
    ] as const) {
      const log = vi.fn();
      await handleClaimResponse(jsonResponse(401, body), new TokenGate(log));
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0][0]).toMatch(expected);
    }
  });

  it('an accepted claim clears the refusal, returns the job and reads the expiry header', async () => {
    const log = vi.fn();
    const gate = new TokenGate(log, () => NOW);
    gate.refused({ kind: 'expired' });
    const job = await handleClaimResponse(
      jsonResponse(200, { job: { jobId: 'j1', kind: 'chat' } }, { 'X-Noesis-Token-Expires': new Date(NOW + 2 * DAY).toISOString() }),
      gate,
    );
    expect(job).toEqual({ jobId: 'j1', kind: 'chat' });
    expect(gate.isRefused).toBe(false);
    expect(log.mock.calls.map((c) => c[0]).join('\n')).toMatch(/accepted again[\s\S]*expires in 2 days/);
  });

  it('other failures (5xx) claim nothing and leave the token state alone', async () => {
    const gate = new TokenGate(vi.fn());
    gate.refused({ kind: 'expired' });
    expect(await handleClaimResponse(jsonResponse(503, {}), gate)).toBeNull();
    expect(gate.isRefused).toBe(true);
  });
});

describe('MCP client: expired-token hint', () => {
  it('adds where to extend an expired token, for current and older servers', () => {
    expect(explainTokenError(401, { error: 'x', error_code: 'API_TOKEN_EXPIRED' }, 'x')).toBe('x — extend it in Noesis Settings → API Tokens');
    expect(explainTokenError(401, { error: OLD_EXPIRED_TEXT }, OLD_EXPIRED_TEXT)).toContain('extend it in Noesis Settings → API Tokens');
  });

  it('leaves every other error as it was', () => {
    expect(explainTokenError(401, { error: 'revoked', error_code: 'API_TOKEN_REVOKED' }, 'revoked')).toBe('revoked');
    expect(explainTokenError(500, { error: 'has expired' }, 'has expired')).toBe('has expired');
  });
});
