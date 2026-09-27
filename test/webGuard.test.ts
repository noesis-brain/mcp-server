import { describe, it, expect } from 'vitest';
import { checkWebFetchUrl, isBlockedAddress, webFetchEnvWarnings, type HostLookup } from '../src/agent/webGuard.js';

/**
 * The daemon runs on the user's own machine, so WebFetch is a request from INSIDE their
 * network. These tests pin what a Navi — or a web page steering one — may never reach.
 * DNS is always stubbed: a test that resolves real names proves nothing about the guard.
 */
const resolvesTo = (...addresses: string[]): HostLookup => async () => addresses.map((address) => ({ address }));
const neverCalled: HostLookup = async () => {
  throw new Error('lookup must not run for this input');
};

describe('isBlockedAddress', () => {
  it('blocks every private and reserved IPv4 range the backend blocks', () => {
    for (const ip of [
      '0.0.0.0', '10.1.2.3', '100.64.0.1', '100.127.255.254', '127.0.0.1', '127.255.255.255',
      '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.0.0.8', '192.168.1.1',
      '198.18.0.1', '224.0.0.1', '240.0.0.1', '255.255.255.255',
    ]) {
      expect({ ip, blocked: isBlockedAddress(ip) }).toEqual({ ip, blocked: true });
    }
  });

  it('allows public addresses, including ones next to private ranges', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '100.63.255.255', '100.128.0.0', '172.15.255.255', '172.32.0.0', '2404:6800:4012::200e']) {
      expect({ ip, blocked: isBlockedAddress(ip) }).toEqual({ ip, blocked: false });
    }
  });

  // The backend guard's regex expects `::ffff:127.0.0.1`; WHATWG URL writes the same
  // address as `::ffff:7f00:1`, which it therefore passes. Both spellings must block here.
  it('blocks IPv4-mapped IPv6 in both spellings', () => {
    for (const ip of ['::ffff:7f00:1', '::ffff:127.0.0.1', '::ffff:a9fe:a9fe', '::ffff:c0a8:101']) {
      expect({ ip, blocked: isBlockedAddress(ip) }).toEqual({ ip, blocked: true });
    }
  });

  it('judges NAT64 addresses by the IPv4 address they embed', () => {
    expect(isBlockedAddress('64:ff9b::7f00:1')).toBe(true);    // 127.0.0.1
    expect(isBlockedAddress('64:ff9b::127.0.0.1')).toBe(true);
    expect(isBlockedAddress('64:ff9b::a9fe:a9fe')).toBe(true); // 169.254.169.254
    expect(isBlockedAddress('64:ff9b::808:808')).toBe(false);  // 8.8.8.8 — a real NAT64 network
  });

  it('blocks IPv6 loopback, unique-local, link-local, multicast and tunnelled forms', () => {
    for (const ip of ['::', '::1', '::7f00:1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '2002:7f00:1::', '2001:0:4136:e378::1', '64:ff9b:1::1']) {
      expect({ ip, blocked: isBlockedAddress(ip) }).toEqual({ ip, blocked: true });
    }
  });

  it('treats anything that is not an IP address as blocked', () => {
    expect(isBlockedAddress('localhost')).toBe(true);
    expect(isBlockedAddress('')).toBe(true);
  });
});

describe('checkWebFetchUrl', () => {
  it('allows a public https page whose name resolves to a public address', async () => {
    expect(await checkWebFetchUrl('https://www.momoshop.com.tw/product/5219168?x=1', resolvesTo('203.69.138.1')))
      .toEqual({ ok: true, host: 'www.momoshop.com.tw' });
  });

  it('allows plain http — WebFetch upgrades it to https itself', async () => {
    expect((await checkWebFetchUrl('http://example.com/', resolvesTo('93.184.215.14'))).ok).toBe(true);
  });

  it('refuses non-web schemes and credentials', async () => {
    for (const url of ['file:///etc/passwd', 'ftp://example.com/', 'data:text/html,hi', 'javascript:alert(1)', 'https://user:pw@example.com/']) {
      expect({ url, ok: (await checkWebFetchUrl(url, neverCalled)).ok }).toEqual({ url, ok: false });
    }
  });

  it('refuses private IP literals, including encoded and mapped spellings', async () => {
    for (const url of [
      'http://127.0.0.1:5555/api/auth/me', 'http://2130706433/', 'http://0x7f.1/', 'http://10.0.0.1/',
      'http://100.64.1.2/', 'http://169.254.169.254/latest/meta-data/', 'http://192.168.1.1/',
      'http://[::1]/', 'http://[::ffff:7f00:1]/', 'http://[::ffff:127.0.0.1]/', 'http://[64:ff9b::7f00:1]/',
    ]) {
      const verdict = await checkWebFetchUrl(url, neverCalled);
      expect({ url, ok: verdict.ok }).toEqual({ url, ok: false });
    }
  });

  // The stub answers with a PUBLIC address, so only the name rules can refuse these — a
  // throwing stub let the trailing-dot rule be deleted with this test still green, because
  // "could not be resolved" refused `localhost.` for the wrong reason.
  it('refuses local host names by name alone, including a trailing-dot localhost', async () => {
    for (const url of ['http://localhost:5555/', 'http://localhost.:5555/api/auth/me', 'http://LOCALHOST/', 'http://router/', 'http://printer.local/', 'http://app.localhost/', 'http://db.internal/', 'http://nas.home.arpa/', 'http://printer.local./']) {
      const verdict = await checkWebFetchUrl(url, resolvesTo('93.184.215.14'));
      expect({ url, ok: verdict.ok }).toEqual({ url, ok: false });
    }
  });

  // The case the CLI does NOT catch: a public-looking name that resolves to loopback.
  it('refuses a public name that resolves to a private address', async () => {
    const verdict = await checkWebFetchUrl('https://127.0.0.1.nip.io/', resolvesTo('127.0.0.1'));
    expect(verdict.ok).toBe(false);
    expect((verdict as { reason: string }).reason).toContain('127.0.0.1');
  });

  it('refuses when ANY resolved address is private, not just the first', async () => {
    expect((await checkWebFetchUrl('https://mixed.example.com/', resolvesTo('93.184.215.14', '10.0.0.5'))).ok).toBe(false);
  });

  it('refuses names that do not resolve, or resolve to nothing', async () => {
    const failing: HostLookup = async () => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    };
    expect((await checkWebFetchUrl('https://no-such-host.example/', failing)).ok).toBe(false);
    expect((await checkWebFetchUrl('https://empty.example.com/', resolvesTo())).ok).toBe(false);
  });

  it('refuses garbage input without throwing', async () => {
    for (const raw of [undefined, null, 42, '', '   ', 'not a url', { url: 'https://x.com' }]) {
      expect((await checkWebFetchUrl(raw, neverCalled)).ok).toBe(false);
    }
  });
});

describe('webFetchEnvWarnings', () => {
  it('is silent in a normal environment', () => {
    expect(webFetchEnvWarnings({})).toEqual([]);
  });

  it('warns when certificate checks are off or a proxy resolves names', () => {
    expect(webFetchEnvWarnings({ NODE_TLS_REJECT_UNAUTHORIZED: '0' })).toHaveLength(1);
    expect(webFetchEnvWarnings({ HTTPS_PROXY: 'http://proxy:3128' })).toHaveLength(1);
    expect(webFetchEnvWarnings({ https_proxy: 'http://proxy:3128', NODE_TLS_REJECT_UNAUTHORIZED: '0' })).toHaveLength(2);
    expect(webFetchEnvWarnings({ NODE_TLS_REJECT_UNAUTHORIZED: '1' })).toEqual([]);
  });
});
