/**
 * Unit tests — list_roots renderer (M3).
 */
import { describe, it, expect } from 'vitest';
import { formatRootsList } from '../src/resolve/rootsFormat.js';
import type { ResolverContext } from '../src/resolve/noteRef.js';

const ctx: ResolverContext = {
  clientOs: 'darwin',
  homeDir: '/Users/chandler',
  vaultRootId: 7,
  deviceHomeDirs: { win32: 'c:/Users/ccheng' },
  roots: [
    { id: 7, name: 'Noesis Cloud', local_paths: { win32: '~/Noesis', darwin: '~/Noesis', linux: '~/Noesis' } },
    {
      id: 21,
      name: 'My Git',
      local_paths: { win32: 'c:/temp_cGit' },
      archived_at: '2026-07-11T00:00:00Z',
      vault_subfolder: 'my-git',
    },
    {
      id: 23,
      name: 'Claude Commands',
      local_paths: { win32: 'c:/Users/chand/.claude/commands' },
      archived_at: '2026-07-11T00:00:00Z',
      vault_subfolder: null,
    },
  ],
};

describe('formatRootsList', () => {
  it('marks the vault, resolves the local base, and tables archived roots', () => {
    const text = formatRootsList(ctx);

    expect(text).toContain('Watched directories (1):');
    expect(text).toContain('**Noesis Cloud**  ← YOUR VAULT');
    expect(text).toContain('macOS  : ~/Noesis  [active]');
    expect(text).toContain('On this machine: /Users/chandler/Noesis');

    expect(text).toContain('Archived roots — legacy path translation (2):');
    expect(text).toContain('- My Git: c:/temp_cGit → vault: my-git/');
    expect(text).toContain('- Claude Commands: c:/Users/chand/.claude/commands → (notes trashed at migration)');
    expect(text).toContain('translate them into the vault automatically');

    // No missing-OS tip: the vault has a darwin slot.
    expect(text).not.toContain("can't sync on this machine");
  });

  it('flags an ACTIVE root missing this OS and handles the empty case', () => {
    const withMissing: ResolverContext = {
      ...ctx,
      roots: [...ctx.roots, { id: 30, name: 'WinOnly', local_paths: { win32: 'd:/x' } }],
    };
    const text = formatRootsList(withMissing);
    expect(text).toContain('(not configured for this OS)');
    expect(text).toContain("can't sync on this machine");

    expect(formatRootsList({ ...ctx, roots: [] })).toContain('designated automatically on first use');
  });
});
