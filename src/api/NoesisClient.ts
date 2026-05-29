/**
 * NoesisClient - HTTP client for Noesis API
 *
 * Replaces direct PostgreSQL access in MCP server.
 * All operations go through authenticated API calls.
 */

import crypto from 'crypto';
import os from 'os';
import path from 'path';

// ============================================================
// Cross-platform OS detection (phase32)
// ============================================================
// The MCP server runs on the user's local machine; process.platform is the
// source of truth for which path to surface to Claude Code. NOESIS_FAKE_PLATFORM
// is a test-only override that lets the same dist/ simulate the other OS.

export type OsKey = 'win32' | 'darwin' | 'linux';

const _envFakePlatform = process.env.NOESIS_FAKE_PLATFORM as OsKey | undefined;
const _realPlatform: OsKey = process.platform === 'darwin' ? 'darwin'
  : process.platform === 'win32' ? 'win32'
  : 'linux';
export const CLIENT_OS: OsKey = (_envFakePlatform === 'win32' || _envFakePlatform === 'darwin' || _envFakePlatform === 'linux')
  ? _envFakePlatform
  : _realPlatform;

/**
 * Expand a leading `~` or `%USERPROFILE%` (home-directory shortcut) against
 * this machine's home directory. Cloud-flow root paths are stored as
 * `~/Noesis/...` in the cloud DB because the cloud cannot know each machine's
 * $HOME -- the MCP server expands here at sync time. No-op for already-absolute
 * paths.
 *
 * `%USERPROFILE%` is accepted because the frontend renders Windows-row root
 * paths as `%USERPROFILE%\Noesis` for display (Windows shells don't expand `~`),
 * and that displayed form ends up on the clipboard via the note's "Copy file
 * path" button. Recognising it here keeps Copy → Paste → `sync_notes` working
 * end-to-end on Windows.
 *
 * Phase 34 introduced this expansion. Older MCP server versions stored
 * `cloud://` sentinels and never expanded; that path is gone.
 */
export function expandHome(p: string): string {
  if (!p) return '';
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  // Windows: `%USERPROFILE%` and `%USERPROFILE%\...` (case-insensitive variable name).
  const envHomeMatch = p.match(/^%USERPROFILE%([\\/].*)?$/i);
  if (envHomeMatch) {
    const tail = envHomeMatch[1];
    if (!tail) return os.homedir();
    return path.join(os.homedir(), tail.slice(1));
  }
  return p;
}

/**
 * Return the OS-active path from a root's local_paths map, or '' if
 * missing. Tilde-prefixed values are expanded against `os.homedir()` for
 * direct fs use. Callers that need an error on miss should use
 * requireActiveRootPath in tools/index.ts instead.
 */
export function getActivePathFromMap(localPaths: Record<string, string> | null | undefined): string {
  if (!localPaths) return '';
  return expandHome(localPaths[CLIENT_OS] || '');
}

// Types matching PostgresAdapter interface
export interface Codebase {
  id: number;
  path: string;
  label?: string;
  branch?: string;
  description?: string;
  repo_url?: string;
  is_archived?: boolean;
  created_at?: string;
  modified_at?: string;
}

export interface Note {
  id: number;
  title: string;
  // Synthesized server-side from joined root.local_paths + relative_path.
  // Prefer relative_path + root.local_paths when constructing a per-OS path.
  file_path: string;
  relative_path?: string;
  content?: string;
  description?: string;
  keywords?: string[];
  aliases?: string[];
  related_codes?: number[];
  related_codebases?: Codebase[];
  catalogs?: string[];
  points?: number;
  is_favorite?: boolean;
  modified_at?: string;
  root_id?: number;
  importance_score?: number;
  quality_score?: number;
  relations?: Array<{ type: string; target_id: number; context?: string }>;
  edited_online_at?: string | null;
  conflict_marker?: Record<string, unknown> | null;
}

export interface EditedOnlineNote {
  id: number;
  title: string | null;
  relative_path: string;
  hash: string;
  edited_online_at: string;
  root_id: number;
  // Phase32: backend now returns the full per-OS map. Convenience `root_path`
  // is populated by the client below (getEditedOnlineNotes) to the OS-active
  // value so existing call sites keep working.
  root_path: string;
  root_local_paths?: Record<string, string>;
}

