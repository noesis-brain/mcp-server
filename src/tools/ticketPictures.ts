/**
 * Pictures in a Jot ticket (TCK-1845, 2.8.0). The page stores a pasted or attached
 * picture as a Markdown link to a hosted note image, `![picture](/api/note-images/<token>)`.
 * backlog_get returns the ticket as JSON text, so Claude Code would see only the link.
 * This module finds those links and turns each picture into an MCP image block after
 * the JSON, so a session that reads a ticket also sees its screenshots.
 *
 * Limits keep one ticket from flooding the context: at most MAX_PICTURES pictures,
 * each at most MAX_PICTURE_BYTES. A picture over a limit, of a type Claude cannot read
 * (SVG), or that fails to download is listed by URL in the text instead.
 */

export const MAX_PICTURES = 8;
/** 3.75 MB raw is 5 MB as base64, the largest image the Claude API accepts. */
export const MAX_PICTURE_BYTES = 3_932_160;
/**
 * All loaded pictures together, raw: 15 MB is about 20 MB as base64, safely under the
 * Claude API's 32 MB request limit with the rest of the conversation. Pictures past it
 * are listed by URL.
 */
export const MAX_TOTAL_PICTURE_BYTES = 15 * 1024 * 1024;
/** The image types Claude can read. */
export const READABLE_PICTURE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

const PICTURE_LINK_RE = /!\[([^\]\n]*)\]\(\s*((?:https?:\/\/[^\s)]+)?\/api\/note-images\/([A-Za-z0-9_-]+))[^)\n]*\)/g;

export interface PictureRef {
  /** The link target as written: a path, or an absolute URL. */
  url: string;
  /** The token after /api/note-images/, used to drop repeats. */
  token: string;
  /** Where the picture appears: "draft", "refined text", "requirement", "message 12". */
  where: string;
  alt: string;
}

export type PictureFetch =
  | { ok: true; data: string; mimeType: string; bytes: number }
  | { ok: false; reason: string };

export interface PictureFetcher {
  fetchTicketPicture(url: string): Promise<PictureFetch>;
}

type TicketData = {
  issue?: { origin_jot?: string | null; refined_text?: string | null; body_md?: string | null; title?: string | null };
  messages?: Array<{ id?: number; body_md?: string | null }>;
};

/** Every hosted picture link in the ticket, in reading order, each token once. */
export function collectPictureRefs(data: unknown): PictureRef[] {
  const d = (data ?? {}) as TicketData;
  const sources: Array<[string, string | null | undefined]> = [
    ['draft', d.issue?.origin_jot || d.issue?.title],
    ['refined text', d.issue?.refined_text],
    ['requirement', d.issue?.body_md],
    ...(d.messages ?? []).map((m): [string, string | null | undefined] => [`message ${m.id ?? '?'}`, m.body_md]),
  ];
  const seen = new Set<string>();
  const out: PictureRef[] = [];
  for (const [where, text] of sources) {
    if (!text) continue;
    for (const m of text.matchAll(PICTURE_LINK_RE)) {
      const token = m[3];
      if (seen.has(token)) continue;
      seen.add(token);
      out.push({ url: m[2], token, where, alt: m[1].trim() });
    }
  }
  return out;
}

type Block = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

/**
 * The tool result for a ticket: the JSON text, then one label and one image block per
 * picture. Pictures beyond the cap, or that could not be read, are listed by URL.
 */
export async function ticketContentWithPictures(
  data: unknown,
  fetcher: PictureFetcher,
): Promise<{ content: Block[] }> {
  const content: Block[] = [{ type: 'text', text: JSON.stringify(data, null, 2) }];
  const refs = collectPictureRefs(data);
  if (refs.length === 0) return { content };

  const shown: Block[] = [];
  const listed: string[] = [];
  let n = 0;
  let total = 0;
  for (const ref of refs) {
    n++;
    if (n > MAX_PICTURES) {
      listed.push(`Picture ${n} (${ref.where}): ${ref.url} — not loaded, over the ${MAX_PICTURES}-picture limit`);
      continue;
    }
    const got = await fetcher.fetchTicketPicture(ref.url);
    if (!got.ok) {
      listed.push(`Picture ${n} (${ref.where}): ${ref.url} — not loaded: ${got.reason}`);
      continue;
    }
    if (total + got.bytes > MAX_TOTAL_PICTURE_BYTES) {
      listed.push(`Picture ${n} (${ref.where}): ${ref.url} — not loaded, the pictures before it already fill the size budget`);
      continue;
    }
    total += got.bytes;
    const alt = ref.alt ? ` "${ref.alt}"` : '';
    shown.push({ type: 'text', text: `Picture ${n} (${ref.where})${alt}: ${ref.url}` });
    shown.push({ type: 'image', data: got.data, mimeType: got.mimeType });
  }
  const header =
    `This ticket has ${refs.length} picture${refs.length === 1 ? '' : 's'}. ` +
    'Each loaded picture follows as an image, after a line that says where it appears in the ticket.';
  content.push({ type: 'text', text: [header, ...listed].join('\n') });
  content.push(...shown);
  return { content };
}
