/**
 * Unit tests — vault-safe full-sync semantics (H4 / F4).
 *
 * Drives the real sync_notes full-root handler (captured from registerTools)
 * with an in-memory fake client + a temp vault on disk. Pins:
 *   - the vault never triggers the "move new files to .noesis" prompt;
 *   - a cloud note whose local file exists on disk under a dot-folder (hidden
 *     from the scanner) is NOT silently overwritten — it's flagged a conflict.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { registerTools } from '../src/tools/index.js';
import { NoesisClient } from '../src/api/NoesisClient.js';

type Handler = (args: any) => Promise<{ content: Array<{ type: string; text: string }> }>;

// Capture the sync_notes handler from registerTools (which only calls server.tool).
function captureSyncNotes(client: NoesisClient): Handler {
  let handler: Handler | null = null;
  const fakeServer = {
    tool: (name: string, _desc: string, _schema: unknown, cb: Handler) => {
      if (name === 'sync_notes') handler = cb;
    },
  };
  registerTools(fakeServer as any, { client });
  if (!handler) throw new Error('sync_notes handler not registered');
  return handler;
}

let home: string;
let vault: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'h4-'));
  vault = path.join(home, 'Noesis');
  fs.mkdirSync(vault, { recursive: true });
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

function makeClient(cloudNotes: any[], spies: Record<string, any> = {}): NoesisClient {
  return {
    getRootsForSync: async () => [{ id: 7, name: 'Noesis Cloud', path: vault, local_paths: { linux: '~/Noesis' }, lastScannedAt: null }],
    getResolverContext: async () => ({ clientOs: 'linux', homeDir: home, vaultRootId: 7, deviceHomeDirs: null, roots: [] }),
    getNotesForSync: async () => cloudNotes,
    upsertNote: spies.upsertNote ?? (async () => ({})),
    updateFileMetadata: async () => true,
    updateRootScanTime: async () => {},
    logSyncOperation: async () => {},
    getNote: async () => undefined,
    ...spies,
  } as unknown as NoesisClient;
}

describe('sync_notes full-sync — vault safety (H4)', () => {
  it('does NOT prompt to move new vault files to .noesis; push-creates them', async () => {
    fs.writeFileSync(path.join(vault, 'fresh-note.md'), '# fresh\n\nlocal only', 'utf-8');
    let upserts = 0;
    const client = makeClient([], { upsertNote: async () => { upserts++; return {}; } });

    const res = await captureSyncNotes(client)({ root: 'Noesis Cloud' });
    const text = res.content[0].text;

    expect(text).not.toMatch(/move them to|moveNewToNoesis/i); // no trap prompt
    expect(upserts).toBe(1); // pushed straight to cloud
  });

  it('does NOT clobber a scan-hidden (.noesis/) local file that diverges from cloud', async () => {
    const rel = 'my-git/.noesis/keep.md';
    const localContent = '# my local edits — must survive';
    fs.mkdirSync(path.join(vault, 'my-git', '.noesis'), { recursive: true });
    fs.writeFileSync(path.join(vault, rel), localContent, 'utf-8');

    // Cloud has the same rel with DIFFERENT content. The scanner skips
    // dot-dirs, so the loop sees this as "cloud-only" — the old code would
    // blind-overwrite. H4 must detect the on-disk file and refuse.
    const client = makeClient([
      { id: 5, relative_path: rel, hash: 'CLOUDHASH', modified_at: new Date().toISOString(),
        content: '# cloud version — would clobber', title: null, description: null, keywords: null, edited_online_at: null },
    ]);

    const res = await captureSyncNotes(client)({ root: 'Noesis Cloud' });

    expect(fs.readFileSync(path.join(vault, rel), 'utf-8')).toBe(localContent); // preserved
    expect(res.content[0].text).toMatch(/conflict/i); // surfaced, not silent
  });

  it('a genuinely absent cloud-only note is still pulled to disk', async () => {
    const rel = 'my-git/pulled.md';
    const client = makeClient([
      { id: 8, relative_path: rel, hash: 'H', modified_at: new Date().toISOString(),
        content: '# pulled from cloud', title: null, description: null, keywords: null, edited_online_at: null },
    ]);

    await captureSyncNotes(client)({ root: 'Noesis Cloud' });
    expect(fs.existsSync(path.join(vault, rel))).toBe(true);
    expect(fs.readFileSync(path.join(vault, rel), 'utf-8')).toBe('# pulled from cloud');
  });
});
