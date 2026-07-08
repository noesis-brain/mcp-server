/**
 * Navi management tools for the md-manager MCP server.
 *
 * Exposes search/read/create/update/duplicate/delete operations on Navis
 * (AI personas with custom system prompts). All operations go through the
 * backend's /api/navis routes, so the MCP server is a thin HTTP wrapper.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NoesisClient, Navi, CreateNaviInput, UpdateNaviInput } from '../api/NoesisClient.js';

// Shared field schemas for create/update
const ttsProviderEnum = z.enum(['speechify', 'webspeech', 'minimax', 'edgetts']);
const aiProviderEnum = z.enum(['claude', 'gemini']);
const iconTypeEnum = z.enum(['lucide', 'custom']);

const naviFieldsShape = {
  name: z.string().optional().describe('Display name for the Navi'),
  system_prompt: z.string().optional().describe('The system prompt that defines the Navi\'s persona and behavior'),
  description: z.string().nullable().optional().describe('Short one-line description'),
  icon: z.string().optional().describe('Lucide icon name (e.g., "sparkles", "graduation-cap") when icon_type is "lucide"'),
  icon_type: iconTypeEnum.optional().describe('"lucide" for built-in icons, "custom" for uploaded images'),
  color: z.string().optional().describe('Hex color code for the Navi avatar (e.g., "#10b981")'),
  use_knowledge_base: z.boolean().optional().describe('Whether the Navi can reference the user\'s note knowledge base'),
  use_web_search: z.boolean().optional().describe('Whether the Navi gets live Google Search grounding + full-length URL fetching on the main chat call. Gemini-only; ignored when ai_provider=claude. Opt-in for fact-checkers and research Navis; costs more and is slower.'),
  use_conversation_history: z.boolean().optional().describe('Whether to persist conversation history across messages'),
  animation_presets: z.array(z.string()).optional().describe('Array of animation presets: none, bounce, pulse, wiggle, glow, spin, shake'),
  animation_triggers: z.array(z.string()).optional().describe('Array of animation triggers: none, hover, responding, hover_and_responding, always'),
  tts_provider: ttsProviderEnum.nullable().optional().describe('TTS voice provider, or null for no TTS'),
  tts_voice_id: z.string().nullable().optional().describe('Provider-specific voice ID'),
  tts_rate: z.number().min(0.5).max(2.0).nullable().optional().describe('TTS rate (0.5-2.0)'),
  tts_pitch: z.number().min(0).max(2.0).nullable().optional().describe('TTS pitch (0-2.0)'),
  tts_autoplay: z.boolean().optional().describe('Auto-play TTS on responses. Leave false for text-heavy Navis.'),
  ai_provider: aiProviderEnum.nullable().optional().describe('AI backend override (claude or gemini), or null for user default'),
  ai_model: z.string().nullable().optional().describe('Specific model ID (e.g., "claude-opus-4-6"), or null for provider default'),
};

/**
 * Format a Navi as a compact one-line summary for list output.
 */
function formatNaviLine(n: Navi): string {
  const kind = n.is_template ? 'template' : 'custom';
  const desc = n.description ? ` — ${n.description}` : '';
  return `#${n.id}  [${kind}]  ${n.name}${desc}`;
}

/**
 * Format a Navi as a full detail block.
 */
function formatNaviDetail(n: Navi): string {
  const lines: string[] = [];
  lines.push(`# ${n.name} (id: ${n.id})`);
  if (n.description) lines.push(`Description: ${n.description}`);
  lines.push(`Type: ${n.is_template ? 'template (read-only)' : 'custom (yours)'}`);
  lines.push(`Icon: ${n.icon} [${n.icon_type}]   Color: ${n.color}`);
  lines.push(`Knowledge base: ${n.use_knowledge_base}   Web search: ${n.use_web_search ?? false}   Conversation history: ${n.use_conversation_history}`);
  if (n.tts_provider) lines.push(`TTS: ${n.tts_provider} (voice: ${n.tts_voice_id ?? 'default'}, rate: ${n.tts_rate ?? 'default'}, pitch: ${n.tts_pitch ?? 'default'})`);
  if (n.ai_provider) lines.push(`AI override: ${n.ai_provider}${n.ai_model ? ` / ${n.ai_model}` : ''}`);
  if (n.animation_presets?.length) lines.push(`Animations: ${n.animation_presets.join(', ')} (triggers: ${(n.animation_triggers ?? []).join(', ') || 'none'})`);
  if (n.inspired_by_living_person) lines.push('Inspired by a living person: true (public sharing disabled)');
  lines.push('');
  lines.push('## System Prompt');
  lines.push(n.system_prompt);
  return lines.join('\n');
}

