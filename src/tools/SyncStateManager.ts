/**
 * SyncStateManager - Hash-based three-way sync comparison + baseline content store
 *
 * State JSON at {rootPath}/.noesis/.sync-state.json:
 *   v1 (legacy): { version: 1, hashes: { relPath: hash } }
 *   v2 (current): { version: 2, entries: { relPath: { hash, lastSyncedAt } } }
 * Both are accepted on load; v1 is rewritten as v2 on next save.
 *
 * Baseline content: {rootPath}/.noesis/baseline/{relPath} mirrors the exact markdown
 * last successfully synced. Required by the MCP three-tier conflict cascade
 * (anchor reapply → node-diff3 → structured BASE/LOCAL/CLOUD report).
 */

import * as fs from 'fs';
import * as path from 'path';

interface SyncEntryV2 {
  hash: string;
  /** Server-returned `modified_at` from the last successful sync. Never client wall-clock. */
  lastSyncedAt: string | undefined;
}

interface SyncStateV2 {
  version: 2;
  entries: Record<string, SyncEntryV2>;
}

interface SyncStateV1 {
  version: 1;
  hashes: Record<string, string>;
}

export type SyncDirection = 'skip' | 'push' | 'pull' | 'conflict';

/**
 * Determine sync direction using three-way hash comparison.
 *
 * Extra defense: when `cloudEditedOnlineAt` is newer than `baselineLastSyncedAt`,
 * cloud counts as changed-since-baseline even if the cloud hash happens to match
 * baseline (defense against hash collisions and metadata-only re-hash drift).
 */
export function determineSyncDirection(
  localHash: string,
  cloudHash: string,
  baselineHash: string | undefined,
  localMtime: number,
  cloudMtime: number,
  cloudEditedOnlineAt?: string | null,
  baselineLastSyncedAt?: string | undefined
): SyncDirection {
  // Same content on both sides — nothing to do
  if (localHash === cloudHash) return 'skip';

  // Baseline exists — three-way comparison
  if (baselineHash !== undefined) {
    const localChanged = localHash !== baselineHash;
    let cloudChanged = cloudHash !== baselineHash;

    // Defense: trust the explicit edited_online_at signal when it postdates baseline.
    if (
      !cloudChanged &&
      cloudEditedOnlineAt &&
      (!baselineLastSyncedAt || new Date(cloudEditedOnlineAt) > new Date(baselineLastSyncedAt))
    ) {
      cloudChanged = true;
    }

    if (localChanged && !cloudChanged) return 'push';
    if (!localChanged && cloudChanged) return 'pull';
    if (localChanged && cloudChanged) return 'conflict';
    return 'skip';
  }

  // No baseline — fall back to timestamp comparison (existing behavior)
  const TOLERANCE_MS = 1000;
  const timeDiff = localMtime - cloudMtime;
  if (Math.abs(timeDiff) < TOLERANCE_MS) return 'conflict';
  return timeDiff > 0 ? 'push' : 'pull';
}

export interface BaselineMeta {
  hash: string;
  lastSyncedAt: string | undefined;
}

export class SyncStateManager {
  private statePath: string;
  private baselineDir: string;
  private state: SyncStateV2 | null = null;
  private dirty = false;

  private normalizeKey(relativePath: string): string {
    let normalized = relativePath.replace(/\\/g, '/');
    if (normalized.length >= 2 && normalized[1] === ':') {
      normalized = normalized[0].toLowerCase() + normalized.slice(1);
    }
    return normalized;
  }

  constructor(rootPath: string) {
    this.statePath = path.join(rootPath, '.noesis', '.sync-state.json');
    this.baselineDir = path.join(rootPath, '.noesis', 'baseline');
  }

  /**
   * Load state from disk. Accepts both v1 and v2; upgrades v1 to v2 in memory
   * (re-written to disk on next save).
   */
  load(): void {
    try {
      if (fs.existsSync(this.statePath)) {
        const raw = fs.readFileSync(this.statePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed && parsed.version === 2 && typeof parsed.entries === 'object') {
          this.state = parsed as SyncStateV2;
          this.dirty = false;
        } else if (parsed && parsed.version === 1 && typeof parsed.hashes === 'object') {
          // v1 → v2 upgrade: lastSyncedAt unknown; baseline files absent until next successful sync.
          const v1 = parsed as SyncStateV1;
          const entries: Record<string, SyncEntryV2> = {};
          for (const [k, hash] of Object.entries(v1.hashes)) {
            entries[k] = { hash, lastSyncedAt: undefined };
          }
          this.state = { version: 2, entries };
          this.dirty = true; // re-save as v2 next chance
        } else {
          this.state = null;
          this.dirty = false;
        }
      } else {
        this.state = null;
        this.dirty = false;
      }
    } catch {
      // Corrupted file — start fresh
      this.state = null;
      this.dirty = false;
    }
  }

