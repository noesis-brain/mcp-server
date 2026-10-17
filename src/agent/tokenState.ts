/**
 * The local agent's view of its own Noesis API token.
 *
 * Noesis API tokens expire after 90 days. Before 2.3.1 an expired token made every claim
 * fail with 401 and the daemon said nothing — it simply never picked anything up. Now:
 *  - at startup, checkToken() asks GET /api/agent/token and explains any refusal;
 *  - while running, one TokenGate shared by every worker turns a 401 into ONE clear log
 *    line, slows polling to REJECTED_BACKOFF_MS, and logs again when the token is accepted
 *    (e.g. after the owner clicks Extend in Settings → API Tokens — the token value does
 *    not change, so no restart is needed);
 *  - the X-Noesis-Token-Expires header on every answer drives an "expires soon" warning,
 *    at most once a day.
 *
 * Old servers send no error_code and have no /api/agent/token: refusals are classified from
 * their error text, and a 404 from the check just skips it.
 */

/** While the server refuses the token, poll this slowly instead of every 2 s. */
export const REJECTED_BACKOFF_MS = 60_000;
/** Warn when the token has this many days or fewer left. */
export const EXPIRY_WARN_DAYS = 7;

const DAY_MS = 86_400_000;
const WHERE_TO_FIX = 'Settings → API Tokens';

export type TokenRefusal =
  | { kind: 'expired'; name?: string; expiresAt?: string }
  | { kind: 'revoked'; name?: string }
  | { kind: 'invalid' };

export type TokenCheck =
  | { kind: 'ok'; name: string; expiresAt: string; daysLeft: number }
  | { kind: 'refused'; refusal: TokenRefusal }
  | { kind: 'skip'; reason: string };

interface RefusalBody {
  error?: unknown;
  error_code?: unknown;
  tokenName?: unknown;
  expiresAt?: unknown;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

/** What a 401 body says about the token — by error_code, or by the text older servers send. */
export function classifyRefusal(body: unknown): TokenRefusal {
  const b = (body && typeof body === 'object' ? body : {}) as RefusalBody;
  const code = str(b.error_code);
  const text = str(b.error) ?? '';
  // Older servers: `API token has expired (name: "X", expired: 2026-10-14T03:18:32.151Z, sent: …)`
  const textName = /name: "([^"]*)"/.exec(text)?.[1];
  const textExpiry = /expired: (\d{4}-\d{2}-\d{2}T[0-9:.]+Z)/.exec(text)?.[1];
  const name = str(b.tokenName) ?? textName;
  if (code === 'API_TOKEN_EXPIRED' || (!code && /has expired/i.test(text))) {
    return { kind: 'expired', name, expiresAt: str(b.expiresAt) ?? textExpiry };
  }
  if (code === 'API_TOKEN_REVOKED' || (!code && /revoked/i.test(text))) {
    return { kind: 'revoked', name };
  }
  return { kind: 'invalid' };
}