export interface SearchResult {
  id: number;
  title: string;
  file_path: string;
  content?: string;
  description?: string;
  relevance_score?: number;
  relevance?: number;  // Computed as percentage
  excerpt?: string;
  modified_at?: string;
}

export interface SearchOptions {
  limit?: number;
  root?: string;
  catalog?: string;
}

export interface Catalog {
  id: number;
  name: string;
  color: string;
  icon?: string;
  description?: string;
  sort_order: number;
  is_builtin: boolean;
  note_count: number;
}

export interface Root {
  id: number;
  name: string;
  // Phase32: cross-platform path map. `path` is now derived for convenience
  // (CLIENT_OS-active value) — callers needing the per-OS map should read
  // `local_paths` directly.
  local_paths: Record<string, string>;
  path?: string;
  is_visible?: boolean;
  last_scanned_at?: string;
}

export interface LocalFile {
  path: string;
  relativePath: string;
  content: string;
  rootId: number;
  rootName?: string;
  project?: string;
  title?: string;
  hash?: string;
  mtime?: Date;
  size?: number;
}

export interface Navi {
  id: number;
  user_id: number | null;
  name: string;
  description: string | null;
  system_prompt: string;
  icon: string;
  icon_type: 'lucide' | 'custom';
  icon_url: string | null;
  color: string;
  is_template: boolean;
  is_active: boolean;
  use_knowledge_base: boolean;
  use_web_search?: boolean;
  use_conversation_history: boolean;
  animation_presets: string[];
  animation_triggers: string[];
  tts_provider: 'speechify' | 'webspeech' | 'minimax' | 'edgetts' | null;
  tts_voice_id: string | null;
  tts_rate: number | null;
  tts_pitch: number | null;
  tts_autoplay?: boolean;
  ai_provider: 'claude' | 'gemini' | null;
  ai_model: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChatSession {
  id: number;
  title: string | null;
  is_pinned: number;
  navi_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface ChatMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  navi_id: number | null;
  created_at: string;
}

export interface ChatSessionResult {
  session: ChatSession;
  navi: { id: number; name: string; description: string | null } | null;
  messages: ChatMessage[];
  hasMore: boolean;
}

export interface CreateNaviInput {
  name: string;
  system_prompt: string;
  description?: string | null;
  icon?: string;
  icon_type?: 'lucide' | 'custom';
  icon_url?: string | null;
  color?: string;
  use_knowledge_base?: boolean;
  use_web_search?: boolean;
  use_conversation_history?: boolean;
  animation_presets?: string[];
  animation_triggers?: string[];
  tts_provider?: 'speechify' | 'webspeech' | 'minimax' | 'edgetts' | null;
  tts_voice_id?: string | null;
  tts_rate?: number | null;
  tts_pitch?: number | null;
  tts_autoplay?: boolean;
  ai_provider?: 'claude' | 'gemini' | null;
  ai_model?: string | null;
}

export type UpdateNaviInput = Partial<CreateNaviInput> & { is_active?: boolean };

export interface SyncLogOptions {
  rootId: number;
  filesScanned: number;
  filesAdded: number;
  filesUpdated: number;
  filesDeleted: number;
  source: string;
  machineName?: string;
  notes?: string;
}

/**
 * HTTP client for Noesis API
 */
export class NoesisClient {
  private baseUrl: string;
  private apiToken: string;

  constructor(baseUrl: string, apiToken: string) {
    // Remove trailing slash
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiToken = apiToken;
  }

