/**
 * Note types for md-manager MCP server
 */

export interface Note {
  id: number;
  title: string;
  file_path: string;
  content: string;
  description?: string;
  keywords?: string;
  points?: number;
  is_favorite?: number;
  modified_at?: string;
  created_at?: string;
  hash?: string;
  // Phase 6.2: Smart Scoring & Relations
  importance_score?: number;
  quality_score?: number;
  relations?: Relation[];
}

/**
 * Document relation (Phase 6.2)
 * Bidirectional: forward types have inverse counterparts
 */
export interface Relation {
  type: RelationType;
  target_id: number;
  context?: string;
}

export type RelationType =
  | 'references' | 'referenced_by'
  | 'implements' | 'implemented_by'
  | 'extends' | 'extended_by'
  | 'supersedes' | 'superseded_by';

export interface SearchResult {
  id: number;
  title: string;
  file_path: string;
  content: string;
  excerpt: string;
  relevance: number;
  modified_at?: string;
}

export interface SearchOptions {
  limit?: number;
  root?: string;
  dateRange?: {
    start: string;
    end: string;
  };
}

export interface SyncResult {
  synced: number;
  skipped: number;
  errors: string[];
  details: Array<{
    file: string;
    action: 'created' | 'updated' | 'skipped' | 'error';
    reason?: string;
    aiMetadata?: boolean;
  }>;
}

/**
 * Bidirectional sync result - tracks both push and pull operations
 */
export interface BidirectionalSyncResult {
  pushed: { created: number; updated: number };
  pulled: { created: number; updated: number };
  skipped: number;
  conflicts: Array<{
    path: string;
    localModified: string;
    cloudModified: string;
  }>;
  errors: string[];
  details: Array<{
    file: string;
    action: 'pushed_create' | 'pushed_update' | 'pulled_create' | 'pulled_update' | 'skipped' | 'conflict' | 'error';
    reason?: string;
  }>;
}

export interface SyncStatus {
  pending: number;
  lastSync: string | null;
  roots: Array<{
    name: string;
    path: string;
    fileCount: number;
    lastScanned: string | null;
  }>;
}

export interface LocalFile {
  path: string;
  relativePath: string;
  content: string;
  hash: string;
  mtime: Date;
  size: number;
  rootId: number;
  rootName: string;
  project?: string;  // Project name detected from .git folder
}
