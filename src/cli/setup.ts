/**
 * `noesis-mcp setup` — install CLAUDE.md conventions and skills into ~/.claude/.
 *
 * Idempotent: re-running upgrades the bracketed block / overwrites versioned
 * skill files in place. User edits outside the markers are preserved.
 *
 * Opt-ins: --with-restructure-rule, --with-capture, --with-ticket-hook (each with a
 * --no-* twin that wins); --all turns on every opt-in.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'node:readline/promises';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Package root: dist/cli/setup.js -> ../.. = package root.
const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');
const TEMPLATES_DIR = path.join(PACKAGE_ROOT, 'templates');
const SKILL_TEMPLATES_DIR = path.join(PACKAGE_ROOT, 'skill-templates');
const SCRIPTS_DIR = path.join(PACKAGE_ROOT, 'scripts');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const CLAUDE_MD_PATH = path.join(CLAUDE_DIR, 'CLAUDE.md');
const COMMANDS_DIR = path.join(CLAUDE_DIR, 'commands');
const SETTINGS_PATH = path.join(CLAUDE_DIR, 'settings.json');

// Copilot targets a per-repo instructions file, not a global profile — VS Code
// Copilot has no established global-instructions equivalent to ~/.claude/CLAUDE.md.
const COPILOT_INSTRUCTIONS_PATH = path.join(process.cwd(), '.github', 'copilot-instructions.md');

/**
 * A versioned block injected into ~/.claude/CLAUDE.md, delimited by HTML-comment
 * markers so re-runs can upgrade or remove it in place without touching the user's
 * own content. Each block owns an independent version.
 */
interface BlockSpec {
  /** Template filename under templates/. */
  templateFile: string;
  /** Exact start marker (carries the current version). */
  startMarker: string;
  /** Exact end marker. */
  endMarker: string;
  /** Loose start marker (any version) — used to find an existing block during upgrade/removal. */
  startRe: RegExp;
}

// Core conventions — always installed (unless --skills-only).
const CORE_BLOCK_VERSION = 'v4'; // v2 (2.5.0): + Noesis tickets section; v3 (2.6.0): + new work in a bound session; v4 (2.7.0): + the "which ticket?" checkpoint and ship
const CORE_BLOCK: BlockSpec = {
  templateFile: 'claude-md-block.md',
  startMarker: `<!-- noesis-mcp-server:start ${CORE_BLOCK_VERSION} -->`,
  endMarker: `<!-- noesis-mcp-server:end -->`,
  startRe: /<!-- noesis-mcp-server:start [^>]*-->/,
};

// Optional "restructure notes on sync" rule — opt-in (off by default).
const RESTRUCTURE_BLOCK_VERSION = 'v1';
const RESTRUCTURE_BLOCK: BlockSpec = {
  templateFile: 'claude-md-restructure-on-sync.md',
  startMarker: `<!-- noesis-mcp-server:restructure-on-sync:start ${RESTRUCTURE_BLOCK_VERSION} -->`,
  endMarker: `<!-- noesis-mcp-server:restructure-on-sync:end -->`,
  startRe: /<!-- noesis-mcp-server:restructure-on-sync:start [^>]*-->/,
};

type Client = 'claude' | 'copilot';

interface SetupOptions {
  client: Client;
  claudeMdOnly: boolean;
  skillsOnly: boolean;
  dryRun: boolean;
  withRestructure: boolean;
  noRestructure: boolean;
  withCapture: boolean;
  noCapture: boolean;
  withTicketHook: boolean;
  noTicketHook: boolean;
}

function parseArgs(argv: string[]): SetupOptions {
  const clientArg = argv.find((a) => a.startsWith('--client='));
  const client = clientArg ? clientArg.slice('--client='.length) : 'claude';
  if (client !== 'claude' && client !== 'copilot') {
    throw new Error(`Unknown --client "${client}" (expected "claude" or "copilot").`);
  }

  // --all = every opt-in; an explicit --no-* still wins (the resolvers check it first).
  const all = argv.includes('--all');
  return {
    client,
    claudeMdOnly: argv.includes('--claude-md-only'),
    skillsOnly: argv.includes('--skills-only'),
    dryRun: argv.includes('--dry-run'),
    withRestructure: all || argv.includes('--with-restructure-rule'),
    noRestructure: argv.includes('--no-restructure-rule'),
    withCapture: all || argv.includes('--with-capture'),
    noCapture: argv.includes('--no-capture'),
    withTicketHook: all || argv.includes('--with-ticket-hook'),
    noTicketHook: argv.includes('--no-ticket-hook'),
  };
}

type BlockAction = 'created' | 'inserted' | 'upgraded' | 'unchanged' | 'removed' | 'absent';

function readTargetFile(targetPath: string): string | null {
  return fs.existsSync(targetPath) ? fs.readFileSync(targetPath, 'utf-8') : null;
}

