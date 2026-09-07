/**
 * Recovering which Claude Code sessions touched a note that predates session stamping.
 *
 * Forward stamping (claudeSessions.ts) only helps notes synced from now on. This scans the
 * transcript corpus for mentions of a note's path and reconstructs {id, cwd, last_active} for the
 * sessions that worked on it — the same search that, done by hand, is what motivated the feature.
 *
 * Cost is the whole design problem here: the corpus on a working machine is ~470 MB across ~600
 * session transcripts, with a single file reaching 30 MB. So: filter before opening, stream
 * instead of reading whole files, cache by (size, mtime), and stop at a time budget.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { claudeConfigDir, projectsDir, normalizeCwd, type ClaudeSessionRef } from './claudeSessions.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Characters that cannot appear inside a path, used to find where one starts. */
const PATH_STOP = new Set(['"', "'", ' ', '\t', ',', '[', ']', '{', '}', '(', ')', '=', ';', '`', '*', '?', '<', '>', '|']);

/**
 * Absolute Windows or POSIX .md paths mentioned on one line.
 *
 * Deliberately NOT a regex. Transcript lines routinely run to hundreds of KB (tool-result dumps),
 * and a lazy-quantified pattern backtracks catastrophically on them — measured at ~8 s per
 * transcript, which made a full index take over an hour. Scanning from each '.md' backwards to
 * the first impossible character is linear with a tiny constant.
 */
function extractMdPaths(line: string, into: Set<string>, limit: number): void {
  let idx = line.indexOf('.md');
  while (idx !== -1 && into.size < limit) {
    let start = idx;
    while (start > 0 && !PATH_STOP.has(line[start - 1])) start--;
    const cand = line.slice(start, idx + 3);
    // Absolute only: a bare 'foo.md' says nothing about which note it is.
    if (/^(?:[A-Za-z]:[\\/]|\/)/.test(cand)) {
      into.add(normalizeCwd(cand.replace(/\\\\/g, '/')).toLowerCase());
    }
    idx = line.indexOf('.md', idx + 3);
  }
}

/** A runaway note-heavy session should not blow up the index file. */
const MAX_PATHS_PER_SESSION = 200;

const INDEX_VERSION = 1;

export interface SessionIndexEntry {
  file: string;
  size: number;
  mtimeMs: number;
  cwd: string | null;
  branch: string | null;
  title: string | null;
  lastActive: string | null;
  paths: string[];
}

export interface SessionIndex {
  version: number;
  entries: Record<string, SessionIndexEntry>;
}

/**
 * Deliberately in the Claude config dir, NOT in a Noesis root — an index that synced itself to the
 * cloud would be both useless there and a privacy leak (it lists local paths).
 */
export function indexPath(): string {
  return path.join(claudeConfigDir(), '.noesis-session-index.json');
}

export function loadIndex(): SessionIndex {
  try {
    const raw = JSON.parse(fs.readFileSync(indexPath(), 'utf-8'));
    if (raw && raw.version === INDEX_VERSION && raw.entries) return raw as SessionIndex;
  } catch { /* absent or corrupt — rebuild from scratch */ }
  return { version: INDEX_VERSION, entries: {} };
}

export function saveIndex(index: SessionIndex): void {
  try {
    fs.writeFileSync(indexPath(), JSON.stringify(index), 'utf-8');
  } catch { /* an unwritable index costs a rescan, nothing more */ }
}

/**
 * Every real session transcript, and nothing else.
 *
 * Two filters, both load-bearing. Depth 1 skips the newer `<session-id>/subagents/` layout. The
 * UUID test drops the ~1,500 legacy `agent-<hex>.jsonl` subagent files that sit as SIBLINGS of
 * real sessions — the bug that makes the capture watcher's own scan mostly wasted work.
 */
export function listSessionTranscripts(): Array<{ sessionId: string; file: string; size: number; mtimeMs: number }> {
  const out: Array<{ sessionId: string; file: string; size: number; mtimeMs: number }> = [];
  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(projectsDir(), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(projectsDir(), d.name);
    let files: fs.Dirent[];
    try { files = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      const sessionId = f.name.slice(0, -6);
      if (!UUID_RE.test(sessionId)) continue;
      const file = path.join(dir, f.name);
      try {
        const st = fs.statSync(file);
        out.push({ sessionId, file, size: st.size, mtimeMs: st.mtimeMs });
      } catch { /* vanished mid-scan */ }
    }
  }
  return out;
}

