/**
 * Tool registry for md-manager MCP server
 */

import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { NoesisClient, type LocalFile, type EditedOnlineNote, type OsKey, CLIENT_OS, getActivePathFromMap, expandHome } from '../api/NoesisClient.js';
import type { SyncResult, SyncStatus, BidirectionalSyncResult } from '../types/index.js';
import { initEmbeddingService, generateEmbedding, generateEmbeddingsBatch } from '../services/embedding.js';
import { SyncStateManager, determineSyncDirection } from './SyncStateManager.js';
import { registerNaviTools } from './navis.js';
import { suggestOtherOsPath } from '../utils/suggestPath.js';
import { diff3Merge, diffPatch } from 'node-diff3';

// ============================================
// Path normalization
// ============================================

/**
 * Normalize a file path for consistent comparison and storage.
 * - Replaces backslashes with forward slashes
 * - On Windows, lowercases the drive letter (D: → d:) to prevent case-sensitive duplicates
 */
function normalizePath(p: string): string {
  let normalized = p.replace(/\\/g, '/');
  // Windows drive letters are case-insensitive; normalize to lowercase
  if (normalized.length >= 2 && normalized[1] === ':') {
    normalized = normalized[0].toLowerCase() + normalized.slice(1);
  }
  return normalized;
}

// ============================================
// Utility functions for root/project detection
// ============================================

/**
 * Find the nearest .git directory by walking up from startPath
 */
function findGitRoot(startPath: string): string | null {
  let currentPath = path.resolve(startPath);

  while (currentPath !== path.dirname(currentPath)) {
    const gitPath = path.join(currentPath, '.git');
    if (fs.existsSync(gitPath)) {
      return currentPath;
    }
    currentPath = path.dirname(currentPath);
  }
  return null;
}

/**
 * Detect root folder and project name from current working directory.
 *
 * When knownRoots are provided (matching CWD to a registered root):
 *   - Uses path prefix matching first (most reliable for registered roots)
 *   - Falls back to git-based detection only if prefix matching fails
 *
 * When knownRoots are NOT provided (auto-creating a new root):
 *   - Uses git-based detection to find the nearest repo root
 */
function detectRootFromCwd(
  knownRoots?: Array<{ id: number; name: string; path: string; lastScannedAt: string | null }>
): { rootPath: string; projectName: string } | null {
  const cwd = process.cwd();

  // When matching against known roots, prefer prefix matching over git detection.
  // Git detection can return a sub-repo path that doesn't match the registered parent root.
  if (knownRoots && knownRoots.length > 0) {
    let bestMatch: typeof knownRoots[0] | null = null;
    let bestMatchLength = 0;

    for (const root of knownRoots) {
      // Tilde-expand cloud-flow paths (~/Noesis/...) so they can be
      // compared against an absolute cwd. Roots without a path on this OS
      // expand to '' and are skipped.
      const rawPath = expandHome(root.path);
      if (!rawPath) continue;

      const rootPath = path.resolve(rawPath);
      const normalizedCwd = path.resolve(cwd);

      if (normalizedCwd.toLowerCase().startsWith(rootPath.toLowerCase())) {
        if (rootPath.length > bestMatchLength) {
          bestMatch = root;
          bestMatchLength = rootPath.length;
        }
      }
    }

    if (bestMatch) {
      const rootPath = path.resolve(bestMatch.path);
      const relativeToCwd = path.relative(rootPath, cwd);
      const parts = relativeToCwd.split(path.sep).filter(Boolean);
      const projectName = parts[0] || path.basename(cwd);

      return { rootPath: bestMatch.path, projectName };
    }
  }

  // Fallback: Git-based detection (primarily for auto-creating new roots)
  const gitRoot = findGitRoot(cwd);
  if (gitRoot) {
    return {
      rootPath: path.dirname(gitRoot),  // Parent of git repo
      projectName: path.basename(gitRoot)
    };
  }

  return null;
}

/**
 * Detect project name for a file by finding its nearest .git folder
 */
function detectProjectForFile(filePath: string, rootPath: string): string {
  const fileDir = path.dirname(filePath);
  const gitRoot = findGitRoot(fileDir);

  if (gitRoot) {
    // Normalize both paths for comparison (handles Windows/Unix path separator differences)
    const normalizedGitRoot = path.resolve(gitRoot);
    const normalizedRootPath = path.resolve(rootPath);

    if (normalizedGitRoot.startsWith(normalizedRootPath)) {
      return path.basename(gitRoot);
    }
  }

  // Fallback: use first directory component of relative path
  const relativePath = path.relative(rootPath, filePath);
  const parts = relativePath.split(path.sep);
  return parts[0] || 'Uncategorized';
}

/**
 * Resolve a user-supplied file path to a registered root + relative path,
 * mirroring the sync resolver (see sync_notes): expand `~` / `%USERPROFILE%`
 * against this machine's home, resolve to absolute, then prefix-match the input
 * against each root's active path, preferring the longest (most specific) match.
 * Returns null if the path isn't inside any known root.
 *
 * This is what lets get_note resolve an absolute clipboard path
 * (e.g. C:\Users\me\Noesis\foo.md) against a tilde-stored cloud root (~/Noesis):
 * the backend /notes/by-path route does a literal prefix compare and never
 * expands `~`, so absolute paths can't match cloud roots there — resolving
 * client-side and calling /notes/by-relative instead sidesteps that.
 */
export function resolvePathToRoot(
  filePath: string,
  roots: Array<{ id: number; path?: string }>
): { rootId: number; relativePath: string } | null {
  const normalizedInput = normalizePath(path.resolve(expandHome(filePath)));
  let best: { id: number; rootPath: string } | null = null;
  for (const r of roots) {
    const rawPath = expandHome(r.path || '');
    if (!rawPath) continue;
    const rootPath = normalizePath(path.resolve(rawPath));
    if (normalizedInput === rootPath || normalizedInput.startsWith(rootPath + '/')) {
      if (!best || rootPath.length > best.rootPath.length) {
        best = { id: r.id, rootPath };
      }
    }
  }
  if (!best) return null;
  return { rootId: best.id, relativePath: normalizePath(path.relative(best.rootPath, normalizedInput)) };
}

/**
 * Get a unique file path by appending -1, -2, etc. if file already exists
 */
function getUniqueFilePath(filePath: string): string {
  if (!fs.existsSync(filePath)) return filePath;

  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);

  let counter = 1;
  let newPath = filePath;
  while (fs.existsSync(newPath)) {
    newPath = path.join(dir, `${base}-${counter}${ext}`);
    counter++;
  }
  return newPath;
}

export interface ToolServices {
  client: NoesisClient;
  geminiApiKey?: string;
}

/**
 * Register all MCP tools with the server
 */