/** Whether the given block is currently present in the target file. */
function blockExists(spec: BlockSpec, targetPath: string): boolean {
  const current = readTargetFile(targetPath);
  return current !== null && spec.startRe.test(current);
}

function buildWrappedBlock(spec: BlockSpec): string {
  const blockContent = fs.readFileSync(path.join(TEMPLATES_DIR, spec.templateFile), 'utf-8').trimEnd();
  return `${spec.startMarker}\n${blockContent}\n${spec.endMarker}`;
}

/** Find an existing block's [start, end) byte range, or null. Throws if the start marker has no matching end. */
function locateBlock(current: string, spec: BlockSpec): { start: number; end: number } | null {
  const startMatch = current.match(spec.startRe);
  if (!startMatch) return null;
  const startIdx = current.indexOf(startMatch[0]);
  const endIdx = current.indexOf(spec.endMarker, startIdx);
  if (endIdx === -1) {
    throw new Error(`Found ${startMatch[0]} but no matching ${spec.endMarker} in ${CLAUDE_MD_PATH}. Fix manually or remove the start marker and re-run.`);
  }
  return { start: startIdx, end: endIdx + spec.endMarker.length };
}

/**
 * Install (install=true) or remove (install=false) a block in the target file, idempotently.
 * User content outside the markers is preserved.
 */
function applyBlock(spec: BlockSpec, install: boolean, dryRun: boolean, targetPath: string): BlockAction {
  const current = readTargetFile(targetPath);

  // Removal path — strip the marker pair and its content, collapsing the surrounding blank lines.
  if (!install) {
    if (current === null) return 'absent';
    const loc = locateBlock(current, spec);
    if (!loc) return 'absent';
    const before = current.slice(0, loc.start).replace(/\n+$/, '\n');
    const after = current.slice(loc.end).replace(/^\n+/, '');
    let next = before + after;
    if (next.length > 0 && !next.endsWith('\n')) next += '\n';
    if (!dryRun) fs.writeFileSync(targetPath, next, 'utf-8');
    return 'removed';
  }

  // Install path.
  const wrappedBlock = buildWrappedBlock(spec);

  if (current === null) {
    if (!dryRun) {
      const targetDir = path.dirname(targetPath);
      if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(targetPath, wrappedBlock + '\n', 'utf-8');
    }
    return 'created';
  }

  const loc = locateBlock(current, spec);
  if (!loc) {
    // No existing block — append.
    const sep = current.endsWith('\n') ? '\n' : '\n\n';
    const next = current + sep + wrappedBlock + '\n';
    if (!dryRun) fs.writeFileSync(targetPath, next, 'utf-8');
    return 'inserted';
  }

  const existingBlock = current.substring(loc.start, loc.end);
  if (existingBlock === wrappedBlock) {
    return 'unchanged';
  }
  const next = current.substring(0, loc.start) + wrappedBlock + current.substring(loc.end);
  if (!dryRun) fs.writeFileSync(targetPath, next, 'utf-8');
  return 'upgraded';
}

async function promptYesNo(question: string, defaultYes: boolean): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    if (answer === '') return defaultYes;
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

/**
 * Decide what to do with the optional restructure-on-sync rule.
 * Returns true (install), false (remove/skip), or undefined (leave current state untouched).
 *
 * Precedence: explicit flags > interactive prompt > leave-as-is (non-TTY / dry-run).
 */
async function resolveRestructureChoice(options: SetupOptions, alreadyInstalled: boolean): Promise<boolean | undefined> {
  if (options.noRestructure) return false;
  if (options.withRestructure) return true;
  if (options.dryRun) return undefined;
  if (!process.stdin.isTTY) return undefined;

  console.log('');
  console.log('Optional rule — "Restructure notes on sync":');
  console.log('  When you sync a note that grew by accretion (bolt-on sections, duplicated');
  console.log('  passages, a chronological patch-log), Claude first restructures it into one');
  console.log('  coherent narrative led by the root cause — preserving diagrams, inventories,');
  console.log('  and snippets — instead of pushing the sprawl as-is.');
  console.log('  This rewrites note *body* text on sync (broader than /noesis-refine-note).');
  const suffix = alreadyInstalled ? ' [Y/n] ' : ' [y/N] ';
  return promptYesNo(`Install this optional rule?${suffix}`, alreadyInstalled);
}

// Commands a prior version installed that have since been renamed or retired.
// Any stale copy under ~/.claude/commands/ is deleted on setup so users don't
// end up with both the old and the new command. (installSkills only ever wrote
// files, so without this a rename orphans the old one.) The `signature` guards
// against nuking an unrelated user file that happens to share the basename —
// we only delete a file that still contains a string unique to our old skill.
const RETIRED_SKILLS: Array<{ name: string; signature: string }> = [
  { name: 'skim-read', signature: 'apply_note_skim_read' },
];

interface SkillResult {
  name: string;
  action: 'created' | 'updated' | 'unchanged' | 'removed';
  path: string;
}

