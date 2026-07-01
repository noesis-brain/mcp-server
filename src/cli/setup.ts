/**
 * `noesis-mcp setup` — install CLAUDE.md conventions and skills into ~/.claude/.
 *
 * Idempotent: re-running upgrades the bracketed block / overwrites versioned
 * skill files in place. User edits outside the markers are preserved.
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
const CORE_BLOCK_VERSION = 'v1';
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

interface SetupOptions {
  claudeMdOnly: boolean;
  skillsOnly: boolean;
  dryRun: boolean;
  withRestructure: boolean;
  noRestructure: boolean;
  withCapture: boolean;
  noCapture: boolean;
}

function parseArgs(argv: string[]): SetupOptions {
  return {
    claudeMdOnly: argv.includes('--claude-md-only'),
    skillsOnly: argv.includes('--skills-only'),
    dryRun: argv.includes('--dry-run'),
    withRestructure: argv.includes('--with-restructure-rule'),
    noRestructure: argv.includes('--no-restructure-rule'),
    withCapture: argv.includes('--with-capture'),
    noCapture: argv.includes('--no-capture'),
  };
}

type BlockAction = 'created' | 'inserted' | 'upgraded' | 'unchanged' | 'removed' | 'absent';

function readClaudeMd(): string | null {
  return fs.existsSync(CLAUDE_MD_PATH) ? fs.readFileSync(CLAUDE_MD_PATH, 'utf-8') : null;
}

/** Whether the given block is currently present in CLAUDE.md. */
function blockExists(spec: BlockSpec): boolean {
  const current = readClaudeMd();
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
 * Install (install=true) or remove (install=false) a block in CLAUDE.md, idempotently.
 * User content outside the markers is preserved.
 */
function applyBlock(spec: BlockSpec, install: boolean, dryRun: boolean): BlockAction {
  const current = readClaudeMd();

  // Removal path — strip the marker pair and its content, collapsing the surrounding blank lines.
  if (!install) {
    if (current === null) return 'absent';
    const loc = locateBlock(current, spec);
    if (!loc) return 'absent';
    const before = current.slice(0, loc.start).replace(/\n+$/, '\n');
    const after = current.slice(loc.end).replace(/^\n+/, '');
    let next = before + after;
    if (next.length > 0 && !next.endsWith('\n')) next += '\n';
    if (!dryRun) fs.writeFileSync(CLAUDE_MD_PATH, next, 'utf-8');
    return 'removed';
  }

  // Install path.
  const wrappedBlock = buildWrappedBlock(spec);

  if (current === null) {
    if (!dryRun) {
      if (!fs.existsSync(CLAUDE_DIR)) fs.mkdirSync(CLAUDE_DIR, { recursive: true });
      fs.writeFileSync(CLAUDE_MD_PATH, wrappedBlock + '\n', 'utf-8');
    }
    return 'created';
  }

  const loc = locateBlock(current, spec);
  if (!loc) {
    // No existing block — append.
    const sep = current.endsWith('\n') ? '\n' : '\n\n';
    const next = current + sep + wrappedBlock + '\n';
    if (!dryRun) fs.writeFileSync(CLAUDE_MD_PATH, next, 'utf-8');
    return 'inserted';
  }

  const existingBlock = current.substring(loc.start, loc.end);
  if (existingBlock === wrappedBlock) {
    return 'unchanged';
  }
  const next = current.substring(0, loc.start) + wrappedBlock + current.substring(loc.end);
  if (!dryRun) fs.writeFileSync(CLAUDE_MD_PATH, next, 'utf-8');
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

export async function runSetup(argv: string[]): Promise<void> {
  const options = parseArgs(argv);
  const note = options.dryRun ? ' (dry-run)' : '';

  console.log(`noesis-mcp setup${note}`);
  console.log(`  CLAUDE.md target:   ${CLAUDE_MD_PATH}`);
  console.log(`  Commands target:    ${COMMANDS_DIR}`);
  console.log('');

  if (!options.skillsOnly) {
    const coreAction = applyBlock(CORE_BLOCK, true, options.dryRun);
    console.log(`  CLAUDE.md: ${coreAction}`);

    // Optional opt-in rule. State is persisted as the block's presence in CLAUDE.md,
    // so re-runs default the prompt to the current state and never lose the user's choice.
    const alreadyInstalled = blockExists(RESTRUCTURE_BLOCK);
    const choice = await resolveRestructureChoice(options, alreadyInstalled);
    if (choice === undefined) {
      console.log(`  Restructure-on-sync rule: ${alreadyInstalled ? 'kept (installed)' : 'not installed'}`);
    } else {
      const action = applyBlock(RESTRUCTURE_BLOCK, choice, options.dryRun);
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
