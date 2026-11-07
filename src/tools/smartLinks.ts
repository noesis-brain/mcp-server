/**
 * Smart links tools (TCK-1883): help a user set up their link types — the Jira site and
 * projects, the GitHub repository, Noesis notes, web pages, custom systems — and check the
 * result in a loop, without ever changing a note.
 *
 * The loop these tools are built for:
 *   1. smart_links_scan_notes — what the user's notes already link to, with proposed types;
 *   2. smart_links_test / smart_links_preview_note — try CANDIDATE settings on sample text or on
 *      a real note: a dry run, nothing is saved;
 *   3. smart_links_set_settings — save the final settings (the answer holds the previous ones,
 *      for a rollback).
 * Every rule is the server's: the tools are a thin HTTP wrapper over /api/smart-links.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NoesisClient, SmartLinkSettingsInput } from '../api/NoesisClient.js';

const STYLE_HELP =
  'Styles: "id+title" = [KEY](url) Title (the Daily Briefing style), "id-title" = [KEY Title](url), "id" = [KEY](url), "title" = [Title](url).';

const typeSchema = z
  .object({
    id: z.string().describe('Unique id of this link type, e.g. "jira1" (letters, digits, _ or -)'),
    preset: z.enum(['jira', 'github', 'noesis', 'web', 'custom']),
  })
  .passthrough()
  .describe(
    'One link type. jira: host, projects (keys a TYPED key may use), typed, pasted, style. github: host (default github.com), owner, repo, shortForms (e.g. ["PR-{number:num}", "PR #{number:num}"]), idFormat {pull, issue}, typed, pasted, style. noesis: pasted, style. web: skipSites, pasted, style. custom: name, urlTemplates (placeholders only: {name}, {name:num}, {name:A|B}, {name:*}), shortForms, idFormat, titleFrom (page|none), typed, pasted, style. style = { lineStart, inSentence }. typed/pasted = suggest | auto | off.',
  );

const settingsSchema = z
  .object({
    enabled: z.boolean().describe('"Suggest while I write": the master switch for the editor chips'),
    types: z.array(typeSchema).max(20),
  })
  .describe(`The whole Smart links settings object. ${STYLE_HELP}`);

type Rendering = { style: string; linkText: string; after: string } | null;

/** A rendering as the markdown it would put in the note. */
function asMarkdown(r: Rendering, href: string | null): string {
  if (!r || !href) return '(no change)';
  const text = r.linkText.replace(/([\\[\]])/g, '\\$1');
  return `[${text}](${href})${r.after}`;
}

function json(value: unknown): string {
  return '```json\n' + JSON.stringify(value, null, 2) + '\n```';
}

