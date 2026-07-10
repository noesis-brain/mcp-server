/**
 * Unit tests — NoesisClient.getResolverContext (M2).
 *
 * Stubs global fetch: verifies the single-round-trip contract with the V3
 * backend (includeArchived=1, X-Client-OS header) and the mapping into a
 * ResolverContext — including graceful defaults against a PRE-V3 server
 * response that lacks the meta fields.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { NoesisClient, CLIENT_OS } from '../src/api/NoesisClient.js';

const V3_PAYLOAD = {
  roots: [
    { id: 7, name: 'Noesis Cloud', local_paths: { win32: '~/Noesis', darwin: '~/Noesis', linux: '~/Noesis' } },
    {
      id: 21,
      name: 'My Git',
      local_paths: { win32: 'c:/temp_cGit' },
      archived_at: '2026-07-11T00:00:00Z',
      vault_subfolder: 'my-git',
    },
  ],
  vault_root_id: 7,
  device_home_dirs: { win32: 'c:/Users/ccheng', darwin: '/Users/chandler' },
};

function stubFetch(payload: unknown) {
  const spy = vi.fn(async () => ({
    ok: true,
    json: async () => payload,
  }));
  vi.stubGlobal('fetch', spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('NoesisClient.getResolverContext', () => {
  it('requests archived roots in one round-trip and maps the V3 payload', async () => {
    const spy = stubFetch(V3_PAYLOAD);
    const client = new NoesisClient('https://api.example.com', 'tok');

    const ctx = await client.getResolverContext();

    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(url).toBe('https://api.example.com/api/mcp/roots?includeArchived=1');
    expect(init.headers['X-Client-OS']).toBe(CLIENT_OS);

    expect(ctx.clientOs).toBe(CLIENT_OS);
    expect(ctx.homeDir.length).toBeGreaterThan(0);
    expect(ctx.vaultRootId).toBe(7);
    expect(ctx.deviceHomeDirs).toEqual({ win32: 'c:/Users/ccheng', darwin: '/Users/chandler' });
    expect(ctx.roots).toEqual([
      { id: 7, name: 'Noesis Cloud', local_paths: { win32: '~/Noesis', darwin: '~/Noesis', linux: '~/Noesis' }, archived_at: null, vault_subfolder: null },
      { id: 21, name: 'My Git', local_paths: { win32: 'c:/temp_cGit' }, archived_at: '2026-07-11T00:00:00Z', vault_subfolder: 'my-git' },
    ]);
  });

  it('defaults gracefully against a pre-V3 server payload', async () => {
    stubFetch({ roots: [{ id: 1, name: 'Old', local_paths: { darwin: '/x' } }] });
    const client = new NoesisClient('https://api.example.com', 'tok');

    const ctx = await client.getResolverContext();

    expect(ctx.vaultRootId).toBeNull();
    expect(ctx.deviceHomeDirs).toBeNull();
    expect(ctx.roots).toEqual([
      { id: 1, name: 'Old', local_paths: { darwin: '/x' }, archived_at: null, vault_subfolder: null },
    ]);
  });
});