/**
 * Build a ~120-char snippet around the first match of `query` inside `text`.
 */
function buildSnippet(text: string, query: string, context = 60): string | null {
  if (!text) return null;
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const idx = lowerText.indexOf(lowerQuery);
  if (idx === -1) return null;
  const start = Math.max(0, idx - context);
  const end = Math.min(text.length, idx + query.length + context);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return `${prefix}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${suffix}`;
}

export function registerNaviTools(server: McpServer, client: NoesisClient): void {
  // ─── list_navis ──────────────────────────────────────────────
  server.tool(
    'list_navis',
    'List all Navis available to the user: their custom Navis + all built-in templates. Returns a compact summary; use get_navi to read a full system_prompt.',
    {},
    async () => {
      const { navis, templates, default_navi_id } = await client.listNavis();
      const parts: string[] = [];
      parts.push(`Your custom Navis (${navis.length}):`);
      if (navis.length === 0) {
        parts.push('  (none yet — use create_navi to add one)');
      } else {
        for (const n of navis) parts.push(`  ${formatNaviLine(n)}${default_navi_id === n.id ? '  ★ default' : ''}`);
      }
      parts.push('');
      parts.push(`Templates (${templates.length}):`);
      for (const n of templates) parts.push(`  ${formatNaviLine(n)}`);
      return { content: [{ type: 'text', text: parts.join('\n') }] };
    }
  );

  // ─── search_navis ────────────────────────────────────────────
  server.tool(
    'search_navis',
    'Search Navis by keyword. Matches case-insensitive substrings across name, description, and system_prompt. Returns matches with a short snippet showing where the keyword appears.',
    {
      query: z.string().describe('Keyword or phrase to search for'),
      scope: z.enum(['mine', 'templates', 'all']).optional().describe('Which Navis to search (default: all)'),
    },
    async (args) => {
      const { query, scope = 'all' } = args;
      if (!query.trim()) {
        return { content: [{ type: 'text', text: 'Empty query — provide a keyword to search for.' }] };
      }
      const { navis, templates } = await client.listNavis();
      const pool: Navi[] = [];
      if (scope === 'mine' || scope === 'all') pool.push(...navis);
      if (scope === 'templates' || scope === 'all') pool.push(...templates);

      const q = query.toLowerCase();
      const matches: Array<{ navi: Navi; field: string; snippet: string }> = [];
      for (const n of pool) {
        if (n.name.toLowerCase().includes(q)) {
          matches.push({ navi: n, field: 'name', snippet: n.name });
          continue;
        }
        if (n.description && n.description.toLowerCase().includes(q)) {
          matches.push({ navi: n, field: 'description', snippet: buildSnippet(n.description, query) ?? n.description });
          continue;
        }
        const promptSnippet = buildSnippet(n.system_prompt, query);
        if (promptSnippet) {
          matches.push({ navi: n, field: 'system_prompt', snippet: promptSnippet });
        }
      }

      if (matches.length === 0) {
        return { content: [{ type: 'text', text: `No Navis matched "${query}" in scope "${scope}".` }] };
      }

      const lines = [`Found ${matches.length} match${matches.length === 1 ? '' : 'es'} for "${query}" (scope: ${scope}):`, ''];
      for (const m of matches.slice(0, 20)) {
        lines.push(formatNaviLine(m.navi));
        lines.push(`    match in ${m.field}: ${m.snippet}`);
        lines.push('');
      }
      if (matches.length > 20) lines.push(`…and ${matches.length - 20} more. Refine your query to narrow.`);
      return { content: [{ type: 'text', text: lines.join('\n').trimEnd() }] };
    }
  );

  // ─── get_navi ────────────────────────────────────────────────
  server.tool(
    'get_navi',
    'Read a single Navi by id, including the full system_prompt. Use this when you need to review a Navi\'s behavior before updating it.',
    {
      id: z.number().int().describe('Numeric Navi id (from list_navis or search_navis)'),
    },
    async (args) => {
      const navi = await client.getNavi(args.id);
      return { content: [{ type: 'text', text: formatNaviDetail(navi) }] };
    }
  );

  // ─── create_navi ─────────────────────────────────────────────
  server.tool(
    'create_navi',
    'Create a new custom Navi owned by the authenticated user. Required: name + system_prompt. All other fields are optional and fall back to sensible defaults (icon=sparkles, color=#8b5cf6, use_knowledge_base=false, use_conversation_history=true).',
    {
      ...naviFieldsShape,
      name: z.string().describe('Display name for the Navi (required)'),
      system_prompt: z.string().describe('The system prompt that defines the Navi\'s persona and behavior (required)'),
      inspired_by_living_person: z.boolean().optional().describe('Set true when this persona is modeled on a real, living person. Create-only and immutable afterward (update_navi cannot change it). Blocks the Navi from ever being public-shared.'),
    },
    async (args) => {
      const body: CreateNaviInput = {
        name: args.name,
        system_prompt: args.system_prompt,
        description: args.description,
        icon: args.icon,
        icon_type: args.icon_type,
        color: args.color,
        use_knowledge_base: args.use_knowledge_base,
        use_web_search: args.use_web_search,
        use_conversation_history: args.use_conversation_history,
        animation_presets: args.animation_presets,
        animation_triggers: args.animation_triggers,
        tts_provider: args.tts_provider,
        tts_voice_id: args.tts_voice_id,
        tts_rate: args.tts_rate,
        tts_pitch: args.tts_pitch,
        tts_autoplay: args.tts_autoplay,
        ai_provider: args.ai_provider,
        ai_model: args.ai_model,
        inspired_by_living_person: args.inspired_by_living_person,
      };
      const navi = await client.createNavi(body);
      return {
        content: [{
          type: 'text',
          text: `Created Navi #${navi.id}: ${navi.name}\n\n${formatNaviDetail(navi)}`
        }]
      };
    }
  );

  // ─── update_navi ─────────────────────────────────────────────
  server.tool(
    'update_navi',
    'Update an existing custom Navi (you must own it — templates are read-only). Only pass the fields you want to change; omitted fields stay untouched. Pass null to explicitly clear optional fields like tts_provider or ai_provider.',
    {
      id: z.number().int().describe('Numeric Navi id to update'),
      ...naviFieldsShape,
      is_active: z.boolean().optional().describe('Set to false to soft-deactivate without deleting'),
    },
    async (args) => {
      const { id, ...rest } = args;
      const body: UpdateNaviInput = rest;
      const navi = await client.updateNavi(id, body);
      return {
        content: [{
          type: 'text',
          text: `Updated Navi #${navi.id}: ${navi.name}\n\n${formatNaviDetail(navi)}`
        }]
      };
    }
  );

  // ─── duplicate_navi ──────────────────────────────────────────
  server.tool(
    'duplicate_navi',
    'Clone a Navi (either a template or one you own) into a new custom Navi owned by you. Use this to fork a template as a starting point for customization.',
    {
      id: z.number().int().describe('Source Navi id to clone'),
      name: z.string().optional().describe('Optional name for the copy (defaults to "<source name> (Copy)")'),
    },
    async (args) => {
      const navi = await client.duplicateNavi(args.id, args.name);
      return {
        content: [{
          type: 'text',
          text: `Duplicated into Navi #${navi.id}: ${navi.name}\n\n${formatNaviDetail(navi)}`
        }]
      };
    }
  );

  // ─── delete_navi ─────────────────────────────────────────────
  server.tool(
    'delete_navi',
    'Delete a custom Navi you own (hard delete — cannot be undone). Templates cannot be deleted. SAFETY: the first call returns a preview and requires confirm=true on a follow-up call to actually delete.',
    {
      id: z.number().int().describe('Navi id to delete'),
      confirm: z.boolean().optional().describe('Must be true to actually perform the delete. Omit or set false to get a preview.'),
    },
    async (args) => {
      if (!args.confirm) {
        const navi = await client.getNavi(args.id);
        return {
          content: [{
            type: 'text',
            text: `DELETE PREVIEW — not yet deleted.\n\n${formatNaviDetail(navi)}\n\nTo proceed, call delete_navi again with { id: ${args.id}, confirm: true }.`
          }]
        };
      }
      await client.deleteNavi(args.id);
      return { content: [{ type: 'text', text: `Deleted Navi #${args.id}.` }] };
    }
  );
}
