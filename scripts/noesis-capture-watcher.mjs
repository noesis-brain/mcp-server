#!/usr/bin/env node
// noesis-capture-watcher.mjs — Live Session Capture into Noesis
//
// Tails a Claude Code session transcript (.jsonl) and renders it to a clean,
// readable Markdown note (default: ~/Noesis/captures/<session-id>.md, override
// with --out), then pushes that note to the Noesis cloud directly
// (POST /api/mcp/notes/upsert) on every change. Both the local render and the
// cloud push are fully deterministic and run with no Claude session in the loop
// — the /noesis-capture skill only starts/stops this watcher and reports status.
//
// Zero external dependencies (only node: builtins; uses global fetch + node:crypto).
// Node ESM (requires Node >= 18 for global fetch; tested on Node 22).
//
// Usage:
//   node noesis-capture-watcher.mjs --session "<id-or-name>" [--out <path>]
//        [--once] [--resolve-only] [--print-self] [--self <id>] [--interval-ms 1500]
//        [--no-cloud] [--push-min-interval-ms 5000] [--max-life-ms <ms>]
//
//   --session               session id (UUID) or a substring of its ai-title / summary
//   --out                   output .md path (default: ~/Noesis/captures/<id>.md)
//   --once                  render a single snapshot (+ one cloud push) and exit
//   --resolve-only          print resolved {sessionId,transcriptPath,...} JSON and exit
//   --print-self            print `SELF=<id>` for the CURRENT session (this cwd) and exit
//   --self <id>             refuse if the resolved session equals this id (self-guard)
//   --interval-ms           poll interval while tailing (default 1500)
//   --no-cloud              local render only — do not push to the Noesis cloud
//   --push-min-interval-ms  min ms between cloud pushes (debounce; default 5000)
//   --max-life-ms           optional hard lifetime cap (ms); watcher self-exits when reached
//
// Cloud auth: NOESIS_API_TOKEN / NOESIS_API_URL are read from the environment,
// else from ~/.claude.json -> mcpServers.noesis.env. The token is never logged
// or placed on a command line.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const HOME = os.homedir();
const PROJECTS = path.join(HOME, '.claude', 'projects');
const SNAPSHOT = path.join(HOME, '.claude', 'session-snapshot.json');
// Default output dir when --out is not supplied. ~/Noesis is the conventional
// Noesis root; the /noesis-capture skill overrides this with --out under the
// user's actual registered root (resolved via mcp__noesis__list_roots) so the
// cloud push always finds a matching root.
const DEFAULT_OUT_DIR = path.join(HOME, 'Noesis', 'captures');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------- arg parsing

function parseArgs(argv) {
  const a = { intervalMs: 1500 };
  for (let i = 0; i < argv.length; i++) {
    let k = argv[i];
    let v = null;
    const eq = k.indexOf('=');
    if (k.startsWith('--') && eq > 0) { v = k.slice(eq + 1); k = k.slice(0, eq); }
    switch (k) {
      case '--session': a.session = v ?? argv[++i]; break;
      case '--out': a.out = v ?? argv[++i]; break;
      case '--self': a.self = v ?? argv[++i]; break;
      case '--interval-ms': a.intervalMs = parseInt(v ?? argv[++i], 10) || 1500; break;
      case '--max-life-ms': a.maxLifeMs = parseInt(v ?? argv[++i], 10) || 0; break;
      case '--push-min-interval-ms': a.pushMinIntervalMs = parseInt(v ?? argv[++i], 10) || 0; break;
      case '--no-cloud': a.noCloud = true; break;
      case '--once': a.once = true; break;
      case '--resolve-only': a.resolveOnly = true; break;
      case '--print-self': a.printSelf = true; break;
      case '--help': case '-h': a.help = true; break;
      default: break;
    }
  }
  return a;
}

// ------------------------------------------------------------------ utilities

const oneLine = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

// ANSI/CSI escape sequences (e.g. "\x1b[7m", "\x1b[0m") leak in from terminal
// command output; strip them so result lines read as plain text.
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
const stripAnsi = (s) => String(s == null ? '' : s).replace(ANSI_RE, '');

// git prints this autocrlf warning to stderr on add/commit when a repo lacks a
// .gitattributes; it carries no signal in a session capture, so drop it from
// command output (Bash/PowerShell) before the result is summarized.
const GIT_CRLF_WARN_RE = /warning: in the working copy of '[^']*', LF will be replaced by CRLF the next time Git touches it\.?\s*/g;
const stripCmdNoise = (s) => String(s == null ? '' : s).replace(GIT_CRLF_WARN_RE, '');

// Some Windows console tools (`wsl --status`, certain `reg`/`netsh` invocations)
// write UTF-16LE to a piped stdout; captured as UTF-8 that leaves NUL bytes
// interleaved through the text. Postgres rejects NUL in text columns outright,
// and render() joins the whole note into one string before the cloud push, so
// a single stray NUL anywhere fails the ENTIRE push, not just that one entry.
const stripNulBytes = (s) => String(s == null ? '' : s).replace(/\u0000/g, '');