function formatWhen(iso: string | undefined): string {
  if (!iso || Number.isNaN(Date.parse(iso))) return 'an unknown date';
  return `${new Date(iso).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

const quoted = (name: string | undefined) => (name ? ` "${name}"` : '');

/** The one line a refusal is explained with — at startup and at runtime alike. */
export function describeRefusal(r: TokenRefusal): string {
  switch (r.kind) {
    case 'expired':
      return `[noesis-agent] Your Noesis API token${quoted(r.name)} expired on ${formatWhen(r.expiresAt)}. ` +
        `Extend it in ${WHERE_TO_FIX} — this agent keeps checking and resumes by itself.`;
    case 'revoked':
      return `[noesis-agent] Your Noesis API token${quoted(r.name)} was revoked. ` +
        `Generate a new one in ${WHERE_TO_FIX} and restart the agent with it.`;
    default:
      return `[noesis-agent] Noesis did not recognise this API token. ` +
        `Check NOESIS_API_TOKEN, or generate a new one in ${WHERE_TO_FIX}.`;
  }
}

export function describeExpirySoon(name: string | undefined, expiresAt: string, daysLeft: number): string {
  const when = daysLeft <= 0 ? 'today' : daysLeft === 1 ? 'in 1 day' : `in ${daysLeft} days`;
  return `[noesis-agent] Your Noesis API token${quoted(name)} expires ${when} (${formatWhen(expiresAt)}). ` +
    `Extend it in ${WHERE_TO_FIX} to keep this agent running.`;
}

/** Startup: ask the server about this token. Never throws. */
export async function checkToken(
  apiBaseUrl: string,
  apiToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenCheck> {
  let res: Response;
  try {
    res = await fetchImpl(`${apiBaseUrl}/api/agent/token`, { headers: { Authorization: `Bearer ${apiToken}` } });
  } catch (err) {
    return { kind: 'skip', reason: `could not reach the server (${err instanceof Error ? err.message : String(err)})` };
  }
  if (res.status === 401) {
    const body = (await res.json().catch(() => ({}))) as RefusalBody;
    // A server without the check routes this path on to a later layer, which refuses the
    // noe_ token with ITS OWN code (e.g. a JWT check's TOKEN_INVALID) — meaning the token
    // layer already accepted it. Only API_TOKEN_* codes, or the older server's code-less
    // token texts, are about this token. A token without the noe_ prefix never reaches the
    // token layer at all, so that same answer means it is simply not a Noesis API token.
    const code = str(body.error_code);
    if (code && !code.startsWith('API_TOKEN_') && apiToken.startsWith('noe_')) {
      return { kind: 'skip', reason: `this server has no token check (${code})` };
    }
    return { kind: 'refused', refusal: classifyRefusal(body) };
  }
  if (!res.ok) return { kind: 'skip', reason: `HTTP ${res.status}` }; // e.g. a server without the check
  const body = (await res.json().catch(() => ({}))) as { name?: unknown; expiresAt?: unknown; daysLeft?: unknown };
  const expiresAt = str(body.expiresAt);
  if (!expiresAt || typeof body.daysLeft !== 'number') return { kind: 'skip', reason: 'unexpected answer' };
  return { kind: 'ok', name: str(body.name) ?? '', expiresAt, daysLeft: body.daysLeft };
}

/**
 * The token state every worker shares, so N workers produce ONE log line per change
 * rather than one per worker per poll.
 */
export class TokenGate {
  private refusal: string | null = null;
  private warnedOn: string | null = null;
  private tokenName: string | undefined;

  constructor(
    private readonly log: (line: string) => void = (line) => console.error(line),
    private readonly now: () => number = () => Date.now(),
  ) {}

  get isRefused(): boolean {
    return this.refusal !== null;
  }

  /** The server refused the token: say why once, then stay quiet until it changes. */
  refused(r: TokenRefusal): void {
    const line = describeRefusal(r);
    if (this.refusal !== line) this.log(line);
    this.refusal = line;
  }

  /** The server accepted the token: if it had been refusing it, say so. */
  accepted(): void {
    if (this.refusal === null) return;
    this.refusal = null;
    this.log('[noesis-agent] API token accepted again — resuming.');
  }

  /** How long a worker with nothing to do waits before polling again. */
  waitMs(pollMs: number): number {
    return this.refusal === null ? pollMs : REJECTED_BACKOFF_MS;
  }

  /** Remember the token's name (from the startup check) for later warnings. */
  setTokenName(name: string | undefined): void {
    this.tokenName = name || undefined;
  }

  /**
   * Warn when the token expires within EXPIRY_WARN_DAYS — at most once a day, whether
   * the date came from the startup check or from an answer's X-Noesis-Token-Expires.
   */
  expiryHeader(iso: string | null | undefined): void {
    if (!iso) return;
    const at = Date.parse(iso);
    if (Number.isNaN(at)) return;
    const daysLeft = Math.floor((at - this.now()) / DAY_MS);
    if (daysLeft > EXPIRY_WARN_DAYS) return;
    const today = new Date(this.now()).toISOString().slice(0, 10);
    if (this.warnedOn === today) return;
    this.warnedOn = today;
    this.log(describeExpirySoon(this.tokenName, iso, daysLeft));
  }
}

/**
 * Apply the startup check. Returns normally to start the workers; throws for a token that
 * can never work again (revoked or unknown), which ends the process with that message.
 */
export function applyStartupCheck(check: TokenCheck, gate: TokenGate): void {
  if (check.kind === 'skip') return;
  if (check.kind === 'ok') {
    gate.setTokenName(check.name);
    gate.expiryHeader(check.expiresAt); // shares the once-a-day warning with the claim answers
    return;
  }
  if (check.refusal.kind === 'expired') {
    gate.refused(check.refusal); // logs once; the workers start in backoff and recover after an Extend
    return;
  }
  throw new Error(describeRefusal(check.refusal).replace(/^\[noesis-agent\] /, ''));
}
