/**
 * Unit tests — getResolverContext TTL cache (H8).
 *
 * Pins that repeated resolver-context reads within the TTL collapse to ONE
 * round-trip (the hot path calls it per get_note / per sync), that the cache
 * returns the same mapped context, and that invalidateResolverContext forces a
 * refetch. Fetch is stubbed — no network.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { NoesisClient, CLIENT_OS } from '../src/api/NoesisClient.js';

const PAYLOAD = {
  roots: [{ id: 7, name: 'Noesis Cloud', local_paths: { win32: '~/Noesis', darwin: '~/Noesis', linux: '~/Noesis' } }],
  vault_root_id: 7,
  device_home_dirs: { win32: 'c:/Users/ccheng' },
};

function stubFetch() {
  const spy = vi.fn(async () => ({ ok: true, json: async () => PAYLOAD }));
  vi.stubGlobal('fetch', spy);
  return spy;
}

afterEach(() => vi.unstubAllGlobals());

describe('NoesisClient.getResolverContext TTL cache', () => {
  it('serves repeated calls within the TTL from cache (one fetch)', async () => {
    const spy = stubFetch();
    const c = new NoesisClient('https://api.example.com', 'tok');

    const a = await c.getResolverContext();
    const b = await c.getResolverContext();
    const d = await c.getResolverContext();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(a.vaultRootId).toBe(7);
    expect(a.clientOs).toBe(CLIENT_OS);
    expect(b).toBe(a); // same object identity from cache
    expect(d).toBe(a);
  });

  it('refetches after invalidateResolverContext()', async () => {
    const spy = stubFetch();
    const c = new NoesisClient('https://api.example.com', 'tok');

    await c.getResolverContext();
    c.invalidateResolverContext();
    await c.getResolverContext();

    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('a fresh client does not share the cache', async () => {
    const spy = stubFetch();
    await new NoesisClient('https://api.example.com', 'tok').getResolverContext();
    await new NoesisClient('https://api.example.com', 'tok').getResolverContext();
    expect(spy).toHaveBeenCalledTimes(2); // per-instance cache
  });

  it('reportDeviceHomeDir busts the cache (device_home_dirs is in the ctx)', async () => {
    const spy = vi.fn(async () => ({ ok: true, json: async () => PAYLOAD }));
    vi.stubGlobal('fetch', spy);
    const c = new NoesisClient('https://api.example.com', 'tok');

    await c.getResolverContext();            // fetch 1 (primes cache)
    await c.reportDeviceHomeDir();           // PATCH (fetch 2) + invalidate
    await c.getResolverContext();            // fetch 3 (cache was busted)

    const contextCalls = spy.mock.calls.filter((c: any[]) => String(c[0]).includes('/roots?includeArchived')).length;
    expect(contextCalls).toBe(2); // NOT served from a stale cache after the mutation
  });

  it('createRoot busts the cache when root creation succeeds', async () => {
    const spy = vi.fn(async (url: string) =>
      String(url).includes('/roots') && !String(url).includes('includeArchived')
        ? { ok: true, json: async () => ({ root: { id: 9, name: 'x', local_paths: {} } }) }
        : { ok: true, json: async () => PAYLOAD }
    );
    vi.stubGlobal('fetch', spy);
    const c = new NoesisClient('https://api.example.com', 'tok');

    await c.getResolverContext();                     // fetch: context (primes)
    await c.createRoot({ name: 'x', path: '/x' });    // POST /roots + invalidate
    await c.getResolverContext();                     // context refetched

    const contextCalls = spy.mock.calls.filter((c: any[]) => String(c[0]).includes('includeArchived')).length;
    expect(contextCalls).toBe(2);
  });
});
