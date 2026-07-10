/**
 * Unit tests — unified note-reference resolution (M1).
 *
 * Pure logic: contexts are constructed per test (no env staging, no fs, no
 * network), covering BOTH client OSes by parameter — the darwin machine
 * resolving Windows-shaped references and vice versa, which is the exact
 * blind spot the single-vault refactor exists to fix.
 */
import { describe, it, expect } from 'vitest';
import {
  parseNoteReference,
  resolvePathReference,
  localAbsFor,
  type ResolverContext,
} from '../src/resolve/noteRef.js';

const VAULT_ID = 7;

function macCtx(overrides: Partial<ResolverContext> = {}): ResolverContext {
  return {
    clientOs: 'darwin',
    homeDir: '/Users/chandler',
    vaultRootId: VAULT_ID,
    deviceHomeDirs: { win32: 'c:/Users/ccheng', darwin: '/Users/chandler' },
    roots: [
      { id: VAULT_ID, name: 'Noesis Cloud', local_paths: { win32: '~/Noesis', darwin: '~/Noesis', linux: '~/Noesis' } },
      {
        id: 21,
        name: 'My Git',
        local_paths: { win32: 'c:/temp_cGit' },
        archived_at: '2026-07-11T00:00:00Z',
        vault_subfolder: 'my-git',
      },
      {
        id: 22,
        name: 'english-lesson-picture-story',
        local_paths: { win32: 'c:/temp_cGit/english-lesson-picture-story' },
        archived_at: '2026-07-11T00:00:00Z',
        vault_subfolder: 'english-lesson-picture-story',
      },
      {
        id: 23,
        name: 'Claude Commands',
        local_paths: { win32: 'c:/Users/chand/.claude/commands' },
        archived_at: '2026-07-11T00:00:00Z',
        vault_subfolder: null, // trashed disposition
      },
      { id: 24, name: 'empty-slot', local_paths: { darwin: '' } }, // the cwd footgun shape
    ],
    ...overrides,
  };
}

function winCtx(): ResolverContext {
  const ctx = macCtx();
  return { ...ctx, clientOs: 'win32', homeDir: 'C:\\Users\\ccheng' };
}

describe('parseNoteReference', () => {
  it('parses ids, noesis:// and note URLs on any host', () => {
    expect(parseNoteReference('2761')).toEqual({ kind: 'id', id: 2761 });
    expect(parseNoteReference('noesis://note/2761')).toEqual({ kind: 'id', id: 2761 });
    expect(parseNoteReference('noesis://note/2761/btc-fixes.md')).toEqual({ kind: 'id', id: 2761 });
    expect(parseNoteReference('https://noesisbrain.com/notes/2761')).toEqual({ kind: 'id', id: 2761 });
    expect(parseNoteReference('https://noesisbrain.com/notes/2761#bm=abc-123')).toEqual({ kind: 'id', id: 2761 });
    expect(parseNoteReference('http://localhost:3500/notes/99?tab=x')).toEqual({ kind: 'id', id: 99 });
  });

  it('treats everything else as a path', () => {
    expect(parseNoteReference('~/Noesis/my-git/foo.md')).toEqual({ kind: 'path', path: '~/Noesis/my-git/foo.md' });
    expect(parseNoteReference('C:\\temp_cGit\\.noesis\\foo.md')).toEqual({ kind: 'path', path: 'C:\\temp_cGit\\.noesis\\foo.md' });
    expect(parseNoteReference('https://example.com/not-a-note')).toEqual({ kind: 'path', path: 'https://example.com/not-a-note' });
    expect(parseNoteReference('https://host/a/notes/12.png')).toEqual({ kind: 'path', path: 'https://host/a/notes/12.png' });
    expect(parseNoteReference('123abc.md')).toEqual({ kind: 'path', path: '123abc.md' });
  });
});