export function registerTools(server: McpServer, services: ToolServices): void {
  const { client, geminiApiKey } = services;

  // Initialize embedding service if API key is provided
  let embeddingsEnabled = false;
  if (geminiApiKey) {
    try {
      initEmbeddingService(geminiApiKey);
      embeddingsEnabled = true;
    } catch (error) {
      console.error('Failed to initialize embedding service:', error);
    }
  }

  // Register Navi management tools
  registerNaviTools(server, client);

  // Register search_notes tool
  server.tool(
    'search_notes',
    'Search your knowledge base using full-text search. Returns relevant notes ranked by BM25 relevance.',
    {
      query: z.string().describe('Search query (natural language or keywords)'),
      limit: z.number().optional().describe('Maximum number of results (default: 10, max: 50)'),
      root: z.string().optional().describe('Optional: filter to specific root folder'),
      catalog: z.string().optional().describe('Optional: filter to notes in a specific catalog (e.g., "Work", "Claude")')
    },
    async (args) => {
      const { query, limit = 10, root, catalog } = args;

      // Clamp limit to max 50
      const effectiveLimit = Math.min(limit, 50);

      const results = await client.searchNotes(query, {
        limit: effectiveLimit,
        root,
        catalog
      });

      if (results.length === 0) {
        return {
          content: [{
            type: 'text',
            text: `No notes found matching "${query}".\n\nTry:\n- Using different keywords\n- Checking for typos\n- Using broader search terms`
          }]
        };
      }

      const formatted = results.map((note, index) => {
        const relevance = note.relevance ?? 0;
        const relevanceLabel = relevance >= 80 ? '🎯' :
                              relevance >= 60 ? '✓' :
                              relevance >= 40 ? '○' : '·';

        return `${index + 1}. ${relevanceLabel} **${note.title}** [ID: ${note.id}] (${relevance}% match)
   Path: ${note.file_path}
   ${note.excerpt}
   ${note.modified_at ? `Modified: ${new Date(note.modified_at).toLocaleDateString()}` : ''}`;
      }).join('\n\n');

      return {
        content: [{
          type: 'text',
          text: `Found ${results.length} note${results.length === 1 ? '' : 's'} for "${query}":\n\n${formatted}`
        }]
      };
    }
  );

  // Register search_by_related_code tool
  server.tool(
    'search_by_related_code',
    'Find notes that reference a codebase. The query matches a path fragment or codebase label (case-insensitive) against the managed codebase registry, then returns every note linked to a matching codebase.',
    {
      path: z.string().describe('Codebase path or label fragment (e.g., "bt-ui-apps", "Cloud Connector Service")'),
      limit: z.number().optional().describe('Maximum results (default: 20, max: 50)')
    },
    async (args) => {
      const { path, limit = 20 } = args;
      const results = await client.searchByRelatedCode(path, Math.min(limit, 50));

      if (results.length === 0) {
        return {
          content: [{
            type: 'text',
            text: `No notes found referencing a codebase matching "${path}".`
          }]
        };
      }

      const formatted = results.map((note: any, i: number) => {
        const desc = note.description ? `\n   ${note.description.substring(0, 150)}${note.description.length > 150 ? '...' : ''}` : '';
        const matched = note.matched_label
          ? `${note.matched_label} · ${note.matched_path}`
          : note.matched_path;
        return `${i + 1}. **${note.title}** [ID: ${note.id}]
   Path: ${note.file_path}
   Matched codebase: ${matched}${desc}`;
      }).join('\n\n');

      return {
        content: [{
          type: 'text',
          text: `Found ${results.length} note(s) referencing a codebase matching "${path}":\n\n${formatted}`
        }]
      };
    }
  );

  // Register get_note tool
  server.tool(
    'get_note',
    'PRIMARY READ TOOL FOR NOESIS NOTES — USE THIS INSTEAD OF the `Read` filesystem tool for ANY path inside a registered Noesis root. A path is Noesis-tracked if it contains `/.noesis/`, OR sits under a folder named `Noesis` (the cloud root — e.g. `~/Noesis/…`, `%USERPROFILE%\\Noesis\\…`, or `C:\\Users\\<you>\\Noesis\\…`), OR is under any directory returned by `list_roots`. The path is a Noesis identifier, not just a filesystem coordinate; the file may not exist on this machine\'s disk but the content always exists in the Noesis cloud and works across machines — and an ABSOLUTE path resolves here even when the cloud stored the root in tilde form. This tool is READ-ONLY (no disk write) and is SAFE TO CALL IN PLAN MODE. RECOVERY RULE: if `Read` returned "File does not exist" for a `.md` path that looks like a note — especially one under a `.noesis`/`Noesis` folder — YOUR IMMEDIATE NEXT ACTION IS THIS TOOL with the same path. DO NOT use Glob or Grep to hunt for similar filenames, DO NOT ask the user to disambiguate the path, DO NOT suggest the user typed it wrong, and DO NOT conclude the note is missing or on another machine until THIS lookup also fails. Trigger phrases: "read this note", "summarize this file", "what does X say", "open this", "check this bug report", "review this doc" — when the referenced path is Noesis-tracked, use THIS tool. For a writable local copy (e.g., `Edit`/`Write` operations, git diffs, or any task that needs the file on local disk), use `sync_notes(files: [path])` instead, which materializes the file onto disk at the canonical path. Accepts either a Note ID (`id`) or a file path (`path`).',
    {
      id: z.number().optional().describe('Note ID'),
      path: z.string().optional().describe('File path of the note')
    },
    async (args) => {
      const { id, path } = args;

      if (!id && !path) {
        return {
          content: [{
            type: 'text',
            text: 'Error: Please provide either an id or a path to get the note.'
          }],
          isError: true
        };
      }

      let note;
      if (id) {
        note = await client.getNote(id);
      } else {
        // Resolve the path against registered roots locally first. This handles
        // absolute clipboard paths (C:\Users\me\Noesis\...) against tilde-stored
        // cloud roots (~/Noesis), which the server-side by-path route can't match
        // because it never expands `~`. Fall back to by-path for any path that
        // isn't inside a known root.
        const roots = await client.getRoots();
        const resolved = resolvePathToRoot(path!, roots);
        note = resolved
          ? await client.getNoteByRelativePath(resolved.rootId, resolved.relativePath)
          : undefined;
        if (!note) {
          note = await client.getNoteByPath(path!);
        }
      }

      if (!note) {
        return {
          content: [{
            type: 'text',
            text: `Note not found: ${id ? `id=${id}` : `path=${path}`}`
          }],
          isError: true
        };
      }

      // Build rich metadata output
      let metadata = `# ${note.title}\n\n**ID:** ${(note as any).id}\n**Path:** ${note.file_path}\n**Modified:** ${note.modified_at || 'Unknown'}`;

      // Online-edit warning: prepended at the very top of the response so Claude sees it before any local Edit/Write.
      const editedOnlineAt = (note as any).edited_online_at;
      const conflictMarker = (note as any).conflict_marker;
      let warningPrefix = '';
      if (editedOnlineAt) {
        warningPrefix += `⚠ This note was edited online (${editedOnlineAt}) — pull the cloud version (\`mcp__noesis__pull_notes\`) before any local Edit/Write.\n\n`;
        metadata += `\n**Edited Online At:** ${editedOnlineAt}`;
      }
      if (conflictMarker) {
        warningPrefix += `⚠ This note has an unresolved sync conflict — run \`/noesis-sync\` or hand-edit the local file and re-run \`mcp__noesis__sync_notes\`.\n\n`;
        metadata += `\n**Conflict Marker:** present`;
      }

      if ((note as any).description) {
        metadata += `\n**Description:** ${(note as any).description}`;
      }
      if ((note as any).keywords && Array.isArray((note as any).keywords) && (note as any).keywords.length > 0) {
        metadata += `\n**Keywords:** ${(note as any).keywords.join(', ')}`;
      }
      if ((note as any).aliases && Array.isArray((note as any).aliases) && (note as any).aliases.length > 0) {
        metadata += `\n**Aliases:** ${(note as any).aliases.join(', ')}`;
      }
      if ((note as any).catalogs && Array.isArray((note as any).catalogs) && (note as any).catalogs.length > 0) {
        metadata += `\n**Catalogs:** ${(note as any).catalogs.join(', ')}`;
      }
      if ((note as any).importance_score != null) {
        metadata += `\n**Importance:** ${(note as any).importance_score}/100`;
      }
      if ((note as any).quality_score != null) {
        metadata += `\n**Quality:** ${(note as any).quality_score}/100`;
      }

      // Relations (from JSONB column)
      const relations = (note as any).relations;
      if (relations && Array.isArray(relations) && relations.length > 0) {
        metadata += `\n\n**Relations:**`;
        for (const rel of relations) {
          metadata += `\n- ${rel.type} → note ${rel.target_id}`;
          if (rel.context) metadata += ` (${rel.context})`;
        }
      }

      // Related codebases (resolved from the managed registry)
      const relatedCodebases = (note as any).related_codebases;
      if (relatedCodebases && Array.isArray(relatedCodebases) && relatedCodebases.length > 0) {
        metadata += `\n\n**Related Codebase:**`;
        for (const c of relatedCodebases) {
          const label = c?.label ? `${c.label} · ` : '';
          metadata += `\n- ${label}${c?.path ?? ''}`;
        }
      }

      metadata += `\n\n---\n\n${note.content}`;

      return {
        content: [{
          type: 'text',
          text: warningPrefix + metadata
        }]
      };
    }
  );

  // Register get_note_skim_read tool
  server.tool(
    'get_note_skim_read',
    "Read a note's SKIM-READ KEY PARTS — the spans the app's Skim-Read feature surfaces as the gist a reader should focus on. READ-ONLY: it computes the key parts on demand and writes NO marks to the note. Accepts a Note ID (`id`) or a file path (`path`). Use this to inspect what Skim-Read extracts for a note, or when iterating on the Skim-Read feature itself (set `fresh:true` to bypass the 30-min server cache after changing extraction logic). Cost: ~1 LLM call per (content+style+intensity), cached 30 min unless `fresh`. Knobs: `style` (gist|balanced|thorough|structure|keyword|question|inverse), `intensity` (light|normal|heavy), `granularities` (section|paragraph|sentence|keyword), `focusQuestion` (with style='question'), `language`. Returns key parts grouped by granularity with each part's importance (0..1) and a short reason. A note with no skimmable gist (a list/tracker/changelog) may correctly return zero parts. NOTE: this tool calls the in-app AI; if it fails with a quota/503/'AI not configured' error, use `apply_note_skim_read` instead — YOU generate the key parts and the server just persists them (no in-app AI needed).",
    {
      id: z.number().optional().describe('Note ID'),
      path: z.string().optional().describe('File path of the note'),
      style: z.enum(['gist', 'balanced', 'thorough', 'structure', 'keyword', 'question', 'inverse']).optional()
        .describe("Reading strategy (default: balanced)"),
      intensity: z.enum(['light', 'normal', 'heavy']).optional().describe('How many parts to surface (default: normal)'),
      granularities: z.array(z.enum(['section', 'paragraph', 'sentence', 'keyword'])).optional()
        .describe('Which granularities to allow (default: all)'),
      focusQuestion: z.string().optional().describe("Only with style='question': surface only spans relevant to this question"),
      language: z.string().optional().describe("Note language hint (e.g. 'en', 'zh')"),
      fresh: z.boolean().optional().describe('Bypass the 30-min server cache and recompute (use when iterating on extraction logic)')
    },
    async (args) => {
      const { id, path, style, intensity, granularities, focusQuestion, language, fresh } = args;

      if (!id && !path) {
        return {
          content: [{ type: 'text', text: 'Error: Please provide either an id or a path.' }],
          isError: true
        };
      }

      // Resolve a path to a note id locally first (mirrors get_note) so tilde-stored
      // roots resolve; then skim-read by id. Fall back to sending the path through.
      let noteId = id;
      if (!noteId && path) {
        const roots = await client.getRoots();
        const resolved = resolvePathToRoot(path, roots);
        const note = resolved
          ? await client.getNoteByRelativePath(resolved.rootId, resolved.relativePath)
          : await client.getNoteByPath(path);
        if (note) noteId = (note as any).id;
      }

      let result;
      try {
        result = await client.getNoteSkimRead(
          noteId
            ? { id: noteId, style, intensity, granularities, focusQuestion, language, fresh }
            : { path, style, intensity, granularities, focusQuestion, language, fresh }
        );
      } catch (e) {
        return {
          content: [{ type: 'text', text: `Skim-Read failed: ${(e as Error).message}` }],
          isError: true
        };
      }

      const meta = `**Note ID:** ${result.noteId} · **kind:** ${result.noteKind} · **parts:** ${result.keyPartCount} · **model:** ${result.model ?? 'n/a'}${result.cached ? ' · cached' : ' · fresh'}`;

      if (!result.keyParts || result.keyParts.length === 0) {
        return {
          content: [{
            type: 'text',
            text: `# Skim-Read — ${result.title}\n\n${meta}\n\nNo key parts surfaced — this note has no skimmable gist (kind: ${result.noteKind}). For a list / tracker / changelog this is the expected result.`
          }]
        };
      }

      const ORDER = ['section', 'paragraph', 'sentence', 'keyword'];
      const byGran = new Map<string, typeof result.keyParts>();
      for (const kp of result.keyParts) {
        if (!byGran.has(kp.granularity)) byGran.set(kp.granularity, []);
        byGran.get(kp.granularity)!.push(kp);
      }

      let body = '';
      for (const g of ORDER) {
        const items = byGran.get(g);
        if (!items || items.length === 0) continue;
        items.sort((a, b) => b.importance - a.importance);
        body += `\n## ${g.charAt(0).toUpperCase() + g.slice(1)} (${items.length})\n`;
        for (const kp of items) {
          const reason = kp.reason ? ` — ${kp.reason}` : '';
          body += `- [${kp.importance.toFixed(2)}] ${JSON.stringify(kp.quote)}${reason}\n`;
        }
      }

      return {
        content: [{
          type: 'text',
          text: `# Skim-Read — ${result.title}\n\n${meta}\n${body}`
        }]
      };
    }
  );

  server.tool(
    'apply_note_skim_read',
    [
      "Persist Skim-Read KEY PARTS that YOU generate for a note — the Gemini-free fallback for the app's Skim-Read feature when the in-app AI is rate-limited/503/unconfigured. WRITES marks: the server anchors each verbatim quote against the note's authoritative content and persists the matches as `suggested` ai_skim marks (the same marks the Skim-Read panel renders). The server does NO LLM call — it only anchors + persists what you provide.",
      "",
      "WORKFLOW: (1) read the note's content (get_note); (2) pick the key parts a reader should focus on to get the gist; (3) call this tool with `id` (or `path`) and `keyParts`; (4) if the result lists `unmatchedQuotes`, FIX those quotes (they weren't found verbatim) and call again.",
      "",
      "Each keyPart: { granularity, quote, headingPath?, importance?, reason? }.",
      "- quote: MUST be copied CHARACTER-FOR-CHARACTER (verbatim) from the note — do NOT paraphrase, fix typos, translate, summarize, or add ellipses. Make it long enough to occur exactly once; if a short phrase repeats, include enough surrounding words to be unique. For a 'section' quote the heading line text; 'sentence' the full sentence; 'paragraph' its first ~12 words; 'keyword' the exact token(s).",
      "- granularity: section | paragraph | sentence | keyword.",
      "- importance: 0..1; reserve > 0.8 for the few genuinely load-bearing parts.",
      "- reason: <= 12 words, plainly what the span says (no hype words).",
      "- Only quote VISIBLE prose. Never quote inside code fences (```), YAML frontmatter, HTML tags, or a COLLAPSED `<details>` block (one without the `open` attribute).",
      "- headingPath: ancestor heading texts (top-most first) to disambiguate a repeated quote; [] if unknown.",
      "Knobs (optional): `style`, `intensity` (light|normal|heavy — bounds how many parts persist), `granularities`, `language`, `model` (provenance label). Re-applying replaces prior un-accepted suggestions; accepted/dismissed marks are preserved.",
    ].join('\n'),
    {
      id: z.number().optional().describe('Note ID'),
      path: z.string().optional().describe('File path of the note'),
      keyParts: z.array(z.object({
        granularity: z.enum(['section', 'paragraph', 'sentence', 'keyword']),
        quote: z.string().describe('Verbatim slice of the note content (character-for-character)'),
        headingPath: z.array(z.string()).optional().describe('Ancestor heading texts, top-most first; [] if unknown'),
        importance: z.number().min(0).max(1).optional().describe('0..1; > 0.8 only for load-bearing parts'),
        reason: z.string().optional().describe('<= 12 words: plainly what the span says'),
      })).min(1).describe('The key parts you generated (verbatim quotes from the note)'),
      style: z.enum(['gist', 'balanced', 'thorough', 'structure', 'keyword', 'question', 'inverse']).optional()
        .describe('Reading strategy hint (default: balanced)'),
      intensity: z.enum(['light', 'normal', 'heavy']).optional().describe('Bounds how many parts persist (default: normal)'),
      granularities: z.array(z.enum(['section', 'paragraph', 'sentence', 'keyword'])).optional()
        .describe('Which granularities to allow (default: all)'),
      language: z.string().optional().describe("Note language hint (e.g. 'en', 'zh')"),
      model: z.string().optional().describe("Provenance label stored on the run (default: 'claude-code')"),
    },
    async (args) => {
      const { id, path, keyParts, style, intensity, granularities, language, model } = args;

      if (!id && !path) {
        return {
          content: [{ type: 'text', text: 'Error: Please provide either an id or a path.' }],
          isError: true
        };
      }

      // Resolve a path to a note id locally first (mirrors get_note_skim_read).
      let noteId = id;
      if (!noteId && path) {
        const roots = await client.getRoots();
        const resolved = resolvePathToRoot(path, roots);
        const note = resolved
          ? await client.getNoteByRelativePath(resolved.rootId, resolved.relativePath)
          : await client.getNoteByPath(path);
        if (note) noteId = (note as any).id;
      }

      let result;
      try {
        result = await client.applyNoteSkimRead(
          noteId
            ? { id: noteId, keyParts, style, intensity, granularities, language, model }
            : { path, keyParts, style, intensity, granularities, language, model }
        );
      } catch (e) {
        return {
          content: [{ type: 'text', text: `Apply Skim-Read failed: ${(e as Error).message}` }],
          isError: true
        };
      }

      const lines: string[] = [
        `**Note ID:** ${result.noteId} · **applied:** ${result.keyPartCount}/${result.providedCount} provided · **anchored:** ${result.anchoredCount} · **model:** ${result.model ?? 'n/a'}`,
      ];
      if (result.unmatchedQuotes && result.unmatchedQuotes.length > 0) {
        lines.push('');
        lines.push(`**${result.unmatchedQuotes.length} quote(s) did NOT anchor (not found verbatim in the note). Fix the exact text and re-apply:**`);
        for (const q of result.unmatchedQuotes) lines.push(`- ${JSON.stringify(q)}`);
      } else if (result.keyPartCount > 0) {
        lines.push('');
        lines.push('All provided quotes anchored. Open the note in Noesis — the Skim-Read panel now shows these key parts.');
      }
      if (result.declined) {
        lines.push('');
        lines.push('(Nothing anchored — no suggestions were persisted.)');
      }

      return {
        content: [{
          type: 'text',
          text: `# Skim-Read applied — ${result.title}\n\n${lines.join('\n')}`
        }]
      };
    }
  );

  server.tool(
    'get_bookmark_context',
    'Read the note content surrounding a specific bookmark/tag. ' +
    'Accepts either a Noesis bookmark URL of the form ' +
    '`https://noesisbrain.com/notes/{id}#bm={uuid}` ' +
    '(parse it to extract note_id and bookmark_id) ' +
    'OR explicit note_id + bookmark_id params. ' +
    'Use this whenever the user shares a `#bm=` URL and asks what is written around it, ' +
    'or asks Claude to "read the content around this tag/bookmark". ' +
    'Do NOT use WebFetch on these URLs — the `#bm=` fragment is client-side only.',
    {
      url: z.string().optional().describe(
        'Full Noesis bookmark URL, e.g. https://noesisbrain.com/notes/2312#bm=384e924d-...'
      ),
      note_id: z.number().optional().describe('Note ID (alternative to url)'),
      bookmark_id: z.string().optional().describe('Bookmark UUID (alternative to url)'),
      context_paragraphs: z.number().optional().describe(
        'Number of paragraphs to show before and after the bookmarked passage (default 2, max 5)'
      ),
    },
    async (args) => {
      let noteId: number | undefined = args.note_id;
      let bookmarkId: string | undefined = args.bookmark_id;

      if (args.url) {
        const m = args.url.match(/\/notes\/(\d+)[^#]*#.*bm=([A-Za-z0-9_-]+)/);
        if (m) { noteId = parseInt(m[1], 10); bookmarkId = m[2]; }
      }

      if (!noteId || !bookmarkId) {
        return {
          content: [{ type: 'text', text: 'Error: provide either url or both note_id + bookmark_id.' }],
          isError: true
        };
      }

      const result = await client.getBookmarkContext(noteId, bookmarkId, args.context_paragraphs ?? 2);
      if (!result) {
        return {
          content: [{ type: 'text', text: `Bookmark not found (note=${noteId}, bookmark=${bookmarkId})` }],
          isError: true
        };
      }

      const { bookmark, note_title, context_before, context_anchor, context_after } = result;
      const lines: string[] = [
        `## Bookmark in "${note_title}" (Note ${noteId})`,
        `**Label:** ${bookmark.label}  **Type:** ${bookmark.type}  **Color:** ${bookmark.color}`,
        '',
      ];
      if (context_before) { lines.push('**Context before:**', context_before, ''); }
      lines.push(`**[BOOKMARK: ${bookmark.label}]**`, context_anchor, '');
      if (context_after) { lines.push('**Context after:**', context_after); }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  // Register get_chat_session tool
  server.tool(
    'get_chat_session',
    'Get a chat session (conversation) and its messages by ID. URL pattern: noesisbrain.com/<id>. Includes main-thread messages and Navi Discussion turns (each turn is labeled with the speaker Navi). Scoped to the authenticated user.',
    {
      id: z.number().describe('Chat session ID'),
      limit: z.number().optional().describe('Max messages to return (default 200, max 500). Returns the latest N messages in chronological order.')
    },
    async (args) => {
      const { id, limit } = args;
      const result = await client.getChatSession(id, limit != null ? { limit } : {});

      if (!result) {
        return {
          content: [{ type: 'text', text: `Chat session not found: id=${id}` }],
          isError: true
        };
      }

      const { session, navi, messages, hasMore } = result;
      const title = session.title || 'Untitled';
      const naviLine = navi
        ? `**Navi:** ${navi.name}${navi.description ? ` — ${navi.description}` : ''}`
        : '**Navi:** _(none)_';

      let out = `# Chat session ${session.id} — "${title}"\n${naviLine}\n`;
      out += `**Created:** ${session.created_at} · **Updated:** ${session.updated_at}\n`;
      out += `**Messages:** ${messages.length}${hasMore ? ' (older messages omitted)' : ''}\n\n---\n`;

      if (messages.length === 0) {
        out += '\n_No messages in this session yet._\n';
      } else {
        for (const m of messages) {
          // Navi Discussion turns carry their own navi_id/navi_name (each
          // participant speaks under their own persona). Fall back to the
          // session-level Navi for regular assistant turns.
          const perTurnName = (m as any).navi_name as string | undefined;
          const speakerNavi = perTurnName || navi?.name || 'assistant';
          const speaker = m.role === 'user' ? 'user' : speakerNavi;
          const tag = (m as any).message_type === 'discussion' ? ' _(discussion)_' : '';
          out += `\n**${speaker}**${tag} · ${m.created_at}\n${m.content}\n`;
        }
      }

      if (hasMore) {
        const next = Math.min((limit ?? 200) * 2, 500);
        out += `\n_Older messages were omitted. Pass \`limit: ${next}\` to fetch more._\n`;
      }

      return { content: [{ type: 'text', text: out }] };
    }
  );

  // Register list_catalogs tool
  server.tool(
    'list_catalogs',
    'List all note catalogs (categories) in the knowledge base with note counts.',
    {},
    async () => {
      const catalogs = await client.listCatalogs();

      if (catalogs.length === 0) {
        return {
          content: [{
            type: 'text',
            text: 'No catalogs found.'
          }]
        };
      }

      const formatted = catalogs.map((cat, index) => {
        const builtin = cat.is_builtin ? ' (built-in)' : '';
        let line = `${index + 1}. **${cat.name}**${builtin} — ${cat.note_count} note${cat.note_count === 1 ? '' : 's'} [color: ${cat.color}]`;
        if (cat.description) {
          line += `\n   ${cat.description}`;
        }
        return line;
      }).join('\n');

      return {
        content: [{
          type: 'text',
          text: `Catalogs (${catalogs.length}):\n\n${formatted}`
        }]
      };
    }
  );

  // Register list_notes tool
  server.tool(
    'list_notes',
    'List notes in the knowledge base with optional filtering.',
    {
      limit: z.number().optional().describe('Maximum number of notes to return (default: 20)'),
      root: z.string().optional().describe('Filter to specific root folder'),
      catalog: z.string().optional().describe('Filter to notes in a specific catalog (e.g., "Work", "Claude")'),
      recent: z.number().optional().describe('Only show notes modified in the last N days')
    },
    async (args) => {
      const { limit = 20, root, catalog, recent } = args;

      let notes;
      if (recent) {
        notes = await client.getRecentNotes(recent, limit);
      } else {
        notes = await client.listNotes({ limit, root, catalog });
      }

      if (notes.length === 0) {
        return {
          content: [{
            type: 'text',
            text: 'No notes found matching the criteria.'
          }]
        };
      }

      const formatted = notes.map((note, index) => {
        const fav = note.is_favorite ? '⭐ ' : '';
        const pts = note.points ? ` [${note.points} pts]` : '';
        return `${index + 1}. ${fav}**${note.title || 'Untitled'}**${pts}\n   ${note.file_path}`;
      }).join('\n\n');

      const title = recent
        ? `Notes modified in the last ${recent} days (${notes.length}):`
        : `Notes (${notes.length}):`;

      return {
        content: [{
          type: 'text',
          text: `${title}\n\n${formatted}`
        }]
      };
    }
  );

  // Register list_roots tool
  server.tool(
    'list_roots',
    'List all watched root directories in the knowledge base.',
    {},
    async () => {
      const roots = await client.getRoots();

      if (roots.length === 0) {
        return {
          content: [{
            type: 'text',
            text: 'No root directories configured.'
          }]
        };
      }

      // Phase32: each root now has a per-OS path map. Show all configured
      // entries with an [active] marker on the CLIENT_OS row.
      const lines: string[] = [];
      let anyMissing = false;
      roots.forEach((root, index) => {
        lines.push(`${index + 1}. **${root.name}**`);
        for (const key of ['win32', 'darwin', 'linux'] as const) {
          const v = root.local_paths?.[key];
          const label = key === 'win32' ? 'Windows' : key === 'darwin' ? 'macOS  ' : 'Linux  ';
          const marker = key === CLIENT_OS ? '  [active]' : '';
          if (v) {
            lines.push(`   ${label}: ${v}${marker}`);
          } else if (key === CLIENT_OS) {
            lines.push(`   ${label}: (not configured for this OS)${marker}`);
            anyMissing = true;
          }
        }
        lines.push('');
      });

      let text = `Watched directories (${roots.length}):\n\n${lines.join('\n').trimEnd()}`;
      if (anyMissing) {
        text += `\n\nTip: roots missing a path for the current OS (${CLIENT_OS}) cannot be used for get_note/sync_notes on this machine. Add the missing path in Noesis Dashboard.`;
      }

      return {
        content: [{ type: 'text', text }]
      };
    }
  );

  // Register add_root tool
  server.tool(
    'add_root',
    'Add a new watched root directory to the knowledge base. Provide an OS-specific path via path_win, path_mac, or path_linux; at least one is required. If only one is supplied AND it is under the user\'s home directory, the other OS slot is auto-suggested. Legacy `path` parameter is accepted and auto-routed to the matching OS slot.',
    {
      name: z.string().describe('Display name for this root (e.g., "My Notes", "Work Projects")'),
      path_win: z.string().optional().describe('Windows absolute path (e.g., "C:/Users/me/notes")'),
      path_mac: z.string().optional().describe('macOS absolute path (e.g., "~/notes" or "/Users/me/notes")'),
      path_linux: z.string().optional().describe('Linux absolute path (e.g., "/home/me/notes")'),
      path: z.string().optional().describe('Legacy single-path form. Auto-routed to the matching OS slot by shape (drive letter → win32; /Users/... → darwin; /... → linux). Prefer path_win/path_mac/path_linux for new code.'),
    },
    async (args) => {
      try {
        // Build initial local_paths map.
        const local_paths: Record<string, string> = {};
        if (args.path_win) local_paths['win32'] = normalizePath(args.path_win);
        if (args.path_mac) local_paths['darwin'] = args.path_mac;
        if (args.path_linux) local_paths['linux'] = args.path_linux;

        // Legacy: route a single `path` arg by shape.
        if (args.path && Object.keys(local_paths).length === 0) {
          const p = args.path;
          const key: OsKey = /^[A-Za-z]:[\\/]/.test(p) ? 'win32'
            : (p.startsWith('/Users/') || p.startsWith('~/')) ? 'darwin'
            : p.startsWith('/') ? 'linux'
            : 'win32';
          local_paths[key] = key === 'win32' ? normalizePath(p) : p;
          process.stderr.write(`[noesis-mcp] add_root: legacy 'path' routed to local_paths.${key}. Prefer path_${key === 'win32' ? 'win' : key === 'darwin' ? 'mac' : 'linux'} for new code.\n`);
        }

        if (Object.keys(local_paths).length === 0) {
          return {
            content: [{ type: 'text', text: 'At least one of path_win, path_mac, path_linux, or legacy path is required.' }],
            isError: true,
          };
        }

        // Suggest the other-OS slot if not supplied AND source is home-relative.
        // Suggestion lands ONLY for win32↔darwin (the two surfaces in v1). Linux
        // users fill in their own path; no auto-suggestion to or from linux.
        if (local_paths.win32 && !local_paths.darwin) {
          const s = suggestOtherOsPath(local_paths.win32, 'win32');
          if (s) {
            local_paths.darwin = s;
            process.stderr.write(`[noesis-mcp] add_root: auto-filled darwin path as ${s} — edit via the Dashboard if wrong.\n`);
          }
        } else if (local_paths.darwin && !local_paths.win32) {
          const s = suggestOtherOsPath(local_paths.darwin, 'darwin');
          if (s) {
            local_paths.win32 = s;
            process.stderr.write(`[noesis-mcp] add_root: auto-filled win32 path as ${s} (contains %USERNAME% template token) — edit via the Dashboard if wrong.\n`);
          }
        }

        const root = await client.createRoot({ name: args.name, local_paths });

        const pathLines: string[] = [];
        for (const key of ['win32', 'darwin', 'linux'] as const) {
          const v = root.local_paths?.[key];
          if (v) {
            const label = key === 'win32' ? 'Windows' : key === 'darwin' ? 'macOS' : 'Linux';
            pathLines.push(`  - ${label}: ${v}${key === CLIENT_OS ? ' [active]' : ''}`);
          }
        }

        return {
          content: [{
            type: 'text',
            text: `Root added successfully:\n\n- **ID:** ${root.id}\n- **Name:** ${root.name}\n- **Paths:**\n${pathLines.join('\n')}`
          }]
        };
      } catch (err: any) {
        const message = err?.message || String(err);
        if (message.includes('already exists') || message.includes('409')) {
          return {
            content: [{
              type: 'text',
              text: `A root with that path already exists for this OS.`
            }],
            isError: true
          };
        }
        throw err;
      }
    }
  );

  // Register pull_notes tool
  server.tool(
    'pull_notes',
    'Pull notes from Noesis cloud database to create local .md files. Use this to sync notes to a new machine.',
    {
      destination: z.string().describe('Local folder path where notes will be created (e.g., "C:/projects/my-notes")'),
      root: z.string().optional().describe('Optional: only pull notes from a specific root (by name)'),
      overwrite: z.boolean().optional().describe('Overwrite existing files (default: false, skip existing)'),
      dryRun: z.boolean().optional().describe('Preview what would be pulled without creating files (default: false)')
    },
    async (args) => {
      const { destination, root, overwrite = false, dryRun = false } = args;

      // Validate destination path
      const destPath = path.resolve(destination);

      // SAFETY: Check if destination is inside any watched root
      // This prevents creating duplicate notes when sync_notes runs later
      const roots = await client.getRoots();
      for (const watchedRoot of roots) {
        // Normalize paths for comparison (handle trailing slashes, case)
        const normalizedDest = path.normalize(destPath).toLowerCase();
        const normalizedRoot = path.normalize(watchedRoot.path || '').toLowerCase();
        if (!normalizedRoot) continue;

        // Add path separator to ensure proper directory boundary matching
        // e.g., "C:\temp_cGit" should not match "C:\temp_cGit2"
        const destWithSep = normalizedDest.endsWith(path.sep) ? normalizedDest : normalizedDest + path.sep;
        const rootWithSep = normalizedRoot.endsWith(path.sep) ? normalizedRoot : normalizedRoot + path.sep;

        // Check if destPath is inside rootPath or vice versa
        if (destWithSep.startsWith(rootWithSep) || rootWithSep.startsWith(destWithSep)) {
          return {
            content: [{
              type: 'text',
              text: `❌ **Error: Cannot pull to this destination**\n\n` +
                `The destination "${destPath}" overlaps with watched root "${watchedRoot.name}" (${watchedRoot.path}).\n\n` +
                `This would cause duplicate notes when sync_notes runs later.\n\n` +
                `**Solution:** Choose a destination outside of all watched roots, such as:\n` +
                `- \`C:/pulled-notes\`\n` +
                `- \`D:/backup/notes\`\n` +
                `- Any folder NOT inside: ${roots.map(r => r.path).join(', ')}`
            }]
          };
        }
      }

      // Get notes from database
      const notes = await client.getNotesForPull({ root });

      if (notes.length === 0) {
        return {
          content: [{
            type: 'text',
            text: root
              ? `No notes found in root "${root}".`
              : 'No notes found in the database.'
          }]
        };
      }

      // Group notes by root for reporting
      const notesByRoot = new Map<string, typeof notes>();
      for (const note of notes) {
        if (!notesByRoot.has(note.root_name)) {
          notesByRoot.set(note.root_name, []);
        }
        notesByRoot.get(note.root_name)!.push(note);
      }

      // If dry run, just report what would happen
      if (dryRun) {
        let report = `**Dry Run - Would pull ${notes.length} notes to ${destPath}:**\n\n`;

        for (const [rootName, rootNotes] of notesByRoot) {
          report += `**${rootName}** (${rootNotes.length} notes):\n`;
          for (const note of rootNotes.slice(0, 10)) {
            const filePath = path.join(destPath, note.relative_path);
            const exists = fs.existsSync(filePath);
            const action = exists ? (overwrite ? '⚠️ OVERWRITE' : '⏭️ SKIP') : '✅ CREATE';
            report += `  ${action}: ${note.relative_path}\n`;
          }
          if (rootNotes.length > 10) {
            report += `  ... and ${rootNotes.length - 10} more\n`;
          }
          report += '\n';
        }

        return {
          content: [{
            type: 'text',
            text: report
          }]
        };
      }

      // Create destination directory if it doesn't exist
      if (!fs.existsSync(destPath)) {
        fs.mkdirSync(destPath, { recursive: true });
      }

      // Pull notes
      const results = {
        created: 0,
        skipped: 0,
        overwritten: 0,
        errors: [] as string[]
      };

      for (const note of notes) {
        try {
          const filePath = path.join(destPath, note.relative_path);
          const fileDir = path.dirname(filePath);

          // Check if file exists
          if (fs.existsSync(filePath)) {
            if (overwrite) {
              // Create directory if needed
              if (!fs.existsSync(fileDir)) {
                fs.mkdirSync(fileDir, { recursive: true });
              }
              fs.writeFileSync(filePath, note.content, 'utf-8');
              results.overwritten++;
            } else {
              results.skipped++;
            }
          } else {
            // Create directory if needed
            if (!fs.existsSync(fileDir)) {
              fs.mkdirSync(fileDir, { recursive: true });
            }
            fs.writeFileSync(filePath, note.content, 'utf-8');
            results.created++;
          }
        } catch (error) {
          results.errors.push(`${note.relative_path}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }

      // Build result message
      let message = `**Pull complete!**\n\n`;
      message += `📁 Destination: ${destPath}\n`;
      message += `✅ Created: ${results.created} files\n`;

      if (results.overwritten > 0) {
        message += `⚠️ Overwritten: ${results.overwritten} files\n`;
      }

      if (results.skipped > 0) {
        message += `⏭️ Skipped: ${results.skipped} existing files\n`;
      }

      if (results.errors.length > 0) {
        message += `\n❌ Errors (${results.errors.length}):\n`;
        for (const error of results.errors.slice(0, 5)) {
          message += `  - ${error}\n`;
        }
        if (results.errors.length > 5) {
          message += `  ... and ${results.errors.length - 5} more errors\n`;
        }
      }

      message += `\n**Notes by root:**\n`;
      for (const [rootName, rootNotes] of notesByRoot) {
        message += `  - ${rootName}: ${rootNotes.length} notes\n`;
      }

      return {
        content: [{
          type: 'text',
          text: message
        }]
      };
    }
  );

  // Register list_edited_online_notes tool
  server.tool(
    'list_edited_online_notes',
    'List notes that were edited via the Noesis web UI (Quick Fix) and have pending local sync. For each note, reports whether the local file is unchanged (safe to pull), also_modified (conflict-cascade will run), or not_on_disk. Use this before running sync_notes to preview what will happen.',
    {
      root_id: z.number().optional().describe('Filter to a specific root ID (optional; omit to list all roots)')
    },
    async (args) => {
      const { root_id } = args;

      const editedNotes = await client.getEditedOnlineNotes(root_id);

      if (editedNotes.length === 0) {
        return {
          content: [{
            type: 'text',
            text: 'No notes with pending online edits found. All notes are in sync.'
          }]
        };
      }

      // Group by root_path to load SyncStateManager once per root
      const byRoot = new Map<string, EditedOnlineNote[]>();
      for (const note of editedNotes) {
        const key = note.root_path;
        if (!byRoot.has(key)) byRoot.set(key, []);
        byRoot.get(key)!.push(note);
      }

      const rows: string[] = [];
      let safeToPull = 0;
      for (const [rootPath, notes] of byRoot) {
        // Load baseline state once for this root
        const syncManager = new SyncStateManager(rootPath);
        syncManager.load();

        for (const note of notes) {
          const localFilePath = path.join(rootPath, note.relative_path);

          let localStatus: 'unchanged' | 'also_modified' | 'not_on_disk';
          if (!fs.existsSync(localFilePath)) {
            localStatus = 'not_on_disk';
          } else {
            const localContent = fs.readFileSync(localFilePath, 'utf-8');
            const localHash = NoesisClient.computeHash(localContent);
            const baselineHash = syncManager.getBaseline(note.relative_path);

            if (baselineHash === undefined) {
              // No baseline yet — compare local hash to cloud hash directly
              localStatus = localHash === note.hash ? 'unchanged' : 'also_modified';
            } else {
              localStatus = localHash === baselineHash ? 'unchanged' : 'also_modified';
            }
          }

          if (localStatus === 'unchanged') safeToPull++;

          const statusLabel = localStatus === 'unchanged' ? '✓ safe to pull'
                            : localStatus === 'also_modified' ? '⚡ will conflict-cascade'
                            : '? not on disk';

          const editedAt = new Date(note.edited_online_at).toLocaleString();
          const title = note.title || note.relative_path;
          rows.push(
            `- **${title}** [ID: ${note.id}]\n` +
            `  File: ${note.relative_path}\n` +
            `  Edited online: ${editedAt}\n` +
            `  Local: ${statusLabel}`
          );
        }
      }

      const count = editedNotes.length;
      const noun = count === 1 ? 'note' : 'notes';

      return {
        content: [{
          type: 'text',
          text: `**${count} ${noun} with pending online edits** (${safeToPull} safe to pull, ${count - safeToPull} will conflict-cascade):\n\n` +
                rows.join('\n\n') +
                '\n\n**Next step:** Run `sync_notes` with the file paths (absolute) to pull. Safe notes pull automatically; others run the conflict cascade (Tier A → B → C).'
        }]
      };
    }
  );

  // Register sync_notes tool (bidirectional sync)
  server.tool(
    'sync_notes',
    'Bidirectional sync for the listed files. If a `files` path is MISSING LOCALLY but present in the cloud, this materializes the cloud content onto local disk at that path — creating any missing parent directories — and sets a sync baseline so future edits diff correctly. Use this whenever the user references a path inside a registered Noesis root and the file is not yet on this machine (e.g., the note was created by Claude Code on another laptop and pushed to Noesis); after the call the file will exist on disk at the canonical path and can be read, edited, and re-pushed normally. A path is inside a Noesis root if it contains `/.noesis/`, sits under a folder named `Noesis` (the cloud root — `~/Noesis/…`, `%USERPROFILE%\\Noesis\\…`, `C:\\Users\\<you>\\Noesis\\…`), or is under any directory in `list_roots`; absolute paths work even when the cloud stored the root in tilde form. If both sides have content and differ, conflicts are detected and reported. Calling without `root` or `files` performs a FULL root scan, which is slow and should only be used for intentional bulk syncs. PLAN-MODE GUIDANCE: This tool writes to disk so plan mode forbids the actual call, but you SHOULD propose calling it as Step 1 of any plan that needs a local file for a Noesis-tracked path that is missing on this machine — DO NOT ask the user "did you mean a different path?" or fall back to filesystem search when the path is inside a registered Noesis root. For read-only intent in plan mode (just reading content), prefer `get_note(path)` instead — it is read-only and plan-safe.',
    {
      root: z.string().optional().describe('Sync only a specific root folder (by name)'),
      files: z.array(z.string()).optional().describe('Sync specific file paths only. IMPORTANT: Use absolute paths (e.g., "C:/projects/docs/file.md"). Relative paths may resolve incorrectly.'),
      dryRun: z.boolean().optional().describe('Preview changes without syncing (default: false)'),
      force: z.boolean().optional().describe('Force re-sync even if file hash is unchanged. Useful for regenerating AI metadata on existing files (default: false)'),
      regenerateMetadata: z.boolean().optional().describe('Regenerate all metadata using AI, overwriting existing values. Use when you want AI to improve/replace current title, description, and keywords (default: false)'),
      moveNewToNoesis: z.boolean().optional().describe('Move new local-only files to .noesis folder before syncing. Keeps ad-hoc notes separate from project files (default: false)')
    },
    async (args) => {
      const { root, files, dryRun = false, force = false, regenerateMetadata = false, moveNewToNoesis = false } = args;

      // Get roots for sync
      let roots = await client.getRootsForSync();

      // If no roots configured, try auto-detection from CWD
      if (roots.length === 0) {
        const detected = detectRootFromCwd();

        if (detected) {
          // Check if this root already exists
          const existingRoot = await client.getRootByPath(normalizePath(detected.rootPath));

          if (existingRoot) {
            roots = [{
              id: existingRoot.id,
              name: existingRoot.name,
              path: existingRoot.path || getActivePathFromMap(existingRoot.local_paths),
              local_paths: existingRoot.local_paths || {},
              lastScannedAt: null,
            }];
          } else if (!dryRun) {
            // Auto-create the root — populate only the CLIENT_OS key; other slots
            // can be filled later from the Dashboard or another machine.
            const newRoot = await client.createRoot({
              name: path.basename(detected.rootPath),
              local_paths: { [CLIENT_OS]: normalizePath(detected.rootPath) },
            });
            roots = [{
              id: newRoot.id,
              name: newRoot.name,
              path: newRoot.path || getActivePathFromMap(newRoot.local_paths),
              local_paths: newRoot.local_paths || {},
              lastScannedAt: null,
            }];
          } else {
            return {
              content: [{
                type: 'text',
                text: `**Dry Run - Auto-Detection:**\n\nNo roots configured. Would auto-create root from current directory:\n\n📁 **Root:** ${detected.rootPath}\n📦 **Project:** ${detected.projectName}\n\nRun without --dryRun to create this root and sync files.`
              }]
            };
          }
        } else {
          return {
            content: [{
              type: 'text',
              text: 'No root directories configured and could not auto-detect from current directory.\n\nTo sync, either:\n1. Run from a git repository directory\n2. Add roots through the Noesis web UI'
            }]
          };
        }
      }

      // Safety guard: require explicit scope when roots exist.
      // Never sync based on CWD auto-detection alone — process.cwd() is fixed
      // at MCP server startup and doesn't reflect which file the user means.
      // Use `files` for specific files, `root` for full root sync.
      if (!root && !files) {
        const rootList = roots
          .map(r => `- \`${r.name}\`: ${r.path}`)
          .join('\n');
        return {
          content: [{
            type: 'text',
            text: `No scope specified. Please use one of:\n\n` +
                  `**Sync specific files** (recommended):\n` +
                  `sync_notes({ files: ["C:/full/path/to/file.md"] })\n\n` +
                  `**Sync an entire root:**\n${rootList}\n` +
                  `Example: sync_notes({ root: "${roots[0].name}" })`
          }]
        };
      }

      // Handle specific files sync mode (push-only for specific files)
      if (files && files.length > 0) {
        return await syncSpecificFiles(files, roots, dryRun, client, force, regenerateMetadata);
      }

      // Filter to specific root if requested
      const rootsToSync = root
        ? roots.filter(r => r.name.toLowerCase().includes(root.toLowerCase()))
        : roots;

      if (rootsToSync.length === 0) {
        return {
          content: [{
            type: 'text',
            text: `No root found matching "${root}". Available roots:\n${roots.map(r => `- ${r.name}: ${r.path}`).join('\n')}`
          }]
        };
      }

      // Initialize bidirectional sync result
      const result: BidirectionalSyncResult = {
        pushed: { created: 0, updated: 0 },
        pulled: { created: 0, updated: 0 },
        skipped: 0,
        conflicts: [],
        errors: [],
        details: []
      };

      // Track files moved to .noesis folder
      const allMovedToNoesis: string[] = [];

      for (const syncRoot of rootsToSync) {
        // Check if root path exists
        if (!fs.existsSync(syncRoot.path)) {
          result.errors.push(`Root path not found: ${syncRoot.path}`);
          continue;
        }

        // Load sync state for three-way hash comparison
        const stateMgr = new SyncStateManager(syncRoot.path);
        stateMgr.load();

        // Get cloud notes with hashes and timestamps
        const cloudNotes = await client.getNotesForSync(syncRoot.id);
        const cloudMap = new Map<string, {
          id: number; hash: string; modified_at: string; content: string;
          title: string | null; description: string | null; keywords: string | null;
          edited_online_at: string | null;
        }>();
        for (const note of cloudNotes) {
          if (note.relative_path) {
            // Normalize for consistent comparison with local paths
            const normalizedPath = normalizePath(note.relative_path);
            cloudMap.set(normalizedPath, {
              id: note.id,
              hash: note.hash,
              modified_at: note.modified_at,
              content: note.content,
              title: note.title,
              description: note.description,
              keywords: note.keywords,
              edited_online_at: note.edited_online_at,
            });
          }
        }

        // Scan local .md files (with project detection)
        const localFiles = scanMarkdownFiles(syncRoot.path, syncRoot.id, syncRoot.name, true);
        const localMap = new Map<string, LocalFile>();
        for (const file of localFiles) {
          localMap.set(file.relativePath, file);
        }

        // Get all unique paths (union of local and cloud)
        const allPaths = new Set([...localMap.keys(), ...cloudMap.keys()]);

        // Collect LOCAL ONLY files (exist locally, not in cloud, not already in .noesis)
        const localOnlyFiles: LocalFile[] = [];
        for (const relativePath of allPaths) {
          const localFile = localMap.get(relativePath);
          const cloudNote = cloudMap.get(relativePath);
          if (localFile && !cloudNote) {
            // Skip files already in .noesis folder
            if (!relativePath.startsWith('.noesis/')) {
              localOnlyFiles.push(localFile);
            }
          }
        }

        // If LOCAL ONLY files found and moveNewToNoesis not set, return prompt
        if (localOnlyFiles.length > 0 && !moveNewToNoesis && !dryRun) {
          return {
            content: [{
              type: 'text',
              text: `Found ${localOnlyFiles.length} new local note(s) not yet in cloud:\n` +
                    localOnlyFiles.map(f => `- ${f.relativePath}`).join('\n') +
                    `\n\n📁 Would you like to move them to \`.noesis\` folder before syncing?\n` +
                    `This keeps Noesis notes separate from project files.\n\n` +
                    `**Options:**\n` +
                    `- Run sync with \`moveNewToNoesis: true\` to move and sync\n` +
                    `- Run sync again without the parameter to sync from current location`
            }]
          };
        }

        // If moveNewToNoesis is true and there are LOCAL ONLY files, move them to .noesis
        const movedToNoesisFiles: string[] = [];
        if (moveNewToNoesis && localOnlyFiles.length > 0 && !dryRun) {
          for (const file of localOnlyFiles) {
            const oldPath = file.path;
            const fileName = path.basename(oldPath);

            // Create .noesis folder in the same directory as the file (project level)
            const fileDir = path.dirname(oldPath);
            const noesisDir = path.join(fileDir, '.noesis');
            if (!fs.existsSync(noesisDir)) {
              fs.mkdirSync(noesisDir, { recursive: true });
            }

            const newPath = path.join(noesisDir, fileName);

            // Handle name collision
            const finalPath = getUniqueFilePath(newPath);
            fs.renameSync(oldPath, finalPath);

            // Update localMap with new relative path (preserve parent folder structure)
            const relativeDir = path.dirname(file.relativePath);
            const newRelativePath = relativeDir ? `${relativeDir}/.noesis/${path.basename(finalPath)}` : `.noesis/${path.basename(finalPath)}`;
            localMap.delete(file.relativePath);
            stateMgr.removeBaseline(file.relativePath);

            // Re-read file to get updated stats
            const content = fs.readFileSync(finalPath, 'utf-8');
            const stats = fs.statSync(finalPath);
            const hash = NoesisClient.computeHash(content);

            localMap.set(newRelativePath, {
              ...file,
              path: normalizePath(finalPath),
              relativePath: newRelativePath,
              content,
              hash,
              mtime: stats.mtime,
              size: stats.size
            });

            movedToNoesisFiles.push(`${file.relativePath} → ${newRelativePath}`);
          }

          // Update allPaths to reflect the moves
          allPaths.clear();
          for (const key of localMap.keys()) {
            allPaths.add(key);
          }
          for (const key of cloudMap.keys()) {
            allPaths.add(key);
          }

          // Track moved files for the summary
          allMovedToNoesis.push(...movedToNoesisFiles);
        }

        for (const relativePath of allPaths) {
          const localFile = localMap.get(relativePath);
          const cloudNote = cloudMap.get(relativePath);

          try {
            if (localFile && !cloudNote) {
              // LOCAL ONLY: Push to cloud (create)
              if (dryRun) {
                result.details.push({ file: relativePath, action: 'pushed_create' });
                result.pushed.created++;
              } else {
                const metadata = parseYamlFrontmatter(localFile.content);
                await client.upsertNote(localFile, metadata, { force, regenerateMetadata });
                if (localFile.hash) stateMgr.setBaseline(
                  relativePath,
                  { hash: localFile.hash, lastSyncedAt: new Date().toISOString() },
                  localFile.content
                );
                result.details.push({ file: relativePath, action: 'pushed_create' });
                result.pushed.created++;
              }
            } else if (!localFile && cloudNote) {
              // CLOUD ONLY: Pull to local (create)
              if (dryRun) {
                result.details.push({ file: relativePath, action: 'pulled_create' });
                result.pulled.created++;
              } else {
                // Write file locally
                const localPath = path.join(syncRoot.path, relativePath);
                const localDir = path.dirname(localPath);
                if (!fs.existsSync(localDir)) {
                  fs.mkdirSync(localDir, { recursive: true });
                }
                fs.writeFileSync(localPath, cloudNote.content, 'utf-8');
                // Update DB file_size to match actual written file (may differ due to line endings)
                const stats = fs.statSync(localPath);
                await client.updateFileMetadata(normalizePath(localPath), stats.size, cloudNote.hash);
                stateMgr.setBaseline(
                  relativePath,
                  { hash: cloudNote.hash, lastSyncedAt: cloudNote.modified_at },
                  cloudNote.content
                );
                result.details.push({ file: relativePath, action: 'pulled_create' });
                result.pulled.created++;
              }
            } else if (localFile && cloudNote) {
              // BOTH EXIST: Compare hashes
              if (localFile.hash === cloudNote.hash) {
                // Same hash: seed baseline and check for metadata enrichment
                if (!dryRun && localFile.hash) {
                  stateMgr.setBaseline(
                    relativePath,
                    { hash: localFile.hash, lastSyncedAt: cloudNote.modified_at },
                    localFile.content
                  );
                }

                // Check if cloud has enriched metadata that local lacks
                if (!dryRun) {
                  const localMetadata = parseYamlFrontmatter(localFile.content);
                  const cloudKw = parseCloudKeywords(cloudNote.keywords);
                  const metadataDiffers =
                    (cloudNote.title && cloudNote.title !== localMetadata.title) ||
                    (cloudNote.description && cloudNote.description !== localMetadata.description) ||
                    (cloudKw.length > 0 && JSON.stringify(cloudKw.sort()) !== JSON.stringify((localMetadata.keywords || []).sort()));

                  if (metadataDiffers) {
                    const localPath = path.join(syncRoot.path, relativePath);
                    const updatedContent = updateFrontmatter(localFile.content, {
                      title: cloudNote.title || undefined,
                      description: cloudNote.description || undefined,
                      keywords: cloudKw.length > 0 ? cloudKw : undefined
                    });
                    fs.writeFileSync(localPath, updatedContent, 'utf-8');
                    result.details.push({ file: relativePath, action: 'pulled_update', reason: 'metadata from cloud' });
                    result.pulled.updated++;
                    continue;
                  }
                }

                // Hashes match but cloud still has edited_online_at set — clear the stale flag
                if (!dryRun && cloudNote.edited_online_at) {
                  const localPath = path.join(syncRoot.path, relativePath);
                  const stats = fs.statSync(localPath);
                  await client.updateFileMetadata(normalizePath(localPath), stats.size, localFile.hash!);
                }
                result.details.push({ file: relativePath, action: 'skipped', reason: 'unchanged' });
                result.skipped++;
              } else {
                // Different hash: use three-way comparison with baseline
                const baselineMeta = stateMgr.getBaselineMeta(relativePath);
                const baselineHash = baselineMeta?.hash;
                const baselineLastSyncedAt = baselineMeta?.lastSyncedAt;
                const localMtime = localFile.mtime ? localFile.mtime.getTime() : Date.now();
                const cloudMtime = new Date(cloudNote.modified_at).getTime();
                const direction = force
                  ? 'push'
                  : determineSyncDirection(
                      localFile.hash!,
                      cloudNote.hash,
                      baselineHash,
                      localMtime,
                      cloudMtime,
                      cloudNote.edited_online_at,
                      baselineLastSyncedAt
                    );

                if (direction === 'conflict') {
                  await runConflictCascade({
                    relativePath,
                    localPath: path.join(syncRoot.path, relativePath),
                    localContent: localFile.content,
                    cloudNote: {
                      id: cloudNote.id,
                      content: cloudNote.content,
                      hash: cloudNote.hash,
                      modified_at: cloudNote.modified_at,
                      edited_online_at: cloudNote.edited_online_at,
                    },
                    baselineHash,
                    baselineLastSyncedAt,
                    baselineContent: stateMgr.getBaselineContent(relativePath),
                    localFile,
                    localMtime: localFile.mtime ?? new Date(),
                    dryRun,
                    client,
                    stateMgr,
                    result,
                  });
                } else if (direction === 'push') {
                  // Local changed: smart merge - cloud H1 + local body, preserve cloud metadata
                  if (dryRun) {
                    result.details.push({ file: relativePath, action: 'pushed_update', reason: 'merged' });
                    result.pushed.updated++;
                  } else {
                    const metadata = parseYamlFrontmatter(localFile.content);
                    // Merge: use cloud's H1 (Noesis title edits) + local's body (local content edits)
                    const mergedContent = mergeContent(localFile.content, cloudNote.content);

                    // Enrich frontmatter with cloud metadata before push
                    const cloudKw = parseCloudKeywords(cloudNote.keywords);
                    const hasCloudMetadata = cloudNote.title || cloudNote.description || cloudKw.length > 0;
                    const enrichedContent = hasCloudMetadata
                      ? updateFrontmatter(mergedContent, {
                          title: cloudNote.title || undefined,
                          description: cloudNote.description || undefined,
                          keywords: cloudKw.length > 0 ? cloudKw : undefined
                        })
                      : mergedContent;

                    const enrichedHash = NoesisClient.computeHash(enrichedContent);
                    const mergedFile: LocalFile = {
                      ...localFile,
                      content: enrichedContent,
                      hash: enrichedHash
                    };
                    // preserveMetadata=true: keep cloud's AI-generated title/description/keywords
                    await client.upsertNote(mergedFile, metadata, { force: true, regenerateMetadata, preserveMetadata: true });

                    // Write enriched content back to local file
                    const localPath = path.join(syncRoot.path, relativePath);
                    fs.writeFileSync(localPath, enrichedContent, 'utf-8');

                    stateMgr.setBaseline(
                      relativePath,
                      { hash: enrichedHash, lastSyncedAt: new Date().toISOString() },
                      enrichedContent
                    );
                    result.details.push({ file: relativePath, action: 'pushed_update', reason: 'merged' });
                    result.pushed.updated++;
                  }
                } else if (direction === 'pull') {
                  // Cloud changed: pull to local
                  if (dryRun) {
                    result.details.push({ file: relativePath, action: 'pulled_update' });
                    result.pulled.updated++;
                  } else {
                    const localPath = path.join(syncRoot.path, relativePath);
                    fs.writeFileSync(localPath, cloudNote.content, 'utf-8');
                    // Update DB file_size to match actual written file (may differ due to line endings)
                    const stats = fs.statSync(localPath);
                    await client.updateFileMetadata(normalizePath(localPath), stats.size, cloudNote.hash);
                    stateMgr.setBaseline(
                      relativePath,
                      { hash: cloudNote.hash, lastSyncedAt: cloudNote.modified_at },
                      cloudNote.content
                    );
                    result.details.push({ file: relativePath, action: 'pulled_update' });
                    result.pulled.updated++;
                  }
                }
              }
            }
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'Unknown error';
            result.errors.push(`${relativePath}: ${errorMsg}`);
            result.details.push({ file: relativePath, action: 'error', reason: errorMsg });
          }
        }

        // Prune stale baselines for files no longer on either side, then save
        if (!dryRun) {
          stateMgr.pruneStale(allPaths);
          stateMgr.save();
        }

        // Update root scan time (unless dry run)
        if (!dryRun) {
          await client.updateRootScanTime(syncRoot.id);

          // Log sync operation for Dashboard
          try {
            await client.logSyncOperation({
              rootId: syncRoot.id,
              filesScanned: localFiles.length,
              filesAdded: result.pushed.created,
              filesUpdated: result.pushed.updated,
              filesDeleted: 0,
              source: 'mcp-bidirectional',
              machineName: os.hostname(),
              notes: result.conflicts.length > 0 ? `${result.conflicts.length} conflicts` : undefined
            });
          } catch (logError) {
            console.error('Failed to log sync operation:', logError);
          }
        }
      }

      // Build response message
      let message = dryRun ? '**Dry Run - Bidirectional Sync Preview:**\n\n' : '**Bidirectional Sync Complete!**\n\n';

      const totalPushed = result.pushed.created + result.pushed.updated;
      const totalPulled = result.pulled.created + result.pulled.updated;

      message += `📊 **Summary:**\n`;
      if (allMovedToNoesis.length > 0) {
        message += `- 📂 Moved to .noesis: ${allMovedToNoesis.length}\n`;
      }
      message += `- ⬆️ Pushed to cloud: ${totalPushed} (${result.pushed.created} new, ${result.pushed.updated} updated)\n`;
      message += `- ⬇️ Pulled from cloud: ${totalPulled} (${result.pulled.created} new, ${result.pulled.updated} updated)\n`;
      message += `- ⏭️ Skipped: ${result.skipped} (unchanged)\n`;

      if (result.conflicts.length > 0) {
        message += `- ⚠️ Conflicts: ${result.conflicts.length} (manual resolution needed)\n`;
      }
      if (result.errors.length > 0) {
        message += `- ❌ Errors: ${result.errors.length}\n`;
      }

      message += `\n📁 **Roots synced:** ${rootsToSync.map(r => r.name).join(', ')}\n`;

      // Show moved files
      if (allMovedToNoesis.length > 0) {
        message += '\n**📂 Moved to .noesis:**\n';
        for (const moved of allMovedToNoesis.slice(0, 10)) {
          message += `- ${moved}\n`;
        }
        if (allMovedToNoesis.length > 10) {
          message += `... and ${allMovedToNoesis.length - 10} more\n`;
        }
      }

      // Show changes (limit to first 20)
      const showDetails = result.details.filter(d => d.action !== 'skipped').slice(0, 20);
      if (showDetails.length > 0) {
        message += '\n**Changes:**\n';
        for (const detail of showDetails) {
          const icon = detail.action === 'pushed_create' ? '⬆️✨' :
                      detail.action === 'pushed_update' ? '⬆️🔄' :
                      detail.action === 'pulled_create' ? '⬇️✨' :
                      detail.action === 'pulled_update' ? '⬇️🔄' :
                      detail.action === 'conflict' ? '⚠️' :
                      detail.action === 'error' ? '❌' : '⏭️';
          message += `${icon} ${detail.file}`;
          if (detail.reason) message += ` (${detail.reason})`;
          message += '\n';
        }

        const remaining = result.details.filter(d => d.action !== 'skipped').length - 20;
        if (remaining > 0) {
          message += `... and ${remaining} more\n`;
        }
      }

      // Show conflicts (with structured BASE/LOCAL/CLOUD blocks when available).
      if (result.conflicts.length > 0) {
        message += '\n**⚠️ Conflicts (not synced):**\n';
        for (const conflict of result.conflicts.slice(0, 5)) {
          message += `- ${conflict.path}\n`;
          message += `  Local: ${new Date(conflict.localModified).toLocaleString()}\n`;
          message += `  Cloud: ${new Date(conflict.cloudModified).toLocaleString()}\n`;
          const structured = (conflict as any).structuredText as string | undefined;
          if (structured) message += structured;
        }
        if (result.conflicts.length > 5) {
          message += `... and ${result.conflicts.length - 5} more conflicts\n`;
        }
        message += '\n_Resolve via Path 1 (edit the local file and re-run `mcp__noesis__sync_notes`) or Path 2 (run `/noesis-sync`)._\n';
      }

      if (result.errors.length > 0) {
        message += '\n**Errors:**\n';
        for (const error of result.errors.slice(0, 5)) {
          message += `❌ ${error}\n`;
        }
        if (result.errors.length > 5) {
          message += `... and ${result.errors.length - 5} more errors\n`;
        }
      }

      return {
        content: [{
          type: 'text',
          text: message
        }]
      };
    }
  );

  // Register sync_status tool
  server.tool(
    'sync_status',
    'Check Noesis sync status: last sync time, root directories, and file counts.',
    {},
    async () => {
      const roots = await client.getRootsForSync();
      const noteCounts = await client.getNoteCountByRoot();
      const lastSync = await client.getLastSyncTime();

      if (roots.length === 0) {
        return {
          content: [{
            type: 'text',
            text: 'No root directories configured. Add roots through the md-manager UI first.'
          }]
        };
      }

      let message = '**Sync Status**\n\n';

      message += `🕐 **Last sync:** ${lastSync ? new Date(lastSync).toLocaleString() : 'Never'}\n\n`;

      message += `📁 **Roots (${roots.length}):**\n`;
      for (const syncRoot of roots) {
        const count = noteCounts.get(syncRoot.id) || 0;
        const exists = fs.existsSync(syncRoot.path);
        const status = exists ? '✅' : '❌ (not found)';

        message += `\n**${syncRoot.name}** ${status}\n`;
        message += `  Path: ${syncRoot.path}\n`;
        message += `  Notes in DB: ${count}\n`;

        if (exists) {
          // Count local files
          const localFiles = scanMarkdownFiles(syncRoot.path, syncRoot.id, syncRoot.name);
          message += `  Local .md files: ${localFiles.length}\n`;

          // Check for pending changes
          const dbHashes = await client.getNoteHashesByRoot(syncRoot.id);
          let pending = 0;
          for (const file of localFiles) {
            const dbHash = dbHashes.get(file.relativePath);
            if (!dbHash || dbHash !== file.hash) {
              pending++;
            }
          }
          if (pending > 0) {
            message += `  ⚠️ Pending changes: ${pending} files\n`;
          }
        }

        if (syncRoot.lastScannedAt) {
          message += `  Last scanned: ${new Date(syncRoot.lastScannedAt).toLocaleString()}\n`;
        }
      }

      return {
        content: [{
          type: 'text',
          text: message
        }]
      };
    }
  );

  // ============================================
  // Phase 6.1: AI Metadata Enhancement Tools
  // ============================================

  // Register enhance_note_metadata tool
  server.tool(
    'enhance_note_metadata',
    'Get a note\'s content and current metadata for AI analysis. Use this to review and improve document metadata (title, description, keywords, aliases) for better searchability. Returns the note content so YOU (Claude) can analyze it and suggest improvements.',
    {
      note_id: z.number().describe('The ID of the note to enhance'),
      apply_suggestions: z.object({
        title: z.string().optional(),
        description: z.string().optional(),
        keywords: z.array(z.string()).optional(),
        aliases: z.array(z.string()).optional()
      }).optional().describe('If provided, apply these metadata updates to the note')
    },
    async (args) => {
      const { note_id, apply_suggestions } = args;

      // If suggestions provided, apply them
      if (apply_suggestions) {
        const updated = await client.updateNoteMetadata(note_id, apply_suggestions);

        if (!updated) {
          return {
            content: [{
              type: 'text',
              text: `Failed to update note ${note_id}. Note may not exist.`
            }],
            isError: true
          };
        }

        // Build update summary
        const updates: string[] = [];
        if (apply_suggestions.title) updates.push(`title: "${apply_suggestions.title}"`);
        if (apply_suggestions.description) updates.push(`description: "${apply_suggestions.description.substring(0, 50)}..."`);
        if (apply_suggestions.keywords?.length) updates.push(`keywords: [${apply_suggestions.keywords.join(', ')}]`);
        if (apply_suggestions.aliases?.length) updates.push(`aliases: [${apply_suggestions.aliases.join(', ')}]`);

        return {
          content: [{
            type: 'text',
            text: `✅ **Metadata updated for note ${note_id}**\n\nUpdates applied:\n${updates.map(u => `- ${u}`).join('\n')}\n\n_The FTS vector will be automatically regenerated on next search._`
          }]
        };
      }

      // Otherwise, get note for analysis
      const note = await client.getNoteForEnhancement(note_id);

      if (!note) {
        return {
          content: [{
            type: 'text',
            text: `Note ${note_id} not found or is trashed.`
          }],
          isError: true
        };
      }

      // Format for Claude to analyze
      let message = `**Note Analysis: ${note.title}**\n\n`;
      message += `**File:** ${note.file_path}\n\n`;

      message += `**Current Metadata:**\n`;
      message += `- Project/Root: ${note.root_name || '_(unknown)_'}\n`;
      message += `- Title: ${note.title}\n`;
      message += `- Description: ${note.description || '_(empty)_'}\n`;
      message += `- Keywords: ${note.keywords.length > 0 ? note.keywords.join(', ') : '_(empty)_'}\n`;
      message += `- Aliases: ${note.aliases.length > 0 ? note.aliases.join(', ') : '_(empty)_'}\n`;
      message += `- Last AI Enhanced: ${note.ai_enhanced_at || 'Never'}\n\n`;

      // Truncate content if too long, but provide enough for analysis
      const contentPreview = note.content.length > 3000
        ? note.content.substring(0, 3000) + '\n\n...[truncated]...'
        : note.content;

      message += `**Content Preview:**\n\`\`\`markdown\n${contentPreview}\n\`\`\`\n\n`;

      message += `---\n\n`;
      message += `**Instructions for Claude:**\n`;
      message += `Analyze this document and suggest improved metadata. Consider:\n`;
      message += `1. **Title**: Should be descriptive and searchable (e.g., "AI Chat Implementation with RAG and Gemini")\n`;
      message += `2. **Description**: 1-2 sentence summary of what this document is about\n`;
      message += `3. **Keywords**: 5-10 terms including:\n`;
      message += `   - The main project/system/product this document is about (identify from content)\n`;
      message += `   - If root folder "${note.root_name}" is a meaningful project name (not generic like ".claude-notes", "docs"), include it\n`;
      message += `   - Technical terms, technologies, and concepts mentioned\n`;
      message += `   - Common search terms users might use to find this document\n`;
      message += `4. **Aliases**: Alternative names or phrases that could refer to this topic\n\n`;
      message += `To apply your suggestions, call this tool again with the \`apply_suggestions\` parameter.`;

      return {
        content: [{
          type: 'text',
          text: message
        }]
      };
    }
  );

  // Register list_notes_needing_enhancement tool
  server.tool(
    'list_notes_needing_enhancement',
    'List notes that are missing metadata (description or keywords). Use important_only=true to prioritize notes you have favorited, starred (⭐ in content), or rated with points.',
    {
      root: z.string().optional().describe('Filter to a specific root folder'),
      catalog: z.string().optional().describe('Filter to notes in a specific catalog (e.g., "Work", "Claude")'),
      limit: z.number().optional().describe('Maximum number of notes to return (default: 20, max: 50)'),
      important_only: z.boolean().optional().describe('Only show notes that are favorited, have ⭐ in content, or have points > 0')
    },
    async (args) => {
      const { root, catalog, limit = 20, important_only = false } = args;
      const effectiveLimit = Math.min(limit, 50);

      const notes = await client.getNotesNeedingEnhancement({ root, catalog, limit: effectiveLimit, importantOnly: important_only });

      if (notes.length === 0) {
        const context = important_only ? 'important ' : '';
        return {
          content: [{
            type: 'text',
            text: root
              ? `All ${context}notes in "${root}" have complete metadata! 🎉`
              : `All ${context}notes have complete metadata! 🎉`
          }]
        };
      }

      const header = important_only
        ? `**Important Notes Needing Enhancement (${notes.length}):**\n_(Favorited, starred, or rated)_\n\n`
        : `**Notes Needing Enhancement (${notes.length}):**\n\n`;

      let message = header;

      for (const note of notes) {
        const missing: string[] = [];
        if (!note.has_description) missing.push('description');
        if (!note.has_keywords) missing.push('keywords');

        // Build importance indicators
        const importance: string[] = [];
        if (note.is_favorite) importance.push('★ FAV');
        if (note.has_stars) importance.push('⭐ STARRED');
        if (note.points > 0) importance.push(`PTS:${note.points}`);

        message += `${note.id}. **${note.title}**\n`;
        if (importance.length > 0) {
          message += `   ${importance.join(' | ')}\n`;
        }
        message += `   Missing: ${missing.join(', ')}\n`;
        message += `   Path: ${note.file_path}\n\n`;
      }

      message += `---\n`;
      message += `Use \`enhance_note_metadata\` with a note ID to analyze and improve its metadata.`;

      return {
        content: [{
          type: 'text',
          text: message
        }]
      };
    }
  );

  // ============================================
  // Phase 6.2: Smart Scoring & Relations Tools
  // ============================================

  /**
   * Rate document importance (0-100)
   */
  server.tool(
    'rate_importance',
    'Rate a document\'s importance score (0-100). Without score: returns note for analysis. With score: updates the importance_score.',
    {
      note_id: z.number().describe('The note ID to rate'),
      score: z.number().min(0).max(100).optional().describe('Importance score 0-100 (omit to get note for analysis)')
    },
    async (args) => {
      const { note_id, score } = args;

      // If score provided, update it
      if (score !== undefined) {
        const updated = await client.updateImportanceScore(note_id, score);
        if (!updated) {
          return {
            content: [{ type: 'text', text: `Note ${note_id} not found or is trashed.` }],
            isError: true
          };
        }
        return {
          content: [{ type: 'text', text: `✅ Updated importance score for note ${note_id} to **${score}/100**` }]
        };
      }

      // Otherwise, return note for analysis
      const note = await client.getNoteForScoring(note_id);
      if (!note) {
        return {
          content: [{ type: 'text', text: `Note ${note_id} not found or is trashed.` }],
          isError: true
        };
      }

      const contentPreview = note.content.substring(0, 1000) + (note.content.length > 1000 ? '...' : '');

      let message = `**Rate Importance for:** ${note.title}\n\n`;
      message += `**Current Scores:**\n`;
      message += `- Importance: ${note.importance_score !== null ? `${note.importance_score}/100` : 'Not rated'}\n`;
      message += `- Quality: ${note.quality_score !== null ? `${note.quality_score}/100` : 'Not rated'}\n\n`;
      message += `**Signals:**\n`;
      message += `- Favorite: ${note.is_favorite ? 'Yes ⭐' : 'No'}\n`;
      message += `- Points: ${note.points}\n`;
      message += `- Relations: ${note.relations.length} connections\n\n`;
      message += `**Keywords:** ${note.keywords.length > 0 ? note.keywords.join(', ') : 'None'}\n\n`;
      message += `**Description:** ${note.description || 'None'}\n\n`;
      message += `**Content Preview:**\n\`\`\`\n${contentPreview}\n\`\`\`\n\n`;
      message += `---\n`;
      message += `Analyze this document and call \`rate_importance\` with a score 0-100.\n`;
      message += `Consider: unique content, topic breadth, reference frequency, practical value.`;

      return { content: [{ type: 'text', text: message }] };
    }
  );

  /**
   * Rate document quality (0-100)
   */
  server.tool(
    'rate_quality',
    'Rate a document\'s quality score (0-100). Without score: returns note for analysis. With score: updates the quality_score.',
    {
      note_id: z.number().describe('The note ID to rate'),
      score: z.number().min(0).max(100).optional().describe('Quality score 0-100 (omit to get note for analysis)')
    },
    async (args) => {
      const { note_id, score } = args;

      // If score provided, update it
      if (score !== undefined) {
        const updated = await client.updateQualityScore(note_id, score);
        if (!updated) {
          return {
            content: [{ type: 'text', text: `Note ${note_id} not found or is trashed.` }],
            isError: true
          };
        }
        return {
          content: [{ type: 'text', text: `✅ Updated quality score for note ${note_id} to **${score}/100**` }]
        };
      }

      // Otherwise, return note for analysis
      const note = await client.getNoteForScoring(note_id);
      if (!note) {
        return {
          content: [{ type: 'text', text: `Note ${note_id} not found or is trashed.` }],
          isError: true
        };
      }

      const contentPreview = note.content.substring(0, 1000) + (note.content.length > 1000 ? '...' : '');

      let message = `**Rate Quality for:** ${note.title}\n\n`;
      message += `**Current Scores:**\n`;
      message += `- Importance: ${note.importance_score !== null ? `${note.importance_score}/100` : 'Not rated'}\n`;
      message += `- Quality: ${note.quality_score !== null ? `${note.quality_score}/100` : 'Not rated'}\n\n`;
      message += `**Metadata Completeness:**\n`;
      message += `- Has description: ${note.description ? 'Yes ✅' : 'No ❌'}\n`;
      message += `- Has keywords: ${note.keywords.length > 0 ? `Yes (${note.keywords.length}) ✅` : 'No ❌'}\n`;
      message += `- Has relations: ${note.relations.length > 0 ? `Yes (${note.relations.length}) ✅` : 'No ❌'}\n\n`;
      message += `**Content Preview:**\n\`\`\`\n${contentPreview}\n\`\`\`\n\n`;
      message += `---\n`;
      message += `Analyze this document and call \`rate_quality\` with a score 0-100.\n`;
      message += `Consider: structure, completeness, clarity, metadata quality, up-to-date content.`;

      return { content: [{ type: 'text', text: message }] };
    }
  );

  /**
   * Update document relations (bidirectional)
   */
  server.tool(
    'update_relations',
    'Update document relations. Without relations: returns note + other notes for analysis. With relations: updates and creates inverse relations.',
    {
      note_id: z.number().describe('The note ID to update relations for'),
      relations: z.array(z.object({
        type: z.enum(['references', 'implements', 'extends', 'supersedes']).describe('Relation type'),
        target_id: z.number().describe('Target note ID'),
        context: z.string().optional().describe('Optional context explaining the relation')
      })).optional().describe('Relations to set (omit to get notes for analysis)')
    },
    async (args) => {
      const { note_id, relations } = args;

      // If relations provided, update them
      if (relations !== undefined) {
        const result = await client.updateRelations(note_id, relations);
        let message = `✅ Updated relations for note ${note_id}\n\n`;
        message += `- Relations set: ${relations.length}\n`;
        message += `- Inverse relations created: ${result.inversesCreated}\n\n`;

        if (relations.length > 0) {
          message += `**Relations:**\n`;
          for (const rel of relations) {
            message += `- ${rel.type} → note ${rel.target_id}`;
            if (rel.context) message += ` (${rel.context})`;
            message += `\n`;
          }
        }

        return { content: [{ type: 'text', text: message }] };
      }

      // Otherwise, return note + other notes for analysis
      const note = await client.getNoteForScoring(note_id);
      if (!note) {
        return {
          content: [{ type: 'text', text: `Note ${note_id} not found or is trashed.` }],
          isError: true
        };
      }

      const otherNotes = await client.getNotesForRelationAnalysis(note_id, { limit: 30 });

      let message = `**Find Relations for:** ${note.title} (ID: ${note.id})\n\n`;
      message += `**Description:** ${note.description || 'None'}\n`;
      message += `**Keywords:** ${note.keywords.length > 0 ? note.keywords.join(', ') : 'None'}\n\n`;

      if (note.relations.length > 0) {
        message += `**Current Relations:**\n`;
        for (const rel of note.relations) {
          message += `- ${rel.type} → note ${rel.target_id}`;
          if (rel.context) message += ` (${rel.context})`;
          message += `\n`;
        }
        message += `\n`;
      }

      // Display related codebases (resolved from the managed registry)
      const relatedCodebases = (note as any).related_codebases;
      if (relatedCodebases && Array.isArray(relatedCodebases) && relatedCodebases.length > 0) {
        message += `**Related Codebase:**\n`;
        for (const c of relatedCodebases) {
          const label = c?.label ? `${c.label} · ` : '';
          message += `- ${label}${c?.path ?? ''}\n`;
        }
        message += `\n`;
      }

      message += `**Other Notes to Consider:**\n\n`;
      for (const other of otherNotes) {
        message += `**${other.id}.** ${other.title}\n`;
        if (other.description) {
          message += `   ${other.description.substring(0, 100)}${other.description.length > 100 ? '...' : ''}\n`;
        }
        if (other.keywords.length > 0) {
          message += `   Keywords: ${other.keywords.slice(0, 5).join(', ')}\n`;
        }
        message += `\n`;
      }

      message += `---\n`;
      message += `**Relation Types:**\n`;
      message += `- \`references\`: This doc mentions/links to another\n`;
      message += `- \`implements\`: This doc implements a plan/design from another\n`;
      message += `- \`extends\`: This doc builds on/extends another\n`;
      message += `- \`supersedes\`: This doc replaces/obsoletes another\n\n`;
      message += `Call \`update_relations\` with detected relations.`;

      return { content: [{ type: 'text', text: message }] };
    }
  );

  // Register get_relation_graph tool
  server.tool(
    'get_relation_graph',
    'Traverse the relation graph from a starting note, following relation links up to N hops deep. Returns all reachable notes with their depth and the relation that led to them.',
    {
      note_id: z.number().describe('Starting note ID'),
      depth: z.number().min(1).max(4).optional().describe('Maximum traversal depth (default: 2, max: 4)')
    },
    async (args) => {
      const { note_id, depth = 2 } = args;
      const results = await client.getRelationGraph(note_id, Math.min(Math.max(depth, 1), 4));

      if (results.length === 0) {
        return {
          content: [{
            type: 'text',
            text: `No connected notes found within ${depth} hops of note ${note_id}.`
          }]
        };
      }

      // Group by depth for display
      const byDepth = new Map<number, any[]>();
      for (const n of results) {
        const d = n.depth;
        if (!byDepth.has(d)) byDepth.set(d, []);
        byDepth.get(d)!.push(n);
      }

      let output = `Relation graph from note ${note_id} (${results.length} connected note${results.length === 1 ? '' : 's'}, max depth ${depth}):\n`;
      for (const [d, notes] of [...byDepth.entries()].sort((a, b) => a[0] - b[0])) {
        output += `\n--- Depth ${d} ---\n`;
        for (const n of notes) {
          const desc = n.description ? `\n  ${n.description.substring(0, 120)}${n.description.length > 120 ? '...' : ''}` : '';
          output += `- **${n.title}** [ID: ${n.id}] via ${n.relation_type} from note ${n.from_id}\n  ${n.file_path}${desc}\n`;
        }
      }

      return {
        content: [{
          type: 'text',
          text: output
        }]
      };
    }
  );

  /**
   * Move / re-path a note, preserving all metadata
   */
  server.tool(
    'move_note',
    'Move a note to a new file path, preserving all metadata (favorites, points, scores, relations, embeddings). Optionally moves the physical file on disk.',
    {
      note_id: z.number().describe('The ID of the note to move'),
      new_path: z.string().describe('New absolute file path for the note'),
      new_root_name: z.string().optional().describe('Target root name; auto-detected from path if omitted'),
      move_file: z.boolean().optional().describe('Physically move the file on disk (default: false)')
    },
    async (args) => {
      const { note_id, new_path, new_root_name, move_file = false } = args;

      // 1. Fetch current note — save old path for display and sync state
      const currentNote = await client.getNote(note_id);
      if (!currentNote) {
        return {
          content: [{ type: 'text', text: `Note ${note_id} not found or is trashed.` }],
          isError: true
        };
      }
      const oldPath = currentNote.file_path;
      const oldRelativePath = currentNote.relative_path || '';

      // Resolve old root name for display and potential revert
      let oldRootName: string | undefined;
      if (currentNote.root_id) {
        const roots = await client.getRoots();
        const oldRoot = roots.find(r => r.id === currentNote.root_id);
        oldRootName = oldRoot?.name;
      }

      // 2. Update DB first — if this fails, no filesystem changes were made
      const moveResult = await client.moveNote(note_id, new_path, { newRootName: new_root_name });
      if (!moveResult) {
        return {
          content: [{ type: 'text', text: `Failed to move note ${note_id}. The target path may conflict with an existing note, or the path is not within any watched root directory.` }],
          isError: true
        };
      }

      // 3. If move_file, physically move the file on disk
      if (move_file) {
        const normalizedOldPath = normalizePath(oldPath);
        const normalizedNewPath = normalizePath(new_path);

        try {
          // Create destination directory
          fs.mkdirSync(path.dirname(normalizedNewPath), { recursive: true });

          // Move file with cross-drive fallback
          try {
            fs.renameSync(normalizedOldPath, normalizedNewPath);
          } catch (err: any) {
            if (err.code === 'EXDEV') {
              fs.copyFileSync(normalizedOldPath, normalizedNewPath);
              fs.unlinkSync(normalizedOldPath);
            } else {
              throw err;
            }
          }
        } catch (fileErr: any) {
          // Revert DB change
          await client.moveNote(note_id, oldPath, { newRootName: oldRootName });
          return {
            content: [{ type: 'text', text: `Failed to move file on disk: ${fileErr.message}\nDatabase change has been reverted.` }],
            isError: true
          };
        }
      }

      // 4. Update sync state if applicable
      try {
        const roots = await client.getRootsForSync();

        // Remove baseline from old root
        const oldRoot = roots.find(r => {
          return normalizePath(oldPath).startsWith(normalizePath(r.path));
        });
        if (oldRoot && oldRelativePath) {
          const oldMgr = new SyncStateManager(oldRoot.path);
          oldMgr.load();
          oldMgr.removeBaseline(oldRelativePath);
          oldMgr.save();
        }

        // Set baseline in new root
        const newRoot = roots.find(r => r.name === moveResult.root_name);
        if (newRoot && moveResult.relative_path) {
          const newMgr = new SyncStateManager(newRoot.path);
          newMgr.load();
          // Compute hash from file content if available
          const filePath = normalizePath(new_path);
          if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, 'utf-8');
            const hash = NoesisClient.computeHash(content);
            newMgr.setBaseline(moveResult.relative_path, hash);
          }
          newMgr.save();
        }
      } catch {
        // Sync state update is best-effort; move already succeeded
      }

      // 5. Format response
      let message = `Moved note ${note_id}:\n\n`;
      message += `**From:** ${oldPath}\n`;
      message += `**To:** ${moveResult.file_path}\n`;
      if (oldRootName && oldRootName !== moveResult.root_name) {
        message += `**Root:** ${oldRootName} → ${moveResult.root_name}\n`;
      }
      if (move_file) {
        message += `**File:** physically moved on disk\n`;
      }
      message += `\nAll metadata preserved (favorites, points, scores, relations, embeddings).`;

      return { content: [{ type: 'text', text: message }] };
    }
  );

  /**
   * Update note signals (favorite, points)
   */
  server.tool(
    'update_signals',
    'Update a note\'s favorite status and/or points. Use to mark notes as favorite or adjust their point value (0-150).',
    {
      note_id: z.number().describe('The note ID to update'),
      is_favorite: z.boolean().optional().describe('Set favorite status'),
      points: z.number().min(0).max(150).optional().describe('Set points value (0-150)')
    },
    async (args) => {
      const { note_id, is_favorite, points } = args;

      if (is_favorite === undefined && points === undefined) {
        return {
          content: [{ type: 'text', text: 'At least one of is_favorite or points is required.' }],
          isError: true
        };
      }

      const success = await client.updateNoteSignals(note_id, { is_favorite, points });
      if (!success) {
        return {
          content: [{ type: 'text', text: `Failed to update signals for note ${note_id}. Note may not exist.` }],
          isError: true
        };
      }

      const parts: string[] = [];
      if (is_favorite !== undefined) parts.push(`favorite: ${is_favorite ? 'Yes ⭐' : 'No'}`);
      if (points !== undefined) parts.push(`points: ${points}`);

      return {
        content: [{ type: 'text', text: `Updated note ${note_id}: ${parts.join(', ')}` }]
      };
    }
  );

  /**
   * Trash a note (soft-delete)
   */
  server.tool(
    'trash_note',
    'Soft-delete a note by marking it as trashed. The note is hidden from searches but can be recovered. Use for orphaned or duplicate records.',
    {
      note_id: z.number().describe('The note ID to trash')
    },
    async (args) => {
      const { note_id } = args;

      // Fetch note info for confirmation message
      const note = await client.getNote(note_id);
      if (!note) {
        return {
          content: [{ type: 'text', text: `Note ${note_id} not found.` }],
          isError: true
        };
      }

      const success = await client.trashNote(note_id);
      if (!success) {
        return {
          content: [{ type: 'text', text: `Failed to trash note ${note_id}.` }],
          isError: true
        };
      }

      return {
        content: [{ type: 'text', text: `Trashed note ${note_id}: "${note.title}"\nPath was: ${note.file_path}` }]
      };
    }
  );

  // Register set_note_catalogs tool
  server.tool(
    'set_note_catalogs',
    'Set the catalogs (categories) for a note. Replaces all existing catalog assignments.',
    {
      note_id: z.number().describe('The note ID'),
      catalogs: z.array(z.string()).describe('Array of catalog names to assign (e.g., ["Work", "Claude"])')
    },
    async (args) => {
      const { note_id, catalogs } = args;

      const note = await client.getNote(note_id);
      if (!note) {
        return {
          content: [{ type: 'text', text: `Note ${note_id} not found.` }],
          isError: true
        };
      }

      await client.setNoteCatalogs(note_id, catalogs);

      const catalogList = catalogs.length > 0 ? catalogs.join(', ') : '(none)';
      return {
        content: [{ type: 'text', text: `Updated catalogs for note ${note_id} ("${note.title}"): ${catalogList}` }]
      };
    }
  );

  // Register set_note_related_codes tool
  server.tool(
    'set_note_related_codes',
    'Link a note to managed codebases by ID. Replaces the note\'s full reference list. Prefer codebase_ids (use list_codebases / find_or_create_codebase to obtain them). The legacy related_codes:string[] shape is also accepted: each path is resolved via find-or-create on the server.',
    {
      note_id: z.number().describe('The note ID'),
      codebase_ids: z.array(z.number()).optional().describe('Primary: array of codebase IDs from the registry'),
      related_codes: z.array(z.string()).optional().describe('Legacy fallback: raw codebase paths. The server auto-creates a codebase row for each new path.'),
    },
    async (args) => {
      const { note_id, codebase_ids, related_codes } = args;
      if (!codebase_ids && !related_codes) {
        return {
          content: [{ type: 'text', text: 'Provide either codebase_ids or related_codes.' }],
          isError: true,
        };
      }
      const note = await client.getNote(note_id);
      if (!note) {
        return {
          content: [{ type: 'text', text: `Note ${note_id} not found.` }],
          isError: true,
        };
      }
      const payload: number[] | string[] = codebase_ids ?? (related_codes as string[]);
      await client.setNoteRelatedCodes(note_id, payload as any);
      const summary = Array.isArray(payload) && payload.length > 0
        ? payload.map((p: any) => String(p)).join(', ')
        : '(none)';
      return {
        content: [{ type: 'text', text: `Updated related codebases for note ${note_id} ("${note.title}"): ${summary}` }],
      };
    }
  );

  // ============================================
  // CODEBASES (managed registry)
  // ============================================

  const fmtCodebase = (c: any) => {
    const head = c.label ? `${c.label} (#${c.id})` : `#${c.id}`;
    const tail = [c.path, c.branch && `branch=${c.branch}`, c.repo_url, c.is_archived && '(archived)']
      .filter(Boolean).join(' · ');
    return `${head} — ${tail}`;
  };

  server.tool(
    'list_codebases',
    'List the user\'s managed codebases (the registry that backs each note\'s related codes). By default excludes archived rows.',
    {
      include_archived: z.boolean().optional().describe('Set true to include archived codebases (default false).'),
    },
    async ({ include_archived }) => {
      const rows = await client.listCodebases(!!include_archived);
      if (rows.length === 0) {
        return { content: [{ type: 'text', text: 'No codebases registered.' }] };
      }
      const text = rows.map(fmtCodebase).join('\n');
      return { content: [{ type: 'text', text }] };
    }
  );

  server.tool(
    'get_codebase',
    'Fetch a single codebase by ID, including label / branch / description / repo_url.',
    { id: z.number().describe('Codebase ID') },
    async ({ id }) => {
      const c = await client.getCodebase(id);
      const lines = [
        `ID: ${c.id}`,
        `Path: ${c.path}`,
        c.label && `Label: ${c.label}`,
        c.branch && `Branch: ${c.branch}`,
        c.description && `Description: ${c.description}`,
        c.repo_url && `Repo URL: ${c.repo_url}`,
        c.is_archived && `Status: archived`,
      ].filter(Boolean).join('\n');
      return { content: [{ type: 'text', text: lines }] };
    }
  );

  server.tool(
    'create_codebase',
    'Create a new managed codebase entry. The path is the canonical disk location; label / branch / description / repo_url are optional metadata.',
    {
      path: z.string().describe('Filesystem path of the codebase (e.g., "C:/temp_cGit/my-repo"). Backslashes are auto-converted to forward slashes.'),
      label: z.string().optional().describe('Human-readable name (e.g., "Cloud Connector Service").'),
      branch: z.string().optional().describe('Active branch or stream name.'),
      description: z.string().optional().describe('Free-text description of the codebase.'),
      repo_url: z.string().optional().describe('Optional remote URL (GitHub, etc.).'),
    },
    async (input) => {
      const c = await client.createCodebase(input);
      return { content: [{ type: 'text', text: `Created codebase: ${fmtCodebase(c)}` }] };
    }
  );

  server.tool(
    'find_or_create_codebase',
    'Return the codebase row matching this path (case-insensitive), creating one if it does not exist. Use this in skills that discover codebase paths from note content and need to convert them into codebase IDs for set_note_related_codes.',
    {
      path: z.string().describe('Filesystem path of the codebase. Backslashes are normalized to forward slashes; case is preserved on first create.'),
      label: z.string().optional().describe('Used only when the row is newly created.'),
    },
    async (input) => {
      const c = await client.findOrCreateCodebase(input);
      return { content: [{ type: 'text', text: `Resolved codebase: ${fmtCodebase(c)}` }] };
    }
  );

  server.tool(
    'update_codebase',
    'Update fields on a managed codebase. Pass only the fields you want to change. Pass is_archived=true to archive (hides from the picker without breaking existing note references).',
    {
      id: z.number().describe('Codebase ID'),
      path: z.string().optional(),
      label: z.string().nullable().optional(),
      branch: z.string().nullable().optional(),
      description: z.string().nullable().optional(),
      repo_url: z.string().nullable().optional(),
      is_archived: z.boolean().optional(),
    },
    async ({ id, ...patch }) => {
      const c = await client.updateCodebase(id, patch);
      return { content: [{ type: 'text', text: `Updated codebase: ${fmtCodebase(c)}` }] };
    }
  );

  server.tool(
    'delete_codebase',
    'Permanently delete a codebase AND remove its reference from every note that links to it. Destructive. Prefer update_codebase with is_archived=true unless you really want it gone.',
    { id: z.number().describe('Codebase ID') },
    async ({ id }) => {
      const r = await client.deleteCodebase(id);
      return { content: [{ type: 'text', text: `Deleted codebase ${id}; unlinked from ${r.unlinked_from_note_count} note(s).` }] };
    }
  );

  /**
   * Analyze knowledge base health
   */
  server.tool(
    'analyze_knowledge_base',
    'Analyze knowledge base health. Returns stats, low-quality docs, orphans, and recommendations.',
    {
      root: z.string().optional().describe('Filter to specific root folder'),
      limit: z.number().min(1).max(50).optional().describe('Max docs to show per category (default: 10)')
    },
    async (args) => {
      const { root, limit } = args;

      const stats = await client.getKnowledgeBaseStats({ root, limit: limit || 10 });

      let message = `# Knowledge Base Health Report\n\n`;

      // Overall stats
      message += `## Overview\n\n`;
      message += `| Metric | Count | % |\n`;
      message += `|--------|-------|---|\n`;
      message += `| Total Notes | ${stats.total} | 100% |\n`;
      message += `| With Importance Score | ${stats.withImportanceScore} | ${Math.round(stats.withImportanceScore / stats.total * 100)}% |\n`;
      message += `| With Quality Score | ${stats.withQualityScore} | ${Math.round(stats.withQualityScore / stats.total * 100)}% |\n`;
      message += `| With Relations | ${stats.withRelations} | ${Math.round(stats.withRelations / stats.total * 100)}% |\n`;
      message += `| With Description | ${stats.withDescription} | ${Math.round(stats.withDescription / stats.total * 100)}% |\n`;
      message += `| With Keywords | ${stats.withKeywords} | ${Math.round(stats.withKeywords / stats.total * 100)}% |\n\n`;

      // Low quality docs
      if (stats.lowQuality.length > 0) {
        message += `## Low Quality Documents (score < 50)\n\n`;
        for (const doc of stats.lowQuality.slice(0, 5)) {
          message += `- **${doc.id}.** ${doc.title} (quality: ${doc.quality_score ?? 'unrated'})\n`;
        }
        if (stats.lowQuality.length > 5) {
          message += `- ... and ${stats.lowQuality.length - 5} more\n`;
        }
        message += `\n`;
      }

      // Low importance docs
      if (stats.lowImportance.length > 0) {
        message += `## Low Importance Documents (score < 30)\n\n`;
        for (const doc of stats.lowImportance.slice(0, 5)) {
          message += `- **${doc.id}.** ${doc.title} (importance: ${doc.importance_score ?? 'unrated'})\n`;
        }
        if (stats.lowImportance.length > 5) {
          message += `- ... and ${stats.lowImportance.length - 5} more\n`;
        }
        message += `\n`;
      }

      // Orphan docs
      if (stats.orphans.length > 0) {
        message += `## Orphan Documents (no relations)\n\n`;
        for (const doc of stats.orphans.slice(0, 5)) {
          message += `- **${doc.id}.** ${doc.title}\n`;
        }
        if (stats.orphans.length > 5) {
          message += `- ... and ${stats.orphans.length - 5} more\n`;
        }
        message += `\n`;
      }

      // Missing metadata
      if (stats.missingMetadata.length > 0) {
        message += `## Missing Metadata\n\n`;
        for (const doc of stats.missingMetadata.slice(0, 5)) {
          message += `- **${doc.id}.** ${doc.title} (missing: ${doc.missing.join(', ')})\n`;
        }
        if (stats.missingMetadata.length > 5) {
          message += `- ... and ${stats.missingMetadata.length - 5} more\n`;
        }
        message += `\n`;
      }

      // Recommendations
      message += `## Recommendations\n\n`;
      const unscoredImportance = stats.total - stats.withImportanceScore;
      const unscoredQuality = stats.total - stats.withQualityScore;

      if (unscoredImportance > 0) {
        message += `- 📊 ${unscoredImportance} notes need importance scoring. Use \`rate_importance\` to score them.\n`;
      }
      if (unscoredQuality > 0) {
        message += `- 📊 ${unscoredQuality} notes need quality scoring. Use \`rate_quality\` to score them.\n`;
      }
      if (stats.orphans.length > 0) {
        message += `- 🔗 ${stats.orphans.length} orphan notes found. Use \`update_relations\` to connect them.\n`;
      }
      if (stats.missingMetadata.length > 0) {
        message += `- 📝 ${stats.missingMetadata.length} notes missing metadata. Use \`enhance_note_metadata\` to improve them.\n`;
      }

      if (unscoredImportance === 0 && unscoredQuality === 0 && stats.orphans.length === 0 && stats.missingMetadata.length === 0) {
        message += `✅ Knowledge base is in great shape!\n`;
      }

      return { content: [{ type: 'text', text: message }] };
    }
  );

  // ============================================
  // Phase 6.3: Semantic Search with Embeddings
  // ============================================

  /**
   * Generate embeddings for notes without them
   */
  server.tool(
    'generate_embeddings',
    'Generate embeddings for notes that don\'t have them. Uses Gemini API to create 768-dim vectors for semantic search. Processes in batches with progress reporting.',
    {
      batch_size: z.number().min(1).max(50).optional().describe('Number of notes to process (default: 10, max: 50)'),
      root: z.string().optional().describe('Filter to specific root folder')
    },
    async (args) => {
      const { batch_size = 10, root } = args;

      if (!embeddingsEnabled) {
        return {
          content: [{
            type: 'text',
            text: '❌ Embedding service not available. GEMINI_API_KEY may not be configured.'
          }],
          isError: true
        };
      }

      // Get notes without embeddings
      const notes = await client.getNotesWithoutEmbeddings({ limit: batch_size, root });

      if (notes.length === 0) {
        const context = root ? ` in "${root}"` : '';
        return {
          content: [{
            type: 'text',
            text: `✅ All notes${context} already have embeddings!`
          }]
        };
      }

      let message = `**Generating embeddings for ${notes.length} notes...**\n\n`;

      // Prepare texts for batch processing
      const texts = notes.map(note => ({
        id: note.id,
        text: `${note.title}\n\n${note.content}`.trim()
      }));

      const results = await generateEmbeddingsBatch(texts);

      // Store embeddings in database
      let success = 0;
      let failed = 0;
      const details: string[] = [];

      for (const result of results) {
        try {
          const updated = await client.updateNoteEmbedding(result.id, result.embedding);
          if (updated) {
            success++;
            const note = notes.find(n => n.id === result.id);
            details.push(`✅ ${result.id}: ${note?.title || 'Unknown'}`);
          } else {
            failed++;
            details.push(`❌ ${result.id}: Failed to update`);
          }
        } catch (error) {
          failed++;
          details.push(`❌ ${result.id}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }

      // Check how many notes still need embeddings
      const stats = await client.getEmbeddingStats();

      message += `**Results:**\n`;
      message += `- ✅ Generated: ${success}\n`;
      if (failed > 0) {
        message += `- ❌ Failed: ${failed}\n`;
      }
      message += `\n**Progress:**\n`;
      for (const detail of details.slice(0, 10)) {
        message += `${detail}\n`;
      }
      if (details.length > 10) {
        message += `... and ${details.length - 10} more\n`;
      }

      message += `\n**Overall Stats:**\n`;
      message += `- Total notes: ${stats.total}\n`;
      message += `- With embeddings: ${stats.withEmbeddings}\n`;
      message += `- Without embeddings: ${stats.withoutEmbeddings}\n`;

      if (stats.withoutEmbeddings > 0) {
        message += `\n_Run again to process more notes._`;
      }

      return { content: [{ type: 'text', text: message }] };
    }
  );

  /**
   * Semantic search using vector similarity
   */
  server.tool(
    'search_semantic',
    'Search notes using semantic similarity. Converts your query to an embedding and finds notes with similar meaning, not just matching keywords.',
    {
      query: z.string().describe('Natural language search query'),
      limit: z.number().min(1).max(20).optional().describe('Maximum results (default: 10, max: 20)'),
      root: z.string().optional().describe('Filter to specific root folder')
    },
    async (args) => {
      const { query, limit = 10, root } = args;

      if (!embeddingsEnabled) {
        return {
          content: [{
            type: 'text',
            text: '❌ Semantic search not available. GEMINI_API_KEY may not be configured.\n\nUse `search_notes` for keyword-based search instead.'
          }],
          isError: true
        };
      }

      try {
        // Generate embedding for query
        const queryEmbedding = await generateEmbedding(query);

        // Search by similarity
        const results = await client.searchByEmbedding(queryEmbedding, { limit, root });

        if (results.length === 0) {
          return {
            content: [{
              type: 'text',
              text: `No semantically similar notes found for "${query}".\n\nTry:\n- Rephrasing your query\n- Using more descriptive terms\n- Checking if notes have embeddings (use \`generate_embeddings\` first)`
            }]
          };
        }

        let message = `**Semantic Search Results for:** "${query}"\n\n`;

        for (let i = 0; i < results.length; i++) {
          const note = results[i];
          const similarityPct = Math.round(note.similarity * 100);
          const icon = similarityPct >= 80 ? '🎯' :
                       similarityPct >= 60 ? '✓' :
                       similarityPct >= 40 ? '○' : '·';

          message += `${i + 1}. ${icon} **${note.title}** [ID: ${note.id}] (${similarityPct}% similar)\n`;
          message += `   Path: ${note.file_path}\n`;
          if (note.description) {
            const desc = note.description.length > 100
              ? note.description.substring(0, 100) + '...'
              : note.description;
            message += `   ${desc}\n`;
          }
          message += `\n`;
        }

        return { content: [{ type: 'text', text: message }] };
      } catch (error) {
        return {
          content: [{
            type: 'text',
            text: `Error performing semantic search: ${error instanceof Error ? error.message : 'Unknown error'}`
          }],
          isError: true
        };
      }
    }
  );

  /**
   * Find notes similar to a given note
   */
  server.tool(
    'find_similar_notes',
    'Find notes that are semantically similar to a given note. Useful for discovering related content and potential document relationships.',
    {
      note_id: z.number().describe('The ID of the note to find similar notes for'),
      limit: z.number().min(1).max(20).optional().describe('Maximum results (default: 5, max: 20)')
    },
    async (args) => {
      const { note_id, limit = 5 } = args;

      if (!embeddingsEnabled) {
        return {
          content: [{
            type: 'text',
            text: '❌ Similarity search not available. GEMINI_API_KEY may not be configured.'
          }],
          isError: true
        };
      }

      try {
        // Get source note info first
        const sourceNote = await client.getNote(note_id);
        if (!sourceNote) {
          return {
            content: [{
              type: 'text',
              text: `Note ${note_id} not found.`
            }],
            isError: true
          };
        }

        // Find similar notes
        const similarNotes = await client.findSimilarNotes(note_id, { limit });

        if (similarNotes.length === 0) {
          return {
            content: [{
              type: 'text',
              text: `No similar notes found for "${sourceNote.title}".\n\nThis could mean:\n- The source note doesn't have an embedding yet\n- Other notes don't have embeddings yet (use \`generate_embeddings\`)\n- This note's content is unique in your knowledge base`
            }]
          };
        }

        let message = `**Notes Similar to:** ${sourceNote.title} (ID: ${note_id})\n\n`;

        for (let i = 0; i < similarNotes.length; i++) {
          const note = similarNotes[i];
          const similarityPct = Math.round(note.similarity * 100);
          const icon = similarityPct >= 80 ? '🎯' :
                       similarityPct >= 60 ? '✓' :
                       similarityPct >= 40 ? '○' : '·';

          message += `${i + 1}. ${icon} **${note.title}** [ID: ${note.id}] (${similarityPct}% similar)\n`;
          message += `   Path: ${note.file_path}\n`;
          if (note.description) {
            const desc = note.description.length > 100
              ? note.description.substring(0, 100) + '...'
              : note.description;
            message += `   ${desc}\n`;
          }
          message += `\n`;
        }

        message += `---\n`;
        message += `_Tip: Use \`update_relations\` to link related documents._`;

        return { content: [{ type: 'text', text: message }] };
      } catch (error) {
        return {
          content: [{
            type: 'text',
            text: `Error finding similar notes: ${error instanceof Error ? error.message : 'Unknown error'}`
          }],
          isError: true
        };
      }
    }
  );

  // ─── Daily News MCP Tools ───

  server.tool(
    'get_news_preferences',
    'Get your Daily News preferences including topic weights, RSS sources, seed URLs, language setting, and daily article limit. Use this to understand and analyze your news reading patterns.',
    {},
    async () => {
      try {
        const data = await client.getNewsPreferences();
        const settings = data.settings || {};
        const prefs = settings.preferences || {};
        const sources = data.sources || [];
        const seeds = data.seeds || [];

        let message = `**Daily News Preferences**\n\n`;
        message += `**Language:** ${settings.preferred_language || 'en'}\n`;
        message += `**Daily article limit:** ${settings.daily_article_limit || 20}\n`;
        message += `**Last refresh:** ${settings.last_refresh_at || 'never'}\n\n`;

        if (prefs.topics && Object.keys(prefs.topics).length > 0) {
          message += `**Topic Weights:**\n`;
          for (const [topic, weight] of Object.entries(prefs.topics).sort(([, a], [, b]) => (b as number) - (a as number))) {
            message += `- ${topic}: ${Math.round((weight as number) * 100)}%\n`;
          }
          message += `\n`;
        }

        if (prefs.sources && Object.keys(prefs.sources).length > 0) {
          message += `**Source Weights:**\n`;
          for (const [source, weight] of Object.entries(prefs.sources).sort(([, a], [, b]) => (b as number) - (a as number))) {
            message += `- ${source}: ${Math.round((weight as number) * 100)}%\n`;
          }
          message += `\n`;
        }

        message += `**RSS Sources (${sources.length}):**\n`;
        for (const s of sources) {
          message += `- ${s.is_active ? '✓' : '✗'} ${s.name} (${s.topic || 'no topic'}, ${s.language}) — ${s.url}\n`;
        }
        message += `\n`;

        message += `**Seed URLs (${seeds.length}):**\n`;
        for (const s of seeds) {
          message += `- ${s.domain || s.url} → topics: ${(s.extracted_topics || []).join(', ') || 'none'}\n`;
        }

        return { content: [{ type: 'text', text: message }] };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error fetching news preferences: ${error instanceof Error ? error.message : 'Unknown error'}` }],
          isError: true
        };
      }
    }
  );

  server.tool(
    'update_news_preferences',
    'Update your Daily News preferences. Can change language, daily article limit, or the full preference profile (topic/source weights). Use after analyzing preferences to push refinements.',
    {
      preferred_language: z.string().optional().describe('Preferred language code (e.g., "en", "zh-TW", "ja")'),
      daily_article_limit: z.number().optional().describe('Max articles shown per day (5-100)'),
      preferences: z.object({
        topics: z.record(z.number()).optional().describe('Topic weights (0-1), e.g., {"AI": 0.9, "Science": 0.3}'),
        sources: z.record(z.number()).optional().describe('Source weights (0-1), e.g., {"bbc.com": 0.8}'),
        keywords: z.array(z.string()).optional().describe('Interest keywords'),
      }).optional().describe('Full preference profile to update'),
    },
    async (args) => {
      try {
        const updateData: any = {};
        if (args.preferred_language || args.daily_article_limit) {
          updateData.settings = {};
          if (args.preferred_language) updateData.settings.preferred_language = args.preferred_language;
          if (args.daily_article_limit) updateData.settings.daily_article_limit = args.daily_article_limit;
        }
        if (args.preferences) {
          updateData.preferences = args.preferences;
        }

        await client.updateNewsPreferences(updateData);

        const changes: string[] = [];
        if (args.preferred_language) changes.push(`Language → ${args.preferred_language}`);
        if (args.daily_article_limit) changes.push(`Daily limit → ${args.daily_article_limit}`);
        if (args.preferences?.topics) changes.push(`Topics updated (${Object.keys(args.preferences.topics).length} entries)`);
        if (args.preferences?.sources) changes.push(`Sources updated (${Object.keys(args.preferences.sources).length} entries)`);
        if (args.preferences?.keywords) changes.push(`Keywords updated (${args.preferences.keywords.length} entries)`);

        return {
          content: [{ type: 'text', text: `✅ News preferences updated:\n${changes.map(c => `- ${c}`).join('\n')}` }]
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error updating preferences: ${error instanceof Error ? error.message : 'Unknown error'}` }],
          isError: true
        };
      }
    }
  );

  server.tool(
    'add_news_source',
    'Add an RSS/Atom feed as a news source. Use after discovering RSS feeds via web search to register them in the Daily News tool.',
    {
      name: z.string().describe('Display name for the source (e.g., "TechCrunch", "BBC World")'),
      url: z.string().describe('RSS or Atom feed URL'),
      topic: z.string().optional().describe('Topic category (e.g., "Technology", "World", "Science")'),
      language: z.string().optional().describe('Source language code (e.g., "en", "zh-TW", "ja")'),
    },
    async (args) => {
      try {
        const domain = (() => {
          try { return new URL(args.url).hostname.replace(/^www\./, ''); } catch { return undefined; }
        })();

        const result = await client.addNewsSource({
          name: args.name,
          url: args.url,
          domain,
          topic: args.topic,
          language: args.language || 'en',
          source_type: 'rss',
        });

        return {
          content: [{ type: 'text', text: `✅ News source added: **${args.name}**\n- URL: ${args.url}\n- Topic: ${args.topic || 'unset'}\n- Language: ${args.language || 'en'}` }]
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error adding news source: ${error instanceof Error ? error.message : 'Unknown error'}` }],
          isError: true
        };
      }
    }
  );
}

/**
 * Scan directory for .md files recursively
 * @param detectProjects - If true, detect project from .git folder for each file
 */
function scanMarkdownFiles(rootPath: string, rootId: number, rootName: string, detectProjects: boolean = false): LocalFile[] {
  const files: LocalFile[] = [];

  function scan(dir: string): void {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        // Skip hidden files/directories and node_modules
        if (entry.name.startsWith('.') || entry.name === 'node_modules') {
          continue;
        }

        if (entry.isDirectory()) {
          scan(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          try {
            const content = fs.readFileSync(fullPath, 'utf-8');
            const stats = fs.statSync(fullPath);
            const relativePath = normalizePath(path.relative(rootPath, fullPath));

            // Detect project if enabled
            const project = detectProjects ? detectProjectForFile(fullPath, rootPath) : undefined;

            files.push({
              path: normalizePath(fullPath),
              relativePath,
              content,
              hash: NoesisClient.computeHash(content),
              mtime: stats.mtime,
              size: stats.size,
              rootId,
              rootName,
              project
            });
          } catch (err) {
            // Skip files that can't be read
            console.error(`Error reading ${fullPath}:`, err);
          }
        }
      }
    } catch (err) {
      console.error(`Error scanning ${dir}:`, err);
    }
  }

  scan(rootPath);
  return files;
}

/**
 * Sync specific files by path (single-file or multi-file sync mode)
 * @param force - If true, bypass hash check and always re-sync (useful for metadata regeneration)
 * @param regenerateMetadata - If true, backend AI regenerates all metadata fields, overwriting existing values
 */
async function syncSpecificFiles(
  filePaths: string[],
  roots: Array<{ id: number; name: string; path: string; lastScannedAt: string | null }>,
  dryRun: boolean,
  client: NoesisClient,
  force: boolean = false,
  regenerateMetadata: boolean = false
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  // Use bidirectional sync result type
  const result: BidirectionalSyncResult = {
    pushed: { created: 0, updated: 0 },
    pulled: { created: 0, updated: 0 },
    skipped: 0,
    conflicts: [],
    errors: [],
    details: []
  };

  const affectedRoots = new Set<number>();
  const warnings: string[] = [];

  // Cache SyncStateManagers per root path
  const syncStateCache = new Map<string, SyncStateManager>();

  // Cache cloud notes per root to avoid multiple API calls
  const cloudNotesCache = new Map<number, Map<string, {
    id: number;
    hash: string;
    modified_at: string;
    content: string;
    title: string | null;
    description: string | null;
    keywords: string | null;
    edited_online_at: string | null;
  }>>();

  for (const filePath of filePaths) {
    // Normalize path — with auto-correction for doubled directory segments.
    // expandHome handles `~/...`, `~\...`, and `%USERPROFILE%\...` (the Windows
    // display form clients copy from the Noesis frontend) before path.resolve,
    // which itself doesn't expand `~` or env vars.
    let normalizedPath = normalizePath(path.resolve(expandHome(filePath)));

    // Check if resolved path falls inside any known root
    const inKnownRoot = roots.some(r => normalizedPath.startsWith(normalizePath(path.resolve(r.path))));
    if (!inKnownRoot) {
      // Look for consecutive duplicate segments (e.g., md-manager/md-manager)
      const segments = normalizedPath.split('/');
      let corrected = false;
      for (let i = 1; i < segments.length; i++) {
        if (segments[i] === segments[i - 1]) {
          const deduped = [...segments.slice(0, i), ...segments.slice(i + 1)];
          const candidate = deduped.join('/');
          if (roots.some(r => candidate.startsWith(normalizePath(path.resolve(r.path))))) {
            warnings.push(`Auto-corrected doubled path segment "${segments[i]}": ${filePath} -> ${candidate}`);
            normalizedPath = candidate;
            corrected = true;
            break;
          }
        }
      }
    }

    // Check if it's a markdown file (before existence check so cloud-only pulls also validate)
    if (!normalizedPath.endsWith('.md')) {
      result.errors.push(`Not a markdown file: ${filePath}`);
      result.details.push({ file: filePath, action: 'error', reason: 'Not a markdown file' });
      continue;
    }

    // Check if file exists locally — if not, try pulling from cloud
    if (!fs.existsSync(normalizedPath)) {
      const matchingRoot = roots.find(r => normalizedPath.startsWith(normalizePath(path.resolve(r.path))));
      if (!matchingRoot) {
        result.errors.push(`File not in any configured root: ${filePath}`);
        result.details.push({ file: filePath, action: 'error', reason: 'Not in configured root' });
        continue;
      }

      const relativePath = normalizePath(path.relative(matchingRoot.path, normalizedPath));

      // Fetch cloud notes (cached)
      if (!cloudNotesCache.has(matchingRoot.id)) {
        const cloudNotes = await client.getNotesForSync(matchingRoot.id);
        const cloudMap = new Map<string, typeof cloudNotes[0]>();
        for (const note of cloudNotes) {
          if (note.relative_path) {
            cloudMap.set(normalizePath(note.relative_path), note);
          }
        }
        cloudNotesCache.set(matchingRoot.id, cloudMap);
      }
      const cloudNotesMap = cloudNotesCache.get(matchingRoot.id)!;
      const cloudNote = cloudNotesMap.get(relativePath);

      if (cloudNote) {
        // CLOUD ONLY: Pull to local (create)
        if (dryRun) {
          result.details.push({ file: relativePath, action: 'pulled_create' });
          result.pulled.created++;
        } else {
          const localDir = path.dirname(normalizedPath);
          if (!fs.existsSync(localDir)) {
            fs.mkdirSync(localDir, { recursive: true });
          }
          fs.writeFileSync(normalizedPath, cloudNote.content, 'utf-8');
          const stats = fs.statSync(normalizedPath);
          await client.updateFileMetadata(normalizedPath, stats.size, cloudNote.hash);
          // Set baseline
          if (!syncStateCache.has(matchingRoot.path)) {
            const mgr = new SyncStateManager(matchingRoot.path);
            mgr.load();
            syncStateCache.set(matchingRoot.path, mgr);
          }
          syncStateCache.get(matchingRoot.path)!.setBaseline(relativePath, cloudNote.hash);
          result.details.push({ file: relativePath, action: 'pulled_create' });
          result.pulled.created++;
          affectedRoots.add(matchingRoot.id);
        }
      } else {
        result.errors.push(`Path '${filePath}' is inside root '${matchingRoot.name}' but no note at relative path '${relativePath}' exists in the cloud. This is a genuinely missing note — not a stale local cache. Try search_notes or list_notes to find similar paths in this root.`);
        result.details.push({ file: filePath, action: 'error', reason: 'Not found locally or in cloud' });
      }
      continue;
    }

    // Find which root this file belongs to
    const matchingRoot = roots.find(r => normalizedPath.startsWith(normalizePath(path.resolve(r.path))));

    if (!matchingRoot) {
      result.errors.push(`Path '${filePath}' is not inside any registered Noesis root. Call list_roots to see what's registered, or use add_root to register a parent directory before syncing this path.`);
      result.details.push({ file: filePath, action: 'error', reason: 'Not in configured root' });
      continue;
    }

    try {
      // Read local file content
      const localContent = fs.readFileSync(normalizedPath, 'utf-8');
      const stats = fs.statSync(normalizedPath);
      const relativePath = normalizePath(path.relative(matchingRoot.path, normalizedPath));
      const localHash = NoesisClient.computeHash(localContent);
      const localMtime = stats.mtime.getTime();

      // Get cloud notes for this root (cached)
      if (!cloudNotesCache.has(matchingRoot.id)) {
        const cloudNotes = await client.getNotesForSync(matchingRoot.id);
        const cloudMap = new Map<string, typeof cloudNotes[0]>();
        for (const note of cloudNotes) {
          if (note.relative_path) {
            cloudMap.set(normalizePath(note.relative_path), note);
          }
        }
        cloudNotesCache.set(matchingRoot.id, cloudMap);
      }
      const cloudNotesMap = cloudNotesCache.get(matchingRoot.id)!;
      const cloudNote = cloudNotesMap.get(relativePath);

      // Get or create SyncStateManager for this root
      if (!syncStateCache.has(matchingRoot.path)) {
        const mgr = new SyncStateManager(matchingRoot.path);
        mgr.load();
        syncStateCache.set(matchingRoot.path, mgr);
      }
      const stateMgr = syncStateCache.get(matchingRoot.path)!;

      // Parse local frontmatter metadata
      const localMetadata = parseYamlFrontmatter(localContent);

      if (!cloudNote) {
        // LOCAL ONLY: Push to cloud (create)
        if (dryRun) {
          result.details.push({ file: relativePath, action: 'pushed_create' });
          result.pushed.created++;
        } else {
          const project = detectProjectForFile(normalizedPath, matchingRoot.path);
          const localFile: LocalFile = {
            path: normalizedPath,
            relativePath,
            content: localContent,
            hash: localHash,
            mtime: stats.mtime,
            size: stats.size,
            rootId: matchingRoot.id,
            rootName: matchingRoot.name,
            project
          };
          await client.upsertNote(localFile, localMetadata, { force, regenerateMetadata });
          stateMgr.setBaseline(
            relativePath,
            { hash: localHash, lastSyncedAt: new Date().toISOString() },
            localContent
          );
          result.details.push({ file: relativePath, action: 'pushed_create' });
          result.pushed.created++;
          affectedRoots.add(matchingRoot.id);
        }
      } else if (localHash === cloudNote.hash) {
        // SAME CONTENT HASH: Check if metadata differs
        const cloudKeywords = parseCloudKeywords(cloudNote.keywords);

        const metadataDiffers =
          (cloudNote.title && cloudNote.title !== localMetadata.title) ||
          (cloudNote.description && cloudNote.description !== localMetadata.description) ||
          (cloudKeywords.length > 0 && JSON.stringify(cloudKeywords.sort()) !== JSON.stringify((localMetadata.keywords || []).sort()));

        if (metadataDiffers) {
          // Cloud has different metadata - pull it to local
          const cloudMtime = new Date(cloudNote.modified_at).getTime();

          if (cloudMtime > localMtime || force) {
            // Cloud is newer or force mode - pull metadata to local
            if (dryRun) {
              result.details.push({ file: relativePath, action: 'pulled_update', reason: 'metadata from cloud' });
              result.pulled.updated++;
            } else {
              // Update local file frontmatter with cloud metadata
              const updatedContent = updateFrontmatter(localContent, {
                title: cloudNote.title || undefined,
                description: cloudNote.description || undefined,
                keywords: cloudKeywords.length > 0 ? cloudKeywords : undefined
              });
              fs.writeFileSync(normalizedPath, updatedContent, 'utf-8');
              result.details.push({ file: relativePath, action: 'pulled_update', reason: 'metadata from cloud' });
              result.pulled.updated++;
              affectedRoots.add(matchingRoot.id);
            }
          } else {
            // Local is newer - push metadata to cloud.
            // Merge local over cloud so a missing/unparsed key falls back to cloud instead of wiping it.
            // Explicit empty values (description: "", keywords: []) still propagate — only `undefined` falls back.
            if (dryRun) {
              result.details.push({ file: relativePath, action: 'pushed_update', reason: 'metadata to cloud' });
              result.pushed.updated++;
            } else {
              const project = detectProjectForFile(normalizedPath, matchingRoot.path);
              const localFile: LocalFile = {
                path: normalizedPath,
                relativePath,
                content: localContent,
                hash: localHash,
                mtime: stats.mtime,
                size: stats.size,
                rootId: matchingRoot.id,
                rootName: matchingRoot.name,
                project
              };
              const mergedMetadata = {
                title: localMetadata.title !== undefined ? localMetadata.title : (cloudNote.title || undefined),
                description: localMetadata.description !== undefined ? localMetadata.description : (cloudNote.description || undefined),
                keywords: localMetadata.keywords !== undefined ? localMetadata.keywords : (cloudKeywords.length > 0 ? cloudKeywords : undefined)
              };
              await client.upsertNote(localFile, mergedMetadata, { force: true, regenerateMetadata });
              result.details.push({ file: relativePath, action: 'pushed_update', reason: 'metadata to cloud' });
              result.pushed.updated++;
              affectedRoots.add(matchingRoot.id);
            }
          }
        } else {
          // Content and metadata unchanged
          result.details.push({ file: relativePath, action: 'skipped', reason: 'unchanged' });
          result.skipped++;
        }
        // Record baseline for same-hash files (seed state on first sync)
        if (!dryRun) {
          stateMgr.setBaseline(
            relativePath,
            { hash: localHash, lastSyncedAt: cloudNote.modified_at },
            localContent
          );
        }
      } else {
        // DIFFERENT CONTENT HASH: Use three-way comparison with baseline
        const baselineMeta = stateMgr.getBaselineMeta(relativePath);
        const baselineHash = baselineMeta?.hash;
        const baselineLastSyncedAt = baselineMeta?.lastSyncedAt;
        const cloudMtime = new Date(cloudNote.modified_at).getTime();
        const direction = force
          ? 'push'
          : determineSyncDirection(
              localHash,
              cloudNote.hash,
              baselineHash,
              localMtime,
              cloudMtime,
              cloudNote.edited_online_at,
              baselineLastSyncedAt
            );

        if (direction === 'conflict') {
          const project = detectProjectForFile(normalizedPath, matchingRoot.path);
          const localFile: LocalFile = {
            path: normalizedPath,
            relativePath,
            content: localContent,
            hash: localHash,
            mtime: stats.mtime,
            size: stats.size,
            rootId: matchingRoot.id,
            rootName: matchingRoot.name,
            project,
          };
          await runConflictCascade({
            relativePath,
            localPath: normalizedPath,
            localContent,
            cloudNote: {
              id: cloudNote.id,
              content: cloudNote.content,
              hash: cloudNote.hash,
              modified_at: cloudNote.modified_at,
              edited_online_at: cloudNote.edited_online_at,
            },
            baselineHash,
            baselineLastSyncedAt,
            baselineContent: stateMgr.getBaselineContent(relativePath),
            localFile,
            localMtime: stats.mtime,
            dryRun,
            client,
            stateMgr,
            result,
          });
          if (result.pushed.updated > 0) affectedRoots.add(matchingRoot.id);
        } else if (direction === 'push') {
          // Local changed - smart merge: cloud H1 + local body, preserve cloud metadata
          if (dryRun) {
            result.details.push({ file: relativePath, action: 'pushed_update', reason: 'merged' });
            result.pushed.updated++;
          } else {
            const project = detectProjectForFile(normalizedPath, matchingRoot.path);
            // Merge: use cloud's H1 (Noesis title edits) + local's body (local content edits)
            const mergedContent = mergeContent(localContent, cloudNote.content);

            // Enrich frontmatter with cloud metadata before push
            const cloudKw = parseCloudKeywords(cloudNote.keywords);
            const hasCloudMetadata = cloudNote.title || cloudNote.description || cloudKw.length > 0;
            const enrichedContent = hasCloudMetadata
              ? updateFrontmatter(mergedContent, {
                  title: cloudNote.title || undefined,
                  description: cloudNote.description || undefined,
                  keywords: cloudKw.length > 0 ? cloudKw : undefined
                })
              : mergedContent;

            const enrichedHash = NoesisClient.computeHash(enrichedContent);
            const localFile: LocalFile = {
              path: normalizedPath,
              relativePath,
              content: enrichedContent,
              hash: enrichedHash,
              mtime: stats.mtime,
              size: stats.size,
              rootId: matchingRoot.id,
              rootName: matchingRoot.name,
              project
            };
            // preserveMetadata=true: keep cloud's AI-generated title/description/keywords
            await client.upsertNote(localFile, localMetadata, { force: true, regenerateMetadata, preserveMetadata: true });

            // Write enriched content back to local file
            fs.writeFileSync(normalizedPath, enrichedContent, 'utf-8');

            stateMgr.setBaseline(
              relativePath,
              { hash: enrichedHash, lastSyncedAt: new Date().toISOString() },
              enrichedContent
            );
            result.details.push({ file: relativePath, action: 'pushed_update', reason: 'merged' });
            result.pushed.updated++;
            affectedRoots.add(matchingRoot.id);
          }
        } else if (direction === 'pull') {
          // Cloud changed - pull content to local
          if (dryRun) {
            result.details.push({ file: relativePath, action: 'pulled_update' });
            result.pulled.updated++;
          } else {
            fs.writeFileSync(normalizedPath, cloudNote.content, 'utf-8');
            const stats = fs.statSync(normalizedPath);
            await client.updateFileMetadata(normalizedPath, stats.size, cloudNote.hash);
            stateMgr.setBaseline(
              relativePath,
              { hash: cloudNote.hash, lastSyncedAt: cloudNote.modified_at },
              cloudNote.content
            );
            result.details.push({ file: relativePath, action: 'pulled_update' });
            result.pulled.updated++;
            affectedRoots.add(matchingRoot.id);
          }
        }
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      result.errors.push(`${filePath}: ${errorMsg}`);
      result.details.push({ file: filePath, action: 'error', reason: errorMsg });
    }
  }

  // Save sync state baselines (unless dry run)
  if (!dryRun) {
    for (const mgr of syncStateCache.values()) {
      mgr.save();
    }
  }

  // Update root scan times and log sync for affected roots (unless dry run)
  if (!dryRun && affectedRoots.size > 0) {
    for (const rootId of affectedRoots) {
      await client.updateRootScanTime(rootId);

      // Log sync operation for Dashboard
      try {
        await client.logSyncOperation({
          rootId,
          filesScanned: filePaths.length,
          filesAdded: result.pushed.created,
          filesUpdated: result.pushed.updated + result.pulled.updated,
          filesDeleted: 0,
          source: 'mcp-bidirectional',
          machineName: os.hostname(),
          notes: result.conflicts.length > 0 ? `${result.conflicts.length} conflicts` : 'Specific files sync'
        });
      } catch (logError) {
        console.error('Failed to log sync operation:', logError);
      }
    }
  }

  // Build response message
  const fileCount = filePaths.length;
  let message = dryRun
    ? `**Dry Run - Bidirectional Sync Preview (${fileCount} file${fileCount === 1 ? '' : 's'}):**\n\n`
    : `**Bidirectional Sync Complete (${fileCount} file${fileCount === 1 ? '' : 's'})!**\n\n`;

  const totalPushed = result.pushed.created + result.pushed.updated;
  const totalPulled = result.pulled.created + result.pulled.updated;

  message += `📊 **Summary:**\n`;
  message += `- ⬆️ Pushed to cloud: ${totalPushed} (${result.pushed.created} new, ${result.pushed.updated} updated)\n`;
  message += `- ⬇️ Pulled from cloud: ${totalPulled} (${result.pulled.created} new, ${result.pulled.updated} updated)\n`;
  message += `- ⏭️ Skipped: ${result.skipped} (unchanged)\n`;

  if (result.conflicts.length > 0) {
    message += `- ⚠️ Conflicts: ${result.conflicts.length} (manual resolution needed)\n`;
  }
  if (result.errors.length > 0) {
    message += `- ❌ Errors: ${result.errors.length}\n`;
  }

  if (warnings.length > 0) {
    message += `\n**Path Corrections:**\n`;
    for (const w of warnings) {
      message += `- ${w}\n`;
    }
  }

  // Show changes
  const showDetails = result.details.filter(d => d.action !== 'skipped');
  if (showDetails.length > 0) {
    message += '\n**Changes:**\n';
    for (const detail of showDetails) {
      const icon = detail.action === 'pushed_create' ? '⬆️✨' :
                  detail.action === 'pushed_update' ? '⬆️🔄' :
                  detail.action === 'pulled_create' ? '⬇️✨' :
                  detail.action === 'pulled_update' ? '⬇️🔄' :
                  detail.action === 'conflict' ? '⚠️' :
                  detail.action === 'error' ? '❌' : '⏭️';
      message += `${icon} ${detail.file}`;
      if (detail.reason) message += ` (${detail.reason})`;
      message += '\n';
    }
  }

  // Show conflicts (with structured BASE/LOCAL/CLOUD blocks when available).
  if (result.conflicts.length > 0) {
    message += '\n**⚠️ Conflicts (not synced):**\n';
    for (const conflict of result.conflicts) {
      message += `- ${conflict.path}\n`;
      message += `  Local: ${new Date(conflict.localModified).toLocaleString()}\n`;
      message += `  Cloud: ${new Date(conflict.cloudModified).toLocaleString()}\n`;
      const structured = (conflict as any).structuredText as string | undefined;
      if (structured) message += structured;
    }
    message += '\n_Resolve via Path 1 (edit the local file and re-run `mcp__noesis__sync_notes`) or Path 2 (run `/noesis-sync`)._\n';
  }

  return {
    content: [{
      type: 'text' as const,
      text: message
    }]
  };
}

/**
 * Parse YAML frontmatter from markdown content using js-yaml
 */
function parseYamlFrontmatter(content: string): {
  title?: string;
  description?: string;
  keywords?: string[];
} {
  const result: { title?: string; description?: string; keywords?: string[] } = {};

  // Check for YAML frontmatter (--- at start)
  if (!content.startsWith('---')) {
    return result;
  }

  const endIndex = content.indexOf('---', 3);
  if (endIndex === -1) {
    return result;
  }

  const frontmatterStr = content.substring(3, endIndex).trim();

  try {
    const parsed = yaml.load(frontmatterStr) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') {
      return result;
    }

    // Extract title
    if (typeof parsed.title === 'string') {
      result.title = parsed.title;
    }

    // Extract description
    if (typeof parsed.description === 'string') {
      result.description = parsed.description;
    }

    // Extract keywords (support both 'keywords' and 'tags')
    const keywordsValue = parsed.keywords ?? parsed.tags;
    if (Array.isArray(keywordsValue)) {
      result.keywords = keywordsValue.filter((k): k is string => typeof k === 'string');
    } else if (typeof keywordsValue === 'string') {
      // Handle comma-separated string
      result.keywords = keywordsValue.split(',').map(k => k.trim()).filter(k => k);
    }
  } catch (error) {
    // If YAML parsing fails, return empty result
    console.error('Failed to parse YAML frontmatter:', error);
  }

  return result;
}

/**
 * Parse cloud keywords from various formats (string JSON, array, or null)
 */
function parseCloudKeywords(keywords: string | string[] | null): string[] {
  if (!keywords) return [];
  if (Array.isArray(keywords)) return keywords;
  try {
    const parsed = JSON.parse(keywords);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Update frontmatter in file content with new metadata values
 * Preserves existing frontmatter structure and only updates specified fields
 */
function updateFrontmatter(
  content: string,
  updates: { title?: string; description?: string; keywords?: string[] }
): string {
  // If no frontmatter exists, create one
  if (!content.startsWith('---')) {
    const frontmatterLines = ['---'];
    if (updates.title) frontmatterLines.push(`title: ${updates.title}`);
    if (updates.description) frontmatterLines.push(`description: ${updates.description}`);
    if (updates.keywords && updates.keywords.length > 0) {
      frontmatterLines.push('keywords:');
      for (const kw of updates.keywords) {
        frontmatterLines.push(`  - ${kw}`);
      }
    }
    frontmatterLines.push('---');
    return frontmatterLines.join('\n') + '\n' + content;
  }

  // Find end of frontmatter
  const endIndex = content.indexOf('---', 3);
  if (endIndex === -1) {
    return content; // Invalid frontmatter, return unchanged
  }

  const frontmatter = content.substring(3, endIndex);
  const bodyContent = content.substring(endIndex + 3);
  const lines = frontmatter.split(/\r?\n/);
  const newLines: string[] = [];
  const updatedKeys = new Set<string>();
  let i = 0;

  let lastReplacedKey: string | null = null;

  while (i < lines.length) {
    const line = lines[i];
    const colonIndex = line.indexOf(':');

    // Indented or non-key lines: continuation/sub-items of previous key
    if (colonIndex === -1 || line.match(/^\s/)) {
      if (lastReplacedKey === null) {
        newLines.push(line);
      }
      // else: skip — belongs to a replaced key
      i++;
      continue;
    }

    // New top-level key — reset sub-item tracking
    lastReplacedKey = null;
    const key = line.substring(0, colonIndex).trim().toLowerCase();

    if (key === 'title' && updates.title !== undefined) {
      if (!updatedKeys.has('title')) {
        newLines.push(`title: ${updates.title}`);
        updatedKeys.add('title');
      }
      lastReplacedKey = 'title';
    } else if (key === 'description' && updates.description !== undefined) {
      if (!updatedKeys.has('description')) {
        newLines.push(`description: ${updates.description}`);
        updatedKeys.add('description');
      }
      lastReplacedKey = 'description';
    } else if ((key === 'keywords' || key === 'tags') && updates.keywords !== undefined) {
      if (!updatedKeys.has('keywords')) {
        newLines.push('keywords:');
        for (const kw of updates.keywords) {
          newLines.push(`  - ${kw}`);
        }
        updatedKeys.add('keywords');
      }
      lastReplacedKey = 'keywords';
    } else {
      newLines.push(line);
    }
    i++;
  }

  // Add any new keys that weren't in original frontmatter
  if (updates.title !== undefined && !updatedKeys.has('title')) {
    newLines.push(`title: ${updates.title}`);
  }
  if (updates.description !== undefined && !updatedKeys.has('description')) {
    newLines.push(`description: ${updates.description}`);
  }
  if (updates.keywords !== undefined && !updatedKeys.has('keywords')) {
    newLines.push('keywords:');
    for (const kw of updates.keywords) {
      newLines.push(`  - ${kw}`);
    }
  }

  return '---\n' + newLines.filter(l => l.trim() !== '').join('\n') + '\n---' + bodyContent;
}

/**
 * Parse markdown content into structure: frontmatter, H1 heading, and body
 */
function parseMarkdownStructure(content: string): {
  frontmatter: string;
  h1: string | null;
  body: string;
} {
  let frontmatter = '';
  let remaining = content;

  // Extract YAML frontmatter (--- ... ---)
  if (content.startsWith('---')) {
    const endIndex = content.indexOf('---', 3);
    if (endIndex !== -1) {
      frontmatter = content.substring(0, endIndex + 3);
      remaining = content.substring(endIndex + 3).replace(/^\r?\n/, ''); // Remove leading newline after frontmatter
    }
  }

  // Extract first H1 heading (# ...)
  const h1Match = remaining.match(/^(#\s+.+?)(\r?\n|$)/m);
  let h1: string | null = null;
  let body = remaining;

  if (h1Match) {
    h1 = h1Match[1];
    // Get everything after the H1 (including the newline after it)
    const h1EndIndex = remaining.indexOf(h1Match[0]) + h1Match[0].length;
    body = remaining.substring(h1EndIndex);
  }

  return { frontmatter, h1, body };
}

/**
 * Reconstruct markdown content from parts
 */
function reconstructMarkdown(frontmatter: string, h1: string | null, body: string): string {
  let result = '';

  if (frontmatter) {
    result += frontmatter + '\n';
  }

  if (h1) {
    result += h1 + '\n';
  }

  result += body;

  return result;
}

// ============================================
// Bidirectional sync conflict cascade (tiers A → B → C)
// ============================================

interface TierAResult { kind: 'merged'; merged: string; hunks: number }
interface TierBResult { kind: 'merged'; merged: string }
interface TierCRegion { aLines: string[]; oLines: string[]; bLines: string[] }
interface TierCResult { kind: 'conflict'; regions: TierCRegion[] }

/**
 * Tier A — anchor-first reapply.
 *
 * Derive cloud-side hunks from `diffPatch(B, C)`. For each hunk, pull a few lines of
 * surrounding context from B as `prefix`/`suffix`. Search L for a unique
 * `prefix + originalLines + suffix` match. If found, splice C's replacement lines in.
 *
 * Returns null when any hunk's anchor isn't unique in L (or original drifted) — caller
 * falls through to tier B.
 *
 * Cheap, deterministic, and handles the common typo case cleanly without producing the
 * line-noise that diff3Merge sometimes emits when adjacent lines diverge.
 */
function tierAAnchorReapply(local: string, base: string, cloud: string): TierAResult | null {
  const baseLines = base.split(/\r?\n/);
  const cloudLines = cloud.split(/\r?\n/);
  const patches = diffPatch(baseLines, cloudLines);
  if (patches.length === 0) {
    return { kind: 'merged', merged: local, hunks: 0 };
  }

  const CONTEXT = 3;
  type Splice = { localStart: number; localEnd: number; replacement: string[] };
  const splices: Splice[] = [];

  for (const p of patches) {
    const baseStart = p.buffer1.offset;
    const baseEnd = baseStart + p.buffer1.length;
    const originalLines = p.buffer1.chunk;
    const replacementLines = p.buffer2.chunk;

    const prefixLines = baseLines.slice(Math.max(0, baseStart - CONTEXT), baseStart);
    const suffixLines = baseLines.slice(baseEnd, Math.min(baseLines.length, baseEnd + CONTEXT));

    // Search L's text for a unique `prefix + original + suffix` match (line-joined).
    const localLines = local.split(/\r?\n/);
    const needle = [...prefixLines, ...originalLines, ...suffixLines];
    const matchIdx = findUniqueLineRun(localLines, needle);
    if (matchIdx === -1) return null;

    const localOriginalStart = matchIdx + prefixLines.length;
    const localOriginalEnd = localOriginalStart + originalLines.length;
    splices.push({ localStart: localOriginalStart, localEnd: localOriginalEnd, replacement: replacementLines });
  }

  // Apply all splices in reverse order so indices stay valid.
  let mergedLines = local.split(/\r?\n/);
  splices.sort((a, b) => b.localStart - a.localStart);
  for (const s of splices) {
    mergedLines = [
      ...mergedLines.slice(0, s.localStart),
      ...s.replacement,
      ...mergedLines.slice(s.localEnd),
    ];
  }
  return { kind: 'merged', merged: mergedLines.join('\n'), hunks: splices.length };
}

/** Find the unique starting line index where `needle` appears in `haystack`. -1 if absent or non-unique. */
function findUniqueLineRun(haystack: string[], needle: string[]): number {
  if (needle.length === 0 || needle.length > haystack.length) return -1;
  let foundIdx = -1;
  for (let i = 0; i <= haystack.length - needle.length; i++) {
    let match = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) { match = false; break; }
    }
    if (match) {
      if (foundIdx !== -1) return -1; // non-unique
      foundIdx = i;
    }
  }
  return foundIdx;
}

/**
 * Tier B — node-diff3 line-level 3-way merge.
 * Returns merged text only when no conflict regions; null otherwise.
 */
function tierBDiff3(local: string, base: string, cloud: string): TierBResult | TierCResult {
  const regions = diff3Merge<string>(local, base, cloud, { stringSeparator: /\r?\n/ });
  const conflictRegions: TierCRegion[] = [];
  const mergedParts: string[] = [];
  for (const r of regions) {
    if (r.ok) {
      mergedParts.push((r.ok as string[]).join('\n'));
    } else if (r.conflict) {
      conflictRegions.push({
        aLines: r.conflict.a as string[],
        oLines: r.conflict.o as string[],
        bLines: r.conflict.b as string[],
      });
    }
  }
  if (conflictRegions.length > 0) {
    return { kind: 'conflict', regions: conflictRegions };
  }
  return { kind: 'merged', merged: mergedParts.join('\n') };
}

/**
 * Format the structured BASE/LOCAL/CLOUD report for a conflicted file (tier C).
 * Goes into the sync_notes tool's text response so Claude (or the user) can act.
 */
function formatConflictText(relativePath: string, regions: TierCRegion[]): string {
  let s = `\n⚠ Conflict in \`${relativePath}\` — ${regions.length} unresolvable hunk${regions.length === 1 ? '' : 's'}\n`;
  regions.forEach((r, i) => {
    s += `\nHunk ${i + 1}:\n`;
    s += '<<< BASE (last synced)\n';
    s += r.oLines.join('\n') + '\n';
    s += '=== LOCAL\n';
    s += r.aLines.join('\n') + '\n';
    s += '=== CLOUD (edited online)\n';
    s += r.bLines.join('\n') + '\n';
    s += '>>>\n';
  });
  return s;
}

/**
 * Run the three-tier cascade on a single conflicted file. Used by BOTH the
 * bidirectional root-scan path AND the --files specific-file path so they share
 * one merge engine. Mutates `result` in place.
 *
 * Returns: nothing. Side effects:
 *  - On tier A or tier B success: writes merged text to localPath, pushes via
 *    upsert with lastSyncedHash, updates baseline (hash + content + lastSyncedAt).
 *  - On tier C: posts /mark-conflict to surface the web banner; appends the
 *    structured BASE/LOCAL/CLOUD payload onto result.conflicts[].structuredText.
 *  - When baselineContent is undefined (v1-upgraded entry): skips A and B,
 *    jumps to tier C with base: null.
 */
async function runConflictCascade(opts: {
  relativePath: string;
  localPath: string;
  localContent: string;
  cloudNote: { id: number; content: string; hash: string; modified_at: string; edited_online_at: string | null };
  baselineHash: string | undefined;
  baselineLastSyncedAt: string | undefined;
  baselineContent: string | undefined;
  localFile: LocalFile;
  localMtime: Date;
  dryRun: boolean;
  client: NoesisClient;
  stateMgr: SyncStateManager;
  result: BidirectionalSyncResult;
}): Promise<void> {
  const { relativePath, localPath, localContent, cloudNote, baselineHash, baselineLastSyncedAt, baselineContent, localFile, localMtime, dryRun, client, stateMgr, result } = opts;

  const conflictEntry = {
    path: relativePath,
    localModified: localMtime.toISOString(),
    cloudModified: cloudNote.modified_at,
  };

  if (baselineContent === undefined) {
    // v1-upgraded entry: no baseline file, jump to tier C with base: null
    result.conflicts.push(conflictEntry);
    result.details.push({
      file: relativePath,
      action: 'conflict',
      reason: 'baseline content missing (v1-upgraded entry); resolve via Path 1 or Path 2',
    });
    if (!dryRun) {
      try {
        await client.markConflict(cloudNote.id, {
          relativePath,
          reason: 'cloud-edited-online',
          baselineLastSyncedAt: baselineLastSyncedAt ?? null,
          cloudEditedOnlineAt: cloudNote.edited_online_at ?? null,
          base: null,
          local: localContent,
          cloud: cloudNote.content,
        });
      } catch (markErr) {
        console.warn(`Failed to mark conflict for ${relativePath}:`, markErr);
      }
    }
    return;
  }

  // Tier A — anchor-first reapply
  let mergedText: string | null = null;
  let mergedTier: 'A' | 'B' | null = null;
  const aResult = tierAAnchorReapply(localContent, baselineContent, cloudNote.content);
  if (aResult) {
    mergedText = aResult.merged;
    mergedTier = 'A';
  } else {
    // Tier B — node-diff3 line-level 3-way merge
    const bResult = tierBDiff3(localContent, baselineContent, cloudNote.content);
    if (bResult.kind === 'merged') {
      mergedText = bResult.merged;
      mergedTier = 'B';
    } else {
      // Tier C — overlapping hunks; emit structured report
      result.conflicts.push(conflictEntry);
      const conflictText = formatConflictText(relativePath, bResult.regions);
      result.details.push({
        file: relativePath,
        action: 'conflict',
        reason: `${bResult.regions.length} unresolvable hunk(s)`,
      });
      // Stash the formatted text on the entry so the response footer can render it.
      (result.conflicts[result.conflicts.length - 1] as any).structuredText = conflictText;
      if (!dryRun) {
        try {
          await client.markConflict(cloudNote.id, {
            relativePath,
            reason: 'cloud-edited-online',
            baselineHash,
            baselineLastSyncedAt: baselineLastSyncedAt ?? null,
            cloudEditedOnlineAt: cloudNote.edited_online_at ?? null,
            regions: bResult.regions,
            base: baselineContent,
            local: localContent,
            cloud: cloudNote.content,
          });
        } catch (markErr) {
          console.warn(`Failed to mark conflict for ${relativePath}:`, markErr);
        }
      }
      return;
    }
  }

  // Tier A or Tier B produced merged text → push and write back
  if (mergedText !== null && mergedTier !== null) {
    if (dryRun) {
      result.details.push({
        file: relativePath,
        action: 'pushed_update',
        reason: `would auto-merge (tier ${mergedTier})`,
      });
      result.pushed.updated++;
      return;
    }
    const mergedHash = NoesisClient.computeHash(mergedText);
    const mergedFile: LocalFile = { ...localFile, content: mergedText, hash: mergedHash };
    try {
      // lastSyncedHash = the cloud hash we just merged against, NOT baselineHash.
      // The backend's 409 guard rejects when cloud changed AFTER we saw it; we saw cloud=cloudNote.hash
      // when computing the merge, so that's the version this push supersedes. Using baselineHash here
      // would always 409 because cloud.edited_online_at is set + cloud.hash !== baselineHash by definition.
      await client.upsertNote(mergedFile, {}, {
        force: true,
        regenerateMetadata: false,
        preserveMetadata: true,
        lastSyncedHash: cloudNote.hash,
      });
      fs.writeFileSync(localPath, mergedText, 'utf-8');
      stateMgr.setBaseline(
        relativePath,
        { hash: mergedHash, lastSyncedAt: new Date().toISOString() },
        mergedText
      );
      result.details.push({
        file: relativePath,
        action: 'pushed_update',
        reason: `auto-merged (tier ${mergedTier})`,
      });
      result.pushed.updated++;
    } catch (mergeErr) {
      const msg = mergeErr instanceof Error ? mergeErr.message : 'Unknown merge error';
      result.errors.push(`${relativePath}: merge push failed: ${msg}`);
      result.details.push({ file: relativePath, action: 'error', reason: msg });
    }
  }
}

/**
 * Merge local content with cloud content
 * Strategy: Cloud's H1 wins (Noesis edits), Local's body wins (local edits)
 */
function mergeContent(localContent: string, cloudContent: string): string {
  const localParsed = parseMarkdownStructure(localContent);
  const cloudParsed = parseMarkdownStructure(cloudContent);

  // Use cloud's H1 if it exists and differs from local, otherwise use local's H1
  const h1ToUse = cloudParsed.h1 || localParsed.h1;

  // Use local's body (user's local edits)
  const bodyToUse = localParsed.body;

  // Keep local's frontmatter (will be ignored by backend with preserveMetadata)
  return reconstructMarkdown(localParsed.frontmatter, h1ToUse, bodyToUse);
}