  /**
   * Make an authenticated HTTP request
   */
  private async request<T>(
    method: string,
    path: string,
    body?: any
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;

    const response = await fetch(url, {
      method,
      headers: {
        'Authorization': `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json',
        'X-Client-OS': CLIENT_OS,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({ error: 'Request failed' })) as { error?: string };
      throw new Error(errorBody.error || `HTTP ${response.status}: ${response.statusText}`);
    }

    return response.json() as Promise<T>;
  }

  // ============================================
  // ROOTS
  // ============================================

  async getRoots(): Promise<Root[]> {
    const result = await this.request<{ roots: Root[] }>('GET', '/api/mcp/roots');
    // Backfill `path` convenience field from local_paths[CLIENT_OS] for any
    // call site still reading r.path directly.
    return result.roots.map(r => ({ ...r, path: getActivePathFromMap(r.local_paths) }));
  }

  /**
   * Phase 50: Report this device's home directory so the web UI can resolve
   * stored `~/Noesis/...` paths to the user's actual absolute path
   * (e.g. `C:\Users\ccheng\Noesis\...`) for display + clipboard.
   *
   * Idempotent: re-sending the same value is a no-op on the server. Callers
   * should fire-and-forget at startup — failures don't block any tool call,
   * the next process will retry.
   */
  async reportDeviceHomeDir(): Promise<void> {
    await this.request<{ deviceHomeDirs: Record<string, string> }>(
      'PATCH',
      '/api/mcp/device-home',
      { osKey: CLIENT_OS, homeDir: os.homedir() }
    );
  }

  async getRootsForSync(): Promise<Array<{
    id: number;
    name: string;
    path: string;
    local_paths: Record<string, string>;
    lastScannedAt: string | null;
  }>> {
    const result = await this.request<{ roots: any[] }>('GET', '/api/mcp/roots?forSync=true');
    return result.roots.map(r => ({
      id: r.id,
      name: r.name,
      local_paths: r.local_paths || {},
      path: getActivePathFromMap(r.local_paths),
      lastScannedAt: r.last_scanned_at || null
    }));
  }

  /**
   * Create a new root.
   *
   * Accepts either:
   *  - `{ name, local_paths: { win32?, darwin?, linux? } }` (preferred; phase32+),
   *  - `{ name, path }` (legacy single-path — auto-routed into local_paths[CLIENT_OS]).
   */
  async createRoot(options: {
    name: string;
    type?: string;
    local_paths?: Record<string, string>;
    path?: string;
  }): Promise<Root> {
    let local_paths = options.local_paths;
    if (!local_paths && options.path) {
      local_paths = { [CLIENT_OS]: options.path };
    }
    const body: Record<string, unknown> = { name: options.name, local_paths };
    if (options.type) body.type = options.type;
    const result = await this.request<{ root: Root }>('POST', '/api/mcp/roots', body);
    return { ...result.root, path: getActivePathFromMap(result.root.local_paths) };
  }

  async getRootByPath(path: string): Promise<Root | undefined> {
    try {
      const result = await this.request<{ root: Root }>(
        'GET',
        `/api/mcp/roots/by-path?path=${encodeURIComponent(path)}`
      );
      return { ...result.root, path: getActivePathFromMap(result.root.local_paths) };
    } catch {
      return undefined;
    }
  }

  /**
   * Look up a note by (root_id, relative_path). Used by the MCP server's
   * cross-platform `get_note` resolver after it has prefix-matched the input
   * path against a root.
   */
  async getNoteByRelativePath(rootId: number, relativePath: string): Promise<Note | undefined> {
    try {
      const params = new URLSearchParams({ root_id: String(rootId), relative_path: relativePath });
      const result = await this.request<{ note: Note }>('GET', `/api/mcp/notes/by-relative?${params}`);
      return result.note;
    } catch {
      return undefined;
    }
  }

  async getNoteHashesByRoot(rootId: number): Promise<Map<string, string>> {
    const result = await this.request<{ hashes: Record<string, string> }>(
      'GET',
      `/api/mcp/roots/${rootId}/hashes`
    );
    return new Map(Object.entries(result.hashes));
  }

  /**
   * Get notes with hash, modified_at, content, and metadata for bidirectional sync comparison
   */
  async getNotesForSync(rootId: number): Promise<Array<{
    id: number;
    relative_path: string;
    hash: string;
    modified_at: string;
    content: string;
    title: string | null;
    description: string | null;
    keywords: string | null;
    edited_online_at: string | null;
  }>> {
    const result = await this.request<{ notes: Array<{
      id: number;
      relative_path: string;
      hash: string;
      modified_at: string;
      content: string;
      title: string | null;
      description: string | null;
      keywords: string | null;
      edited_online_at: string | null;
    }> }>(
      'GET',
      `/api/mcp/roots/${rootId}/notes-for-sync`
    );
    return result.notes;
  }

  /**
   * Mark a cloud note as having an unresolved sync conflict.
   * The structured BASE/LOCAL/CLOUD payload is stored in notes.conflict_marker (JSONB).
   * Web UI surfaces a yellow banner when this is set.
   */
  async markConflict(noteId: number, payload: object): Promise<void> {
    await this.request('POST', `/api/mcp/notes/${noteId}/mark-conflict`, payload);
  }

  /** Clear the conflict marker after a successful merge + push. */
  async clearConflict(noteId: number): Promise<void> {
    await this.request('POST', `/api/mcp/notes/${noteId}/clear-conflict`, {});
  }

  /**
   * List notes with edited_online_at set — pending local sync from web UI edits.
   * Optionally filter to a specific root by ID.
   */
  async getEditedOnlineNotes(rootId?: number): Promise<EditedOnlineNote[]> {
    const params = rootId !== undefined ? `?root_id=${rootId}` : '';
    const result = await this.request<{ notes: any[] }>(
      'GET',
      `/api/mcp/edited-online-notes${params}`
    );
    // Phase32: backend returns root_local_paths (JSONB map). Compute the
    // OS-active root_path convenience field for back-compat with the existing
    // tool surface.
    return result.notes.map((n): EditedOnlineNote => ({
      id: n.id,
      title: n.title,
      relative_path: n.relative_path,
      hash: n.hash,
      edited_online_at: n.edited_online_at,
      root_id: n.root_id,
      root_local_paths: n.root_local_paths || {},
      root_path: getActivePathFromMap(n.root_local_paths),
    }));
  }

  // ============================================
  // CATALOGS
  // ============================================

  async listCatalogs(): Promise<Catalog[]> {
    const result = await this.request<{ catalogs: Catalog[] }>('GET', '/api/mcp/catalogs');
    return result.catalogs;
  }

  async setNoteCatalogs(noteId: number, catalogs: string[]): Promise<void> {
    await this.request('PUT', `/api/mcp/notes/${noteId}/catalogs`, { catalogs });
  }

  async setNoteRelatedCodes(noteId: number, codes: number[] | string[]): Promise<void> {
    // Numeric ids hit the primary `codebase_ids` channel; raw path strings fall through
    // the backend's find-or-create shim. Mixed input rides the same `related_codes` key
    // and the server resolves per-element.
    const allNumeric = codes.every(c => typeof c === 'number');
    const body = allNumeric ? { codebase_ids: codes } : { related_codes: codes };
    await this.request('PUT', `/api/mcp/notes/${noteId}/related-codes`, body);
  }

  // ============================================
  // CODEBASES (managed registry)
  // ============================================

  async listCodebases(includeArchived: boolean = false): Promise<Codebase[]> {
    const params = new URLSearchParams();
    if (includeArchived) params.set('archived', 'true');
    const qs = params.toString();
    const result = await this.request<{ codebases: Codebase[] }>(
      'GET',
      `/api/mcp/codebases${qs ? `?${qs}` : ''}`,
    );
    return result.codebases;
  }

  async getCodebase(id: number): Promise<Codebase> {
    return this.request<Codebase>('GET', `/api/mcp/codebases/${id}`);
  }

  async getCodebaseUsage(id: number): Promise<{ note_count: number; notes: Array<{ id: number; title: string }> }> {
    return this.request('GET', `/api/mcp/codebases/${id}/usage`);
  }

  async createCodebase(input: {
    path: string;
    label?: string;
    branch?: string;
    description?: string;
    repo_url?: string;
  }): Promise<Codebase> {
    return this.request<Codebase>('POST', `/api/mcp/codebases`, input);
  }

  async findOrCreateCodebase(input: { path: string; label?: string }): Promise<Codebase> {
    return this.request<Codebase>('POST', `/api/mcp/codebases/find-or-create`, input);
  }

  async updateCodebase(id: number, patch: {
    path?: string;
    label?: string | null;
    branch?: string | null;
    description?: string | null;
    repo_url?: string | null;
    is_archived?: boolean;
  }): Promise<Codebase> {
    return this.request<Codebase>('PATCH', `/api/mcp/codebases/${id}`, patch);
  }

  async deleteCodebase(id: number): Promise<{ success: boolean; unlinked_from_note_count: number }> {
    return this.request('DELETE', `/api/mcp/codebases/${id}`);
  }

  async updateRootScanTime(rootId: number): Promise<void> {
    await this.request('PUT', `/api/mcp/roots/${rootId}/scan-time`, {});
  }

  // ============================================
  // NOTES - SEARCH & READ
  // ============================================

  async searchNotes(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const { limit = 10, root, catalog } = options;
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    if (root) params.append('root', root);
    if (catalog) params.append('catalog', catalog);

    const result = await this.request<{ notes: any[] }>(
      'GET',
      `/api/mcp/notes/search?${params}`
    );

    // Transform results to include relevance percentage and excerpt
    return result.notes.map(note => {
      // Convert relevance_score to percentage (BM25 scores vary, normalize to 0-100)
      const relevanceScore = note.relevance_score || 0;
      const relevance = Math.min(Math.round(relevanceScore * 100), 100);

      // Generate excerpt from content
      let excerpt = note.description || '';
      if (!excerpt && note.content) {
        excerpt = note.content.substring(0, 200).replace(/\n/g, ' ').trim();
        if (note.content.length > 200) excerpt += '...';
      }

      return {
        ...note,
        relevance,
        excerpt
      };
    });
  }

  async getNote(id: number): Promise<Note | undefined> {
    try {
      const result = await this.request<{ note: Note }>('GET', `/api/mcp/notes/${id}`);
      return result.note;
    } catch {
      return undefined;
    }
  }

  async getBookmarkContext(
    noteId: number,
    bookmarkId: string,
    contextParagraphs = 2
  ): Promise<{
    bookmark: any;
    note_title: string;
    context_before: string;
    context_anchor: string;
    context_after: string;
  } | undefined> {
    try {
      const params = new URLSearchParams({ paragraphs: String(contextParagraphs) });
      return await this.request(
        'GET',
        `/api/mcp/notes/${noteId}/bookmarks/${bookmarkId}/context?${params}`
      );
    } catch {
      return undefined;
    }
  }

  async getChatSession(
    id: number,
    opts: { limit?: number } = {}
  ): Promise<ChatSessionResult | undefined> {
    try {
      const params = new URLSearchParams();
      if (opts.limit != null) params.set('limit', String(opts.limit));
      const qs = params.toString();
      return await this.request<ChatSessionResult>(
        'GET',
        `/api/mcp/chat/sessions/${id}${qs ? `?${qs}` : ''}`
      );
    } catch {
      return undefined;
    }
  }

  async getNoteByPath(filePath: string): Promise<Note | undefined> {
    try {
      const result = await this.request<{ note: Note }>(
        'GET',
        `/api/mcp/notes/by-path?path=${encodeURIComponent(filePath)}`
      );
      return result.note;
    } catch {
      return undefined;
    }
  }

  async searchByRelatedCode(path: string, limit: number = 20): Promise<any[]> {
    const params = new URLSearchParams({
      path,
      limit: String(limit)
    });
    const result = await this.request<{ notes: any[] }>(
      'GET',
      `/api/mcp/notes/by-related-code?${params}`
    );
    return result.notes;
  }

  async getRelationGraph(noteId: number, depth: number = 2): Promise<any[]> {
    const params = new URLSearchParams({
      id: String(noteId),
      depth: String(depth)
    });
    const result = await this.request<{ notes: any[] }>(
      'GET',
      `/api/mcp/notes/relation-graph?${params}`
    );
    return result.notes;
  }

  async listNotes(options: { limit?: number; offset?: number; root?: string; catalog?: string } = {}): Promise<Note[]> {
    const params = new URLSearchParams();
    if (options.limit) params.append('limit', String(options.limit));
    if (options.offset) params.append('offset', String(options.offset));
    if (options.root) params.append('root', options.root);
    if (options.catalog) params.append('catalog', options.catalog);

    const result = await this.request<{ notes: Note[] }>('GET', `/api/mcp/notes?${params}`);
    return result.notes;
  }

  async getRecentNotes(days: number = 7, limit: number = 20): Promise<Note[]> {
    const params = new URLSearchParams({
      recent: String(days),
      limit: String(limit)
    });

    const result = await this.request<{ notes: Note[] }>('GET', `/api/mcp/notes?${params}`);
    return result.notes;
  }

  /**
   * Get notes for pulling to local files
   */
  async getNotesForPull(options: { root?: string } = {}): Promise<Array<{
    id: number;
    title: string;
    content: string;
    relative_path: string;
    root_name: string;
  }>> {
    const params = new URLSearchParams();
    if (options.root) params.append('root', options.root);
    params.append('for_pull', 'true');

    const result = await this.request<{ notes: any[] }>(
      'GET',
      `/api/mcp/notes?${params}`
    );
    return result.notes;
  }

  /**
   * Get note count by root for sync status
   */
  async getNoteCountByRoot(): Promise<Map<number, number>> {
    const result = await this.request<{ counts: Record<string, number> }>(
      'GET',
      '/api/mcp/notes/count-by-root'
    );
    return new Map(Object.entries(result.counts).map(([k, v]) => [parseInt(k), v]));
  }

  // ============================================
  // NOTES - WRITE (SYNC)
  // ============================================

  async upsertNote(
    file: LocalFile,
    metadata: { title?: string; description?: string; keywords?: string[] } = {},
    options: { force?: boolean; regenerateMetadata?: boolean; preserveMetadata?: boolean; lastSyncedHash?: string } = {}
  ): Promise<{ action: 'created' | 'updated' | 'skipped'; aiMetadataGenerated?: boolean }> {
    const { force = false, regenerateMetadata = false, preserveMetadata = false, lastSyncedHash } = options;
    const body: Record<string, unknown> = { file, metadata, force, regenerateMetadata, preserveMetadata };
    if (lastSyncedHash !== undefined) body.lastSyncedHash = lastSyncedHash;
    const result = await this.request<{ action: 'created' | 'updated' | 'skipped'; aiMetadataGenerated?: boolean }>(
      'POST',
      '/api/mcp/notes/upsert',
      body
    );
    return result;
  }

  async logSyncOperation(options: SyncLogOptions): Promise<void> {
    await this.request('POST', '/api/mcp/sync/log', options);
  }

  // ============================================
  // METADATA ENHANCEMENT
  // ============================================

  async getNoteForEnhancement(id: number): Promise<{
    id: number;
    title: string;
    description: string | null;
    keywords: string[];
    aliases: string[];
    content: string;
    file_path: string;
    root_name: string;
    ai_enhanced_at: string | null;
    related_codes?: number[];
    related_codebases?: Codebase[];
  } | undefined> {
    try {
      const result = await this.request<{ note: any }>('GET', `/api/mcp/notes/${id}/for-enhancement`);
      return result.note;
    } catch {
      return undefined;
    }
  }

  async updateNoteMetadata(
    id: number,
    metadata: {
      title?: string;
      description?: string;
      keywords?: string[];
      aliases?: string[];
    }
  ): Promise<boolean> {
    try {
      await this.request('PUT', `/api/mcp/notes/${id}/metadata`, metadata);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Update file metadata (file_size, hash) after pulling from cloud.
   * Phase32: prefer (root_id, relative_path); falls back to legacy file_path
   * if the caller hasn't been updated.
   */
  async updateFileMetadata(
    filePathOrIds: string | { rootId: number; relativePath: string },
    fileSize: number,
    hash: string
  ): Promise<boolean> {
    try {
      const body: Record<string, unknown> = { file_size: fileSize, hash };
      if (typeof filePathOrIds === 'string') {
        body.file_path = filePathOrIds;
      } else {
        body.root_id = filePathOrIds.rootId;
        body.relative_path = filePathOrIds.relativePath;
      }
      await this.request('PUT', '/api/mcp/notes/file-metadata', body);
      return true;
    } catch {
      return false;
    }
  }

  async getNotesNeedingEnhancement(options: {
    limit?: number;
    importantOnly?: boolean;
    root?: string;
    catalog?: string;
  } = {}): Promise<any[]> {
    const params = new URLSearchParams();
    if (options.limit) params.append('limit', String(options.limit));
    if (options.importantOnly) params.append('important_only', 'true');
    if (options.root) params.append('root', options.root);
    if (options.catalog) params.append('catalog', options.catalog);

    const result = await this.request<{ notes: any[] }>(
      'GET',
      `/api/mcp/notes/needing-enhancement?${params}`
    );
    return result.notes;
  }

  // ============================================
  // SCORES & RELATIONS
  // ============================================

  async updateImportanceScore(id: number, score: number): Promise<boolean> {
    try {
      await this.request('PUT', `/api/mcp/notes/${id}/importance`, { score });
      return true;
    } catch {
      return false;
    }
  }

  async updateQualityScore(id: number, score: number): Promise<boolean> {
    try {
      await this.request('PUT', `/api/mcp/notes/${id}/quality`, { score });
      return true;
    } catch {
      return false;
    }
  }

  async updateRelations(
    id: number,
    relations: Array<{ type: string; target_id: number; context?: string }>
  ): Promise<{ updated: number; inversesCreated: number }> {
    const result = await this.request<{ success: boolean; updated: number }>(
      'PUT',
      `/api/mcp/notes/${id}/relations`,
      { relations }
    );
    return { updated: result.updated || relations.length, inversesCreated: 0 };
  }

  async moveNote(
    id: number,
    newPath: string,
    options: { newRelativePath?: string; newRootName?: string } = {}
  ): Promise<{ id: number; file_path: string; root_name: string; relative_path: string } | null> {
    try {
      const result = await this.request<{ note: { id: number; file_path: string; root_name: string; relative_path: string } }>(
        'PUT',
        `/api/mcp/notes/${id}/move`,
        {
          new_path: newPath,
          new_relative_path: options.newRelativePath,
          new_root_name: options.newRootName,
        }
      );
      return result.note;
    } catch {
      return null;
    }
  }

  async updateNoteSignals(
    id: number,
    signals: { is_favorite?: boolean; points?: number }
  ): Promise<boolean> {
    try {
      await this.request('PUT', `/api/mcp/notes/${id}/signals`, signals);
      return true;
    } catch {
      return false;
    }
  }

  async trashNote(id: number): Promise<boolean> {
    try {
      await this.request('PUT', `/api/mcp/notes/${id}/trash`, {});
      return true;
    } catch {
      return false;
    }
  }

  async getNoteForScoring(id: number): Promise<any | undefined> {
    // Same as getNoteForEnhancement for now
    return this.getNoteForEnhancement(id);
  }

  async getNotesForRelationAnalysis(
    excludeId: number,
    options: { limit?: number; root?: string } = {}
  ): Promise<any[]> {
    const params = new URLSearchParams({ limit: String(options.limit || 50) });
    if (options.root) params.append('root', options.root);

    const result = await this.request<{ notes: any[] }>('GET', `/api/mcp/notes?${params}`);
    return result.notes.filter(n => n.id !== excludeId);
  }

  // ============================================
  // EMBEDDINGS
  // ============================================

  async getNotesWithoutEmbeddings(options: { limit?: number; root?: string } = {}): Promise<any[]> {
    const params = new URLSearchParams();
    if (options.limit) params.append('limit', String(options.limit));
    if (options.root) params.append('root', options.root);

    const result = await this.request<{ notes: any[] }>(
      'GET',
      `/api/mcp/notes/without-embeddings?${params}`
    );
    return result.notes;
  }

  async updateNoteEmbedding(id: number, embedding: number[]): Promise<boolean> {
    try {
      await this.request('PUT', `/api/mcp/notes/${id}/embedding`, { embedding });
      return true;
    } catch {
      return false;
    }
  }

  async searchByEmbedding(
    embedding: number[],
    options: { limit?: number; root?: string; minSimilarity?: number } = {}
  ): Promise<any[]> {
    const result = await this.request<{ notes: any[] }>(
      'POST',
      '/api/mcp/notes/search-semantic',
      { embedding, ...options }
    );
    return result.notes;
  }

  async findSimilarNotes(
    noteId: number,
    options: { limit?: number } = {}
  ): Promise<any[]> {
    const params = new URLSearchParams();
    if (options.limit) params.append('limit', String(options.limit));

    const result = await this.request<{ notes: any[] }>(
      'GET',
      `/api/mcp/notes/${noteId}/similar?${params}`
    );
    return result.notes;
  }

  async getNoteEmbedding(id: number): Promise<{ id: number; embedding: number[] } | undefined> {
    // Get note and extract embedding if present
    const note = await this.getNote(id);
    if (!note) return undefined;
    // Embedding is not returned in standard note response for size reasons
    return undefined;
  }

  async getEmbeddingStats(): Promise<{
    total: number;
    withEmbeddings: number;
    withoutEmbeddings: number;
  }> {
    const result = await this.request<{
      total: number;
      withEmbeddings: number;
      withoutEmbeddings: number;
    }>('GET', '/api/mcp/stats/embeddings');
    return result;
  }

  // ============================================
  // STATUS & SETTINGS
  // ============================================

  async getLastSyncTime(): Promise<string | null> {
    const result = await this.request<{ lastSyncTime: string | null }>('GET', '/api/mcp/status');
    return result.lastSyncTime;
  }

  async setLastSyncTime(timestamp: string): Promise<void> {
    // This is typically handled by logSyncOperation
    // Not directly exposed via API for now
  }

  async getKnowledgeBaseStats(options: { limit?: number; root?: string } = {}): Promise<any> {
    const params = new URLSearchParams();
    if (options.limit) params.append('limit', String(options.limit));
    if (options.root) params.append('root', options.root);

    return this.request('GET', `/api/mcp/analyze?${params}`);
  }

  async getSyncLogs(rootId?: number, limit: number = 10): Promise<any[]> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (rootId) params.append('root_id', String(rootId));

    // Note: This endpoint is on the main API, not /api/mcp
    const result = await this.request<{ logs: any[] }>(
      'GET',
      `/api/sync-logs?${params}`
    );
    return result.logs;
  }

  // ============================================
  // UTILITIES
  // ============================================

  /**
   * Normalize line endings to LF for cross-platform consistency
   * Matches backend behavior in src/backend/routes/mcp.ts
   */
  static normalizeLineEndings(content: string): string {
    return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  }

  // ─── Daily News Methods ───

  async getNewsPreferences(): Promise<any> {
    const [settings, sources, seeds] = await Promise.all([
      this.request<any>('GET', '/api/news/settings'),
      this.request<any>('GET', '/api/news/sources'),
      this.request<any>('GET', '/api/news/seeds'),
    ]);
    return {
      settings: settings.settings,
      sources: sources.sources,
      seeds: seeds.seeds,
    };
  }

  async updateNewsPreferences(data: {
    settings?: { preferred_language?: string; daily_article_limit?: number };
    preferences?: any;
  }): Promise<void> {
    if (data.settings) {
      await this.request('PATCH', '/api/news/settings', data.settings);
    }
    if (data.preferences) {
      await this.request('POST', '/api/news/preferences/import', { preferences: data.preferences });
    }
  }

  async addNewsSource(data: {
    name: string;
    url: string;
    domain?: string;
    topic?: string;
    language?: string;
    source_type?: string;
  }): Promise<any> {
    return this.request('POST', '/api/news/sources', data);
  }

  /**
   * Compute SHA-256 hash of content (for sync comparison)
   * Static method - can be used without API call
   * Note: Normalizes line endings to match backend hash computation
   */
  static computeHash(content: string): string {
    return crypto.createHash('sha256').update(NoesisClient.normalizeLineEndings(content), 'utf8').digest('hex');
  }

  // ============================================
  // NAVIS
  // ============================================

  async listNavis(): Promise<{ navis: Navi[]; templates: Navi[]; default_navi_id: number | null }> {
    return this.request<{ navis: Navi[]; templates: Navi[]; default_navi_id: number | null }>(
      'GET',
      '/api/navis'
    );
  }

  async getNavi(id: number): Promise<Navi> {
    const result = await this.request<{ navi: Navi }>('GET', `/api/navis/${id}`);
    return result.navi;
  }

  async createNavi(body: CreateNaviInput): Promise<Navi> {
    const result = await this.request<{ navi: Navi }>('POST', '/api/navis', body);
    return result.navi;
  }

  async updateNavi(id: number, body: UpdateNaviInput): Promise<Navi> {
    const result = await this.request<{ navi: Navi }>('PUT', `/api/navis/${id}`, body);
    return result.navi;
  }

  async deleteNavi(id: number): Promise<void> {
    await this.request<{ success: boolean }>('DELETE', `/api/navis/${id}`);
  }

  async duplicateNavi(id: number, name?: string): Promise<Navi> {
    const result = await this.request<{ navi: Navi }>(
      'POST',
      `/api/navis/${id}/duplicate`,
      name ? { name } : {}
    );
    return result.navi;
  }

  /**
   * Close the client (no-op for HTTP client)
   */
  async close(): Promise<void> {
    // No-op - HTTP client doesn't need cleanup
  }
}
