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
const esc = (s) => String(s == null ? '' : s).replace(/</g, '&lt;').replace(/>/g, '&gt;');

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
// Claude Code's cwd->project-dir encoding (":" "\" "/" "_" all become "-"). Used
// by --print-self so the /noesis-capture skill can pass --self and never capture
// its own controller session.
function selfSessionId() {
  const name = process.cwd().replace(/[:\\/_]/g, '-');
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
// All top-level session transcripts (depth 1) — excludes subagent/workflow files.
function topLevelTranscripts() {
  const out = [];
  for (const dir of projectDirs()) {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (e.isFile() && e.name.endsWith('.jsonl')) {
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
  if (typeof c === 'string') return stripCmdNoise(stripAnsi(c));
  if (Array.isArray(c)) return stripCmdNoise(stripAnsi(c.filter((b) => b && b.type === 'text').map((b) => b.text).join(' ')));
  return '';
}

function firstWords(s, n) {
  const words = oneLine(s).replace(/[#>*`_~|]/g, '').split(' ').filter(Boolean);
  const head = words.slice(0, n).join(' ');
  return words.length > n ? `${head}…` : head;
}

function blockquote(text) {
  return text.split('\n').map((l) => (l.length ? `> ${l}` : '>')).join('\n');
}

function isSystemInjection(text) {
  const t = text.trimStart();
  return t.startsWith('<system-reminder') || t.startsWith('[SYSTEM NOTIFICATION') ||
         t.startsWith('<task-notification') || t.startsWith('<command-') ||
         t.startsWith('<local-command-stdout') || t.startsWith('Caveat:');
}

function summarizeToolUse(name, input) {
  input = input || {};
  const t = (s, n = 160) => oneLine(s).slice(0, n);
  switch (name) {
    case 'Read': return `Read \`${input.file_path || ''}\``;
    case 'Edit': case 'Write': case 'MultiEdit':
      return `${name} \`${input.file_path || ''}\``;
    case 'NotebookEdit': return `NotebookEdit \`${input.notebook_path || ''}\``;
    case 'Bash': return `Bash: \`${t(input.command || '', 160)}\``;
    case 'PowerShell': return `PowerShell: \`${t(input.command || '', 160)}\``;
    case 'Glob': return `Glob \`${input.pattern || ''}\``;
    case 'Grep': return `Grep \`${input.pattern || ''}\``;
    case 'Task': case 'Agent':
      return `Agent (${input.subagent_type || 'agent'}): ${t(input.description || '')}`;
    case 'WebFetch': return `WebFetch ${input.url || ''}`;
    case 'WebSearch': return `WebSearch: ${t(input.query || '')}`;
    case 'TodoWrite': case 'TaskCreate': case 'TaskUpdate': return name;
    default: {
      const keys = Object.keys(input);
      if (!keys.length) return name;
      // Wrap raw JSON in a code span so any `<` inside is HTML-safe and reads as code.
      return `${name}: \`${t(JSON.stringify(input), 120)}\``;
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

function renderDecisionBlock(toolUse, resultMap) {
  const qs = Array.isArray(toolUse.input?.questions) ? toolUse.input.questions : [];
  const answers = parseAnswers(resultMap.get(toolUse.id));
  const lines = [];
  for (const q of qs) {
    lines.push(`#### Decision — ${esc(oneLine(q.header)) || 'Question'}`);
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
    if (ans != null) {
      const custom = !opts.some(isChosen);
      lines.push(`**Chosen:** ${esc(ans)}${custom ? ' _(custom)_' : ''}`);
    } else {
      lines.push(`**Chosen:** _(pending)_`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function renderPlanBlock(toolUse, resultMap) {
  const res = resultMap.get(toolUse.id);
  const txt = res ? resultText(res) : '';
  const lines = ['- **Plan submitted for approval (ExitPlanMode)**'];
  if (txt && txt.trim()) {
    const body = txt
      .replace(/<\/details>/gi, '&lt;/details&gt;')   // never let an inner tag close our wrapper
      .replace(/^(#{1,6})\s+(.*)$/gm, '**$2**');       // demote headings so they don't pollute the note outline
    const capped = body.length > 12000 ? `${body.slice(0, 12000)}\n\n… (truncated)` : body;
    lines.push('', '<details>', '<summary>Plan / approval</summary>', '', capped, '', '</details>', '');
  } else {
    lines.push('  - ↳ _(awaiting approval)_');
  }
  return lines.join('\n');
}

function renderUserPrompt(turn, text, entry, queued = false) {
  const clean = stripImageRefs(text);
  const imageOnly = !clean;
  const heading = imageOnly ? '(image)' : (firstWords(clean, 9) || '(empty)');
  const ts = tsStamp(entry.timestamp);
  const body = imageOnly ? '_(image attachment)_'
             : (clean.length > 3000 ? `${clean.slice(0, 3000)}\n\n… (truncated)` : clean);
  const parts = [`### ${turn}. ${heading}`];
  const meta = [ts, queued ? '_(queued while working)_' : ''].filter(Boolean).join(' · ');
  if (meta) parts.push(`*${meta}*`);
  parts.push('', blockquote(body), '');
  return parts.join('\n');
}

function render(entries, meta) {
  const resultMap = buildResultMap(entries);
  const out = [];
  out.push(frontmatter(meta));
  out.push(`# ${meta.title}`, '');
  out.push(`> Live capture of source session \`${meta.sessionId}\`. Auto-generated — do not edit by hand.`, '');
  out.push('## Conversation', '');

  let turn = 0;
  for (const e of entries) {
    const content = e.message?.content;
    if (e.type === 'user') {
      if (typeof content === 'string') {
        if (!isSystemInjection(content)) { turn++; out.push(renderUserPrompt(turn, content, e)); }
      } else if (Array.isArray(content)) {
        const hasToolResult = content.some((b) => b?.type === 'tool_result');
        if (!hasToolResult) {
          const texts = content
            .filter((b) => b?.type === 'text' && b.text && !isSystemInjection(b.text))
            .map((b) => b.text);
          if (texts.length) { turn++; out.push(renderUserPrompt(turn, texts.join('\n\n'), e)); }
        }
        // tool_result blocks are folded into the assistant tool_use rendering below
      }
    } else if (e.type === 'queue-operation' && e.operation === 'enqueue') {
      // Messages the user sent while the agent was working are persisted here,
      // NOT as `user` entries. Render real ones; skip task-notification plumbing.
      const text = typeof e.content === 'string' ? e.content : '';
      if (text.trim() && !isSystemInjection(text)) {
        turn++;
        out.push(renderUserPrompt(turn, text, e, true));
      }
    } else if (e.type === 'assistant' && Array.isArray(content)) {
      let emitted = false;
      for (const b of content) {
        if (b.type === 'text') {
          if (b.text && b.text.trim()) { out.push(b.text.trim(), ''); emitted = true; }
        } else if (b.type === 'thinking') {
          // omitted (readable depth)
        } else if (b.type === 'tool_use') {
          if (b.name === 'AskUserQuestion') out.push(renderDecisionBlock(b, resultMap));
          else if (b.name === 'ExitPlanMode') out.push(renderPlanBlock(b, resultMap));
          else {
            out.push(`- **${b.name}** — ${summarizeToolUse(b.name, b.input)}`);
            const res = resultMap.get(b.id);
            // Echo-result tools: the tool-use line already names the target, so the
            // success result is noise — a cat -n file preview for Read, a "… updated
            // successfully (file state is current …)" confirmation for the writers.
            // Drop it on success; keep it on error (e.g. "File does not exist",
            // "String to replace not found"). Outcome-bearing tools (Bash/PowerShell,
            // Grep, Glob, Web*) keep their result — that result IS the point of the step.
            const echoTool = b.name === 'Read' || b.name === 'Edit' || b.name === 'Write'
                          || b.name === 'MultiEdit' || b.name === 'NotebookEdit';
            const r = summarizeToolResult(res);
            if (r && !(echoTool && !res?.is_error)) out.push(`  - ↳ ${r}`);
          }
          emitted = true;
        }
      }
      if (emitted) out.push('');
    }
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
