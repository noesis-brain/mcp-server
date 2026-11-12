/**
 * User skill tools for the md-manager MCP server (TCK-1894).
 *
 * A skill is a named markdown prompt in the user's Noesis skill library. Every Navi in the
 * user's chats can run it: type "/name" in a chat, or pick it in the Generate note dialog.
 * These tools let Claude Code push its own command files (~/.claude/commands/*.md) into
 * that library. All operations go through the backend's /api/user-skills routes.
 */

import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { expandHome, type NoesisClient, type UserSkill } from '../api/NoesisClient.js';

export interface SkillFileFields {
  name: string;
  description: string;
  argument_hint: string;
  body_md: string;
}

const FRONTMATTER_RE = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** Turns any text into a valid skill name: lowercase, a-z 0-9 . _ - only, at most 64. */
export function toSkillName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\.md$/, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+/, '')
    .replace(/-+$/, '')
    .slice(0, 64);
}

function unquote(v: string): string {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}

/**
 * Reads a Claude Code command file: frontmatter `description` and `argument-hint` (and an
 * optional `name`), then the body. The name falls back to the file name without ".md".
 * The frontmatter is read one `key: value` line at a time, the same way the Settings
 * importer does (frontend lib/skillMarkdown.ts). Command files are often not strict YAML
 * ("description: Review code: find bugs", "argument-hint: [a] [b]"), and a strict parser
 * would drop every field for one such line.
 */
export function parseSkillFile(fileName: string, text: string): SkillFileFields {
  const fm = text.match(FRONTMATTER_RE);
  const fields: Record<string, string> = {};
  if (fm) {
    for (const line of fm[1].split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
      if (m) fields[m[1].toLowerCase()] = unquote(m[2]);
    }
  }
  const str = (v: string | undefined): string => v ?? '';
  const body = (fm ? text.slice(fm[0].length) : text.replace(/^\uFEFF/, '')).replace(/^\s*\n/, '');
  return {
    name: toSkillName(str(fields.name) || path.basename(fileName)),
    description: str(fields.description),
    argument_hint: str(fields['argument-hint']),
    body_md: body.trimEnd() + '\n',
  };
}

function formatSkillLine(s: UserSkill): string {
  const hint = s.argument_hint ? ` ${s.argument_hint}` : '';
  const desc = s.description ? ` — ${s.description}` : '';
  return `/${s.name}${hint}${desc}  (id ${s.id}, from ${s.source}, updated ${s.updated_at.slice(0, 10)})`;
}

export function registerSkillTools(server: McpServer, client: NoesisClient): void {
  // ─── list_skills ─────────────────────────────────────────────
  server.tool(
    'list_skills',
    'List the skills in your Noesis skill library. A Navi runs a skill when you type "/name" in a Noesis chat; in v1 a skill turns the chat into a note draft.',
    {},
    async () => {
      const skills = await client.listUserSkills();
      if (skills.length === 0) {
        return { content: [{ type: 'text', text: 'No skills yet. Push one with upsert_skill (for example file_path: "~/.claude/commands/cc-session-note.md").' }] };
      }
      return { content: [{ type: 'text', text: [`${skills.length} skill(s):`, ...skills.map(formatSkillLine)].join('\n') }] };
    }
  );

  // ─── upsert_skill ────────────────────────────────────────────
  server.tool(
    'upsert_skill',
    'Create or replace a skill in your Noesis skill library. Give either file_path (a Claude Code command file: its frontmatter description and argument-hint are read, and the name defaults to the file name) or body. Explicit name, description and argument_hint override the file. A replace overwrites every field: a field you leave empty is cleared.',
    {
      file_path: z.string().optional().describe('Local .md file to read, e.g. "~/.claude/commands/cc-session-note.md"'),
      body: z.string().optional().describe('The skill instructions (Markdown), when no file_path is given'),
      name: z.string().optional().describe('Skill name typed after "/" (a-z, 0-9, ".", "_", "-"). Required without file_path'),
      description: z.string().optional().describe('One-line description shown in the "/" menu'),
      argument_hint: z.string().optional().describe('Hint for the text after the name, e.g. "[focus]"'),
    },
    async (args) => {
      let fields: SkillFileFields = { name: '', description: '', argument_hint: '', body_md: '' };
      if (args.file_path && args.body !== undefined) {
        throw new Error('Give file_path or body, not both.');
      }
      if (args.file_path) {
        const full = path.resolve(expandHome(args.file_path));
        const text = fs.readFileSync(full, 'utf8');
        fields = parseSkillFile(full, text);
      } else if (args.body !== undefined) {
        fields.body_md = args.body;
      } else {
        throw new Error('Give file_path or body.');
      }
      const name = toSkillName(args.name ?? fields.name);
      if (!name) throw new Error('A name is required (pass name, or a file_path whose file name gives one).');
      const { skill, created } = await client.upsertUserSkill(name, {
        description: args.description ?? fields.description,
        argument_hint: args.argument_hint ?? fields.argument_hint,
        body_md: fields.body_md,
      });
      return {
        content: [{
          type: 'text',
          text: `${created ? 'Created' : 'Replaced'} skill /${skill.name} (id ${skill.id}, ${skill.body_md?.length ?? fields.body_md.length} characters). Type /${skill.name} in a Noesis chat to run it.`,
        }],
      };
    }
  );

  // ─── delete_skill ────────────────────────────────────────────
  server.tool(
    'delete_skill',
    'Delete a skill from your Noesis skill library by name (cannot be undone). SAFETY: the first call returns a preview and requires confirm=true on a follow-up call to actually delete.',
    {
      name: z.string().describe('Skill name, with or without the leading "/"'),
      confirm: z.boolean().optional().describe('Must be true to actually delete. Omit or set false to get a preview.'),
    },
    async (args) => {
      const name = toSkillName(args.name.replace(/^\//, ''));
      if (!args.confirm) {
        const skill = (await client.listUserSkills()).find((s) => s.name === name);
        if (!skill) return { content: [{ type: 'text', text: `No skill named /${name}.` }] };
        return {
          content: [{
            type: 'text',
            text: `DELETE PREVIEW — not yet deleted.\n\n${formatSkillLine(skill)}\n\nTo proceed, call delete_skill again with { name: "${name}", confirm: true }.`,
          }],
        };
      }
      await client.deleteUserSkill(name);
      return { content: [{ type: 'text', text: `Deleted skill /${name}.` }] };
    }
  );
}
