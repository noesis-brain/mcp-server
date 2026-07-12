/**
 * Unit test — getNotesForPull auto-pager (H3b / F3).
 *
 * Pins the client-side pagination that keeps pull_notes returning ALL notes
 * while each server response stays bounded: accumulate, advance offset, stop
 * on a short page, thread `root` on every request. Fetch is stubbed — no
 * network, no DB.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { NoesisClient } from '../src/api/NoesisClient.js';

function note(rel: string) {
  return { id: Number(rel.replace(/\D/g, '')) || 0, title: rel, content: '# ' + rel, relative_path: rel, root_name: 'Noesis Cloud' };
}

// Serve `total` notes in pages of 500 (the client's page size), recording the
// query string of every request so we can assert offset/root threading.
function stubPagedFetch(total: number, recorder: string[]) {
  const spy = vi.fn(async (url: string) => {
    recorder.push(url);
    const offset = Number(new URL(url, 'http://x').searchParams.get('offset') ?? '0');
    const slice = Array.from({ length: Math.max(0, Math.min(500, total - offset)) }, (_, i) => note(`n${offset + i}.md`));
    return { ok: true, json: async () => ({ notes: slice }) };
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

afterEach(() => vi.unstubAllGlobals());

describe('NoesisClient.getNotesForPull pager', () => {
  it('single short page → one request, all notes', async () => {
    const rec: string[] = [];
    stubPagedFetch(120, rec);
    const all = await new NoesisClient('https://api.example.com', 'tok').getNotesForPull();
    expect(all).toHaveLength(120);
    expect(rec).toHaveLength(1);
    expect(rec[0]).toContain('offset=0');
    expect(rec[0]).toContain('limit=500');
  });

  it('multiple pages → accumulates every note, stops on the short page', async () => {
    const rec: string[] = [];
    stubPagedFetch(1100, rec); // 500 + 500 + 100
    const all = await new NoesisClient('https://api.example.com', 'tok').getNotesForPull();
    expect(all).toHaveLength(1100);
    expect(new Set(all.map(n => n.relative_path)).size).toBe(1100); // no dup/drop
    expect(rec.map(u => new URL(u, 'http://x').searchParams.get('offset'))).toEqual(['0', '500', '1000']);
  });

  it('exact-multiple total → one extra empty page then stop (no infinite loop)', async () => {
    const rec: string[] = [];
    stubPagedFetch(1000, rec); // 500 + 500 + 0
    const all = await new NoesisClient('https://api.example.com', 'tok').getNotesForPull();
    expect(all).toHaveLength(1000);
    expect(rec).toHaveLength(3); // third page returns 0 (< 500) → break
  });

  it('threads the root filter on every page', async () => {
    const rec: string[] = [];
    stubPagedFetch(1100, rec);
    await new NoesisClient('https://api.example.com', 'tok').getNotesForPull({ root: 'Noesis Cloud' });
    expect(rec.every(u => u.includes('root=Noesis+Cloud') || u.includes('root=Noesis%20Cloud'))).toBe(true);
  });
});
