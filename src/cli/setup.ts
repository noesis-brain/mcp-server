/**
 * `noesis-mcp setup` — install CLAUDE.md conventions and skills into ~/.claude/.
 *
 * Idempotent: re-running upgrades the bracketed block / overwrites versioned
 * skill files in place. User edits outside the markers are preserved.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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

const BLOCK_VERSION = 'v1';
const BLOCK_START = `<!-- noesis-mcp-server:start ${BLOCK_VERSION} -->`;
const BLOCK_END = `<!-- noesis-mcp-server:end -->`;
// Loose start marker (any version) used to find existing blocks during upgrade.
const BLOCK_START_RE = /<!-- noesis-mcp-server:start [^>]*-->/;

interface SetupOptions {
  claudeMdOnly: boolean;
  skillsOnly: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): SetupOptions {
  return {
    claudeMdOnly: argv.includes('--claude-md-only'),
    skillsOnly: argv.includes('--skills-only'),
    dryRun: argv.includes('--dry-run'),
  };
}

function installClaudeMd(dryRun: boolean): { action: 'created' | 'inserted' | 'upgraded' | 'unchanged'; path: string } {
  const blockContent = fs.readFileSync(path.join(TEMPLATES_DIR, 'claude-md-block.md'), 'utf-8').trimEnd();
  const wrappedBlock = `${BLOCK_START}\n${blockContent}\n${BLOCK_END}`;

  if (!fs.existsSync(CLAUDE_DIR)) {
    if (!dryRun) fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  }

  if (!fs.existsSync(CLAUDE_MD_PATH)) {
    if (!dryRun) fs.writeFileSync(CLAUDE_MD_PATH, wrappedBlock + '\n', 'utf-8');
    return { action: 'created', path: CLAUDE_MD_PATH };
  }

  const current = fs.readFileSync(CLAUDE_MD_PATH, 'utf-8');
  const startMatch = current.match(BLOCK_START_RE);

  if (!startMatch) {
    // No existing block — append.
    const sep = current.endsWith('\n') ? '\n' : '\n\n';
    const next = current + sep + wrappedBlock + '\n';
    if (!dryRun) fs.writeFileSync(CLAUDE_MD_PATH, next, 'utf-8');
    return { action: 'inserted', path: CLAUDE_MD_PATH };
  }

  const startIdx = current.indexOf(startMatch[0]);
  const endIdx = current.indexOf(BLOCK_END, startIdx);
  if (endIdx === -1) {
    throw new Error(`Found ${startMatch[0]} but no matching ${BLOCK_END} in ${CLAUDE_MD_PATH}. Fix manually or remove the start marker and re-run.`);
  }

  const existingBlock = current.substring(startIdx, endIdx + BLOCK_END.length);
  if (existingBlock === wrappedBlock) {
    return { action: 'unchanged', path: CLAUDE_MD_PATH };
  }

  const next = current.substring(0, startIdx) + wrappedBlock + current.substring(endIdx + BLOCK_END.length);
  if (!dryRun) fs.writeFileSync(CLAUDE_MD_PATH, next, 'utf-8');
  return { action: 'upgraded', path: CLAUDE_MD_PATH };
}

interface SkillResult {
  name: string;
  action: 'created' | 'updated' | 'unchanged';
  path: string;
}

function installSkills(dryRun: boolean): SkillResult[] {
  if (!fs.existsSync(COMMANDS_DIR)) {
    if (!dryRun) fs.mkdirSync(COMMANDS_DIR, { recursive: true });
  }

  const scriptPath = path.join(SCRIPTS_DIR, 'noesis-sync.mjs').replace(/\\/g, '/');
  const templates = fs.readdirSync(SKILL_TEMPLATES_DIR).filter((f) => f.endsWith('.md'));
  const results: SkillResult[] = [];

  for (const filename of templates) {
    const templatePath = path.join(SKILL_TEMPLATES_DIR, filename);
    const targetPath = path.join(COMMANDS_DIR, filename);
    let content = fs.readFileSync(templatePath, 'utf-8');
    content = content.replace(/\{\{NOESIS_MCP_SCRIPT_PATH\}\}/g, scriptPath);

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

  return results;
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
    const result = installClaudeMd(options.dryRun);
    console.log(`  CLAUDE.md: ${result.action}`);
  } else {
    console.log('  CLAUDE.md: skipped (--skills-only)');
  }

  if (!options.claudeMdOnly) {
    const skillResults = installSkills(options.dryRun);
    for (const r of skillResults) {
      console.log(`  Skill /${r.name}: ${r.action}`);
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