// Drop Claude Code image placeholders ("[Image #1]", "[Image: source: <path>]")
// that carry no readable signal in a text capture.
const stripImageRefs = (s) =>
  String(s == null ? '' : s)
    .replace(/\[Image #\d+\]/g, '')
    .replace(/\[Image:[^\]]*\]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

// Neutralize bare HTML tags so literal "<details>", "<summary>", "<system-reminder>"
// etc. in transcript data don't get interpreted as HTML by the Markdown renderer.
// Only for PLAIN-TEXT data fields (never inside code spans / fenced blocks).
// Also escapes `&` (so a literal `&lt;` stays literal) and `\` (so a Windows path
// like `tools\<script>` or `C:\_build` keeps its backslashes).
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\\/g, '\\\\');

function pad2(n) { return String(n).padStart(2, '0'); }
function localStamp(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
         `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function localDate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function tsStamp(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : localStamp(d);
}
function log(msg) { process.stdout.write(`[noesis-capture] ${localStamp(new Date())} ${msg}\n`); }

function statMtime(p) {
  try { return fs.statSync(p).mtimeMs; } catch { return 0; }
}
function projectDirs() {
  let ents;
  try { ents = fs.readdirSync(PROJECTS, { withFileTypes: true }); } catch { return []; }
  return ents.filter((e) => e.isDirectory()).map((e) => path.join(PROJECTS, e.name));
}
function findById(id) {
  for (const dir of projectDirs()) {
    const p = path.join(dir, `${id}.jsonl`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}
// Map the current working directory to its Claude Code project dir and return
// the most-recently-modified transcript's session id (i.e. THIS session). Mirrors
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Claude Code's cwd->project-dir encoding: EVERY character outside [A-Za-z0-9-] becomes
// "-". The old form listed only [:\/_], which silently mis-encoded any path containing a
// dot or a space (e.g. ~/.noesis-agent). Used by --print-self so the /noesis-capture skill
// can pass --self and never capture its own controller session.
//
// CLAUDE_CODE_SESSION_ID wins when present: Claude Code injects it into every MCP server
// and hook it spawns, and it is exact. The directory scan is a fallback, and it is a GUESS --
// "newest transcript" can pick a concurrent session running in another repo.
function selfSessionId() {
  const fromEnv = (process.env.CLAUDE_CODE_SESSION_ID || '').trim();
  if (SESSION_ID_RE.test(fromEnv)) return fromEnv;
  const name = process.cwd().replace(/[^A-Za-z0-9-]/g, '-');
  let d = path.join(PROJECTS, name);
  if (!fs.existsSync(d)) {
    const fc = name[0] || '';
    const toggled = (fc === fc.toUpperCase() ? fc.toLowerCase() : fc.toUpperCase()) + name.slice(1);
    d = path.join(PROJECTS, toggled);
  }
  let files;
  try { files = fs.readdirSync(d).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(d, f)); }
  catch { return ''; }
  if (!files.length) return '';
  const newest = files.reduce((a, b) => (statMtime(a) >= statMtime(b) ? a : b));
  return path.basename(newest).replace(/\.jsonl$/i, '');
}
// All top-level session transcripts (depth 1). TWO filters, both load-bearing: depth 1
// skips the newer <session-id>/subagents/ layout, and the UUID test drops the LEGACY
// agent-<hex>.jsonl subagent files, which sit as SIBLINGS of real sessions (~1,500 on a
// working machine) and were previously all returned as sessions with a bogus sessionId
// like "agent-a0065ea" — which is what made resolveByName's fallback scan mostly waste.
function topLevelTranscripts() {
  const out = [];
  for (const dir of projectDirs()) {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (e.isFile() && e.name.endsWith('.jsonl') && SESSION_ID_RE.test(e.name.slice(0, -6))) {
        const p = path.join(dir, e.name);
        out.push({ path: p, sessionId: e.name.slice(0, -6), mtime: statMtime(p) });
      }
    }
  }
  return out;
}
// Read the LAST ai-title from a transcript without a full parse pass.
function lastAiTitle(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const idx = raw.lastIndexOf('"type":"ai-title"');
  if (idx < 0) return null;
  const start = raw.lastIndexOf('\n', idx) + 1;
  let end = raw.indexOf('\n', idx);
  if (end < 0) end = raw.length;
  try { return JSON.parse(raw.slice(start, end)).aiTitle || null; } catch { return null; }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function readEntries(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch { /* skip malformed */ }
  }
  return out;
}

// ---------------------------------------------------------------- resolution

function resolveByName(name) {
  const needle = name.toLowerCase();
  const matches = []; // {sessionId, transcriptPath, title, mtime}
  const seen = new Set();
  const add = (sessionId, transcriptPath, title) => {
    if (!sessionId || seen.has(sessionId)) return;
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return;
    seen.add(sessionId);
    matches.push({ sessionId, transcriptPath, title: title || '', mtime: statMtime(transcriptPath) });
  };

  // 1. Per-project sessions-index.json (summary / firstPrompt)
  for (const dir of projectDirs()) {
    const idx = readJson(path.join(dir, 'sessions-index.json'));
    if (!Array.isArray(idx)) continue;
    for (const it of idx) {
      const hay = `${it.summary || ''} ${it.firstPrompt || ''}`.toLowerCase();
      if (it.sessionId && hay.includes(needle)) {
        add(it.sessionId, path.join(dir, `${it.sessionId}.jsonl`), it.summary);
      }
    }
  }

  // 2. Global session-snapshot.json (title)
  const snap = readJson(SNAPSHOT);
  if (Array.isArray(snap)) {
    for (const s of snap) {
      if (s.sessionId && (s.title || '').toLowerCase().includes(needle)) {
        add(s.sessionId, findById(s.sessionId), s.title);
      }
    }
  }

  // 3. Fallback: scan recent transcripts' ai-title (only if nothing found yet).
  if (matches.length === 0) {
    const tops = topLevelTranscripts().sort((a, b) => b.mtime - a.mtime);
    let scanned = 0;
    for (const t of tops) {
      if (seen.has(t.sessionId)) continue;
      if (scanned++ > 200) break;
      const title = lastAiTitle(t.path);
      if (title && title.toLowerCase().includes(needle)) {
        add(t.sessionId, t.path, title);
      }
    }
  }

  matches.sort((a, b) => b.mtime - a.mtime);
  if (!matches.length) return null;
  return { ...matches[0], candidates: matches.slice(0, 5) };
}

function resolve(sessionArg) {
  const arg = sessionArg.trim();
  // Direct transcript path (also handy for tests / subagent transcripts).
  if (/\.jsonl$/i.test(arg) && fs.existsSync(arg)) {
    return { sessionId: path.basename(arg).replace(/\.jsonl$/i, ''), transcriptPath: arg, candidates: [] };
  }
  if (UUID_RE.test(arg)) {
    const p = findById(arg);
    if (p) return { sessionId: arg, transcriptPath: p, candidates: [] };
    return null;
  }
  return resolveByName(arg);
}

// ---------------------------------------------------------------- conversion
//
// Note layout. The Noesis Contents panel nests its outline strictly by `#` level
// (md-manager src/frontend/src/components/TableOfContents.tsx, extractHeaders), so
// the heading levels below ARE the note's structure:
//
//   # <ai-title> — Capture         directly under the frontmatter, so Noesis strips it
//   ## N. <human message>          one per message the human wrote: the first TOC level
//   ### Working process            round 1 of the reply: narration + tool steps
//   ### Answer                     round 1's closing text
//   ### Follow-up K — <trigger>    a later round of the same request (a background task
//   #### Working process             finished, a scheduled wakeup fired, the usage limit
//   #### Answer                      reset, …)
//
// Only human messages open a section. Everything else in the transcript — skill
// bodies, caveats, local commands, queue bookkeeping, task notifications, wakeups,
// rewound branches — is folded into a round or dropped. Claude's own headings are
// flattened (narration, plans) or shifted below their Answer heading, so they can
// never outrank the outline above.

function buildResultMap(entries) {
  const map = new Map();
  for (const e of entries) {
    const content = e.message?.content;
    if (e.type === 'user' && Array.isArray(content)) {
      for (const b of content) {
        if (b && b.type === 'tool_result' && b.tool_use_id) map.set(b.tool_use_id, b);
      }
    }
  }
  return map;
}

function buildToolNameMap(entries) {
  const map = new Map();
  for (const e of entries) {
    const content = e.message?.content;
    if (e.type === 'assistant' && Array.isArray(content)) {
      for (const b of content) {
        if (b && b.type === 'tool_use' && b.id) map.set(b.id, b.name);
      }
    }
  }
  return map;
}

function extractMeta(entries, sessionId) {
  let title = null, cwd = null, gitBranch = null, firstTs = null;
  for (const e of entries) {
    if (e.type === 'ai-title' && e.aiTitle) title = e.aiTitle; // last wins
    if (cwd == null && e.cwd) cwd = e.cwd;
    if (gitBranch == null && e.gitBranch != null) gitBranch = e.gitBranch;
    if (firstTs == null && e.timestamp) firstTs = e.timestamp;
  }
  const shortId = sessionId.slice(0, 8);
  const display = (title ? title : `Session ${shortId}`) + ' — Capture';
  const startDate = firstTs ? localDate(new Date(firstTs)) : localDate(new Date());
  return { sessionId, title: display, cwd, gitBranch, date: startDate, updated: localDate(new Date()) };
}

function yq(s) { return `'${String(s == null ? '' : s).replace(/'/g, "''")}'`; }

function frontmatter(meta) {
  return [
    '---',
    `title: ${yq(meta.title)}`,
    `description: 'Live capture of a Claude Code session, auto-synced to Noesis.'`,
    // `source: claude` drives the Noesis "Captured from Claude Code" badge
    // (SourceProviderBadge resolves note.source === 'claude'; must be exactly 'claude').
    `source: claude`,
    `keywords: [session-capture, claude-code, noesis]`,
    `date: ${meta.date}`,
    `updated: ${meta.updated}`,
    `status: active`,
    `source_session_id: ${yq(meta.sessionId)}`,
    `source_cwd: ${yq(meta.cwd)}`,
    `source_git_branch: ${yq(meta.gitBranch)}`,
    '---',
    '',
  ].join('\n');
}

function resultText(res) {
  const c = res?.content;
  if (typeof c === 'string') return stripCmdNoise(stripAnsi(stripNulBytes(c)));
  if (Array.isArray(c)) return stripCmdNoise(stripAnsi(stripNulBytes(c.filter((b) => b && b.type === 'text').map((b) => b.text).join(' '))));
  return '';
}

// Returns the exact CommonMark closing fence needed to balance `text` if it ends
// inside an open fenced code block (``` or ~~~), or '' if none is open. Mirrors
// the fence-parity rules in frontend/src/utils/codeFences.ts.
function unterminatedFenceCloser(text) {
  let openChar = '';
  let openLen = 0;
  for (const raw of text.split('\n')) {
    const trimmed = raw.trim();
    const m = /^(`{3,}|~{3,})(.*)$/.exec(trimmed);
    if (!m) continue;
    const char = m[1][0];
    const len = m[1].length;
    const info = m[2].trim();
    if (!openChar) {
      openChar = char;
      openLen = len;
    } else if (char === openChar && len >= openLen && info === '') {
      openChar = '';
      openLen = 0;
    }
  }
  return openChar ? openChar.repeat(openLen) : '';
}

// Truncates `text` to at most `maxLen` characters, closing any fenced code block
// left dangling by the cut. An unclosed ``` fence would otherwise mark the rest
// of the note as code (per CommonMark), silently swallowing every later heading
// from both the TOC panel and the rendered body until EOF.
//
// The fence check runs even when THIS function doesn't truncate: Claude Code's
// own transcript can already contain a tool result that IT truncated upstream
// (its own "… (truncated)" marker, mid-fence, before this script ever sees the
// text) -- observed in the wild at ~11968 chars, under this function's 12000
// cap. Closing only on our own cut would miss that case entirely.
function truncateSafely(text, maxLen) {
  const cut = text.length > maxLen ? `${text.slice(0, maxLen)}\n\n… (truncated)` : text;
  const closer = unterminatedFenceCloser(cut);
  return closer ? `${cut}\n${closer}` : cut;
}

function closeOpenFence(text) {
  const closer = unterminatedFenceCloser(text);
  return closer ? `${text}\n${closer}` : text;
}

// Markdown syntax is stripped so a heading reads as plain text; `<` and `>` are
// kept (as a pair) and escaped by esc() where the words are used.
function firstWords(s, n) {
  const words = oneLine(s).replace(/[#*`_~|]/g, '').split(' ').filter(Boolean);
  const head = words.slice(0, n).join(' ');
  return words.length > n ? `${head}…` : head;
}

function blockquote(text) {
  return text.split('\n').map((l) => (l.length ? `> ${l}` : '>')).join('\n');
}

// Transcript text that no human wrote: harness reminders, background-task
// notifications, slash-command plumbing (a prompt command's <command-name> /
// <command-args> is parsed before this check), local-command caveats and output,
// shell-mode output, memory-mode input and MCP resource pushes.
const INJECTION_PREFIXES = [
  '<system-reminder', '[SYSTEM NOTIFICATION', '<task-notification', '<command-', '<local-command-',
  '<bash-stdout', '<bash-stderr', '<user-memory-input', '<mcp-resource-update', '<mcp-polling-update',
  'Caveat:',
];
function isSystemInjection(text) {
  const t = String(text == null ? '' : text).trimStart();
  return INJECTION_PREFIXES.some((p) => t.startsWith(p));
}

// Inline code that survives backticks inside it — PowerShell's escape character, or
// a shell `$(…)` written with backticks: the fence is one backtick longer than the
// longest run inside, padded with a space when the text starts or ends with one.
function codeSpan(text) {
  const s = String(text == null ? '' : text);
  if (!s) return '';
  const fence = '`'.repeat(Math.max(0, ...(s.match(/`+/g) || []).map((run) => run.length)) + 1);
  const pad = /^`|`$/.test(s) || /^ [\s\S]* $/.test(s) ? ' ' : '';
  return `${fence}${pad}${s}${pad}${fence}`;
}

function summarizeToolUse(name, input) {
  input = input || {};
  const t = (s, n = 160) => oneLine(s).slice(0, n);
  switch (name) {
    case 'Read': return `Read ${codeSpan(input.file_path)}`;
    case 'Edit': case 'Write': case 'MultiEdit':
      return `${name} ${codeSpan(input.file_path)}`;
    case 'NotebookEdit': return `NotebookEdit ${codeSpan(input.notebook_path)}`;
    case 'Bash': return `Bash: ${codeSpan(t(input.command || '', 160))}`;
    case 'PowerShell': return `PowerShell: ${codeSpan(t(input.command || '', 160))}`;
    case 'Glob': return `Glob ${codeSpan(input.pattern)}`;
    case 'Grep': return `Grep ${codeSpan(input.pattern)}`;
    case 'Task': case 'Agent':
      return `Agent (${input.subagent_type || 'agent'}): ${t(input.description || '')}`;
    case 'WebFetch': return `WebFetch ${input.url || ''}`;
    case 'WebSearch': return `WebSearch: ${t(input.query || '')}`;
    case 'TodoWrite': case 'TaskCreate': case 'TaskUpdate': return name;
    default: {
      const keys = Object.keys(input);
      if (!keys.length) return name;
      // Wrap raw JSON in a code span so any `<` inside is HTML-safe and reads as code.
      return `${name}: ${codeSpan(t(JSON.stringify(input), 120))}`;
    }
  }
}

function summarizeToolResult(res) {
  if (!res) return '';
  if (res.is_error) return `(error) ${esc(oneLine(resultText(res)).slice(0, 200))}`;
  const txt = oneLine(resultText(res));
  return txt ? esc(txt.slice(0, 200)) : '(done)';
}

function parseAnswers(res) {
  const map = new Map();
  if (!res) return map;
  const txt = resultText(res);
  const re = /"([^"]*)"\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(txt)) !== null) map.set(m[1], m[2]);
  return map;
}

// A tool result the human produced by declining the call. `feedback` is what they
// typed at the permission prompt — their own words, so it opens a new section.
const REJECTION_PREFIX = "The user doesn't want to proceed with this tool use";
function parseRejection(res) {
  if (!res || !res.is_error) return null;
  const txt = resultText(res);
  if (!txt.startsWith(REJECTION_PREFIX)) return null;
  const at = txt.indexOf('the user said:');
  if (at < 0) return { feedback: null };
  const feedback = txt.slice(at + 'the user said:'.length)
    .replace(/\n+Note: The user's next message may contain a correction or preference\.[\s\S]*$/, '')
    .trim();
  return { feedback: feedback && feedback !== 'Denied by user' ? feedback : null };
}

function rejectedToolLabel(name) {
  if (name === 'ExitPlanMode') return 'plan';
  if (name === 'AskUserQuestion') return 'question';
  if (name === 'Edit' || name === 'Write' || name === 'MultiEdit' || name === 'NotebookEdit') return 'edit';
  if (name === 'Bash' || name === 'PowerShell') return 'command';
  return name ? `${name} call` : 'tool call';
}

function renderDecisionBlock(toolUse, resultMap, level) {
  const qs = Array.isArray(toolUse.input?.questions) ? toolUse.input.questions : [];
  const res = resultMap.get(toolUse.id);
  const rejection = parseRejection(res);
  const answers = parseAnswers(res);
  const lines = [];
  for (const q of qs) {
    lines.push(`${'#'.repeat(level)} Decision — ${esc(oneLine(q.header)) || 'Question'}`);
    lines.push(`> ${esc(oneLine(q.question))}`);
    const ans = answers.get(q.question);
    const opts = Array.isArray(q.options) ? q.options : [];
    const isChosen = (opt) => ans != null && (ans === opt.label || ans.includes(opt.label));
    for (const opt of opts) {
      const chosen = isChosen(opt);
      const label = chosen ? `**${esc(opt.label)}**` : esc(opt.label);
      const desc = opt.description ? ` — ${esc(oneLine(opt.description))}` : '';
      lines.push(`- ${label}${desc}${chosen ? '  **(chosen)**' : ''}`);
    }
    lines.push(''); // else the Chosen line continues the last option's list item
    if (ans != null) {
      const custom = !opts.some(isChosen);
      lines.push(`**Chosen:** ${esc(ans)}${custom ? ' _(custom)_' : ''}`);
    } else if (rejection) {
      lines.push(`**Chosen:** _(declined${rejection.feedback ? ' — see the next message' : ''})_`);
    } else {
      lines.push(`**Chosen:** _(pending)_`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// Calls fn(line, prev) for every line OUTSIDE fenced code (``` / ~~~, the rules of
// unterminatedFenceCloser) and returns the rebuilt text; fenced lines pass through
// untouched. fn may return an array to replace one line with several.
function mapOutsideFences(text, fn) {
  const out = [];
  let openChar = '';
  let openLen = 0;
  let prev = '';
  for (const line of String(text).split('\n')) {
    const m = /^(`{3,}|~{3,})(.*)$/.exec(line.trim());
    let fenced = openChar !== '';
    if (m && !openChar) {
      openChar = m[1][0];
      openLen = m[1].length;
      fenced = true;
    } else if (m && m[1][0] === openChar && m[1].length >= openLen && m[2].trim() === '') {
      openChar = '';
      openLen = 0;
    }
    if (fenced) {
      out.push(line);
    } else {
      const r = fn(line, prev);
      if (Array.isArray(r)) out.push(...r);
      else out.push(r);
    }
    prev = line;
  }
  return out.join('\n');
}

const ATX_HEADING_RE = /^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/;

// Narration and plan bodies: headings become bold text, so the outline keeps only
// the sections this renderer creates. Each stays its own paragraph — Claude writes
// text right under a heading, and without the blank lines that text would run into
// the bold line.
function flattenHeadings(text) {
  return mapOutsideFences(text, (line) => {
    const m = ATX_HEADING_RE.exec(line);
    return m ? ['', `**${m[2].replace(/\*\*/g, '')}**`, ''] : line;
  });
}

function minHeadingLevel(text) {
  let min = 7;
  mapOutsideFences(text, (line) => {
    const m = ATX_HEADING_RE.exec(line);
    if (m) min = Math.min(min, m[1].length);
    return line;
  });
  return min;
}

// Answer text keeps its own structure, one level below its Answer heading.
function shiftHeadings(text, delta) {
  if (!delta) return text;
  return mapOutsideFences(text, (line) => {
    const m = ATX_HEADING_RE.exec(line);
    return m ? `${'#'.repeat(Math.min(6, Math.max(1, m[1].length + delta)))} ${m[2]}` : line;
  });
}

// Claude's markdown, made safe for the outline:
//  - a `---` / `***` / `___` rule becomes <hr>: the Contents panel lists bare rules as
//    divider rows, and `---` right under a line of text is a setext H2;
//  - a `===` underline is detached from the text above it (a setext H1);
//  - a line opening with <details>, <summary> or <hN> is escaped: the panel reads those
//    as collapsibles and headings, and an unbalanced one re-levels everything after it.
const RULE_RE = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})[ \t]*$/;
const SETEXT_H1_RE = /^ {0,3}=+[ \t]*$/;
const OUTLINE_TAG_RE = /^<\/?(?:details|summary|h[1-6])\b/i;
function neutralizeOutline(text) {
  return mapOutsideFences(text, (line, prev) => {
    if (RULE_RE.test(line)) return ['', '<hr>', ''];
    if (SETEXT_H1_RE.test(line) && prev.trim()) return ['', line];
    if (OUTLINE_TAG_RE.test(line.trim())) return line.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return line;
  });
}

// The owner's English-coaching block (their global CLAUDE.md), which Claude prints
// at the start or end of a reply: a ─── divider, a quote of the message, a `Better:`
// rewrite and up to two bullets. It coaches the human message, so it is lifted to
// sit under that message, minus the divider and the repeated quote. Parsed line by
// line: the first line that does not fit ends the block, and the text around it
// stays as it was. A block with nothing to refine (a parenthetical placeholder) is dropped.
const REFINEMENT_DIVIDER_RE = /^─{10,}[ \t]+English refinement[ \t]*$/;
function extractRefinements(text) {
  const lines = String(text).split('\n');
  const keep = [];
  const blocks = [];
  let openChar = '';
  let openLen = 0;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    const f = /^(`{3,}|~{3,})(.*)$/.exec(t);
    if (f && !openChar) {
      openChar = f[1][0];
      openLen = f[1].length;
    } else if (f && f[1][0] === openChar && f[1].length >= openLen && f[2].trim() === '') {
      openChar = '';
      openLen = 0;
    }
    if (f || openChar || !REFINEMENT_DIVIDER_RE.test(t)) {
      keep.push(lines[i]);
      continue;
    }
    let j = i + 1;
    while (j < lines.length && !lines[j].trim()) j++;
    while (j < lines.length && lines[j].trimStart().startsWith('>')) j++;
    while (j < lines.length && !lines[j].trim()) j++;
    const next = j < lines.length ? lines[j].trim() : '';
    if (next.startsWith('`Better:')) {
      const block = { better: next, bullets: [] };
      let k = j + 1;
      while (k < lines.length && !lines[k].trim()) k++;
      while (k < lines.length && block.bullets.length < 2 && /^- ".*" -> "/.test(lines[k].trim())) {
        block.bullets.push(lines[k].trim());
        k++;
      }
      blocks.push(block);
      i = (block.bullets.length ? k : j + 1) - 1;
    } else if (/^[*_]?\(.*\)[*_]?$/.test(next)) {
      i = j; // a placeholder: *(No new user message this turn…)*, (slash command — no prose to refine)
    } else {
      keep.push(lines[i]);
    }
  }
  return { text: keep.join('\n').replace(/\n{3,}/g, '\n\n').trim(), blocks };
}

// Applies fn to the parts of one line that are NOT inline code spans (a backtick
// run closed by a run of the same length); the spans themselves pass through.
function mapOutsideCodeSpans(line, fn) {
  let out = '';
  let i = 0;
  while (i < line.length) {
    const open = line.indexOf('`', i);
    if (open < 0) { out += fn(line.slice(i)); break; }
    out += fn(line.slice(i, open));
    let run = 1;
    while (line[open + run] === '`') run++;
    let close = -1;
    for (let k = line.indexOf('`', open + run); k >= 0; ) {
      let r = 1;
      while (line[k + r] === '`') r++;
      if (r === run) { close = k; break; }
      k = line.indexOf('`', k + r);
    }
    if (close < 0) { out += line.slice(open, open + run); i = open + run; continue; }
    out += line.slice(open, close + run);
    i = close + run;
  }
  return out;
}

// A `</details>` in a plan's prose would close the plan's collapsible early, so it
// is escaped there. Code spans and fenced code render as text and are left alone —
// escaping them would show `&lt;/details&gt;` to the reader.
function escapeClosingDetails(text) {
  return mapOutsideFences(text, (line) => mapOutsideCodeSpans(line, (s) => s.replace(/<\/details>/gi, '&lt;/details&gt;')));
}

// The plan as finally decided: the approved text when the human approved it (it
// carries any edits they made in the approval dialog), else the plan as submitted.
function planOutcome(toolUse, resultMap) {
  const submitted = String(toolUse.input?.plan || '');
  const res = resultMap.get(toolUse.id);
  if (!res) return { status: 'awaiting approval', body: submitted };
  if (parseRejection(res)) return { status: 'rejected', body: submitted };
  const txt = resultText(res);
  if (!txt.startsWith('User has approved your plan')) {
    return { status: res.is_error ? 'failed' : 'submitted', body: submitted || txt };
  }
  const m = /## Approved Plan( \(edited by user\))?:\n([\s\S]*)$/.exec(txt);
  return { status: m && m[1] ? 'approved (edited by the user)' : 'approved', body: m ? m[2] : submitted };
}

// Collapsible as before, but opened by a heading that repeats the summary text:
// Noesis then lists that heading (not the summary) in the outline at its own
// level and moves it into the summary bar. Its renderer looks only two lines past
// <summary> for the heading, hence exactly one blank line between them.
function renderPlanBlock(toolUse, resultMap, level) {
  const { status, body } = planOutcome(toolUse, resultMap);
  const title = `Plan — ${status}`;
  const clean = escapeClosingDetails(flattenHeadings(neutralizeOutline(lf(body).trim())));
  return [
    '<details>', `<summary>${title}</summary>`, '', `${'#'.repeat(level)} ${title}`, '',
    clean ? truncateSafely(clean, 12000) : '_(no plan text)_', '', '</details>',
  ].join('\n');
}

function renderStep(toolUse, resultMap) {
  const res = resultMap.get(toolUse.id);
  const lines = [`- **${toolUse.name}** — ${summarizeToolUse(toolUse.name, toolUse.input)}`];
  const rejection = parseRejection(res);
  if (rejection) {
    lines.push(`  - ↳ rejected by the user${rejection.feedback ? ' — see the next message' : ''}`);
    return lines.join('\n');
  }
  // Echo-result tools: the tool-use line already names the target, so the
  // success result is noise — a cat -n file preview for Read, a "… updated
  // successfully (file state is current …)" confirmation for the writers.
  // Drop it on success; keep it on error (e.g. "File does not exist",
  // "String to replace not found"). Outcome-bearing tools (Bash/PowerShell,
  // Grep, Glob, Web*) keep their result — that result IS the point of the step.
  const echoTool = toolUse.name === 'Read' || toolUse.name === 'Edit' || toolUse.name === 'Write'
                || toolUse.name === 'MultiEdit' || toolUse.name === 'NotebookEdit';
  const r = summarizeToolResult(res);
  if (r && !(echoTool && !res?.is_error)) lines.push(`  - ↳ ${r}`);
  return lines.join('\n');
}

// Text pasted on Windows arrives with CRLF. CommonMark treats a lone CR as a line end,
// but this renderer's line rules (headings, fences, rules) would miss it — normalize.
const lf = (s) => String(s == null ? '' : s).replace(/\r\n?/g, '\n');

function userText(content) {
  if (typeof content === 'string') return lf(content);
  if (!Array.isArray(content)) return '';
  return lf(content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n\n'));
}

function countImages(content) {
  return Array.isArray(content) ? content.filter((b) => b && b.type === 'image').length : 0;
}

const isInterrupt = (text) => /^\[Request interrupted by user/.test(String(text).trim());

function taskSummary(text) {
  const m = /<summary>([\s\S]*?)<\/summary>/.exec(String(text));
  return m ? oneLine(m[1]) : '';
}

// A slash command as typed: <command-name>/X</command-name> … <command-args>A</command-args>.
function parseCommandPrompt(text) {
  const t = String(text);
  const name = /<command-name>\s*\/?([^<]*?)\s*<\/command-name>/.exec(t);
  if (!name || !name[1]) return null;
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(t);
  return { name: name[1], args: args ? args[1].trim() : '' };
}

// A command that never reaches Claude (/effort, /model, …) is followed by its own
// <local-command-stdout|stderr>; a prompt command (a skill, a custom command) is
// followed by its expanded body (isMeta) and then Claude's reply.
function isLocalCommand(entries, i) {
  for (let j = i + 1; j < entries.length && j <= i + 25; j++) {
    const e = entries[j];
    if (e.type === 'assistant') return false;
    if (e.type !== 'user' || e.isMeta) continue;
    return userText(e.message?.content).trimStart().startsWith('<local-command-');
  }
  return false;
}

// A user entry that a human typed as a prompt (the shape the rewind check compares).
function isPromptEntry(e) {
  if (e.type !== 'user' || e.isMeta || e.isSidechain || e.isCompactSummary) return false;
  const content = e.message?.content;
  if (Array.isArray(content) && content.some((b) => b && b.type === 'tool_result')) return false;
  const text = userText(content);
  if (parseCommandPrompt(text)) return true;
  if (isInterrupt(text) || isSystemInjection(text)) return false;
  return !!stripImageRefs(text) || countImages(content) > 0;
}

// The conversation as it stands: drops subagent (sidechain) entries, and branches
// the human rewound. Rewinding or editing an earlier message (Esc Esc) leaves the
// old branch in the file, and the new message is its SIBLING (same parentUuid) — so
// a prompt with a later sibling prompt is abandoned, with everything under it.
function pruneEntries(entries) {
  const live = entries.filter((e) => !e.isSidechain);
  const lastByParent = new Map();
  for (const e of live) {
    if (e.uuid && e.parentUuid && isPromptEntry(e)) lastByParent.set(e.parentUuid, e.uuid);
  }
  const abandoned = new Set();
  for (const e of live) {
    if (e.uuid && e.parentUuid && isPromptEntry(e) && lastByParent.get(e.parentUuid) !== e.uuid) abandoned.add(e.uuid);
  }
  if (!abandoned.size) return live;
  const parentOf = new Map();
  for (const e of live) if (e.uuid) parentOf.set(e.uuid, e.parentUuid || null);
  const memo = new Map();
  const isAbandoned = (uuid) => {
    const path = [];
    let u = uuid;
    let result = false;
    while (u && path.length <= parentOf.size) {
      if (memo.has(u)) { result = memo.get(u); break; }
      if (abandoned.has(u)) { result = true; break; }
      path.push(u);
      u = parentOf.get(u);
    }
    for (const p of path) memo.set(p, result);
    return result;
  };
  return live.filter((e) => !e.uuid || !isAbandoned(e.uuid));
}

// Human messages typed while Claude works wait in a queue until Claude can take
// them. Replays the queue bookkeeping and returns those still waiting.
function pendingQueuedPrompts(entries) {
  const queue = [];
  for (const e of entries) {
    if (e.type !== 'queue-operation') continue;
    const content = typeof e.content === 'string' ? e.content : '';
    if (e.operation === 'enqueue') queue.push(content);
    else if (e.operation === 'dequeue') queue.shift();
    else if (e.operation === 'remove') {
      const at = queue.indexOf(content);
      if (at >= 0) queue.splice(at, 1);
      else queue.shift();
    }
  }
  return queue.filter((t) => stripImageRefs(t) && !isSystemInjection(t));
}

// Claude Code 2.1+ writes a turn_duration / stop_hook_summary marker when a turn
// ends; without one, the latest turn is still running. Older CLIs never write them.
function turnMarkersExpected(entries) {
  let version = '';
  for (const e of entries) {
    if (e.type === 'system' && (e.subtype === 'turn_duration' || e.subtype === 'stop_hook_summary')) return true;
    if (typeof e.version === 'string' && e.version) version = e.version;
  }
  const m = /^(\d+)\.(\d+)/.exec(version);
  return !!m && (Number(m[1]) > 2 || (Number(m[1]) === 2 && Number(m[2]) >= 1));
}

// One pass over the transcript: sections (one per human message), each split into
// rounds (one per uninterrupted agent run), each round a list of items.
function collectSections(entries, resultMap) {
  const toolNames = buildToolNameMap(entries);
  const live = pruneEntries(entries);
  const sections = [];
  let cur = null;
  let round = null;
  let turnEnded = false;      // a turn-end marker arrived after Claude's last output
  let trigger = null;         // what woke Claude up for the next round
  let wakeupPending = false;  // scheduled_task_fire seen; the next user entry is its prompt
  let commandSection = null;  // a just-opened command section, until its isMeta body passes

  const openRound = (label) => {
    round = { trigger: label, items: [], ended: false };
    cur.rounds.push(round);
  };
  const openSection = (prompt) => {
    cur = { prompt, rounds: [], refinement: null };
    sections.push(cur);
    openRound(null);
    turnEnded = false;
    trigger = null;
    wakeupPending = false;
    commandSection = null;
  };
  const ensureSection = () => { if (!cur) openSection(null); };
  const addMarker = (md) => {
    ensureSection();
    round.items.push({ kind: 'marker', md });
  };
  const endTurn = () => {
    if (!cur) return;
    turnEnded = true;
    round.ended = true;
  };
  const addInterrupt = () => {
    ensureSection();
    const last = round.items[round.items.length - 1];
    if (!(last && last.kind === 'step' && last.rejected)) round.items.push({ kind: 'marker', md: '_Interrupted by the user._' });
    endTurn();
  };

  for (let i = 0; i < live.length; i++) {
    const e = live[i];
    const content = e.message?.content;

    if (e.type === 'system') {
      if (e.subtype === 'turn_duration' || e.subtype === 'stop_hook_summary') endTurn();
      else if (e.subtype === 'scheduled_task_fire') wakeupPending = true;
      continue;
    }

    if (e.type === 'attachment') {
      const a = e.attachment || {};
      if (a.type === 'queued_command') {
        const text = userText(a.prompt);
        const human = a.commandMode === 'prompt' && (!a.origin || a.origin.kind === 'human');
        if (human && (stripImageRefs(text) || countImages(a.prompt)) && !isSystemInjection(text)) {
          // Typed while Claude was working; this is where it actually reached Claude.
          openSection({ text, ts: e.timestamp, images: countImages(a.prompt), meta: ['sent while Claude was working'] });
        } else if (text.trimStart().startsWith('<task-notification')) {
          const s = taskSummary(text);
          addMarker(`_Background task finished${s ? `: ${esc(s)}` : ''}._`);
        }
      } else if (a.type === 'hook_blocking_error' && a.hookEvent === 'Stop' && turnEnded) {
        trigger = trigger || 'a Stop hook kept Claude working';
      }
      continue;
    }

    if (e.type === 'user') {
      if (Array.isArray(content) && content.some((b) => b && b.type === 'tool_result')) {
        for (const b of content) {
          if (b && b.type === 'tool_result') {
            const rejection = parseRejection(b);
            if (rejection && rejection.feedback) {
              openSection({
                text: rejection.feedback, ts: e.timestamp, images: 0,
                meta: [`reply to a rejected ${rejectedToolLabel(toolNames.get(b.tool_use_id))}`],
              });
            }
          } else if (b && b.type === 'text' && isInterrupt(b.text)) {
            addInterrupt();
          }
        }
        continue;
      }
      const raw = userText(content);
      const images = countImages(content);
      if (e.isMeta) {
        if (wakeupPending) {
          trigger = `scheduled wakeup: ${firstWords(stripImageRefs(raw), 6)}`;
          wakeupPending = false;
        } else if (/^Your claude\.ai usage limit has reset/.test(raw.trim())) {
          trigger = 'resumed after the usage limit reset';
        } else if (commandSection && commandSection === cur && images) {
          cur.prompt.images += images; // a prompt command's images ride on its expanded body
        }
        continue;
      }
      if (e.isCompactSummary) {
        addMarker('_Context compacted here — Claude continued from a summary of the conversation above._');
        continue;
      }
      if (isInterrupt(raw)) { addInterrupt(); continue; }
      if (raw.trimStart().startsWith('<task-notification')) {
        const s = firstWords(taskSummary(raw), 12);
        trigger = `background task finished${s ? `: ${s}` : ''}`;
        continue;
      }
      if (raw.trimStart().startsWith('<bash-input>')) {
        const cmd = /<bash-input>([\s\S]*?)<\/bash-input>/.exec(raw);
        addMarker(`_Ran in the shell: \`${oneLine(cmd ? cmd[1] : '').slice(0, 160)}\`_`);
        continue;
      }
      const command = parseCommandPrompt(raw);
      if (command) {
        if (isLocalCommand(live, i)) continue;
        const text = `/${command.name}${command.args ? ` ${command.args}` : ''}`;
        if (wakeupPending) {
          trigger = `scheduled wakeup: ${firstWords(text, 6)}`;
          wakeupPending = false;
          continue;
        }
        openSection({ text, ts: e.timestamp, images, meta: [], isCommand: true });
        commandSection = cur;
        continue;
      }
      if (typeof content === 'string' && isSystemInjection(content)) continue;
      const text = lf(typeof content === 'string' ? content
        : (Array.isArray(content) ? content : [])
          .filter((b) => b && b.type === 'text' && typeof b.text === 'string' && !isSystemInjection(b.text))
          .map((b) => b.text).join('\n\n'));
      if (!stripImageRefs(text) && !images) continue;
      if (wakeupPending) {
        trigger = `scheduled wakeup: ${firstWords(stripImageRefs(text), 6)}`;
        wakeupPending = false;
        continue;
      }
      openSection({ text, ts: e.timestamp, images, meta: [] });
      continue;
    }

    if (e.type === 'assistant' && Array.isArray(content)) {
      if (e.message?.model === '<synthetic>') {
        // Harness-written: API errors, "You've hit your session limit", "No response requested."
        const t = oneLine(userText(content));
        if (!t || t === 'No response requested.') continue;
        if (trigger) {
          // Woken up (e.g. by a finished background task) straight into an error:
          // the wake-up still gets its own round.
          ensureSection();
          openRound(trigger);
          trigger = null;
          turnEnded = false;
        }
        addMarker(`_${esc(t)}_`);
        continue;
      }
      const blocks = content.filter((b) => b && ((b.type === 'text' && b.text && b.text.trim()) || b.type === 'tool_use'));
      if (!blocks.length) continue; // thinking-only entries
      ensureSection();
      if (turnEnded || trigger) {
        if (round.items.length || trigger) openRound(trigger || 'continued');
        turnEnded = false;
        trigger = null;
      }
      wakeupPending = false;
      commandSection = null;
      for (const b of blocks) {
        if (b.type === 'text') round.items.push({ kind: 'text', text: lf(b.text).trim() });
        else if (b.name === 'AskUserQuestion') round.items.push({ kind: 'decision', use: b });
        else if (b.name === 'ExitPlanMode') round.items.push({ kind: 'plan', use: b });
        else round.items.push({ kind: 'step', use: b, rejected: !!parseRejection(resultMap.get(b.id)) });
      }
    }
  }

  // A command section that got no reply and is followed by another section was a
  // local command whose output never showed up — not a prompt.
  return sections.filter((s, i) => !(s.prompt && s.prompt.isCommand && i < sections.length - 1
    && s.rounds.every((r) => !r.items.length)));
}

// Moves the section's first English-refinement block under its prompt and strips
// the rest; text items left empty are dropped.
function liftRefinements(section) {
  for (const r of section.rounds) {
    for (const it of r.items) {
      if (it.kind !== 'text') continue;
      const { text, blocks } = extractRefinements(it.text);
      it.text = text;
      if (!section.refinement && blocks.length) section.refinement = blocks[0];
    }
    r.items = r.items.filter((it) => it.kind !== 'text' || it.text);
  }
}

// A message is quoted as written: a heading, rule or raw tag the human pasted into it
// stays text inside the quote instead of becoming a heading or collapsible in the note.
// Code blocks are quoted untouched.
function plainQuoteText(text) {
  return mapOutsideFences(neutralizeOutline(text), (line) => line.replace(/^( {0,3})(#{1,6})(?=[ \t]|$)/, '$1\\$2'));
}

function renderPromptHeader(num, section) {
  const p = section.prompt;
  const clean = stripImageRefs(p.text);
  const heading = clean ? (firstWords(clean, 9) || '(empty)') : '(image)';
  const meta = [tsStamp(p.ts), ...p.meta, p.images ? `${p.images} image${p.images === 1 ? '' : 's'}` : ''].filter(Boolean);
  const lines = [`## ${num}. ${esc(heading)}`];
  if (meta.length) lines.push(`*${meta.join(' · ')}*`);
  lines.push('', blockquote(clean ? plainQuoteText(truncateSafely(clean, 3000)) : '_(image attachment)_'), '');
  const ref = section.refinement;
  if (ref) lines.push(ref.better, '', ...ref.bullets, '');
  return lines.join('\n');
}

// A round splits at its last tool step: what came before is the working process,
// the text after it is the answer. A round that is still running has no answer yet.
function renderRound(r, base, running, resultMap) {
  const items = r.items;
  let lastWork = -1;
  items.forEach((it, i) => { if (it.kind === 'step' || it.kind === 'decision' || it.kind === 'plan') lastWork = i; });
  const tail = items.slice(lastWork + 1);
  const split = !running && tail.some((it) => it.kind === 'text') ? lastWork + 1 : items.length;
  const heading = '#'.repeat(base);
  const chunks = [];
  const work = items.slice(0, split);
  if (work.length) {
    chunks.push({ md: `${heading} Working process` });
    for (const it of work) {
      if (it.kind === 'text') chunks.push({ md: closeOpenFence(flattenHeadings(neutralizeOutline(it.text))) });
      else if (it.kind === 'step') chunks.push({ md: renderStep(it.use, resultMap), step: true });
      else if (it.kind === 'decision') chunks.push({ md: renderDecisionBlock(it.use, resultMap, base + 1) });
      else if (it.kind === 'plan') chunks.push({ md: renderPlanBlock(it.use, resultMap, base + 1) });
      else chunks.push({ md: it.md });
    }
  }
  const answer = items.slice(split);
  if (answer.length) {
    chunks.push({ md: `${heading} Answer` });
    const min = Math.min(7, ...answer.filter((it) => it.kind === 'text').map((it) => minHeadingLevel(it.text)));
    const delta = min <= 6 ? base + 1 - min : 0;
    for (const it of answer) {
      chunks.push({ md: it.kind === 'text' ? closeOpenFence(shiftHeadings(neutralizeOutline(it.text), delta)) : it.md });
    }
  }
  // Consecutive tool steps stay one tight list; everything else is its own block.
  return chunks.map((c, i) => (i && c.step && chunks[i - 1].step ? '' : '\n') + c.md).join('\n').trim();
}

function render(entries, meta) {
  const resultMap = buildResultMap(entries);
  const sections = collectSections(entries, resultMap);
  const markers = turnMarkersExpected(entries);
  const out = [];
  out.push(`${frontmatter(meta)}# ${meta.title}`, '');
  out.push(`> Live capture of source session \`${meta.sessionId}\`. Auto-generated — do not edit by hand.`, '');

  let num = 0;
  sections.forEach((s, si) => {
    liftRefinements(s);
    out.push(s.prompt ? renderPromptHeader(++num, s) : '## Session start\n');
    let followUps = 0;
    s.rounds.forEach((r, ri) => {
      if (!r.items.length) return;
      const running = markers && !r.ended && si === sections.length - 1 && ri === s.rounds.length - 1;
      if (ri > 0) out.push(`### Follow-up ${++followUps} — ${esc(r.trigger || 'continued')}`, '');
      out.push(renderRound(r, ri > 0 ? 4 : 3, running, resultMap), '');
    });
  });

  for (const text of pendingQueuedPrompts(entries)) {
    out.push(`_Queued, not yet seen by Claude: “${esc(oneLine(stripImageRefs(text)).slice(0, 300))}”_`, '');
  }
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

// ------------------------------------------------------------------ output IO

function writeOut(outPath, content) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const tmp = `${outPath}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, outPath);
}

// ------------------------------------------------------------ cloud sync (Noesis)
//
// The watcher pushes the rendered note to the Noesis cloud itself, so cloud
// freshness no longer depends on a Claude session running a sync loop. Auth is
// read from the environment or ~/.claude.json (never logged). Hash + endpoint
// match the md-manager MCP server so a direct push is interchangeable with
// mcp__noesis__sync_notes for these auto-generated, local-authoritative notes.

const CLIENT_OS = process.platform === 'darwin' ? 'darwin'
                : process.platform === 'win32' ? 'win32' : 'linux';

// sha256 of LF-normalized content — identical to NoesisClient.computeHash.
function computeHash(content) {
  return crypto.createHash('sha256')
    .update(String(content).replace(/\r\n/g, '\n').replace(/\r/g, '\n'), 'utf8')
    .digest('hex');
}

// Expand ~ / %USERPROFILE% in a root's stored local path (mirrors md-manager).
function expandHome(p) {
  if (!p) return '';
  if (p === '~') return HOME;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(HOME, p.slice(2));
  const m = p.match(/^%USERPROFILE%([\\/].*)?$/i);
  if (m) return m[1] ? path.join(HOME, m[1].slice(1)) : HOME;
  return p;
}

// Resolve {token, baseUrl} from env, else ~/.claude.json -> mcpServers.noesis.env.
// Returns null when no token is available (caller runs local-only).
function loadCloudConfig() {
  let token = process.env.NOESIS_API_TOKEN || '';
  let baseUrl = process.env.NOESIS_API_URL || '';
  if (!token || !baseUrl) {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(HOME, '.claude.json'), 'utf8'));
      const env = (cfg && cfg.mcpServers && cfg.mcpServers.noesis && cfg.mcpServers.noesis.env) || {};
      token = token || env.NOESIS_API_TOKEN || '';
      baseUrl = baseUrl || env.NOESIS_API_URL || '';
    } catch { /* no usable config -> local-only */ }
  }
  baseUrl = (baseUrl || 'https://noesisbrain.com').replace(/\/+$/, '');
  if (!token) return null;
  return { token, baseUrl, clientOs: CLIENT_OS };
}

async function noesisFetch(cfg, method, p, body) {
  const res = await fetch(cfg.baseUrl + p, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      'Content-Type': 'application/json',
      'X-Client-OS': cfg.clientOs,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = JSON.stringify(await res.json()); }
    catch { try { detail = await res.text(); } catch { /* ignore */ } }
    const err = new Error(`HTTP ${res.status}${detail ? ' ' + detail.slice(0, 180) : ''}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Choose the default capture output directory: a `captures/` folder under a
// registered Noesis root, so the cloud push always finds a matching root.
// Prefers the standard ~/Noesis root; else the first root configured for this OS.
// Falls back to DEFAULT_OUT_DIR when the cloud/roots are unavailable. All paths are
// home-expanded HERE so the caller (and the /noesis-capture skill via --resolve-only)
// never has to expand a literal `~` / `%USERPROFILE%` from the stored root path.
async function resolveDefaultOutDir(cfg) {
  if (!cfg) return DEFAULT_OUT_DIR;
  try {
    const data = await noesisFetch(cfg, 'GET', '/api/mcp/roots');
    const roots = Array.isArray(data?.roots) ? data.roots : [];
    const expanded = roots
      .map((r) => (r.local_paths && r.local_paths[cfg.clientOs]) || r.path || '')
      .filter(Boolean)
      .map((lp) => path.resolve(expandHome(lp)));
    const standard = path.resolve(path.join(HOME, 'Noesis'));
    if (expanded.some((p) => p.toLowerCase() === standard.toLowerCase())) {
      return path.join(standard, 'captures');
    }
    if (expanded.length) return path.join(expanded[0], 'captures');
  } catch { /* fall through to the default */ }
  return DEFAULT_OUT_DIR;
}

// Map an absolute outPath to {rootId, rootName, relativePath} via GET /api/mcp/roots
// (longest-prefix match, case-insensitive on Windows). Returns null if no root matches.
async function resolveRoot(cfg, outPath) {
  const data = await noesisFetch(cfg, 'GET', '/api/mcp/roots');
  const roots = Array.isArray(data?.roots) ? data.roots : [];
  const targetReal = path.resolve(outPath).replace(/\\/g, '/');
  const targetCmp = targetReal.toLowerCase().replace(/\/+$/, '');
  let best = null;
  for (const r of roots) {
    const lp = (r.local_paths && r.local_paths[cfg.clientOs]) || r.path || '';
    if (!lp) continue;
    const rootReal = path.resolve(expandHome(lp)).replace(/\\/g, '/').replace(/\/+$/, '');
    const rootCmp = rootReal.toLowerCase();
    if (targetCmp === rootCmp || targetCmp.startsWith(rootCmp + '/')) {
      if (!best || rootCmp.length > best.len) {
        let rel = targetReal.slice(rootReal.length).replace(/^\/+/, '');
        if (!rel) rel = path.basename(targetReal);
        best = { rootId: r.id, rootName: r.name, relativePath: rel, len: rootCmp.length };
      }
    }
  }
  return best ? { rootId: best.rootId, rootName: best.rootName, relativePath: best.relativePath } : null;
}

// POST the note. force:false lets the server short-circuit unchanged content to
// "skipped"; regenerateMetadata:false / preserveMetadata:true keep AI metadata
// off the hot path. Returns { action: 'created'|'updated'|'skipped' }.
async function upsertNote(cfg, root, outPath, content, { force = false } = {}) {
  const body = {
    file: {
      path: path.resolve(outPath).replace(/\\/g, '/'),
      relativePath: root.relativePath,
      content,
      rootId: root.rootId,
      rootName: root.rootName,
      hash: computeHash(content),
      size: Buffer.byteLength(content, 'utf8'),
    },
    metadata: {},
    force,
    regenerateMetadata: false,
    preserveMetadata: true,
  };
  return noesisFetch(cfg, 'POST', '/api/mcp/notes/upsert', body);
}

// Lightweight liveness ping — deliberately separate from upsertNote(), which
// carries the note's entire content. Powers the frontend's "actively under
// watching" title indicator (Noesis web app), which treats capture as live
// only while this heartbeat is recent (see capture_heartbeat_at staleness
// check there) — a killed/crashed watcher never sends watching:false, so the
// frontend times it out instead of waiting for an explicit stop signal.
async function sendHeartbeat(cfg, root, watching) {
  return noesisFetch(cfg, 'POST', '/api/mcp/notes/heartbeat', {
    rootId: root.rootId,
    relativePath: root.relativePath,
    watching,
  });
}

// Per-session status sidecar the statusline reads (.<id>.cloud.json). Owned solely
// by this watcher; written atomically so it never races the skill's state file.
function sidecarPath(outPath) {
  const id = path.basename(outPath).replace(/\.md$/i, '');
  return path.join(path.dirname(outPath), `.${id}.cloud.json`);
}
function writeSidecar(outPath, obj) {
  try {
    const p = sidecarPath(outPath);
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tmp, p);
  } catch { /* sidecar is best-effort; statusline tolerates its absence */ }
}

// ------------------------------------------------------------------ main

const USAGE = `noesis-capture-watcher.mjs --session "<id-or-name>" [--out <path>] [--once] [--resolve-only] [--print-self] [--self <id>] [--interval-ms 1500] [--max-life-ms <ms>]`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { process.stdout.write(`${USAGE}\n`); process.exit(0); }
  if (args.printSelf) { process.stdout.write(`SELF=${selfSessionId()}\n`); process.exit(0); }
  if (!args.session) { process.stderr.write(`ERROR: --session is required\n${USAGE}\n`); process.exit(1); }

  const resolved = resolve(args.session);
  if (!resolved) {
    process.stderr.write(`ERROR: could not resolve session "${args.session}"\n`);
    process.exit(2);
  }
  if (args.self && args.self === resolved.sessionId) {
    process.stderr.write(`REFUSED: self-monitor guard — session "${resolved.sessionId}" is the current (controller) session.\n`);
    process.exit(3);
  }

  // Cloud config drives both root resolution (below) and the sync loop. Resolve it
  // once, up front, so --resolve-only reports the same root-derived outPath the run uses.
  const cloudCfg = args.noCloud ? null : loadCloudConfig();
  const outPath = args.out || path.join(await resolveDefaultOutDir(cloudCfg), `${resolved.sessionId}.md`);

  if (args.resolveOnly) {
    const meta = extractMeta(readEntries(resolved.transcriptPath), resolved.sessionId);
    process.stdout.write(`${JSON.stringify({
      sessionId: resolved.sessionId,
      transcriptPath: resolved.transcriptPath,
      title: meta.title,
      cwd: meta.cwd,
      gitBranch: meta.gitBranch,
      outPath,
      candidates: resolved.candidates || [],
    }, null, 2)}\n`);
    process.exit(0);
  }

  // -------- cloud-sync state (deterministic; no Claude session involved) --------
  const pushMinIntervalMs = args.pushMinIntervalMs && args.pushMinIntervalMs > 0 ? args.pushMinIntervalMs : 5000;
  const heartbeatIntervalMs = 45000; // must stay well under the frontend's ~2min staleness cutoff
  let lastHeartbeatAt = 0;
  let cloudRoot = null;
  let lastRootAttempt = 0;
  let currentMd = null;       // latest rendered markdown
  let currentHash = null;     // sha256 of currentMd
  let lastPushedHash = null;  // sha256 of the content last confirmed on the cloud
  let lastPushAttempt = 0;
  let pushBackoffMs = 0;
  let pushInFlight = false;
  const status = { lastPushTime: 0, lastAction: null, lastError: null };

  const publishSidecar = () => writeSidecar(outPath, {
    sessionId: resolved.sessionId,
    cloudEnabled: !!cloudCfg,
    rootResolved: !!cloudRoot,
    relativePath: cloudRoot ? cloudRoot.relativePath : null,
    lastPushTime: status.lastPushTime,
    lastAction: status.lastAction,
    lastError: status.lastError,
    updatedAt: Date.now(),
  });

  // Resolve the note's Noesis root once (lazy retry every 30s on failure).
  const ensureRoot = async () => {
    if (!cloudCfg || cloudRoot) return;
    const now = Date.now();
    if (now - lastRootAttempt < 30000) return;
    lastRootAttempt = now;
    try {
      cloudRoot = await resolveRoot(cloudCfg, outPath);
      if (cloudRoot) { status.lastError = null; log(`cloud: root "${cloudRoot.rootName}" -> ${cloudRoot.relativePath}`); }
      else { status.lastError = 'no-matching-root'; log(`cloud: no Noesis root matches ${outPath} — push disabled`); }
    } catch (err) {
      status.lastError = `roots: ${err.message}`.slice(0, 200);
      log(`cloud: roots fetch failed — ${err.message}`);
    }
    publishSidecar();
  };

  // Push the latest content when it differs from the cloud copy and the debounce
  // window (or post-failure backoff) has elapsed. Safe to call every tick: it
  // self-guards on in-flight / interval, so a transient failure retries on the
  // next tick even when the transcript is idle. Never rejects.
  const syncTick = async (force = false) => {
    if (!cloudCfg) return;
    await ensureRoot();
    if (!cloudRoot) return;
    if (currentHash == null || currentHash === lastPushedHash) return;  // nothing pending
    if (pushInFlight) return;
    const now = Date.now();
    if (!force && now - lastPushAttempt < Math.max(pushMinIntervalMs, pushBackoffMs)) return;
    pushInFlight = true;
    lastPushAttempt = now;
    const hashToPush = currentHash;
    const contentToPush = currentMd;
    try {
      let res;
      try { res = await upsertNote(cloudCfg, cloudRoot, outPath, contentToPush); }
      catch (e) {
        if (e.status === 409) res = await upsertNote(cloudCfg, cloudRoot, outPath, contentToPush, { force: true });
        else throw e;
      }
      lastPushedHash = hashToPush;
      pushBackoffMs = 0;
      status.lastPushTime = Date.now();
      status.lastAction = (res && res.action) || 'updated';
      status.lastError = null;
      log(`cloud: ${status.lastAction} ${cloudRoot.relativePath}`);
    } catch (err) {
      pushBackoffMs = Math.min(pushBackoffMs ? pushBackoffMs * 2 : 5000, 120000);
      status.lastError = String(err.message).slice(0, 200);
      log(`cloud: push failed — ${err.message} (retry in ~${Math.round(pushBackoffMs / 1000)}s)`);
    } finally {
      pushInFlight = false;
      publishSidecar();
    }
  };

  // Periodic liveness ping, independent of content changes — an idle session
  // (no new transcript entries) would otherwise never push anything via
  // syncTick(), leaving the frontend's staleness check with no way to tell
  // "quiet but alive" from "dead". Fire-and-forget; a dropped heartbeat just
  // waits for the next tick rather than backing off like content pushes do.
  const heartbeatTick = async (watching) => {
    if (!cloudCfg || !cloudRoot) return;
    lastHeartbeatAt = Date.now();
    try { await sendHeartbeat(cloudCfg, cloudRoot, watching); }
    catch (err) { log(`cloud: heartbeat failed — ${err.message}`); }
  };

  // Best-effort final push on graceful shutdown (Ctrl+C / SIGTERM). A force-kill
  // by the SessionEnd hook skips this, but the cloud is already current from the
  // last change-driven push, so that is acceptable.
  const finalPush = async () => {
    if (!cloudCfg || !cloudRoot || currentHash == null || currentHash === lastPushedHash) return;
    try {
      const res = await upsertNote(cloudCfg, cloudRoot, outPath, currentMd);
      lastPushedHash = currentHash;
      status.lastPushTime = Date.now();
      status.lastAction = (res && res.action) || 'updated';
      status.lastError = null;
      publishSidecar();
      log(`cloud: final ${status.lastAction}`);
    } catch (err) {
      log(`cloud: final push failed — ${err.message}`);
    }
  };

  const renderOnce = () => {
    const entries = readEntries(resolved.transcriptPath);
    const meta = extractMeta(entries, resolved.sessionId);
    const md = render(entries, meta);
    writeOut(outPath, md);
    currentMd = md;
    currentHash = computeHash(md);
    return { entries: entries.length, bytes: md.length };
  };

  const first = renderOnce();
  log(`resolved ${resolved.sessionId} -> ${outPath} (${first.entries} entries, ${first.bytes} bytes)`);

  if (args.once) {
    if (cloudCfg) await syncTick(true); else log('cloud: disabled (--no-cloud)');
    process.exit(0);
  }

  if (cloudCfg) log(`cloud: enabled -> ${cloudCfg.baseUrl} (push on change, >= every ${Math.round(pushMinIntervalMs / 1000)}s)`);
  else log('cloud: disabled — no NOESIS_API_TOKEN in env or ~/.claude.json (local render only)');
  publishSidecar();
  if (cloudCfg) syncTick(true).catch(() => {});   // initial cloud push (fire-and-forget)
  // lastHeartbeatAt stays 0 — the main loop below sends the first heartbeat as soon
  // as cloudRoot resolves (heartbeatTick no-ops until then), skipping the case where
  // the note doesn't exist in the cloud yet.

  let last = { mtimeMs: statMtime(resolved.transcriptPath), size: -1 };
  try { const s = fs.statSync(resolved.transcriptPath); last = { mtimeMs: s.mtimeMs, size: s.size }; } catch {}

  // Optional hard lifetime cap: self-exit after maxLifeMs from now. Backstop that
  // fires even if the controller session has gone away.
  const lifeStartMs = Date.now();
  const maxLifeMs = args.maxLifeMs && args.maxLifeMs > 0 ? args.maxLifeMs : 0;
  if (maxLifeMs) log(`lifetime cap: ${Math.round(maxLifeMs / 60000)}m — will self-exit when reached`);

  log(`watching every ${args.intervalMs}ms — Ctrl+C to stop`);
  const timer = setInterval(() => {
    if (maxLifeMs && Date.now() - lifeStartMs >= maxLifeMs) {
      clearInterval(timer);
      log(`lifetime cap reached (${Math.round(maxLifeMs / 60000)}m) — stopping watcher`);
      (async () => { await heartbeatTick(false); await finalPush(); process.exit(0); })();
      return;
    }
    const s = fs.statSync(resolved.transcriptPath, { throwIfNoEntry: false });
    if (s && (s.mtimeMs !== last.mtimeMs || s.size !== last.size)) {
      last = { mtimeMs: s.mtimeMs, size: s.size };
      try {
        const r = renderOnce();
        log(`updated -> ${outPath} (${r.entries} entries)`);
      } catch (err) {
        log(`render error: ${err.message}`);
      }
    }
    // Cloud push: drive a pending change OR retry a prior failure, regardless of
    // whether the transcript changed this tick.
    syncTick().catch(() => {});
    // Liveness heartbeat: independent of content changes, so an idle-but-alive
    // session still refreshes capture_heartbeat_at before it goes stale.
    if (Date.now() - lastHeartbeatAt >= heartbeatIntervalMs) {
      heartbeatTick(true).catch(() => {});
    }
  }, args.intervalMs);

  const stop = () => {
    clearInterval(timer);
    log('stopped');
    (async () => { await heartbeatTick(false); await finalPush(); process.exit(0); })();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => {
  process.stderr.write(`FATAL: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
