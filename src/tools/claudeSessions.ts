/**
 * Stamping the calling Claude Code session onto a note when sync_notes pushes it.
 *
 * The point is one command: from a note, the owner should be able to run
 *   cd "<cwd>" && claude --resume <id>
 * and land back in the conversation that produced it.
 *
 * The note's `claude_sessions:` frontmatter is the portable source of truth; the backend parses
 * it into notes.claude_sessions on upsert. See src/backend/utils/claudeSessions.ts.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';

export interface ClaudeSessionRef {
  id: string;
  cwd: string;
  last_active: string;
  title?: string;
  branch?: string;
}

/** Mirrors MAX_CLAUDE_SESSIONS in the backend. Keeps frontmatter readable, bounds diff noise. */
export const MAX_CLAUDE_SESSIONS = 10;

/**
 * Don't rewrite the file for a few seconds of drift. Without this, every repeat sync inside one
 * session would produce new bytes, turning a "skipped (unchanged)" into a full content push AND
 * a version-history snapshot on the backend. This guard is what makes stamping cheap.
 */
const LAST_ACTIVE_REFRESH_MS = 5 * 60 * 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Head bytes scanned for the first `cwd`. The first entry is a header line with no cwd. */
const HEAD_BYTES = 256 * 1024;
/** Tail bytes scanned for max(timestamp) and the last ai-title. Grown once if it comes up empty. */
const TAIL_BYTES = 64 * 1024;
const TAIL_BYTES_MAX = 1024 * 1024;

export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

export function projectsDir(): string {
  return path.join(claudeConfigDir(), 'projects');
}

/**
 * Claude Code's cwd -> project-dir encoding: every character outside [A-Za-z0-9-] becomes '-'.
 *
 * The encoding is LOSSY and NOT invertible ('md-manager', 'md_manager' and 'md.manager' all
 * collapse to the same name), and the drive-letter case follows whatever the user typed at
 * launch. So this is only ever used to FIND a directory — never to reconstruct a path from one.
 */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9-]/g, '-');
}