describe('resolvePathReference on a macOS client', () => {
  const ctx = macCtx();

  it('translates a legacy Windows path via the archived root, collapsed first', () => {
    const r = resolvePathReference(ctx, 'C:\\temp_cGit\\.noesis\\foo.md');
    expect(r).toEqual({
      rootId: VAULT_ID,
      candidates: ['my-git/foo.md', 'my-git/.noesis/foo.md'],
      via: 'legacy-translation',
      archivedRootId: 21,
    });
  });

  it('nested archived roots: longest prefix wins (case-insensitively)', () => {
    const r = resolvePathReference(ctx, 'c:/TEMP_CGIT/english-lesson-picture-story/x.md');
    expect(r).toMatchObject({ rootId: VAULT_ID, candidates: ['english-lesson-picture-story/x.md'], archivedRootId: 22 });
  });

  it('resolves tilde and absolute-home inputs against the tilde-form vault', () => {
    expect(resolvePathReference(ctx, '~/Noesis/chat-notes/cap.md')).toEqual({
      rootId: VAULT_ID,
      candidates: ['chat-notes/cap.md'],
      via: 'active-root',
    });
    expect(resolvePathReference(ctx, '/Users/chandler/Noesis/chat-notes/cap.md')).toMatchObject({
      candidates: ['chat-notes/cap.md'],
    });
  });

  it('resolves a FOREIGN Windows home path via deviceHomeDirs', () => {
    const r = resolvePathReference(ctx, 'C:\\Users\\CCHENG\\Noesis\\my-git\\foo.md');
    expect(r).toEqual({ rootId: VAULT_ID, candidates: ['my-git/foo.md'], via: 'active-root' });
  });

  it('returns null for trashed-disposition roots, unknown paths, and empty input', () => {
    expect(resolvePathReference(ctx, 'c:/Users/chand/.claude/commands/x.md')).toBeNull();
    expect(resolvePathReference(ctx, '/somewhere/else.md')).toBeNull();
    expect(resolvePathReference(ctx, '   ')).toBeNull();
  });

  it('never matches a root whose slot for the sniffed OS is empty (cwd footgun)', () => {
    // root 24 has darwin: '' — a darwin-shaped input must not match it.
    expect(resolvePathReference(ctx, '/tmp/anything.md')).toBeNull();
  });

  it('archived match without a designated vault yields null (no guessing)', () => {
    const noVault = macCtx({ vaultRootId: null });
    expect(resolvePathReference(noVault, 'c:/temp_cGit/.noesis/foo.md')).toBeNull();
  });
});

describe('resolvePathReference on a Windows client', () => {
  const ctx = winCtx();

  it('resolves %USERPROFILE% and local-home Windows inputs', () => {
    expect(resolvePathReference(ctx, '%USERPROFILE%\\Noesis\\my-git\\foo.md')).toEqual({
      rootId: VAULT_ID,
      candidates: ['my-git/foo.md'],
      via: 'active-root',
    });
    expect(resolvePathReference(ctx, 'C:\\Users\\ccheng\\Noesis\\welcome\\hi.md')).toMatchObject({
      candidates: ['welcome/hi.md'],
    });
  });

  it('resolves a FOREIGN macOS home path via deviceHomeDirs', () => {
    const r = resolvePathReference(ctx, '/Users/chandler/Noesis/chat-notes/cap.md');
    expect(r).toEqual({ rootId: VAULT_ID, candidates: ['chat-notes/cap.md'], via: 'active-root' });
  });

  it('still translates legacy Windows paths', () => {
    const r = resolvePathReference(ctx, 'c:\\temp_cGit\\english-lesson-picture-story\\x.md');
    expect(r).toMatchObject({ candidates: ['english-lesson-picture-story/x.md'] });
  });
});

describe('localAbsFor', () => {
  it('expands the tilde vault against THIS machine home per OS', () => {
    expect(localAbsFor(macCtx(), VAULT_ID, 'my-git/foo.md')).toBe('/Users/chandler/Noesis/my-git/foo.md');
    expect(localAbsFor(winCtx(), VAULT_ID, 'my-git/foo.md')).toBe('c:/Users/ccheng/Noesis/my-git/foo.md');
  });

  it('refuses to guess when the root has no usable slot on this OS', () => {
    expect(localAbsFor(macCtx(), 21, 'foo.md')).toBeNull(); // My Git has win32 only
    expect(localAbsFor(macCtx(), 24, 'x.md')).toBeNull(); // empty darwin slot (footgun)
    expect(localAbsFor(macCtx({ homeDir: '' }), VAULT_ID, 'x.md')).toBeNull(); // tilde base, home unknown
  });
});