async function scanTranscript(file: string): Promise<Omit<SessionIndexEntry, 'file' | 'size' | 'mtimeMs'>> {
  const paths = new Set<string>();
  let cwd: string | null = null;
  let branch: string | null = null;
  let title: string | null = null;
  let lastActive: string | null = null;

  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.startsWith('{')) continue;

    // Cheap first: this runs on the raw line, so a session that never mentions a .md file costs
    // no JSON parsing at all beyond the metadata sniff below.
    if (paths.size < MAX_PATHS_PER_SESSION) {
      extractMdPaths(line, paths, MAX_PATHS_PER_SESSION);
    }

    // Metadata only needs a handful of fields; parse only lines that plausibly carry them.
    if (cwd === null && line.includes('"cwd"')) {
      try {
        const e = JSON.parse(line);
        if (typeof e.cwd === 'string' && e.cwd) cwd = e.cwd;
        if (branch === null && typeof e.gitBranch === 'string') branch = e.gitBranch;
      } catch { /* truncated line */ }
    }
    if (line.includes('"timestamp"')) {
      const m = /"timestamp":"([^"]+)"/.exec(line);
      if (m && (lastActive === null || m[1] > lastActive)) lastActive = m[1];
    }
    if (line.includes('"ai-title"')) {
      const m = /"aiTitle":"((?:[^"\\]|\\.)*)"/.exec(line);
      if (m) { try { title = JSON.parse(`"${m[1]}"`); } catch { /* keep previous */ } }
    }
  }
  rl.close();

  return { cwd, branch, title, lastActive, paths: [...paths] };
}

export interface BuildResult {
  index: SessionIndex;
  scanned: number;
  reused: number;
  skippedOld: number;
  total: number;
  truncated: boolean;
}

/**
 * Refresh the index incrementally. An entry is reused when BOTH size and mtime match, so the
 * steady-state cost is only the transcripts appended to since the last run.
 */
export async function buildIndex(opts: { since?: Date; timeBudgetMs?: number } = {}): Promise<BuildResult> {
  const started = Date.now();
  const budget = opts.timeBudgetMs ?? 20_000;
  const sinceMs = opts.since ? opts.since.getTime() : 0;

  const index = loadIndex();
  const transcripts = listSessionTranscripts();
  // Newest first: if the budget runs out, the sessions most likely to be relevant are already in.
  transcripts.sort((a, b) => b.mtimeMs - a.mtimeMs);

  let scanned = 0, reused = 0, skippedOld = 0, truncated = false;

  for (const t of transcripts) {
    if (t.mtimeMs < sinceMs) { skippedOld++; continue; }

    const prev = index.entries[t.sessionId];
    if (prev && prev.size === t.size && prev.mtimeMs === t.mtimeMs) { reused++; continue; }

    if (Date.now() - started > budget) { truncated = true; break; }

    try {
      const meta = await scanTranscript(t.file);
      index.entries[t.sessionId] = { file: t.file, size: t.size, mtimeMs: t.mtimeMs, ...meta };
      scanned++;
    } catch { /* unreadable transcript — skip it, do not abort the run */ }
  }

  // Saved even on a truncated run, so re-running resumes instead of starting over.
  saveIndex(index);
  return { index, scanned, reused, skippedOld, total: transcripts.length, truncated };
}

export type MatchConfidence = 'absolute' | 'relative' | 'basename';

export interface SessionMatch extends ClaudeSessionRef {
  confidence: MatchConfidence;
}

/**
 * Find sessions that mention a note.
 *
 * Three tiers, strongest first. A basename-only hit is genuinely weak — two notes in different
 * roots can share a filename — so it is reported as such rather than silently mixed in.
 */
export function matchSessions(
  index: SessionIndex,
  opts: { absolutePath?: string; relativePath?: string }
): SessionMatch[] {
  const abs = opts.absolutePath ? normalizeCwd(opts.absolutePath).toLowerCase() : null;
  const rel = opts.relativePath ? normalizeCwd(opts.relativePath).toLowerCase() : null;
  const base = (abs || rel || '').split('/').pop() || '';
  if (!abs && !rel) return [];

  const out: SessionMatch[] = [];
  for (const [sessionId, e] of Object.entries(index.entries)) {
    let confidence: MatchConfidence | null = null;
    for (const p of e.paths) {
      if (abs && p === abs) { confidence = 'absolute'; break; }
      if (rel && p.endsWith('/' + rel)) { confidence = confidence === null ? 'relative' : confidence; continue; }
      if (base && confidence === null && p.endsWith('/' + base)) confidence = 'basename';
    }
    if (!confidence) continue;
    out.push({
      id: sessionId,
      cwd: normalizeCwd(e.cwd || ''),
      last_active: e.lastActive || new Date(e.mtimeMs).toISOString(),
      // The index only ever scans THIS machine's ~/.claude/projects, so anything it finds is
      // resumable here by construction.
      machine_name: os.hostname(),
      ...(e.title ? { title: e.title } : {}),
      ...(e.branch ? { branch: e.branch } : {}),
      confidence,
    });
  }

  const rank: Record<MatchConfidence, number> = { absolute: 0, relative: 1, basename: 2 };
  return out.sort((a, b) =>
    rank[a.confidence] !== rank[b.confidence]
      ? rank[a.confidence] - rank[b.confidence]
      : (a.last_active < b.last_active ? 1 : -1));
}