export function normalizeCwd(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

function readChunk(file: string, from: number, length: number): string {
  const fd = fs.openSync(file, 'r');
  try {
    const size = Math.max(0, Math.min(length, fs.fstatSync(fd).size - from));
    if (size === 0) return '';
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, from);
    return buf.toString('utf-8');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Locate a session transcript. Depth 1 only, and the basename must be the session id.
 *
 * Both filters matter: `agent-<hex>.jsonl` subagent transcripts sit as SIBLINGS of real session
 * files in the legacy layout (1,490 of them on this machine), and the newer layout nests them
 * under `<session-id>/subagents/`. Neither is a session.
 */
export function findTranscript(sessionId: string): string | null {
  if (!UUID_RE.test(sessionId)) return null;
  const root = projectsDir();
  let dirs: string[];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(root, e.name));
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const candidate = path.join(dir, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function parseLines(chunk: string, dropFirstPartial: boolean): Array<Record<string, unknown>> {
  const lines = chunk.split('\n');
  if (dropFirstPartial) lines.shift();
  else lines.pop(); // last line of a head chunk is almost certainly truncated
  const out: Array<Record<string, unknown>> = [];
  for (const line of lines) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    try {
      const v = JSON.parse(s);
      if (v && typeof v === 'object') out.push(v as Record<string, unknown>);
    } catch { /* truncated or non-JSON line */ }
  }
  return out;
}

/**
 * Pull {cwd, branch, last_active, title} out of a transcript with two bounded reads.
 *
 * ~300 KB regardless of file size, which matters: the transcript corpus here is ~471 MB with a
 * 30 MB single-file maximum, and this runs on every push.
 */
export function readTranscriptMeta(file: string): {
  cwd: string | null; branch: string | null; last_active: string | null; title: string | null;
} {
  let cwd: string | null = null;
  let branch: string | null = null;

  // FIRST cwd, not the last: a `cd` inside a Bash tool call changes the recorded cwd partway
  // through ~3% of transcripts, and the launch directory is the one `claude --resume` needs.
  for (const e of parseLines(readChunk(file, 0, HEAD_BYTES), false)) {
    if (cwd === null && typeof e.cwd === 'string' && e.cwd) cwd = e.cwd;
    if (branch === null && typeof e.gitBranch === 'string') branch = e.gitBranch;
    if (cwd !== null && branch !== null) break;
  }

  let last_active: string | null = null;
  let title: string | null = null;
  const size = fs.statSync(file).size;
  for (const span of [TAIL_BYTES, TAIL_BYTES_MAX]) {
    const from = Math.max(0, size - span);
    for (const e of parseLines(readChunk(file, from, span), from > 0)) {
      // max(timestamp), never the file mtime: reopening a session appends untimestamped lines,
      // so mtime can overshoot real activity by days.
      if (typeof e.timestamp === 'string' && (last_active === null || e.timestamp > last_active)) {
        last_active = e.timestamp;
      }
      // ai-title is re-emitted as the title is refined, so last one wins.
      if (e.type === 'ai-title' && typeof e.aiTitle === 'string' && e.aiTitle) title = e.aiTitle;
      else if (title === null && e.type === 'agent-name' && typeof e.agentName === 'string') title = e.agentName;
      else if (title === null && typeof e.slug === 'string' && e.slug) title = e.slug;
    }
    if (last_active !== null || from === 0) break;
  }

  return { cwd, branch, last_active, title };
}

/**
 * The session calling us, or null when we cannot tell.
 *
 * CLAUDE_CODE_SESSION_ID is authoritative: Claude Code injects it (with CLAUDE_PROJECT_DIR) into
 * every stdio MCP server it spawns. Do NOT fall back to "newest transcript in the project dir" —
 * that heuristic picks a concurrent session in another repo, which is measurably wrong.
 *
 * Known limitation: MCP servers spawn once per session, so after `/clear` this id is the
 * pre-clear session. It still resumes a real conversation, and the value is reported to the
 * caller so the drift is visible rather than silently "corrected".
 */
export function currentSessionRef(explicitId?: string): { ref: ClaudeSessionRef; note?: string } | null {
  const id = (explicitId || process.env.CLAUDE_CODE_SESSION_ID || '').trim().toLowerCase();
  if (!UUID_RE.test(id)) return null;

  const file = findTranscript(id);
  if (!file) {
    // No transcript (another machine's config dir, a pruned history). The id and the folder are
    // the only two things `--resume` actually needs, so still stamp — and say what happened.
    const fallbackCwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    return {
      ref: { id, cwd: normalizeCwd(fallbackCwd), last_active: new Date().toISOString() },
      note: 'transcript not found — recorded cwd from CLAUDE_PROJECT_DIR/process.cwd() and last_active from the clock',
    };
  }

  let meta;
  try {
    meta = readTranscriptMeta(file);
  } catch (e) {
    return {
      ref: {
        id,
        cwd: normalizeCwd(process.env.CLAUDE_PROJECT_DIR || process.cwd()),
        last_active: new Date().toISOString(),
      },
      note: `transcript unreadable (${(e as Error).message})`,
    };
  }

  const ref: ClaudeSessionRef = {
    id,
    cwd: normalizeCwd(meta.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd()),
    last_active: meta.last_active || new Date().toISOString(),
  };
  if (meta.title) ref.title = meta.title;
  if (meta.branch) ref.branch = meta.branch;

  // Surface the /clear-style drift instead of guessing around it. The threshold is generous on
  // purpose: a live session's transcript is routinely minutes stale mid-turn.
  let note: string | undefined;
  const age = Date.now() - new Date(ref.last_active).getTime();
  if (Number.isFinite(age) && age > 30 * 60 * 1000) {
    note = `session ${id.slice(0, 8)} last shows activity ${Math.round(age / 60000)} min ago — if you ran /clear, this is the pre-clear session`;
  }
  return { ref, note };
}

function sortAndCap(refs: ClaudeSessionRef[]): ClaudeSessionRef[] {
  return refs
    .sort((a, b) => (a.last_active === b.last_active
      ? a.id.localeCompare(b.id)
      : (a.last_active < b.last_active ? 1 : -1)))
    .slice(0, MAX_CLAUDE_SESSIONS);
}

function sameRefs(a: ClaudeSessionRef[], b: ClaudeSessionRef[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i];
    return x.id === y.id && x.cwd === y.cwd && x.last_active === y.last_active
      && (x.title || '') === (y.title || '') && (x.branch || '') === (y.branch || '');
  });
}

