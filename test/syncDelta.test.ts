/**
 * Unit tests — hash-first delta sync (H3a / F3).
 *
 * Pins the payload regression fix: per-file sync must NOT prime the whole
 * root's content (getNotesForSync), only fetch the ONE touched note's content
 * via getNoteByRelativePath, and only when the candidate exists in the
 * lightweight hash map. Downstream branch outcomes (skipped / pull / local
 * push-create) are preserved.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { syncSpecificFiles, adaptCloudNote } from '../src/tools/index.js';
import { NoesisClient } from '../src/api/NoesisClient.js';

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'noesis-delta-'));
}

// A fake client exposing only what syncSpecificFiles touches. getNotesForSync
// is a spy that MUST stay uncalled (that was the 51.5MB-per-call regression).
function makeClient(overrides: Partial<Record<string, any>> = {}) {
  const home = overrides.__home as string;
  const getNotesForSync = vi.fn(async () => { throw new Error('getNotesForSync must not be called (H3a)'); });
  const getNoteByRelativePath = vi.fn(async (_rootId: number, rel: string) => overrides.__notes?.[rel]);
  const getNoteHashesByRoot = vi.fn(async () => new Map<string, string>(Object.entries(overrides.__hashes ?? {})));
  const client = {
    getResolverContext: async () => ({
      // clientOs 'linux' so an OS-temp home (macOS /var/folders/… sniffs as
      // linux) matches the vault's linux slot — a test-harness detail; on the
      // real Mac the /Users/… home sniffs darwin and matches its darwin slot.
      clientOs: 'linux',
      homeDir: home,
      vaultRootId: 7,
      deviceHomeDirs: null,
      roots: [{ id: 7, name: 'Noesis Cloud', local_paths: { linux: '~/Noesis' }, archived_at: null, vault_subfolder: null }],
    }),
    getNoteHashesByRoot,
    getNoteByRelativePath,
    getNotesForSync,
    getNote: async () => undefined,
    upsertNote: vi.fn(async () => ({})),
    updateFileMetadata: vi.fn(async () => true),
    updateRootScanTime: vi.fn(async () => {}),
    logSyncOperation: vi.fn(async () => {}),
    ...overrides,
  } as unknown as NoesisClient;
  return { client, getNotesForSync, getNoteByRelativePath, getNoteHashesByRoot };
}

let home: string;
beforeEach(() => { home = tmpHome(); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

describe('adaptCloudNote', () => {
  it('takes hash from the map and passes keyword arrays through', () => {
    const row = adaptCloudNote(
      { id: 5, title: 'T', file_path: 'x', relative_path: 'my-git/a.md', content: '# a', keywords: ['k1', 'k2'] } as any,
      'my-git/a.md',
      'HASH123'
    );
    expect(row).toMatchObject({ id: 5, hash: 'HASH123', relative_path: 'my-git/a.md', content: '# a', keywords: ['k1', 'k2'], title: 'T' });
  });

  it('defaults missing optional fields safely', () => {
    const row = adaptCloudNote({ id: 1, title: 'T', file_path: 'x' } as any, 'r.md', 'H');
    expect(row.content).toBe('');
    expect(row.description).toBeNull();
    expect(row.keywords).toBeNull();
    expect(row.edited_online_at).toBeNull();
  });
});

describe('syncSpecificFiles hash-first delta', () => {
  const rel = 'my-git/note.md';

  it('an unchanged file is skipped WITHOUT calling getNotesForSync; content fetched exactly once', async () => {
    const vaultDir = path.join(home, 'Noesis', 'my-git');
    fs.mkdirSync(vaultDir, { recursive: true });
    const content = '# note\n\nbody';
    fs.writeFileSync(path.join(home, 'Noesis', rel), content, 'utf-8');
    const hash = NoesisClient.computeHash(content);

    const { client, getNotesForSync, getNoteByRelativePath } = makeClient({
      __home: home,
      __hashes: { [rel]: hash },
      __notes: { [rel]: { id: 9, title: 'note', file_path: 'x', relative_path: rel, content, modified_at: new Date().toISOString() } },
    });

    const res = await syncSpecificFiles([`${home}/Noesis/${rel}`], false, client);

    expect(getNotesForSync).not.toHaveBeenCalled();
    expect(getNoteByRelativePath).toHaveBeenCalledTimes(1);
    expect(res.content[0].text).toMatch(/kipped|nchanged|0 new/i);
  });

  it('a cloud-only note is pulled to disk without a whole-root fetch', async () => {
    const content = '# pulled\n\nfrom cloud';
    const hash = NoesisClient.computeHash(content);
    const { client, getNotesForSync, getNoteByRelativePath } = makeClient({
      __home: home,
      __hashes: { [rel]: hash },
      __notes: { [rel]: { id: 12, title: 'pulled', file_path: 'x', relative_path: rel, content, modified_at: new Date().toISOString() } },
    });

    await syncSpecificFiles([`${home}/Noesis/${rel}`], false, client);

    expect(getNotesForSync).not.toHaveBeenCalled();
    expect(getNoteByRelativePath).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(path.join(home, 'Noesis', rel), 'utf-8')).toBe(content);
  });

  it('a local-only file (absent from the hash map) never fetches note content', async () => {
    const vaultDir = path.join(home, 'Noesis', 'my-git');
    fs.mkdirSync(vaultDir, { recursive: true });
    fs.writeFileSync(path.join(home, 'Noesis', rel), '# brand new local', 'utf-8');

    const { client, getNotesForSync, getNoteByRelativePath } = makeClient({
      __home: home,
      __hashes: {}, // empty cloud → local-only push-create
    });

    const res = await syncSpecificFiles([`${home}/Noesis/${rel}`], false, client);

    expect(getNotesForSync).not.toHaveBeenCalled();
    expect(getNoteByRelativePath).not.toHaveBeenCalled();
    expect((client as any).upsertNote).toHaveBeenCalledTimes(1);
    expect(res.content[0].text).toMatch(/new|create|ushed/i);
  });
});
