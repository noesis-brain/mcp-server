/**
 * Address guard for the daemon's WebFetch tool.
 *
 * The daemon runs on the USER'S OWN machine, so a request forged by a web page does not
 * land in some cloud network — it lands on their LAN, their router's admin page, and
 * anything listening on localhost (a dev backend on :5555, a database). A page a Navi
 * reads can carry instructions; this is what stops "now fetch http://192.168.1.1/…" from
 * working. It runs inside buildCanUseTool, before the CLI performs the fetch.
 *
 * Mirrors the backend's src/backend/utils/ssrfGuard.ts (this package is published on its
 * own and cannot import from the main repo), with two deliberate differences:
 *  - `net.BlockList` decides membership, so IPv4-mapped IPv6 (`::ffff:7f00:1`) is caught.
 *    The backend's dotted-form regex misses the hex form WHATWG URL produces.
 *  - NAT64 addresses (64:ff9b::/96) are judged by the IPv4 address they embed, which
 *    BlockList does not do on its own (verified: `64:ff9b::7f00:1` passes a v4 rule).
 *
 * WHAT THIS CANNOT DO: the CLI resolves the host name again when it fetches, so an answer
 * that changes between the two lookups (DNS rebinding) is not stopped here. WebFetch
 * itself stops it: it upgrades every URL to https and verifies the certificate, which a
 * private device cannot present for the attacker's name. That protection is gone when
 * certificate checks are disabled or a proxy resolves names for us, hence
 * webFetchEnvWarnings below.
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

export type UrlVerdict = { ok: true; host: string } | { ok: false; reason: string };

/** Resolves a host name to every address it has. Injectable so tests never touch real DNS. */
export type HostLookup = (host: string) => Promise<Array<{ address: string }>>;

const DNS_TIMEOUT_MS = 3000;

/** [network, prefix] IPv4 blocks that must never be fetched — same list as the backend's. */
const PRIVATE_IPV4_CIDRS: Array<[string, number]> = [
  ['0.0.0.0', 8],        // "this network"
  ['10.0.0.0', 8],       // private
  ['100.64.0.0', 10],    // CGNAT (also Tailscale)
  ['127.0.0.0', 8],      // loopback
  ['169.254.0.0', 16],   // link-local / cloud metadata service
  ['172.16.0.0', 12],    // private
  ['192.0.0.0', 24],     // IETF protocol assignments
  ['192.168.0.0', 16],   // private
  ['198.18.0.0', 15],    // benchmarking
  ['224.0.0.0', 4],      // multicast
  ['240.0.0.0', 4],      // reserved + broadcast
];

/**
 * IPv6 blocks that are never a public web server. IPv4-mapped addresses (::ffff:0:0/96)
 * need no entry: BlockList checks them against the IPv4 rules above.
 */
const PRIVATE_IPV6_CIDRS: Array<[string, number]> = [
  ['::', 96],            // unspecified, loopback (::1), deprecated IPv4-compatible
  ['64:ff9b:1::', 48],   // local-use NAT64
  ['100::', 64],         // discard-only
  ['2001::', 32],        // Teredo (embeds an obfuscated IPv4)
  ['2001:db8::', 32],    // documentation
  ['2002::', 16],        // 6to4 (embeds an IPv4)
  ['fc00::', 7],         // unique local
  ['fe80::', 10],        // link-local
  ['ff00::', 8],         // multicast
];

const BLOCKED = new BlockList();
for (const [network, prefix] of PRIVATE_IPV4_CIDRS) BLOCKED.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of PRIVATE_IPV6_CIDRS) BLOCKED.addSubnet(network, prefix, 'ipv6');

/** Host-name suffixes reserved for names that only exist on a local network. */
const LOCAL_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

/** Last 32 bits of a well-known-prefix NAT64 address, as dotted IPv4; null if not NAT64. */
function embeddedNat64(ipv6: string): string | null {
  // Canonicalize through the WHATWG serializer so every spelling (`64:ff9b::127.0.0.1`,
  // `0064:ff9b:0:0:0:0:7f00:0001`) reduces to one lower-case, compressed form.
  let canon: string;
  try {
    canon = new URL(`http://[${ipv6}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
  if (canon === '64:ff9b::') return '0.0.0.0';
  const m = /^64:ff9b::(?:([0-9a-f]{1,4}):)?([0-9a-f]{1,4})$/.exec(canon);
  if (!m) return null;
  const hi = m[1] ? parseInt(m[1], 16) : 0;
  const lo = parseInt(m[2], 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/** True for private, reserved or otherwise non-public addresses. Unparseable input is blocked. */
export function isBlockedAddress(address: string): boolean {
  try {
    const family = isIP(address);
    if (family === 4) return BLOCKED.check(address, 'ipv4');
    if (family !== 6) return true;
    const v4 = embeddedNat64(address);
    if (v4 !== null) return BLOCKED.check(v4, 'ipv4');
    return BLOCKED.check(address, 'ipv6');
  } catch {
    return true;
  }
}

/** Every address the OS would use — dns.lookup honours /etc/hosts, as the CLI's fetch does. */
const systemLookup: HostLookup = (host) => dnsLookup(host, { all: true, verbatim: true });

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

const deny = (reason: string): UrlVerdict => ({ ok: false, reason });

/**
 * Decide whether WebFetch may fetch `raw`. Denies anything that is not an http(s) URL on a
 * public host; a host name must resolve, and EVERY address it resolves to must be public.
 */
export async function checkWebFetchUrl(raw: unknown, lookup: HostLookup = systemLookup): Promise<UrlVerdict> {
  if (typeof raw !== 'string' || raw.trim() === '') return deny('no URL was given');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return deny('it is not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return deny(`${url.protocol} URLs are not allowed`);
  if (url.username || url.password) return deny('URLs with embedded credentials are not allowed');

  let host = url.hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  // `localhost.` is the same host as `localhost`, and it slips past a "needs a dot" rule.
  host = host.replace(/\.+$/, '');
  if (!host) return deny('it has no host');

  if (isIP(host)) {
    return isBlockedAddress(host) ? deny(`${host} is a private or reserved address`) : { ok: true, host };
  }
  if (!host.includes('.')) return deny(`"${host}" is a local host name`);
  if (LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) return deny(`"${host}" is a local-network host name`);

  let addresses: Array<{ address: string }>;
  try {
    addresses = await withTimeout(lookup(host), DNS_TIMEOUT_MS);
  } catch {
    return deny(`${host} could not be resolved`);
  }
  if (addresses.length === 0) return deny(`${host} could not be resolved`);
  const blocked = addresses.find((a) => isBlockedAddress(a.address));
  if (blocked) return deny(`${host} resolves to a private or reserved address (${blocked.address})`);
  return { ok: true, host };
}

/**
 * Startup warnings for environments where the guard's assumptions do not hold: with
 * certificate checks off, DNS rebinding reaches the LAN; behind a proxy, the proxy
 * resolves names, so the address this guard checked is not the one that gets fetched.
 */
export function webFetchEnvWarnings(env: Record<string, string | undefined>): string[] {
  const warnings: string[] = [];
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    warnings.push(
      '[noesis-agent] WARNING: NODE_TLS_REJECT_UNAUTHORIZED=0 turns off certificate checks, so a ' +
        'web page read by a Navi could reach your local network. Unset it before starting the daemon.',
    );
  }
  if (env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy) {
    warnings.push(
      '[noesis-agent] WARNING: an HTTP(S) proxy is set. Navi web fetches are resolved by the proxy, ' +
        "so the daemon's private-address check cannot see where they really go.",
    );
  }
  return warnings;
}