/**
 * Merge `ref` into a note's `claude_sessions:` frontmatter, returning the new content — or the
 * ORIGINAL STRING, byte-identical, when nothing meaningful changed.
 *
 * Only the `claude_sessions:` span is re-emitted; every other frontmatter byte is spliced back
 * verbatim, blank lines included. That is deliberately better-behaved than updateFrontmatter,
 * whose line-walker ends with a blank-line-dropping filter — do not route this through it.
 */
export function upsertSessionFrontmatter(content: string, ref: ClaudeSessionRef): string {
  const m = content.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);

  const eol = content.includes('\r\n') ? '\r\n' : '\n';

  if (!m) {
    // An unterminated `---` opener is a malformed file, not an empty-frontmatter one. Refuse to
    // guess where the block ends — same defensive stance as updateFrontmatter.
    if (content.startsWith('---')) return content;
    const block = yaml.dump({ claude_sessions: [ref] }, { lineWidth: -1 }).trimEnd();
    return `---${eol}${block.split('\n').join(eol)}${eol}---${eol}${eol}${content}`;
  }

  let existing: ClaudeSessionRef[] = [];
  try {
    const parsed = yaml.load(m[1], { json: true }) as Record<string, unknown> | null;
    if (parsed && Array.isArray(parsed.claude_sessions)) {
      existing = (parsed.claude_sessions as unknown[])
        .filter((r): r is ClaudeSessionRef =>
          !!r && typeof r === 'object'
          && typeof (r as ClaudeSessionRef).id === 'string'
          && typeof (r as ClaudeSessionRef).cwd === 'string'
          && typeof (r as ClaudeSessionRef).last_active === 'string');
    }
  } catch {
    // Unparseable frontmatter: leave the file alone rather than rewrite around a guess.
    return content;
  }

  const prior = existing.find((r) => r.id === ref.id);
  if (prior) {
    const drift = new Date(ref.last_active).getTime() - new Date(prior.last_active).getTime();
    // Same session, same folder, and the clock barely moved — nothing worth rewriting the file for.
    if (Number.isFinite(drift) && drift < LAST_ACTIVE_REFRESH_MS && prior.cwd === ref.cwd
        && (prior.title || '') === (ref.title || '')) {
      return content;
    }
  }

  const merged = sortAndCap([ref, ...existing.filter((r) => r.id !== ref.id)]);
  if (sameRefs(sortAndCap([...existing]), merged)) return content;

  const rendered = yaml.dump({ claude_sessions: merged }, { lineWidth: -1 }).trimEnd().split('\n');

  // Splice by line so unrelated keys — and blank lines between them — survive untouched.
  const inner = m[1].split(/\r?\n/);
  const out: string[] = [];
  let i = 0;
  let replaced = false;
  while (i < inner.length) {
    if (/^\s*claude_sessions\s*:/.test(inner[i])) {
      if (!replaced) { out.push(...rendered); replaced = true; }
      i++;
      // Swallow the old block's indented continuation lines.
      while (i < inner.length && /^\s+\S/.test(inner[i])) i++;
      continue;
    }
    out.push(inner[i]);
    i++;
  }
  if (!replaced) out.push(...rendered);

  const newRaw = `---${eol}${out.join(eol)}${eol}---${eol}`;
  return newRaw + content.slice(m[0].length);
}