  /** Get the baseline hash for a file from the last successful sync. */
  getBaseline(relativePath: string): string | undefined {
    return this.state?.entries[this.normalizeKey(relativePath)]?.hash;
  }

  /** Get the full baseline metadata (hash + lastSyncedAt). */
  getBaselineMeta(relativePath: string): BaselineMeta | undefined {
    return this.state?.entries[this.normalizeKey(relativePath)];
  }

  /**
   * Set the baseline hash + lastSyncedAt after a successful sync operation.
   * Optionally provide content to mirror under .noesis/baseline/<relPath>.
   *
   * Backward-compat: callers may pass just `(relativePath, hash)` (string) — old shape.
   */
  setBaseline(
    relativePath: string,
    hashOrMeta: string | BaselineMeta,
    content?: string
  ): void {
    const meta: BaselineMeta = typeof hashOrMeta === 'string'
      ? { hash: hashOrMeta, lastSyncedAt: undefined }
      : hashOrMeta;

    if (!this.state) {
      this.state = { version: 2, entries: {} };
    }
    const key = this.normalizeKey(relativePath);
    const existing = this.state.entries[key];
    if (!existing || existing.hash !== meta.hash || existing.lastSyncedAt !== meta.lastSyncedAt) {
      this.state.entries[key] = { hash: meta.hash, lastSyncedAt: meta.lastSyncedAt };
      this.dirty = true;
    }
    if (content !== undefined) {
      this.writeBaselineContent(relativePath, content);
    }
  }

  /** Remove baseline (state entry + on-disk content file) for a deleted/renamed file. */
  removeBaseline(relativePath: string): void {
    const key = this.normalizeKey(relativePath);
    if (this.state && key in this.state.entries) {
      delete this.state.entries[key];
      this.dirty = true;
    }
    this.removeBaselineContent(relativePath);
  }

  /**
   * Remove baselines for paths not in the active set (cleanup deleted/renamed files).
   * Also deletes corresponding baseline content files.
   */
  pruneStale(activePaths: Set<string>): void {
    if (!this.state) return;
    const normalizedActive = new Set<string>();
    for (const p of activePaths) normalizedActive.add(this.normalizeKey(p));
    for (const key of Object.keys(this.state.entries)) {
      if (!normalizedActive.has(key)) {
        delete this.state.entries[key];
        this.dirty = true;
        this.removeBaselineContent(key);
      }
    }
  }

  /** Read baseline content from disk. Returns undefined for v1-upgraded entries (no file). */
  getBaselineContent(relativePath: string): string | undefined {
    const key = this.normalizeKey(relativePath);
    const filePath = path.join(this.baselineDir, key);
    try {
      if (fs.existsSync(filePath)) return fs.readFileSync(filePath, 'utf-8');
    } catch {
      // Baseline content is best-effort; tier C will fall back to two-way merge.
    }
    return undefined;
  }

  /** Write baseline content to disk under .noesis/baseline/<relPath>. */
  setBaselineContent(relativePath: string, content: string): void {
    this.writeBaselineContent(relativePath, content);
  }

  private writeBaselineContent(relativePath: string, content: string): void {
    const key = this.normalizeKey(relativePath);
    const filePath = path.join(this.baselineDir, key);
    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, content, 'utf-8');
    } catch (err) {
      // Don't fail the sync if baseline write fails; tier A/B simply won't have a baseline next time.
      console.warn(`Failed to write baseline content for ${relativePath}:`, err);
    }
  }

  private removeBaselineContent(relativePath: string): void {
    const key = this.normalizeKey(relativePath);
    const filePath = path.join(this.baselineDir, key);
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {
      // Best-effort cleanup
    }
  }

  /** Write state to disk only if dirty. Creates .noesis dir if needed. */
  save(): void {
    if (!this.dirty || !this.state) return;
    const dir = path.dirname(this.statePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2), 'utf-8');
    this.dirty = false;
  }
}