function installSkills(dryRun: boolean): SkillResult[] {
  if (!fs.existsSync(COMMANDS_DIR)) {
    if (!dryRun) fs.mkdirSync(COMMANDS_DIR, { recursive: true });
  }

  const scriptPath = path.join(SCRIPTS_DIR, 'noesis-sync.mjs').replace(/\\/g, '/');
  const captureWatcherPath = path.join(SCRIPTS_DIR, 'noesis-capture-watcher.mjs').replace(/\\/g, '/');
  const templates = fs.readdirSync(SKILL_TEMPLATES_DIR).filter((f) => f.endsWith('.md'));
  const results: SkillResult[] = [];

  for (const filename of templates) {
    const templatePath = path.join(SKILL_TEMPLATES_DIR, filename);
    const targetPath = path.join(COMMANDS_DIR, filename);
    let content = fs.readFileSync(templatePath, 'utf-8');
    content = content.replace(/\{\{NOESIS_MCP_SCRIPT_PATH\}\}/g, scriptPath);
    content = content.replace(/\{\{NOESIS_CAPTURE_WATCHER_PATH\}\}/g, captureWatcherPath);

    let action: SkillResult['action'];
    if (!fs.existsSync(targetPath)) {
      action = 'created';
    } else {
      const existing = fs.readFileSync(targetPath, 'utf-8');
      action = existing === content ? 'unchanged' : 'updated';
    }

    if (action !== 'unchanged' && !dryRun) {
      fs.writeFileSync(targetPath, content, 'utf-8');
    }

    results.push({ name: filename.replace(/\.md$/, ''), action, path: targetPath });
  }

  // Remove any retired command left behind by an earlier install (only if the
  // file is still recognizably ours — see RETIRED_SKILLS).
  for (const { name, signature } of RETIRED_SKILLS) {
    const stalePath = path.join(COMMANDS_DIR, `${name}.md`);
    if (fs.existsSync(stalePath) && fs.readFileSync(stalePath, 'utf-8').includes(signature)) {
      if (!dryRun) fs.unlinkSync(stalePath);
      results.push({ name, action: 'removed', path: stalePath });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Optional /noesis-capture SessionEnd hook (opt-in).
//
// Registers a SessionEnd hook in ~/.claude/settings.json so that when a capture
// controller session ends, its background watchers are marked stopped and killed.
// The /noesis-capture skill itself is always installed (it's a normal skill
// template); only this hook — which touches settings.json and runs on every
// session exit — is gated behind opt-in, mirroring the restructure-on-sync rule.
// ---------------------------------------------------------------------------

const CAPTURE_HOOK_MARKER = 'noesis-capture-session-end';

/** The exact command we register for the SessionEnd hook (packaged script). */
function captureHookCommand(): string {
  const script = path.join(SCRIPTS_DIR, 'noesis-capture-session-end.mjs').replace(/\\/g, '/');
  return `node "${script}"`;
}

/** A non-null, non-array object. */
function isPlainObject(v: any): boolean {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Parse settings.json, or null if absent. Throws on malformed JSON (never clobber it). */
function readSettings(): any | null {
  if (!fs.existsSync(SETTINGS_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
  } catch {
    throw new Error(`Could not parse ${SETTINGS_PATH} as JSON. Fix it manually and re-run.`);
  }
}

/** Whether any SessionEnd hook command is ours. */
function settingsHasCaptureHook(settings: any): boolean {
  const arr = settings?.hooks?.SessionEnd;
  if (!Array.isArray(arr)) return false;
  return arr.some(
    (e: any) =>
      Array.isArray(e?.hooks) &&
      e.hooks.some((h: any) => typeof h?.command === 'string' && h.command.includes(CAPTURE_HOOK_MARKER)),
  );
}

/** Tolerant presence check for the interactive prompt default (never throws). */
function captureHookInstalled(): boolean {
  try {
    const s = readSettings();
    return s !== null && settingsHasCaptureHook(s);
  } catch {
    return false;
  }
}

/**
 * Install or remove the capture SessionEnd hook in settings.json, idempotently.
 * Other hooks and settings are preserved. Returns the action taken.
 */
function registerCaptureHook(install: boolean, dryRun: boolean): BlockAction {
  let settings = readSettings();
  const existed = settings !== null;
  const command = captureHookCommand();

  // Removal path.
  if (!install) {
    if (!settings || !settingsHasCaptureHook(settings)) return 'absent';
    const arr = settings.hooks.SessionEnd as any[];
    settings.hooks.SessionEnd = arr
      .map((e) => {
        if (Array.isArray(e?.hooks)) {
          e.hooks = e.hooks.filter(
            (h: any) => !(typeof h?.command === 'string' && h.command.includes(CAPTURE_HOOK_MARKER)),
          );
        }
        return e;
      })
      .filter((e) => !Array.isArray(e?.hooks) || e.hooks.length > 0);
    if (settings.hooks.SessionEnd.length === 0) delete settings.hooks.SessionEnd;
    if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;
    if (!dryRun) fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
    return 'removed';
  }

  // Install path. Refuse to touch a settings.json with an unexpected shape rather
  // than silently discarding data or reporting a write that JSON.stringify drops
  // (e.g. a named prop set on an array).
  if (!settings) settings = {};
  if (!isPlainObject(settings)) {
    throw new Error(`Unexpected JSON root in ${SETTINGS_PATH} (expected an object). Fix it manually and re-run.`);
  }
  if (settings.hooks == null) {
    settings.hooks = {};
  } else if (!isPlainObject(settings.hooks)) {
    throw new Error(`"hooks" in ${SETTINGS_PATH} is not an object. Fix it manually and re-run.`);
  }
  if (settings.hooks.SessionEnd == null) {
    settings.hooks.SessionEnd = [];
  } else if (!Array.isArray(settings.hooks.SessionEnd)) {
    throw new Error(`"hooks.SessionEnd" in ${SETTINGS_PATH} is not an array. Fix it manually and re-run.`);
  }
  const arr = settings.hooks.SessionEnd as any[];

  let found = false;
  let changed = false;
  for (const e of arr) {
    if (!Array.isArray(e?.hooks)) continue;
    for (const h of e.hooks) {
      if (typeof h?.command === 'string' && h.command.includes(CAPTURE_HOOK_MARKER)) {
        found = true;
        if (h.command !== command) {
          h.command = command; // upgrade a stale path (e.g. package moved)
          changed = true;
        }
      }
    }
  }
  if (!found) {
    arr.push({ matcher: '', hooks: [{ type: 'command', command }] });
  }
  if (found && !changed) return 'unchanged';
  if (!dryRun) {
    if (!fs.existsSync(CLAUDE_DIR)) fs.mkdirSync(CLAUDE_DIR, { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  }
  return existed ? (found ? 'upgraded' : 'inserted') : 'created';
}

/**
 * Decide what to do with the optional capture SessionEnd hook.
 * Returns true (install), false (remove/skip), or undefined (leave current state).
 * Precedence: explicit flags > interactive prompt > leave-as-is (non-TTY / dry-run).
 */
async function resolveCaptureChoice(options: SetupOptions, alreadyInstalled: boolean): Promise<boolean | undefined> {
  if (options.noCapture) return false;
  if (options.withCapture) return true;
  if (options.dryRun) return undefined;
  if (!process.stdin.isTTY) return undefined;

  console.log('');
  console.log('Optional feature — "/noesis-capture" session-capture auto-cleanup:');
  console.log('  The /noesis-capture skill mirrors live Claude Code sessions into Noesis notes.');
  console.log('  This optional SessionEnd hook auto-stops a capture\'s background watchers when');
  console.log('  the controller session ends (otherwise you run "/noesis-capture stop" yourself).');
  console.log('  It adds a fast, fail-safe hook to ~/.claude/settings.json that runs on session exit.');
  const suffix = alreadyInstalled ? ' [Y/n] ' : ' [y/N] ';
  return promptYesNo(`Install this optional hook?${suffix}`, alreadyInstalled);
}

// ---------------------------------------------------------------------------
// Optional Jot ticket hook (opt-in).
//
// Copies scripts/noesis-ticket-session.mjs to ~/.claude/hooks/ and runs it from four
// events, so a session bound to a Jot ticket keeps its status current without relying on
// the model's memory: a reminder on every prompt, Ready to implement / Implementing at the
// plan steps (back to Planning after a rejected plan, and no other status), and a closed ticket never moves. The copy (not the package
// path, as the capture hook uses) gives a stable path that survives an npx cache or a
// moved checkout; every setup run while the hook is installed refreshes the copy, so an
// upgrade never leaves an old hook behind. It also allows the six ticket tools, so the
// bookkeeping never stops at a permission prompt, and writes the per-computer switch file
// ~/.claude/noesis-ticket.json ({"enabled": true, "repos": []}) when there is none. Listing
// repos there turns on the "which ticket?" checkpoint, the commit trailer, the push read-back
// and the session-start checks in those repos (TCK-1838).
// ---------------------------------------------------------------------------

const TICKET_HOOK_FILE = 'noesis-ticket-session.mjs';
const TICKET_HOOK_MARKER = 'noesis-ticket-session';
/** The owner's earlier hand-installed hook (claude-config hooks/tck-session.js): replaced in place on install. */
const LEGACY_TICKET_HOOK_RE = /(?:^|[\s"'\\/])tck-session\.js\b/;
const HOOKS_DIR = path.join(CLAUDE_DIR, 'hooks');
const TICKET_HOOK_PATH = path.join(HOOKS_DIR, TICKET_HOOK_FILE);
const TICKET_HOOK_EVENTS: ReadonlyArray<{ event: string; matcher: string }> = [
  { event: 'UserPromptSubmit', matcher: '' },
  { event: 'PreToolUse', matcher: '*' },
  // Bash: the branch record and the push read-back; AskUserQuestion: the owner's "Ticket" answer.
  { event: 'PostToolUse', matcher: 'ExitPlanMode|Bash|AskUserQuestion|mcp__noesis__backlog_(bind|set_status|unbind|refine|ship)' },
  // Stale bindings, the reconcile and the /clear hint; never on compact.
  { event: 'SessionStart', matcher: 'startup|resume|clear' },
];
/** The hook's per-computer switch. Missing means the hook does nothing at all; setup writes this
 *  default so an installed hook keeps working, and the owner lists repos in it for the checkpoint. */
const TICKET_SWITCH_PATH = path.join(CLAUDE_DIR, 'noesis-ticket.json');
const TICKET_SWITCH_DEFAULT = { enabled: true, repos: [] as unknown[] };
const TICKET_TOOLS_ALLOW = [
  'mcp__noesis__backlog_get',
  'mcp__noesis__backlog_bind',
  'mcp__noesis__backlog_set_status',
  'mcp__noesis__backlog_unbind',
  'mcp__noesis__backlog_refine',
  'mcp__noesis__backlog_ship',
];

/** The exact command we register: the copied script, absolute, forward slashes. */
function ticketHookCommand(): string {
  return `node "${TICKET_HOOK_PATH.replace(/\\/g, '/')}"`;
}

/** The script a `node <path>` command runs, with ~ expanded, for comparing two spellings. */
function commandScript(cmd: string): string | null {
  const m = cmd.trim().match(/^node(?:\.exe)?\s+(?:"([^"]+)"|'([^']+)'|(\S+))$/i);
  if (!m) return null;
  let p = m[1] ?? m[2] ?? m[3];
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = path.join(os.homedir(), p.slice(2));
  const norm = path.resolve(p).replace(/\\/g, '/');
  return process.platform === 'win32' ? norm.toLowerCase() : norm;
}

const isOurTicketCommand = (cmd: unknown): boolean => typeof cmd === 'string' && cmd.includes(TICKET_HOOK_MARKER);
const isLegacyTicketCommand = (cmd: unknown): boolean =>
  typeof cmd === 'string' && !cmd.includes(TICKET_HOOK_MARKER) && LEGACY_TICKET_HOOK_RE.test(cmd);
/** Ours and pointing at the copied file (absolute or ~/ spelling). */
const isCanonicalTicketCommand = (cmd: string): boolean => {
  const a = commandScript(cmd);
  return a !== null && a === commandScript(ticketHookCommand());
};

/** Two matchers select the same tools: '' / '*' / absent all mean "every tool". */
function sameMatcher(a: unknown, b: string): boolean {
  const all = (m: unknown) => m == null || m === '' || m === '*';
  return all(a) && all(b) ? true : a === b;
}

/** Whether any registered hook command is ours (the legacy owner hook does not count). */
function settingsHasTicketHook(settings: any): boolean {
  const hooks = settings?.hooks;
  if (!isPlainObject(hooks)) return false;
  return TICKET_HOOK_EVENTS.some(({ event }) => {
    const arr = hooks[event];
    return (
      Array.isArray(arr) &&
      arr.some((g: any) => Array.isArray(g?.hooks) && g.hooks.some((h: any) => isOurTicketCommand(h?.command)))
    );
  });
}

/** Tolerant presence check for the interactive prompt default (never throws). */
function ticketHookInstalled(): boolean {
  try {
    const s = readSettings();
    return s !== null && settingsHasTicketHook(s);
  } catch {
    return false;
  }
}

/** Refuse a settings.json whose shape we would have to guess at (never discard the user's data). */
function assertTicketSettingsShape(settings: any): void {
  if (!isPlainObject(settings)) {
    throw new Error(`Unexpected JSON root in ${SETTINGS_PATH} (expected an object). Fix it manually and re-run.`);
  }
  if (settings.hooks != null && !isPlainObject(settings.hooks)) {
    throw new Error(`"hooks" in ${SETTINGS_PATH} is not an object. Fix it manually and re-run.`);
  }
  for (const { event } of TICKET_HOOK_EVENTS) {
    const arr = settings.hooks?.[event];
    if (arr != null && !Array.isArray(arr)) {
      throw new Error(`"hooks.${event}" in ${SETTINGS_PATH} is not an array. Fix it manually and re-run.`);
    }
  }
  if (settings.permissions != null && !isPlainObject(settings.permissions)) {
    throw new Error(`"permissions" in ${SETTINGS_PATH} is not an object. Fix it manually and re-run.`);
  }
  if (settings.permissions?.allow != null && !Array.isArray(settings.permissions.allow)) {
    throw new Error(`"permissions.allow" in ${SETTINGS_PATH} is not an array. Fix it manually and re-run.`);
  }
}

type FileAction = 'created' | 'updated' | 'unchanged' | 'removed' | 'absent';

/**
 * Install or remove the ticket hook, idempotently: the copied script plus one command per
 * event, checked by matcher AND command (added to an existing group with the same matcher,
 * so other hooks in that group stay where they are; a copy under another matcher moves).
 * Only our own command is ever changed or removed.
 */
function registerTicketHook(install: boolean, dryRun: boolean): { settings: BlockAction; file: FileAction; switchFile: 'created' | 'kept' | 'left' } {
  const loaded = readSettings(); // throws on malformed JSON — before anything is copied
  const existed = loaded !== null;
  const settings = loaded ?? {};
  assertTicketSettingsShape(settings);
  const wasInstalled = settingsHasTicketHook(settings);
  const command = ticketHookCommand();
  let changed = false;

  if (!install) {
    if (isPlainObject(settings.hooks)) {
      for (const { event } of TICKET_HOOK_EVENTS) {
        const arr = settings.hooks[event];
        if (!Array.isArray(arr)) continue;
        for (const g of arr) {
          if (!Array.isArray(g?.hooks)) continue;
          const kept = g.hooks.filter((h: any) => !isOurTicketCommand(h?.command));
          if (kept.length !== g.hooks.length) {
            g.hooks = kept;
            changed = true;
          }
        }
        settings.hooks[event] = arr.filter((g: any) => !Array.isArray(g?.hooks) || g.hooks.length > 0);
        if (settings.hooks[event].length === 0) delete settings.hooks[event];
      }
      if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
    }
    if (changed && !dryRun) fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
    let file: FileAction = 'absent';
    if (fs.existsSync(TICKET_HOOK_PATH)) {
      if (!dryRun) fs.unlinkSync(TICKET_HOOK_PATH);
      file = 'removed';
    }
    // The switch file is the owner's configuration: removing the hook leaves it.
    return { settings: changed ? 'removed' : 'absent', file, switchFile: 'left' };
  }

  // The copied script: refreshed whenever its content differs.
  const content = fs.readFileSync(path.join(SCRIPTS_DIR, TICKET_HOOK_FILE), 'utf-8');
  let file: FileAction;
  if (!fs.existsSync(TICKET_HOOK_PATH)) file = 'created';
  else file = fs.readFileSync(TICKET_HOOK_PATH, 'utf-8') === content ? 'unchanged' : 'updated';
  if (file !== 'unchanged' && !dryRun) {
    fs.mkdirSync(HOOKS_DIR, { recursive: true });
    fs.writeFileSync(TICKET_HOOK_PATH, content, 'utf-8');
  }
  // Without the switch file the hook does nothing, so an install writes the default (never over
  // an existing one: it holds the owner's repo list and any "enabled": false).
  const switchFile = fs.existsSync(TICKET_SWITCH_PATH) ? 'kept' : 'created';
  if (switchFile === 'created' && !dryRun) {
    fs.mkdirSync(CLAUDE_DIR, { recursive: true });
    fs.writeFileSync(TICKET_SWITCH_PATH, JSON.stringify(TICKET_SWITCH_DEFAULT, null, 2) + '\n', 'utf-8');
  }

  if (settings.hooks == null) settings.hooks = {};
  for (const { event, matcher } of TICKET_HOOK_EVENTS) {
    if (settings.hooks[event] == null) settings.hooks[event] = [];
    const arr = settings.hooks[event] as any[];
    let found = false;
    for (const g of arr) {
      if (!Array.isArray(g?.hooks)) continue;
      const rightMatcher = sameMatcher(g.matcher, matcher);
      g.hooks = g.hooks.filter((h: any) => {
        const cmd = h?.command;
        if (!isOurTicketCommand(cmd) && !isLegacyTicketCommand(cmd)) return true;
        if (found || !rightMatcher) {
          // A second copy in this event, or one under a matcher that would not fire for
          // every tool the hook needs: drop it (the right group gets the command below).
          changed = true;
          return false;
        }
        found = true;
        if (!isCanonicalTicketCommand(cmd)) {
          h.command = command; // a legacy hook or a stale path, replaced in place
          changed = true;
        }
        return true;
      });
    }
    settings.hooks[event] = arr.filter((g: any) => !Array.isArray(g?.hooks) || g.hooks.length > 0);
    if (!found) {
      const group = (settings.hooks[event] as any[]).find((g: any) => sameMatcher(g?.matcher, matcher) && Array.isArray(g?.hooks));
      if (group) group.hooks.push({ type: 'command', command });
      else settings.hooks[event].push({ matcher, hooks: [{ type: 'command', command }] });
      changed = true;
    }
  }
  if (settings.permissions == null) settings.permissions = {};
  if (settings.permissions.allow == null) settings.permissions.allow = [];
  for (const name of TICKET_TOOLS_ALLOW) {
    if (!settings.permissions.allow.includes(name)) {
      settings.permissions.allow.push(name);
      changed = true;
    }
  }

  if (changed && !dryRun) {
    fs.mkdirSync(CLAUDE_DIR, { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  }
  const action: BlockAction = !changed ? 'unchanged' : !existed ? 'created' : wasInstalled ? 'upgraded' : 'inserted';
  return { settings: action, file, switchFile };
}

/**
 * Decide what to do with the optional ticket hook.
 * Returns true (install), false (remove), or undefined (leave current state).
 * Precedence: explicit flags > interactive prompt > leave-as-is (non-TTY / dry-run).
 */
async function resolveTicketHookChoice(options: SetupOptions, alreadyInstalled: boolean): Promise<boolean | undefined> {
  if (options.noTicketHook) return false;
  if (options.withTicketHook) return true;
  if (options.dryRun) return undefined;
  if (!process.stdin.isTTY) return undefined;

  console.log('');
  console.log('Optional feature — Jot ticket hook:');
  console.log('  When this session works on a Jot ticket (TCK-<n>), the hook reminds Claude of the');
  console.log('  ticket on every prompt and moves its status at the plan steps (Ready to implement,');
  console.log('  then Implementing, and back to Planning if you reject the plan) — never any other status,');
  console.log('  and never for a Shipped or Dropped ticket.');
  console.log('  It copies a small, fail-safe script to ~/.claude/hooks/, adds four hook entries');
  console.log('  and six allowed ticket tools to ~/.claude/settings.json, and writes the switch file');
  console.log('  ~/.claude/noesis-ticket.json if there is none.');
  const suffix = alreadyInstalled ? ' [Y/n] ' : ' [y/N] ';
  return promptYesNo(`Install this optional hook?${suffix}`, alreadyInstalled);
}

function printMcpRegistrationHint(): void {
  // Resolve the absolute path to the running MCP server entry.
  const entry = path.join(PACKAGE_ROOT, 'dist', 'index.js').replace(/\\/g, '/');
  console.log('');
  console.log('───────────────────────────────────────────────────────────────');
  console.log('Final step: register the Noesis MCP server with Claude Code.');
  console.log('───────────────────────────────────────────────────────────────');
  console.log('');
  console.log('Get your API token from https://noesisbrain.com (Settings → API Tokens),');
  console.log('then run:');
  console.log('');
  console.log('  claude mcp add noesis --scope user \\');
  console.log('    -e NOESIS_API_TOKEN="noe_your_token_here" \\');
  console.log('    -e NOESIS_API_URL="https://noesisbrain.com" \\');
  console.log('    -e GEMINI_API_KEY="optional_gemini_key" \\');
  console.log(`    -- node "${entry}"`);
  console.log('');
  console.log('After that, restart Claude Code so the new system prompt and MCP server load.');
  console.log('');
}

/**
 * Registration hint for VS Code Copilot. Unlike `claude mcp add`, Copilot has no
 * CLI for this — it's a JSON file edited via the Command Palette. The root key is
 * "servers" (not "mcpServers" like Claude/Cursor), and secrets go through an
 * "inputs" promptString reference rather than a literal value in the file.
 */
function printCopilotMcpRegistrationHint(): void {
  const entry = path.join(PACKAGE_ROOT, 'dist', 'index.js').replace(/\\/g, '/');
  console.log('');
  console.log('───────────────────────────────────────────────────────────────');
  console.log('Final step: register the Noesis MCP server with Copilot.');
  console.log('───────────────────────────────────────────────────────────────');
  console.log('');
  console.log('In VS Code, open the Command Palette → "MCP: Open User Configuration"');
  console.log('(or "MCP: Add Server" for a guided flow), and add:');
  console.log('');
  console.log('  {');
  console.log('    "inputs": [');
  console.log('      { "type": "promptString", "id": "noesis-token", "description": "Noesis API Token", "password": true }');
  console.log('    ],');
  console.log('    "servers": {');
  console.log('      "noesis": {');
  console.log('        "type": "stdio",');
  console.log('        "command": "node",');
  console.log(`        "args": ["${entry}"],`);
  console.log('        "env": {');
  console.log('          "NOESIS_API_TOKEN": "${input:noesis-token}",');
  console.log('          "NOESIS_API_URL": "https://noesisbrain.com"');
  console.log('        }');
  console.log('      }');
  console.log('    }');
  console.log('  }');
  console.log('');
  console.log('VS Code will prompt for the token on first use and store it securely.');
  console.log('');
}

async function runClaudeSetup(options: SetupOptions): Promise<void> {
  console.log(`  CLAUDE.md target:   ${CLAUDE_MD_PATH}`);
  console.log(`  Commands target:    ${COMMANDS_DIR}`);
  console.log('');

  if (!options.skillsOnly) {
    const coreAction = applyBlock(CORE_BLOCK, true, options.dryRun, CLAUDE_MD_PATH);
    console.log(`  CLAUDE.md: ${coreAction}`);

    // Optional opt-in rule. State is persisted as the block's presence in CLAUDE.md,
    // so re-runs default the prompt to the current state and never lose the user's choice.
    const alreadyInstalled = blockExists(RESTRUCTURE_BLOCK, CLAUDE_MD_PATH);
    const choice = await resolveRestructureChoice(options, alreadyInstalled);
    if (choice === undefined) {
      console.log(`  Restructure-on-sync rule: ${alreadyInstalled ? 'kept (installed)' : 'not installed'}`);
    } else {
      const action = applyBlock(RESTRUCTURE_BLOCK, choice, options.dryRun, CLAUDE_MD_PATH);
      console.log(`  Restructure-on-sync rule: ${action}`);
    }
  } else {
    console.log('  CLAUDE.md: skipped (--skills-only)');
  }

  if (!options.claudeMdOnly) {
    const skillResults = installSkills(options.dryRun);
    for (const r of skillResults) {
      console.log(`  Skill /${r.name}: ${r.action}`);
    }

    // Optional opt-in SessionEnd hook for /noesis-capture. State is persisted as
    // the hook's presence in settings.json, so re-runs default the prompt to the
    // current state and never lose the user's choice.
    const captureAlready = captureHookInstalled();
    const captureChoice = await resolveCaptureChoice(options, captureAlready);
    if (captureChoice === undefined) {
      console.log(`  Capture SessionEnd hook: ${captureAlready ? 'kept (installed)' : 'not installed'}`);
    } else {
      const action = registerCaptureHook(captureChoice, options.dryRun);
      console.log(`  Capture SessionEnd hook: ${action}`);
    }

    // Optional opt-in Jot ticket hook. While it is installed, every run refreshes it (the
    // copied script and its entries), so an upgraded package never leaves an old hook.
    const ticketAlready = ticketHookInstalled();
    const ticketChoice = await resolveTicketHookChoice(options, ticketAlready);
    const ticketInstall = ticketChoice ?? (ticketAlready ? true : undefined);
    if (ticketInstall === undefined) {
      console.log('  Ticket hook: not installed');
    } else {
      const r = registerTicketHook(ticketInstall, options.dryRun);
      const kept = ticketChoice === undefined ? 'kept (installed); ' : '';
      console.log(`  Ticket hook: ${kept}settings ${r.settings}, script ${r.file}, switch file ${r.switchFile}`);
    }
  } else {
    console.log('  Skills: skipped (--claude-md-only)');
  }

  if (!options.dryRun) {
    printMcpRegistrationHint();
  } else {
    console.log('');
    console.log('Dry-run complete. Re-run without --dry-run to apply.');
  }
}

/**
 * Copilot support is instructions-only: it installs the same portable conventions
 * blocks into a per-repo .github/copilot-instructions.md instead of the global
 * ~/.claude/CLAUDE.md. Skills (slash-commands) and the capture SessionEnd hook are
 * Claude-Code-specific mechanisms with no Copilot analog, so they're not offered here.
 */
async function runCopilotSetup(options: SetupOptions): Promise<void> {
  if (options.skillsOnly || options.claudeMdOnly) {
    throw new Error(
      '--skills-only and --claude-md-only are not applicable with --client=copilot: ' +
        'Copilot setup only installs the conventions blocks (no skills/commands exist for Copilot yet).',
    );
  }

  console.log(`  Instructions target: ${COPILOT_INSTRUCTIONS_PATH}`);
  console.log('');

  const coreAction = applyBlock(CORE_BLOCK, true, options.dryRun, COPILOT_INSTRUCTIONS_PATH);
  console.log(`  copilot-instructions.md: ${coreAction}`);

  const alreadyInstalled = blockExists(RESTRUCTURE_BLOCK, COPILOT_INSTRUCTIONS_PATH);
  const choice = await resolveRestructureChoice(options, alreadyInstalled);
  if (choice === undefined) {
    console.log(`  Restructure-on-sync rule: ${alreadyInstalled ? 'kept (installed)' : 'not installed'}`);
  } else {
    const action = applyBlock(RESTRUCTURE_BLOCK, choice, options.dryRun, COPILOT_INSTRUCTIONS_PATH);
    console.log(`  Restructure-on-sync rule: ${action}`);
  }

  console.log('');
  console.log('Note: .github/copilot-instructions.md is typically committed to the repo so');
  console.log('teammates share these conventions in Copilot Chat — unlike the personal, global');
  console.log('~/.claude/CLAUDE.md used for Claude Code.');

  if (!options.dryRun) {
    printCopilotMcpRegistrationHint();
  } else {
    console.log('');
    console.log('Dry-run complete. Re-run without --dry-run to apply.');
  }
}

export async function runSetup(argv: string[]): Promise<void> {
  const options = parseArgs(argv);
  const note = options.dryRun ? ' (dry-run)' : '';

  console.log(`noesis-mcp setup${note} [--client=${options.client}]`);

  if (options.client === 'copilot') {
    await runCopilotSetup(options);
  } else {
    await runClaudeSetup(options);
  }
}