export function registerSmartLinkTools(server: McpServer, client: NoesisClient): void {
  server.tool(
    'smart_links_get_settings',
    "Read the user's Smart links settings: the master switch and their link types. Start here before changing anything.",
    {},
    async () => {
      const settings = await client.getSmartLinkSettings();
      const lines = [
        `Smart links: ${settings.enabled ? 'on' : 'off'} · ${settings.types.length} link type(s)`,
        ...settings.types.map((t) => `- ${t.id}: ${t.preset}${t.host ? ` ${t.host}` : ''}${t.projects?.length ? ` [${t.projects.join(', ')}]` : ''}${t.owner ? ` ${t.owner}/${t.repo}` : ''}`),
        '',
        json(settings),
      ];
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  server.tool(
    'smart_links_set_settings',
    "Save the user's whole Smart links settings object (replaces it). Test candidates with smart_links_test and smart_links_preview_note first. The answer includes the previous settings, so a mistake can be rolled back by saving those.",
    { settings: settingsSchema },
    async (args) => {
      try {
        const { settings, previous } = await client.saveSmartLinkSettings(args.settings as SmartLinkSettingsInput);
        return {
          content: [
            {
              type: 'text',
              text: [`Saved: ${settings.types.length} link type(s), switch ${settings.enabled ? 'on' : 'off'}.`, '', 'Previous settings (save these to roll back):', json(previous)].join('\n'),
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `Not saved: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    'smart_links_scan_notes',
    "Count the links already in the user's own notes (Jira sites and projects, GitHub repositories, Noesis links, other sites) and propose link types for them. Read-only. Projects with fewer than 3 links are proposed unticked.",
    {},
    async () => {
      const scan = await client.scanSmartLinkTypes();
      const lines: string[] = ['## Found in your notes'];
      for (const j of scan.jira) lines.push(`- Jira ${j.host}: ${j.projects.map((p) => `${p.key} (${p.count})`).join(', ')}`);
      for (const g of scan.github) lines.push(`- GitHub ${g.host}/${g.owner}/${g.repo}: ${g.count}`);
      lines.push(`- Noesis note links: ${scan.noesisLinks}`);
      if (scan.otherSites.length) lines.push(`- Other sites: ${scan.otherSites.map((s) => `${s.host} (${s.count})`).join(', ')}`);
      lines.push('', '## Proposed link types (selected = ticked by default)', json(scan.proposals));
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  server.tool(
    'smart_links_test',
    `Try sample texts — pasted URLs, note paths or typed keys such as "BPLAT-1234" or "PR #111" — against the saved settings, or against CANDIDATE settings (a dry run: nothing is saved). For each sample: which link type matched, the link, the title, and the markdown each context would produce (start of a line, inside a sentence). ${STYLE_HELP}`,
    {
      samples: z.array(z.string().min(1).max(2048)).min(1).max(50).describe('Texts to try, e.g. ["https://acme.atlassian.net/browse/ABC-1", "ABC-1", "PR #12"]'),
      settings: settingsSchema.optional().describe('Candidate settings to try instead of the saved ones (not saved)'),
    },
    async (args) => {
      try {
        const results = await client.testSmartLinks(args.samples, args.settings as SmartLinkSettingsInput | undefined);
        const lines = results.map((r) => {
          if (!r.match) return `- ${r.input}\n  → no link type matches`;
          const head = `- ${r.input}\n  → ${r.match.preset} (${r.match.typeId})${r.match.id ? ` · ID ${r.match.id}` : ''} · ${r.match.href ?? '(unresolved)'} · title: ${r.title ?? `none (${r.titleStatus})`}`;
          return `${head}\n    line start: ${asMarkdown(r.lineStart, r.match.href)}\n    in a sentence: ${asMarkdown(r.inSentence, r.match.href)}`;
        });
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Test refused: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    'smart_links_preview_note',
    'Preview, READ-ONLY, what "Make smart links in this note" would change in a note: each bare URL, autolink, link whose text is its own URL or path, and typed key, with the markdown it would become. Uses the saved settings, or CANDIDATE settings (not saved). It never changes the note: the conversion only happens in the editor, where the user can undo it.',
    {
      note_id: z.number().int().positive().describe('The note id (noesisbrain.com/notes/<id>)'),
      settings: settingsSchema.optional().describe('Candidate settings to try instead of the saved ones (not saved)'),
    },
    async (args) => {
      try {
        const items = await client.previewSmartLinksInNote(args.note_id, args.settings as SmartLinkSettingsInput | undefined);
        if (!items.length) return { content: [{ type: 'text', text: 'Nothing to change in this note.' }] };
        const changes = items.filter((i) => i.replacement);
        const lines = [`${changes.length} of ${items.length} found item(s) would change:`];
        for (const i of items) {
          lines.push(`- line ${i.line}: ${i.original}`);
          lines.push(i.replacement ? `  → ${i.replacement}` : `  → (no change: ${i.href ? `no title, ${i.titleStatus}` : 'no link type matches'})`);
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Preview refused: ${(err as Error).message}` }], isError: true };
      }
    },
  );
}
