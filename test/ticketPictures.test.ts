/**
 * Pictures in a Jot ticket (TCK-1845, 2.8.0): backlog_get turns each hosted picture link
 * into an MCP image block, so Claude Code sees the owner's screenshots. These tests pin
 * which links count, the order and labels, the limits, and that the download stays on
 * the Noesis server and never carries the API token.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  collectPictureRefs,
  ticketContentWithPictures,
  MAX_PICTURES,
  MAX_PICTURE_BYTES,
  MAX_TOTAL_PICTURE_BYTES,
  type PictureFetcher,
} from '../src/tools/ticketPictures.js';
import { NoesisClient } from '../src/api/NoesisClient.js';

const ticket = (draft: string, extra: Record<string, unknown> = {}) => ({
  issue: { key: 'TCK-9', title: draft, origin_jot: draft, refined_text: null, body_md: null, ...extra },
  messages: [] as Array<{ id: number; body_md: string }>,
});

describe('collectPictureRefs', () => {
  it('finds relative and absolute hosted pictures in reading order, each token once', () => {
    const data = {
      ...ticket('see ![login](/api/note-images/aaa-1) and ![](https://noesisbrain.com/api/note-images/bbb-2)', {
        refined_text: 'again ![x](/api/note-images/aaa-1)',
        body_md: '![spec](/api/note-images/ccc-3 "title")',
      }),
      messages: [{ id: 12, body_md: 'reply ![m](/api/note-images/ddd-4)' }],
    };
    expect(collectPictureRefs(data)).toEqual([
      { url: '/api/note-images/aaa-1', token: 'aaa-1', where: 'draft', alt: 'login' },
      { url: 'https://noesisbrain.com/api/note-images/bbb-2', token: 'bbb-2', where: 'draft', alt: '' },
      { url: '/api/note-images/ccc-3', token: 'ccc-3', where: 'requirement', alt: 'spec' },
      { url: '/api/note-images/ddd-4', token: 'ddd-4', where: 'message 12', alt: 'm' },
    ]);
  });

  it('ignores plain links and pictures hosted elsewhere', () => {
    expect(collectPictureRefs(ticket('[link](/api/note-images/aaa) ![ext](https://example.com/a.png)'))).toEqual([]);
    expect(collectPictureRefs(null)).toEqual([]);
  });
});

describe('ticketContentWithPictures', () => {
  const ok = (mimeType = 'image/png') => ({ ok: true as const, data: 'QUJD', mimeType, bytes: 3 });

  it('a ticket without pictures is exactly the old JSON text', async () => {
    const data = ticket('no pictures here');
    const fetcher: PictureFetcher = { fetchTicketPicture: vi.fn() };
    const res = await ticketContentWithPictures(data, fetcher);
    expect(res.content).toEqual([{ type: 'text', text: JSON.stringify(data, null, 2) }]);
    expect(fetcher.fetchTicketPicture).not.toHaveBeenCalled();
  });

  it('JSON first, then a header, then one label and one image per loaded picture; failures are listed by URL', async () => {
    const data = ticket('![a](/api/note-images/a1) ![b](/api/note-images/b2) ![c](/api/note-images/c3)');
    const fetcher: PictureFetcher = {
      fetchTicketPicture: vi.fn(async (url: string) =>
        url.endsWith('b2') ? { ok: false as const, reason: 'HTTP 404' } : ok(url.endsWith('c3') ? 'image/jpeg' : 'image/png'),
      ),
    };
    const { content } = await ticketContentWithPictures(data, fetcher);
    expect(content.map((b) => b.type)).toEqual(['text', 'text', 'text', 'image', 'text', 'image']);
    expect(content[1]).toMatchObject({ type: 'text' });
    const header = (content[1] as { text: string }).text;
    expect(header).toContain('This ticket has 3 pictures.');
    expect(header).toContain('Picture 2 (draft): /api/note-images/b2 — not loaded: HTTP 404');
    expect(content[2]).toEqual({ type: 'text', text: 'Picture 1 (draft) "a": /api/note-images/a1' });
    expect(content[3]).toEqual({ type: 'image', data: 'QUJD', mimeType: 'image/png' });
    expect(content[5]).toEqual({ type: 'image', data: 'QUJD', mimeType: 'image/jpeg' });
  });

  it(`loads at most ${MAX_PICTURES} pictures and lists the rest`, async () => {
    const links = Array.from({ length: MAX_PICTURES + 2 }, (_, i) => `![p](/api/note-images/t${i})`).join(' ');
    const fetcher: PictureFetcher = { fetchTicketPicture: vi.fn(async () => ok()) };
    const { content } = await ticketContentWithPictures(ticket(links), fetcher);
    expect(fetcher.fetchTicketPicture).toHaveBeenCalledTimes(MAX_PICTURES);
    expect(content.filter((b) => b.type === 'image')).toHaveLength(MAX_PICTURES);
    expect((content[1] as { text: string }).text).toContain(`Picture ${MAX_PICTURES + 1} (draft): /api/note-images/t${MAX_PICTURES} — not loaded, over the ${MAX_PICTURES}-picture limit`);
  });
});

describe('ticketContentWithPictures — total size budget', () => {
  it('stops loading once the pictures fill the budget, and lists the rest', async () => {
    const big = Math.floor(MAX_TOTAL_PICTURE_BYTES / 2) + 1;
    const links = ['a', 'b', 'c'].map((t) => `![p](/api/note-images/${t})`).join(' ');
    const fetcher: PictureFetcher = { fetchTicketPicture: vi.fn(async () => ({ ok: true as const, data: 'QQ==', mimeType: 'image/png', bytes: big })) };
    const { content } = await ticketContentWithPictures(ticket(links), fetcher);
    expect(content.filter((b) => b.type === 'image')).toHaveLength(1);
    expect((content[1] as { text: string }).text).toContain('Picture 2 (draft): /api/note-images/b — not loaded, the pictures before it already fill the size budget');
  });
});

describe('NoesisClient.fetchTicketPicture', () => {
  afterEach(() => vi.unstubAllGlobals());
  const client = new NoesisClient('https://noesisbrain.com/', 'secret-token');

  const stubFetch = (body: Uint8Array, headers: Record<string, string>, status = 200) => {
    const fn = vi.fn(async () => new Response(body, { status, headers }));
    vi.stubGlobal('fetch', fn);
    return fn;
  };

  it('downloads a relative link from the Noesis server, without the API token', async () => {
    const fn = stubFetch(new Uint8Array([1, 2, 3]), { 'content-type': 'image/png' });
    const got = await client.fetchTicketPicture('/api/note-images/abc');
    expect(got).toEqual({ ok: true, data: Buffer.from([1, 2, 3]).toString('base64'), mimeType: 'image/png', bytes: 3 });
    const [url, init] = fn.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe('https://noesisbrain.com/api/note-images/abc');
    expect(JSON.stringify(init ?? {})).not.toContain('secret-token');
  });

  it('never fetches another host or another path', async () => {
    const fn = stubFetch(new Uint8Array([1]), { 'content-type': 'image/png' });
    expect(await client.fetchTicketPicture('https://evil.example/api/note-images/abc')).toMatchObject({ ok: false });
    expect(await client.fetchTicketPicture('/api/notes/12')).toMatchObject({ ok: false });
    expect(fn).not.toHaveBeenCalled();
  });

  it('refuses SVG, HTTP errors and pictures over the size limit', async () => {
    stubFetch(new Uint8Array([1]), { 'content-type': 'image/svg+xml' });
    expect(await client.fetchTicketPicture('/api/note-images/s')).toEqual({ ok: false, reason: 'a image/svg+xml cannot be shown as an image' });
    stubFetch(new Uint8Array([]), { 'content-type': 'application/json' }, 404);
    expect(await client.fetchTicketPicture('/api/note-images/gone')).toEqual({ ok: false, reason: 'HTTP 404' });
    stubFetch(new Uint8Array(MAX_PICTURE_BYTES + 1), { 'content-type': 'image/jpeg' });
    const big = await client.fetchTicketPicture('/api/note-images/big');
    expect(big.ok).toBe(false);
    expect((big as { reason: string }).reason).toContain('over the 3.75 MB limit');
  });
});
