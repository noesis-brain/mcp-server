/**
 * PostgreSQL adapter for md-manager MCP server
 * Connects to Neon PostgreSQL database
 */

import { Pool } from 'pg';
import * as crypto from 'crypto';
import type { Note, SearchResult, SearchOptions, LocalFile } from '../types/index.js';

export class PostgresAdapter {
  private pool: Pool;
  private userId: number | null;

  constructor(connectionString: string, userId?: number) {
    this.pool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false }
    });
    this.userId = userId ?? null;
  }

  /**
   * Build user_id filter condition for queries
   * Returns { condition, params, nextParamIndex } for adding to WHERE clauses
   */
  private buildUserFilter(startParamIndex: number = 1): {
    condition: string;
    params: any[];
    nextParamIndex: number
  } {
    if (this.userId) {
      return {
        condition: `user_id = $${startParamIndex}`,
        params: [this.userId],
        nextParamIndex: startParamIndex + 1
      };
    }
    return {
      condition: 'TRUE', // No filter when userId not set
      params: [],
      nextParamIndex: startParamIndex
    };
  }

  /**
   * Search notes using PostgreSQL full-text search (tsvector)
   */
  async searchNotes(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const { limit = 10, root } = options;

    try {
      const searchTerms = this.extractSearchTerms(query);

      if (!searchTerms) {
        return [];
      }

      // Use PostgreSQL full-text search with ts_rank
      const userFilter = this.buildUserFilter(1);
      let sql = `
        SELECT
          n.id,
          n.title,
          n.content,
          n.file_path,
          n.description,
          n.points,
          n.is_favorite,
          n.modified_at,
          ts_rank(n.fts_vector, plainto_tsquery('english', $${userFilter.nextParamIndex})) as relevance_score
        FROM notes n
        WHERE n.fts_vector @@ plainto_tsquery('english', $${userFilter.nextParamIndex})
          AND COALESCE(n.is_trashed, FALSE) = FALSE
          AND ${userFilter.condition}
      `;

      const params: any[] = [...userFilter.params, searchTerms];
      let paramIndex = userFilter.nextParamIndex + 1;

      if (root) {
        sql += ` AND n.file_path LIKE $${paramIndex}`;
        params.push(`%${root}%`);
        paramIndex++;
      }

      sql += ` ORDER BY relevance_score DESC, (COALESCE(n.points, 0) + CASE WHEN n.is_favorite THEN 50 ELSE 0 END) DESC LIMIT $${paramIndex}`;
      params.push(limit);

      const result = await this.pool.query(sql, params);

      return result.rows.map(row => ({
        id: row.id,
        title: row.title || 'Untitled',
        file_path: row.file_path,
        content: row.content || '',
        excerpt: this.generateExcerpt(row.content || '', query),
        relevance: this.normalizeRelevance(row.relevance_score),
        modified_at: row.modified_at
      }));
    } catch (error) {
      console.error('FTS search error:', error);
      return this.fallbackSearch(query, options);
    }
  }

  /**
   * Fallback to ILIKE search if FTS fails
   */
  private async fallbackSearch(query: string, options: SearchOptions): Promise<SearchResult[]> {
    const { limit = 10, root } = options;
    const likePattern = `%${query}%`;
    const userFilter = this.buildUserFilter(1);

    let sql = `
      SELECT
        id,
        title,
        content,
        file_path,
        description,
        points,
        is_favorite,
        modified_at
      FROM notes
      WHERE (title ILIKE $${userFilter.nextParamIndex} OR description ILIKE $${userFilter.nextParamIndex} OR content ILIKE $${userFilter.nextParamIndex})
        AND COALESCE(is_trashed, FALSE) = FALSE
        AND ${userFilter.condition}
    `;

    const params: any[] = [...userFilter.params, likePattern];
    let paramIndex = userFilter.nextParamIndex + 1;

    if (root) {
      sql += ` AND file_path LIKE $${paramIndex}`;
      params.push(`%${root}%`);
      paramIndex++;
    }

    sql += ` ORDER BY (CASE WHEN is_favorite THEN 1000 ELSE 0 END + COALESCE(points, 0)) DESC, modified_at DESC LIMIT $${paramIndex}`;
    params.push(limit);

    const result = await this.pool.query(sql, params);

    return result.rows.map(row => ({
      id: row.id,
      title: row.title || 'Untitled',
      file_path: row.file_path,
      content: row.content || '',
      excerpt: this.generateExcerpt(row.content || '', query),
      relevance: 50,
      modified_at: row.modified_at
    }));
  }

  /**
   * Get a note by ID
   */
  async getNote(id: number): Promise<Note | undefined> {
    const userFilter = this.buildUserFilter(2);
    const result = await this.pool.query(
      `SELECT * FROM notes WHERE id = $1 AND ${userFilter.condition}`,
      [id, ...userFilter.params]
    );
    return result.rows[0];
  }

  /**
   * Get a note by file path
   */
  async getNoteByPath(filePath: string): Promise<Note | undefined> {
    const userFilter = this.buildUserFilter(2);
    const result = await this.pool.query(
      `SELECT * FROM notes WHERE file_path = $1 AND ${userFilter.condition}`,
      [filePath, ...userFilter.params]
    );
    return result.rows[0];
  }

  /**
   * List all notes
   */
  async listNotes(options: { limit?: number; offset?: number; root?: string } = {}): Promise<Note[]> {
    const { limit = 50, offset = 0, root } = options;
    const userFilter = this.buildUserFilter(1);

    let sql = `
      SELECT * FROM notes
      WHERE COALESCE(is_trashed, FALSE) = FALSE
        AND ${userFilter.condition}
    `;

    const params: any[] = [...userFilter.params];
    let paramIndex = userFilter.nextParamIndex;

    if (root) {
      sql += ` AND file_path LIKE $${paramIndex}`;
      params.push(`%${root}%`);
      paramIndex++;
    }

    sql += ` ORDER BY modified_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(limit, offset);

    const result = await this.pool.query(sql, params);
    return result.rows;
  }

  /**
   * Get recent notes
   */
  async getRecentNotes(days: number = 7, limit: number = 20): Promise<Note[]> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);
    const userFilter = this.buildUserFilter(3);

    const result = await this.pool.query(`
      SELECT * FROM notes
      WHERE modified_at >= $1
        AND COALESCE(is_trashed, FALSE) = FALSE
        AND ${userFilter.condition}
      ORDER BY modified_at DESC
      LIMIT $2
    `, [cutoffDate.toISOString(), limit, ...userFilter.params]);

    return result.rows;
  }

  /**
   * Get all roots (watched directories)
   */
  async getRoots(): Promise<Array<{ id: number; path: string; name: string; is_visible: boolean }>> {
    const userFilter = this.buildUserFilter(1);
    const result = await this.pool.query(`
      SELECT id, path, name, COALESCE(is_visible, TRUE) as is_visible
      FROM roots
      WHERE COALESCE(is_visible, TRUE) = TRUE
        AND ${userFilter.condition}
    `, userFilter.params);
    return result.rows;
  }

  /**
   * Expand CamelCase terms to include space-separated versions.
   * E.g., "PrintController" becomes "PrintController Print Controller"
   * This improves search recall for technical component names.
   */
  private expandCamelCase(searchQuery: string): string {
    // Find CamelCase words (e.g., PrintController, BtXmlExecutor)
    const camelCasePattern = /\b([A-Z][a-z]+(?:[A-Z][a-z]*)+)\b/g;
    const expandedTerms: string[] = [];

    let match;
    while ((match = camelCasePattern.exec(searchQuery)) !== null) {
      const original = match[1];
      // Split CamelCase: "PrintController" -> "Print Controller"
      const spaced = original.replace(/([a-z])([A-Z])/g, '$1 $2');
      if (spaced !== original) {
        expandedTerms.push(spaced);
      }
    }

    // Return original query plus any expanded terms
    return expandedTerms.length > 0 ? `${searchQuery} ${expandedTerms.join(' ')}` : searchQuery;
  }

  /**
   * Extract search terms from natural language query
   */
  private extractSearchTerms(query: string): string {
    // First expand CamelCase terms for better recall
    const expandedQuery = this.expandCamelCase(query);

    const stopWords = new Set([
      'what', 'is', 'are', 'the', 'a', 'an', 'how', 'can', 'do', 'does', 'tell', 'me',
      'about', 'show', 'find', 'search', 'look', 'for', 'in', 'on', 'at', 'to', 'from',
      'you', 'know', 'your', 'my', 'i', 'we', 'they', 'it', 'this', 'that', 'with',
      'and', 'or', 'but', 'not', 'have', 'has', 'had', 'be', 'been', 'being',
      'would', 'could', 'should', 'will', 'shall', 'may', 'might', 'must',
      'there', 'here', 'where', 'when', 'why', 'which', 'who', 'whom'
    ]);

    const cleanedQuery = expandedQuery
      .replace(/-/g, ' ')
      .replace(/['']s?\b/g, '')
      .replace(/[?!.,;:()\[\]{}"]/g, ' ');

    const words = cleanedQuery.toLowerCase()
      .split(/\s+/)
      .filter(word => word.length > 2 && !stopWords.has(word));

    if (words.length === 0) {
      return '';
    }

    // Join with spaces for plainto_tsquery
    return words.join(' ');
  }

  /**
   * Generate an excerpt from content highlighting the search terms
   */
  private generateExcerpt(content: string, query: string, maxLength: number = 200): string {
    if (!content) return '';

    const lowerContent = content.toLowerCase();
    const searchTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);

    let startIndex = 0;
    for (const term of searchTerms) {
      const index = lowerContent.indexOf(term);
      if (index !== -1) {
        startIndex = Math.max(0, index - 50);
        break;
      }
    }

    let excerpt = content.substring(startIndex, startIndex + maxLength);

    if (startIndex > 0) {
      excerpt = '...' + excerpt.substring(excerpt.indexOf(' ') + 1);
    }
    if (startIndex + maxLength < content.length) {
      excerpt = excerpt.substring(0, excerpt.lastIndexOf(' ')) + '...';
    }

    return excerpt.replace(/\n+/g, ' ').trim();
  }

  /**
   * Normalize ts_rank relevance score to 0-100 percentage
   */
  private normalizeRelevance(score: number): number {
    // ts_rank returns values between 0 and 1 typically
    const normalized = Math.min(100, Math.max(0, score * 100));
    return Math.round(normalized);
  }

  /**
   * Get notes for pulling to local machine
   * Returns notes with relative_path for reconstruction on another machine
   */
  async getNotesForPull(options: { root?: string; rootId?: number } = {}): Promise<Array<{
    id: number;
    relative_path: string;
    content: string;
    title: string;
    root_name: string;
    root_path: string;
    modified_at: string;
  }>> {
    const { root, rootId } = options;

    let sql = `
      SELECT
        n.id,
        n.relative_path,
        n.content,
        n.title,
        r.name as root_name,
        r.path as root_path,
        n.modified_at
      FROM notes n
      JOIN roots r ON n.root_id = r.id
      WHERE COALESCE(n.is_trashed, FALSE) = FALSE
        AND n.relative_path IS NOT NULL
    `;

    const params: any[] = [];
    let paramIndex = 1;

    if (rootId) {
      sql += ` AND n.root_id = $${paramIndex}`;
      params.push(rootId);
      paramIndex++;
    } else if (root) {
      sql += ` AND r.name ILIKE $${paramIndex}`;
      params.push(`%${root}%`);
      paramIndex++;
    }

    sql += ` ORDER BY r.name, n.relative_path`;

    const result = await this.pool.query(sql, params);
    return result.rows;
  }

  /**
   * Get a root by name
   */
  async getRootByName(name: string): Promise<{ id: number; path: string; name: string } | undefined> {
    const userFilter = this.buildUserFilter(2);
    const result = await this.pool.query(
      `SELECT id, path, name FROM roots WHERE name ILIKE $1 AND ${userFilter.condition}`,
      [`%${name}%`, ...userFilter.params]
    );
    return result.rows[0];
  }

  /**
   * Upsert a note (insert or update based on file_path + root_id)
   * Returns 'created' | 'updated' | 'skipped'
   */
  async upsertNote(file: LocalFile, metadata: {
    title?: string;
    description?: string;
    keywords?: string[];
  }): Promise<'created' | 'updated' | 'skipped'> {
    // Check if note exists by relative_path OR file_path (fallback for notes with NULL relative_path)
    const userFilter = this.buildUserFilter(4);
    const existing = await this.pool.query(
      `SELECT id, hash FROM notes WHERE root_id = $1 AND (relative_path = $2 OR file_path = $3) AND ${userFilter.condition}`,
      [file.rootId, file.relativePath, file.path, ...userFilter.params]
    );

    if (existing.rows.length > 0) {
      const currentHash = existing.rows[0].hash;

      // Skip if hash matches (no changes)
      if (currentHash === file.hash) {
        return 'skipped';
      }

      // Update existing note (also sets relative_path and project in case they were NULL)
      await this.pool.query(`
        UPDATE notes SET
          content = $1,
          hash = $2,
          title = $3,
          description = $4,
          keywords = $5::jsonb,
          file_path = $6,
          relative_path = $7,
          file_size = $8,
          project = $9,
          modified_at = NOW(),
          indexed_at = NOW()
        WHERE id = $10
      `, [
        file.content,
        file.hash,
        metadata.title || this.extractTitleFromContent(file.content, file.relativePath),
        metadata.description || null,
        JSON.stringify(metadata.keywords || []),
        file.path,
        file.relativePath,
        file.size,
        file.project || null,
        existing.rows[0].id
      ]);

      return 'updated';
    }

    // Insert new note (include user_id and project if configured)
    await this.pool.query(`
      INSERT INTO notes (
        root_id, file_path, relative_path, content, hash,
        title, description, keywords, file_size, project, modified_at, indexed_at, user_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, NOW(), NOW(), $11)
    `, [
      file.rootId,
      file.path,
      file.relativePath,
      file.content,
      file.hash,
      metadata.title || this.extractTitleFromContent(file.content, file.relativePath),
      metadata.description || null,
      JSON.stringify(metadata.keywords || []),
      file.size,
      file.project || null,
      this.userId
    ]);

    return 'created';
  }

  /**
   * Get all roots with their paths and last scanned times
   */
  async getRootsForSync(): Promise<Array<{
    id: number;
    name: string;
    path: string;
    lastScannedAt: string | null;
  }>> {
    const userFilter = this.buildUserFilter(1);
    const result = await this.pool.query(`
      SELECT id, name, path, last_scanned_at
      FROM roots
      WHERE COALESCE(is_visible, TRUE) = TRUE
        AND ${userFilter.condition}
    `, userFilter.params);
    return result.rows.map(row => ({
      id: row.id,
      name: row.name,
      path: row.path,
      lastScannedAt: row.last_scanned_at
    }));
  }

  /**
   * Get a root by its path (for auto-detection)
   */
  async getRootByPath(rootPath: string): Promise<{ id: number; name: string; path: string } | undefined> {
    const userFilter = this.buildUserFilter(2);
    const result = await this.pool.query(
      `SELECT id, name, path FROM roots WHERE path = $1 AND ${userFilter.condition}`,
      [rootPath, ...userFilter.params]
    );
    return result.rows[0];
  }

  /**
   * Create a new root (for auto-creation during sync)
   */
  async createRoot(options: {
    name: string;
    path: string;
    type?: string;
  }): Promise<{ id: number; name: string; path: string }> {
    const { name, path, type = 'folder' } = options;

    const result = await this.pool.query(`
      INSERT INTO roots (name, path, type, is_active, is_visible, user_id)
      VALUES ($1, $2, $3, FALSE, TRUE, $4)
      RETURNING id, name, path
    `, [name, path, type, this.userId]);

    return result.rows[0];
  }

  /**
   * Log a sync operation (for Dashboard sync activity display)
   */
  async logSyncOperation(options: {
    rootId: number;
    filesScanned: number;
    filesAdded: number;
    filesUpdated: number;
    filesDeleted: number;
    source: string;
    machineName?: string;
    notes?: string;
  }): Promise<void> {
    await this.pool.query(`
      INSERT INTO sync_logs (root_id, files_scanned, files_added, files_updated, files_deleted, source, machine_name, notes)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [
      options.rootId,
      options.filesScanned,
      options.filesAdded,
      options.filesUpdated,
      options.filesDeleted,
      options.source,
      options.machineName || null,
      options.notes || null
    ]);
  }

  /**
   * Get recent sync logs for a root
   */
  async getSyncLogs(rootId?: number, limit: number = 10): Promise<Array<{
    id: number;
    rootId: number;
    syncedAt: string;
    filesScanned: number;
    filesAdded: number;
    filesUpdated: number;
    filesDeleted: number;
    source: string;
    machineName: string | null;
    notes: string | null;
  }>> {
    let sql = `
      SELECT id, root_id, synced_at, files_scanned, files_added,
             files_updated, files_deleted, source, machine_name, notes
      FROM sync_logs
    `;

    const params: any[] = [];
    let paramIndex = 1;

    if (rootId) {
      sql += ` WHERE root_id = $${paramIndex}`;
      params.push(rootId);
      paramIndex++;
    }

    sql += ` ORDER BY synced_at DESC LIMIT $${paramIndex}`;
    params.push(limit);

    const result = await this.pool.query(sql, params);
    return result.rows.map(row => ({
      id: row.id,
      rootId: row.root_id,
      syncedAt: row.synced_at,
      filesScanned: row.files_scanned,
      filesAdded: row.files_added,
      filesUpdated: row.files_updated,
      filesDeleted: row.files_deleted,
      source: row.source,
      machineName: row.machine_name,
      notes: row.notes
    }));
  }

  /**
   * Update last_scanned_at for a root
   */
  async updateRootScanTime(rootId: number): Promise<void> {
    await this.pool.query(
      'UPDATE roots SET last_scanned_at = NOW() WHERE id = $1',
      [rootId]
    );
  }

  /**
   * Get last sync time from settings
   */
  async getLastSyncTime(): Promise<string | null> {
    const result = await this.pool.query(
      "SELECT value FROM settings WHERE key = 'last_sync_time'"
    );
    return result.rows[0]?.value || null;
  }

  /**
   * Set last sync time in settings
   */
  async setLastSyncTime(timestamp: string): Promise<void> {
    await this.pool.query(`
      INSERT INTO settings (key, value) VALUES ('last_sync_time', $1)
      ON CONFLICT (key) DO UPDATE SET value = $1
    `, [timestamp]);
  }

  /**
   * Get count of notes per root
   */
  async getNoteCountByRoot(): Promise<Map<number, number>> {
    const userFilter = this.buildUserFilter(1);
    const result = await this.pool.query(`
      SELECT root_id, COUNT(*) as count
      FROM notes
      WHERE COALESCE(is_trashed, FALSE) = FALSE
        AND ${userFilter.condition}
      GROUP BY root_id
    `, userFilter.params);

    const counts = new Map<number, number>();
    for (const row of result.rows) {
      counts.set(row.root_id, parseInt(row.count, 10));
    }
    return counts;
  }

  /**
   * Get all note hashes for a root (for comparison with local files)
   */
  async getNoteHashesByRoot(rootId: number): Promise<Map<string, string>> {
    const userFilter = this.buildUserFilter(2);
    const result = await this.pool.query(
      `SELECT relative_path, hash FROM notes WHERE root_id = $1 AND relative_path IS NOT NULL AND ${userFilter.condition}`,
      [rootId, ...userFilter.params]
    );

    const hashes = new Map<string, string>();
    for (const row of result.rows) {
      hashes.set(row.relative_path, row.hash || '');
    }
    return hashes;
  }

  /**
   * Extract title from markdown content (H1 heading, frontmatter, or filename)
   * @param content - The markdown content
   * @param filename - Optional filename to use as fallback (e.g., "my-note.md")
   */
  private extractTitleFromContent(content: string, filename?: string): string {
    // Try to find first H1 heading (single #, not ## or more)
    const h1Match = content.match(/^#\s+(.+)$/m);
    if (h1Match) {
      return h1Match[1].trim();
    }

    // Fall back to filename (without extension) - this makes notes searchable by filename
    if (filename) {
      const baseName = filename.replace(/\.md$/i, '').split('/').pop() || filename;
      // Convert kebab-case or snake_case to Title Case
      const title = baseName
        .replace(/[-_]/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase());
      return title;
    }

    // Last resort: use first non-empty line
    const lines = content.split('\n').filter(l => l.trim());
    if (lines.length > 0) {
      const firstLine = lines[0].replace(/^#+\s*/, '').trim();
      return firstLine.substring(0, 100);
    }

    return 'Untitled';
  }

  /**
   * Compute SHA-256 hash of content
   */
  static computeHash(content: string): string {
    return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
  }

  /**
   * Get note with metadata for AI enhancement
   * Returns current metadata and content for analysis
   */
  async getNoteForEnhancement(id: number): Promise<{
    id: number;
    title: string;
    description: string | null;
    keywords: string[];
    aliases: string[];
    content: string;
    file_path: string;
    ai_enhanced_at: string | null;
    root_name: string | null;
  } | null> {
    const userFilter = this.buildUserFilter(2);
    const result = await this.pool.query(`
      SELECT
        n.id, n.title, n.description, n.keywords,
        COALESCE(n.aliases, '{}') as aliases,
        n.content, n.file_path, n.ai_enhanced_at,
        r.name as root_name
      FROM notes n
      LEFT JOIN roots r ON n.root_id = r.id
      WHERE n.id = $1 AND COALESCE(n.is_trashed, FALSE) = FALSE
        AND n.${userFilter.condition}
    `, [id, ...userFilter.params]);

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      id: row.id,
      title: row.title || 'Untitled',
      description: row.description,
      keywords: row.keywords || [],
      aliases: row.aliases || [],
      content: row.content || '',
      file_path: row.file_path,
      ai_enhanced_at: row.ai_enhanced_at,
      root_name: row.root_name
    };
  }

  /**
   * Get notes needing enhancement (missing description or keywords)
   */
  async getNotesNeedingEnhancement(options: {
    root?: string;
    limit?: number;
    important_only?: boolean;
  } = {}): Promise<Array<{
    id: number;
    title: string;
    file_path: string;
    has_description: boolean;
    has_keywords: boolean;
    is_favorite: boolean;
    has_stars: boolean;
    points: number;
    ai_enhanced_at: string | null;
  }>> {
    const { root, limit = 50, important_only = false } = options;
    const userFilter = this.buildUserFilter(1);

    let sql = `
      SELECT
        id, title, file_path,
        (description IS NOT NULL AND description != '') as has_description,
        (keywords IS NOT NULL AND jsonb_array_length(keywords) > 0) as has_keywords,
        COALESCE(is_favorite, FALSE) as is_favorite,
        (content LIKE '%⭐%') as has_stars,
        COALESCE(points, 0) as points,
        ai_enhanced_at
      FROM notes
      WHERE COALESCE(is_trashed, FALSE) = FALSE
        AND (description IS NULL OR description = '' OR keywords IS NULL OR jsonb_array_length(keywords) = 0)
        AND ${userFilter.condition}
    `;

    const params: any[] = [...userFilter.params];
    let paramIndex = userFilter.nextParamIndex;

    // Filter to important notes only (favorite, has stars, or has points)
    if (important_only) {
      sql += ` AND (is_favorite = TRUE OR content LIKE '%⭐%' OR points > 0)`;
    }

    if (root) {
      sql += ` AND file_path LIKE $${paramIndex}`;
      params.push(`%${root}%`);
      paramIndex++;
    }

    // Order by importance: favorites first, then by points, then by recency
    sql += ` ORDER BY is_favorite DESC, points DESC, ai_enhanced_at NULLS FIRST, modified_at DESC LIMIT $${paramIndex}`;
    params.push(limit);

    const result = await this.pool.query(sql, params);
    return result.rows;
  }

  /**
   * Update note metadata (for AI enhancement)
   * Phase 6.1: Updates title, description, keywords, and aliases
   */
  async updateNoteMetadata(id: number, metadata: {
    title?: string;
    description?: string;
    keywords?: string[];
    aliases?: string[];
  }): Promise<boolean> {
    const updates: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (metadata.title !== undefined) {
      updates.push(`title = $${paramIndex}`);
      params.push(metadata.title);
      paramIndex++;
    }

    if (metadata.description !== undefined) {
      updates.push(`description = $${paramIndex}`);
      params.push(metadata.description);
      paramIndex++;
    }

    if (metadata.keywords !== undefined) {
      updates.push(`keywords = $${paramIndex}::jsonb`);
      params.push(JSON.stringify(metadata.keywords));
      paramIndex++;
    }

    if (metadata.aliases !== undefined) {
      updates.push(`aliases = $${paramIndex}`);
      params.push(metadata.aliases);
      paramIndex++;
    }

    if (updates.length === 0) {
      return false;
    }

    // Always update ai_enhanced_at timestamp
    updates.push('ai_enhanced_at = NOW()');

    params.push(id);
    const sql = `UPDATE notes SET ${updates.join(', ')} WHERE id = $${paramIndex}`;

    const result = await this.pool.query(sql, params);
    return (result.rowCount ?? 0) > 0;
  }

  // ============================================
  // Phase 6.2: Smart Scoring & Relations
  // ============================================

  /**
   * Get note with current scores for analysis
   */
  async getNoteForScoring(id: number): Promise<{
    id: number;
    title: string;
    description: string | null;
    keywords: string[];
    content: string;
    file_path: string;
    importance_score: number | null;
    quality_score: number | null;
    relations: Array<{ type: string; target_id: number; context?: string }>;
    is_favorite: boolean;
    points: number;
  } | null> {
    const userFilter = this.buildUserFilter(2);
    const result = await this.pool.query(`
      SELECT
        id, title, description, keywords, content, file_path,
        importance_score, quality_score,
        COALESCE(relations, '[]'::jsonb) as relations,
        COALESCE(is_favorite, FALSE) as is_favorite,
        COALESCE(points, 0) as points
      FROM notes
      WHERE id = $1 AND COALESCE(is_trashed, FALSE) = FALSE
        AND ${userFilter.condition}
    `, [id, ...userFilter.params]);

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      id: row.id,
      title: row.title || 'Untitled',
      description: row.description,
      keywords: row.keywords || [],
      content: row.content || '',
      file_path: row.file_path,
      importance_score: row.importance_score,
      quality_score: row.quality_score,
      relations: row.relations || [],
      is_favorite: row.is_favorite,
      points: row.points
    };
  }

  /**
   * Update importance score (0-100)
   */
  async updateImportanceScore(id: number, score: number): Promise<boolean> {
    const userFilter = this.buildUserFilter(3);
    const result = await this.pool.query(
      `UPDATE notes SET importance_score = $1 WHERE id = $2 AND COALESCE(is_trashed, FALSE) = FALSE AND ${userFilter.condition}`,
      [score, id, ...userFilter.params]
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Update quality score (0-100)
   */
  async updateQualityScore(id: number, score: number): Promise<boolean> {
    const userFilter = this.buildUserFilter(3);
    const result = await this.pool.query(
      `UPDATE notes SET quality_score = $1 WHERE id = $2 AND COALESCE(is_trashed, FALSE) = FALSE AND ${userFilter.condition}`,
      [score, id, ...userFilter.params]
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Update relations for a note (bidirectional)
   * Also creates inverse relations on target notes
   */
  async updateRelations(id: number, relations: Array<{
    type: string;
    target_id: number;
    context?: string;
  }>): Promise<{ updated: number; inversesCreated: number }> {
    // Map of forward relation types to their inverse
    const inverseTypes: Record<string, string> = {
      'references': 'referenced_by',
      'referenced_by': 'references',
      'implements': 'implemented_by',
      'implemented_by': 'implements',
      'extends': 'extended_by',
      'extended_by': 'extends',
      'supersedes': 'superseded_by',
      'superseded_by': 'supersedes'
    };

    // Update the source note's relations
    const userFilter = this.buildUserFilter(3);
    await this.pool.query(
      `UPDATE notes SET relations = $1::jsonb WHERE id = $2 AND ${userFilter.condition}`,
      [JSON.stringify(relations), id, ...userFilter.params]
    );

    // Create inverse relations on target notes
    let inversesCreated = 0;
    for (const rel of relations) {
      const inverseType = inverseTypes[rel.type];
      if (!inverseType) continue;

      // Get current relations of target note
      const targetUserFilter = this.buildUserFilter(2);
      const targetResult = await this.pool.query(
        `SELECT relations FROM notes WHERE id = $1 AND ${targetUserFilter.condition}`,
        [rel.target_id, ...targetUserFilter.params]
      );

      if (targetResult.rows.length === 0) continue;

      const targetRelations: Array<{ type: string; target_id: number; context?: string }> =
        targetResult.rows[0].relations || [];

      // Check if inverse relation already exists
      const existingInverse = targetRelations.find(
        r => r.type === inverseType && r.target_id === id
      );

      if (!existingInverse) {
        // Add inverse relation
        targetRelations.push({
          type: inverseType,
          target_id: id,
          context: rel.context
        });

        await this.pool.query(
          'UPDATE notes SET relations = $1::jsonb WHERE id = $2',
          [JSON.stringify(targetRelations), rel.target_id]
        );
        inversesCreated++;
      }
    }

    return { updated: 1, inversesCreated };
  }

  /**
   * Get other notes for relation analysis (excluding the source note)
   */
  async getNotesForRelationAnalysis(excludeId: number, options: {
    root?: string;
    limit?: number;
  } = {}): Promise<Array<{
    id: number;
    title: string;
    description: string | null;
    keywords: string[];
    file_path: string;
  }>> {
    const { root, limit = 50 } = options;
    const userFilter = this.buildUserFilter(2);

    let sql = `
      SELECT id, title, description, keywords, file_path
      FROM notes
      WHERE id != $1 AND COALESCE(is_trashed, FALSE) = FALSE
        AND ${userFilter.condition}
    `;

    const params: any[] = [excludeId, ...userFilter.params];
    let paramIndex = userFilter.nextParamIndex;

    if (root) {
      sql += ` AND file_path LIKE $${paramIndex}`;
      params.push(`%${root}%`);
      paramIndex++;
    }

    sql += ` ORDER BY COALESCE(importance_score, 0) DESC, modified_at DESC LIMIT $${paramIndex}`;
    params.push(limit);

    const result = await this.pool.query(sql, params);
    return result.rows.map(row => ({
      id: row.id,
      title: row.title || 'Untitled',
      description: row.description,
      keywords: row.keywords || [],
      file_path: row.file_path
    }));
  }

  /**
   * Get knowledge base statistics for health analysis
   */
  async getKnowledgeBaseStats(options: {
    root?: string;
    limit?: number;
  } = {}): Promise<{
    total: number;
    withImportanceScore: number;
    withQualityScore: number;
    withRelations: number;
    withDescription: number;
    withKeywords: number;
    lowQuality: Array<{ id: number; title: string; quality_score: number | null; file_path: string }>;
    lowImportance: Array<{ id: number; title: string; importance_score: number | null; file_path: string }>;
    orphans: Array<{ id: number; title: string; file_path: string }>;
    missingMetadata: Array<{ id: number; title: string; file_path: string; missing: string[] }>;
  }> {
    const { root, limit = 10 } = options;
    const userFilter = this.buildUserFilter(1);

    // Build WHERE clause
    let whereClause = `COALESCE(is_trashed, FALSE) = FALSE AND ${userFilter.condition}`;
    const params: any[] = [...userFilter.params];
    let paramIndex = userFilter.nextParamIndex;

    if (root) {
      whereClause += ` AND file_path LIKE $${paramIndex}`;
      params.push(`%${root}%`);
      paramIndex++;
    }

    // Get aggregate stats
    const statsResult = await this.pool.query(`
      SELECT
        COUNT(*) as total,
        COUNT(importance_score) as with_importance,
        COUNT(quality_score) as with_quality,
        COUNT(*) FILTER (WHERE jsonb_array_length(COALESCE(relations, '[]'::jsonb)) > 0) as with_relations,
        COUNT(*) FILTER (WHERE description IS NOT NULL AND description != '') as with_description,
        COUNT(*) FILTER (WHERE keywords IS NOT NULL AND jsonb_array_length(keywords) > 0) as with_keywords
      FROM notes
      WHERE ${whereClause}
    `, params);

    const stats = statsResult.rows[0];

    // Get low quality docs (score < 50 or NULL, prioritize NULL)
    const lowQualityParams = [...params, limit];
    const lowQualityResult = await this.pool.query(`
      SELECT id, title, quality_score, file_path
      FROM notes
      WHERE ${whereClause} AND (quality_score IS NULL OR quality_score < 50)
      ORDER BY quality_score NULLS FIRST, modified_at DESC
      LIMIT $${paramIndex}
    `, lowQualityParams);

    // Get low importance docs (score < 30 or NULL)
    const lowImportanceResult = await this.pool.query(`
      SELECT id, title, importance_score, file_path
      FROM notes
      WHERE ${whereClause} AND (importance_score IS NULL OR importance_score < 30)
      ORDER BY importance_score NULLS FIRST, modified_at DESC
      LIMIT $${paramIndex}
    `, lowQualityParams);

    // Get orphan docs (no relations)
    const orphansResult = await this.pool.query(`
      SELECT id, title, file_path
      FROM notes
      WHERE ${whereClause} AND (relations IS NULL OR jsonb_array_length(relations) = 0)
      ORDER BY modified_at DESC
      LIMIT $${paramIndex}
    `, lowQualityParams);

    // Get docs missing metadata
    const missingMetadataResult = await this.pool.query(`
      SELECT
        id, title, file_path,
        (description IS NULL OR description = '') as missing_desc,
        (keywords IS NULL OR jsonb_array_length(keywords) = 0) as missing_kw
      FROM notes
      WHERE ${whereClause}
        AND ((description IS NULL OR description = '') OR (keywords IS NULL OR jsonb_array_length(keywords) = 0))
      ORDER BY modified_at DESC
      LIMIT $${paramIndex}
    `, lowQualityParams);

    return {
      total: parseInt(stats.total),
      withImportanceScore: parseInt(stats.with_importance),
      withQualityScore: parseInt(stats.with_quality),
      withRelations: parseInt(stats.with_relations),
      withDescription: parseInt(stats.with_description),
      withKeywords: parseInt(stats.with_keywords),
      lowQuality: lowQualityResult.rows,
      lowImportance: lowImportanceResult.rows,
      orphans: orphansResult.rows,
      missingMetadata: missingMetadataResult.rows.map(row => ({
        id: row.id,
        title: row.title || 'Untitled',
        file_path: row.file_path,
        missing: [
          ...(row.missing_desc ? ['description'] : []),
          ...(row.missing_kw ? ['keywords'] : [])
        ]
      }))
    };
  }

  // ============================================
  // Phase 6.3: Semantic Search with Embeddings
  // ============================================

  /**
   * Get notes without embeddings (for batch processing)
   */
  async getNotesWithoutEmbeddings(options: {
    limit?: number;
    root?: string;
  } = {}): Promise<Array<{
    id: number;
    title: string;
    content: string;
    file_path: string;
  }>> {
    const { limit = 50, root } = options;
    const userFilter = this.buildUserFilter(1);

    let sql = `
      SELECT id, title, content, file_path
      FROM notes
      WHERE embedding IS NULL
        AND COALESCE(is_trashed, FALSE) = FALSE
        AND ${userFilter.condition}
    `;

    const params: any[] = [...userFilter.params];
    let paramIndex = userFilter.nextParamIndex;

    if (root) {
      sql += ` AND file_path LIKE $${paramIndex}`;
      params.push(`%${root}%`);
      paramIndex++;
    }

    sql += ` ORDER BY COALESCE(importance_score, 0) DESC, modified_at DESC LIMIT $${paramIndex}`;
    params.push(limit);

    const result = await this.pool.query(sql, params);
    return result.rows;
  }

  /**
   * Update a note's embedding vector
   */
  async updateNoteEmbedding(id: number, embedding: number[]): Promise<boolean> {
    // Convert array to PostgreSQL vector format: [1,2,3] -> '[1,2,3]'
    const vectorString = `[${embedding.join(',')}]`;
    const userFilter = this.buildUserFilter(3);

    const result = await this.pool.query(
      `UPDATE notes SET embedding = $1::vector WHERE id = $2 AND ${userFilter.condition}`,
      [vectorString, id, ...userFilter.params]
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Search notes by embedding similarity (cosine distance)
   */
  async searchByEmbedding(embedding: number[], options: {
    limit?: number;
    root?: string;
  } = {}): Promise<Array<{
    id: number;
    title: string;
    description: string | null;
    file_path: string;
    similarity: number;
  }>> {
    const { limit = 10, root } = options;
    const vectorString = `[${embedding.join(',')}]`;
    const userFilter = this.buildUserFilter(2);

    let sql = `
      SELECT
        id, title, description, file_path,
        1 - (embedding <=> $1::vector) as similarity
      FROM notes
      WHERE embedding IS NOT NULL
        AND COALESCE(is_trashed, FALSE) = FALSE
        AND ${userFilter.condition}
    `;

    const params: any[] = [vectorString, ...userFilter.params];
    let paramIndex = userFilter.nextParamIndex;

    if (root) {
      sql += ` AND file_path LIKE $${paramIndex}`;
      params.push(`%${root}%`);
      paramIndex++;
    }

    sql += ` ORDER BY embedding <=> $1::vector LIMIT $${paramIndex}`;
    params.push(limit);

    const result = await this.pool.query(sql, params);
    return result.rows.map(row => ({
      id: row.id,
      title: row.title || 'Untitled',
      description: row.description,
      file_path: row.file_path,
      similarity: Math.round(parseFloat(row.similarity) * 100) / 100
    }));
  }

  /**
   * Get a note's embedding for similarity comparison
   */
  async getNoteEmbedding(id: number): Promise<{
    id: number;
    title: string;
    embedding: number[] | null;
  } | null> {
    const userFilter = this.buildUserFilter(2);
    const result = await this.pool.query(`
      SELECT id, title, embedding
      FROM notes
      WHERE id = $1 AND COALESCE(is_trashed, FALSE) = FALSE
        AND ${userFilter.condition}
    `, [id, ...userFilter.params]);

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    // Parse PostgreSQL vector format back to array
    let embedding: number[] | null = null;
    if (row.embedding) {
      // PostgreSQL returns vector as string like '[0.1,0.2,...]'
      const vectorStr = row.embedding.toString();
      embedding = JSON.parse(vectorStr.replace(/^\[/, '[').replace(/\]$/, ']'));
    }

    return {
      id: row.id,
      title: row.title || 'Untitled',
      embedding
    };
  }

  /**
   * Find similar notes by embedding
   */
  async findSimilarNotes(noteId: number, options: {
    limit?: number;
  } = {}): Promise<Array<{
    id: number;
    title: string;
    description: string | null;
    file_path: string;
    similarity: number;
  }>> {
    const { limit = 10 } = options;

    // Get the note's embedding first
    const userFilter = this.buildUserFilter(2);
    const noteResult = await this.pool.query(
      `SELECT embedding FROM notes WHERE id = $1 AND ${userFilter.condition}`,
      [noteId, ...userFilter.params]
    );

    if (noteResult.rows.length === 0 || !noteResult.rows[0].embedding) {
      return [];
    }

    // Find similar notes (excluding the source note)
    const similarUserFilter = this.buildUserFilter(4);
    const result = await this.pool.query(`
      SELECT
        id, title, description, file_path,
        1 - (embedding <=> $1) as similarity
      FROM notes
      WHERE id != $2
        AND embedding IS NOT NULL
        AND COALESCE(is_trashed, FALSE) = FALSE
        AND ${similarUserFilter.condition}
      ORDER BY embedding <=> $1
      LIMIT $3
    `, [noteResult.rows[0].embedding, noteId, limit, ...similarUserFilter.params]);

    return result.rows.map(row => ({
      id: row.id,
      title: row.title || 'Untitled',
      description: row.description,
      file_path: row.file_path,
      similarity: Math.round(parseFloat(row.similarity) * 100) / 100
    }));
  }

  /**
   * Get embedding statistics
   */
  async getEmbeddingStats(): Promise<{
    total: number;
    withEmbeddings: number;
    withoutEmbeddings: number;
  }> {
    const userFilter = this.buildUserFilter(1);
    const result = await this.pool.query(`
      SELECT
        COUNT(*) as total,
        COUNT(embedding) as with_embeddings,
        COUNT(*) - COUNT(embedding) as without_embeddings
      FROM notes
      WHERE COALESCE(is_trashed, FALSE) = FALSE
        AND ${userFilter.condition}
    `, userFilter.params);

    const row = result.rows[0];
    return {
      total: parseInt(row.total),
      withEmbeddings: parseInt(row.with_embeddings),
      withoutEmbeddings: parseInt(row.without_embeddings)
    };
  }

  /**
   * Close the database connection pool
   */
  async close(): Promise<void> {
    await this.pool.end();
  }
}
