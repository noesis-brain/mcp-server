/**
 * `noesis-mcp setup` — the opt-in Jot ticket hook (--with-ticket-hook / --no-ticket-hook)
 * and --all (TCK-1835).
 *
 * Every case runs the real runSetup against a fresh temporary HOME. setup.ts computes its
 * ~/.claude paths at import, so each case sets HOME/USERPROFILE first and re-imports the
 * module (vi.resetModules). stdin is forced non-interactive, so no flag means "leave the
 * current state" — the path a scripted `noesis-mcp setup` after an upgrade takes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'noesis-ticket-session.mjs');
const POST_MATCHER = 'ExitPlanMode|Bash|AskUserQuestion|mcp__noesis__backlog_(bind|set_status|unbind|refine|ship)';
const START_MATCHER = 'startup|resume|clear';
/** The 2.6.0 registration, for the upgrade test. */
const POST_MATCHER_260 = 'ExitPlanMode|mcp__noesis__backlog_(bind|set_status|unbind|refine)';
const ALLOW_260 = [
  'mcp__noesis__backlog_get',
  'mcp__noesis__backlog_bind',
  'mcp__noesis__backlog_set_status',
  'mcp__noesis__backlog_unbind',
  'mcp__noesis__backlog_refine',
];
const ALLOW = [...ALLOW_260, 'mcp__noesis__backlog_ship'];

let home: string;
let logs: string[];
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, isTTY: process.stdin.isTTY };

const claude = (...p: string[]) => path.join(home, '.claude', ...p);
const settingsPath = () => claude('settings.json');
const hookPath = () => claude('hooks', 'noesis-ticket-session.mjs');
const switchPath = () => claude('noesis-ticket.json');
const readSettings = () => JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
const writeSettings = (s: unknown) => {
  fs.mkdirSync(claude(), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(s, null, 2) + '\n');
};
const canonical = () => `node "${hookPath().replace(/\\/g, '/')}"`;

async function setup(...args: string[]): Promise<string> {
  vi.resetModules();
  logs = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    logs.push(a.join(' '));
  });
  try {
    const { runSetup } = await import('../src/cli/setup.js');
    await runSetup(args);
  } finally {
    log.mockRestore();
  }
  return logs.find((l) => l.includes('Ticket hook:')) ?? '';
}

/** Every command registered for an event, in order. */
const commands = (s: any, event: string): string[] =>
  (s.hooks?.[event] ?? []).flatMap((g: any) => (g.hooks ?? []).map((h: any) => h.command));

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'noesis-setup-hooks-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
});
afterEach(() => {
  process.env.HOME = saved.HOME;
  process.env.USERPROFILE = saved.USERPROFILE;
  Object.defineProperty(process.stdin, 'isTTY', { value: saved.isTTY, configurable: true });
  fs.rmSync(home, { recursive: true, force: true });
});

describe('--with-ticket-hook', () => {
  it('installs the copied script, four events, the six allowed tools and the switch file; a re-run changes nothing', async () => {
    const line = await setup('--with-ticket-hook');
    expect(line).toMatch(/Ticket hook: settings created, script created, switch file created/);
    expect(JSON.parse(fs.readFileSync(switchPath(), 'utf8'))).toEqual({ enabled: true, repos: [] });
    expect(fs.readFileSync(hookPath(), 'utf8')).toBe(fs.readFileSync(SCRIPT, 'utf8'));
    const s = readSettings();
    expect(s.hooks.UserPromptSubmit).toEqual([{ matcher: '', hooks: [{ type: 'command', command: canonical() }] }]);
    expect(s.hooks.PreToolUse).toEqual([{ matcher: '*', hooks: [{ type: 'command', command: canonical() }] }]);
    expect(s.hooks.PostToolUse).toEqual([{ matcher: POST_MATCHER, hooks: [{ type: 'command', command: canonical() }] }]);
    expect(s.hooks.SessionStart).toEqual([{ matcher: START_MATCHER, hooks: [{ type: 'command', command: canonical() }] }]);
    expect(s.permissions.allow).toEqual(ALLOW);
    expect(canonical()).toMatch(/^node "[^"\\]+noesis-ticket-session\.mjs"$/); // absolute, forward slashes

    const before = fs.readFileSync(settingsPath(), 'utf8');
    expect(await setup('--with-ticket-hook')).toMatch(/settings unchanged, script unchanged, switch file kept/);
    expect(fs.readFileSync(settingsPath(), 'utf8')).toBe(before);
  });

  it('TCK-1838: upgrades a 2.6.0 install — the PostToolUse matcher moves, SessionStart and backlog_ship are added', async () => {
    const cmd = canonical();
    writeSettings({
      hooks: {
        UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command: cmd }] }],
        PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: cmd }] }],
        PostToolUse: [
          { matcher: 'Write', hooks: [{ type: 'command', command: 'node other.js' }] },
          { matcher: POST_MATCHER_260, hooks: [{ type: 'command', command: cmd }] },
        ],
        SessionStart: [{ hooks: [{ type: 'command', command: 'node session-start.js' }] }],
      },
      permissions: { allow: ['Bash(ls:*)', ...ALLOW_260] },
    });
    const line = await setup('--with-ticket-hook');
    expect(line).toMatch(/settings upgraded/);
    const s = readSettings();
    expect(s.hooks.PostToolUse).toEqual([
      { matcher: 'Write', hooks: [{ type: 'command', command: 'node other.js' }] },
      { matcher: POST_MATCHER, hooks: [{ type: 'command', command: cmd }] },
    ]);
    expect(s.hooks.SessionStart).toEqual([
      { hooks: [{ type: 'command', command: 'node session-start.js' }] },
      { matcher: START_MATCHER, hooks: [{ type: 'command', command: cmd }] },
    ]);
    expect(s.permissions.allow).toEqual(['Bash(ls:*)', ...ALLOW]);
    expect(await setup('--with-ticket-hook')).toMatch(/settings unchanged/);
  });

  it('TCK-1838: an existing switch file (the owner\'s repo list, or "enabled": false) is never overwritten', async () => {
    fs.mkdirSync(claude(), { recursive: true });
    const mine = JSON.stringify({ enabled: false, repos: [{ remote: 'github.com/me/app', deployBranch: 'main' }] });
    fs.writeFileSync(switchPath(), mine);
    expect(await setup('--with-ticket-hook')).toMatch(/switch file kept/);
    expect(fs.readFileSync(switchPath(), 'utf8')).toBe(mine);
    await setup('--no-ticket-hook');
    expect(fs.readFileSync(switchPath(), 'utf8')).toBe(mine); // removing the hook leaves the owner's file
  });

  it('with no flag, an installed hook is kept AND refreshed: a stale copied script is rewritten', async () => {
    await setup('--with-ticket-hook');
    fs.writeFileSync(hookPath(), '// an old hook version\n');
    const line = await setup();
    expect(line).toMatch(/kept \(installed\); settings unchanged, script updated/);
    expect(fs.readFileSync(hookPath(), 'utf8')).toBe(fs.readFileSync(SCRIPT, 'utf8'));
  });

  it('with no flag and no hook, nothing is installed', async () => {
    expect(await setup()).toMatch(/Ticket hook: not installed/);
    expect(fs.existsSync(hookPath())).toBe(false);
    const s = fs.existsSync(settingsPath()) ? readSettings() : {};
    expect(commands(s, 'PreToolUse')).toEqual([]);
  });

  it('a ~/ spelling of the same path counts as installed and is left as it is', async () => {
    const tilde = 'node ~/.claude/hooks/noesis-ticket-session.mjs';
    writeSettings({
      hooks: {
        UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command: tilde }] }],
        PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: tilde }] }],
        PostToolUse: [{ matcher: POST_MATCHER, hooks: [{ type: 'command', command: tilde }] }],
        SessionStart: [{ matcher: START_MATCHER, hooks: [{ type: 'command', command: tilde }] }],
      },
      permissions: { allow: ALLOW },
    });
    const line = await setup('--with-ticket-hook');
    expect(line).toMatch(/settings unchanged, script created/);
    for (const e of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SessionStart']) expect(commands(readSettings(), e)).toEqual([tilde]);
  });

  it("replaces the owner's legacy tck-session.js in place, keeping the other hooks of a shared group", async () => {
    const legacy = 'node ~/.claude/hooks/tck-session.js';
    writeSettings({
      model: 'opus',
      hooks: {
        UserPromptSubmit: [
          { matcher: '', hooks: [{ type: 'command', command: 'node ~/.claude/hooks/english-coach.js' }, { type: 'command', command: legacy }, { type: 'command', command: 'node ~/.claude/hooks/other.js' }] },
        ],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node guard.js' }] }, { matcher: '*', hooks: [{ type: 'command', command: legacy }] }],
        PostToolUse: [{ matcher: POST_MATCHER, hooks: [{ type: 'command', command: legacy }] }],
      },
      permissions: { allow: ['Bash(ls:*)', 'mcp__noesis__backlog_get'] },
    });
    const line = await setup('--with-ticket-hook');
    expect(line).toMatch(/settings inserted/);
    const s = readSettings();
    expect(s.model).toBe('opus');
    expect(commands(s, 'UserPromptSubmit')).toEqual(['node ~/.claude/hooks/english-coach.js', canonical(), 'node ~/.claude/hooks/other.js']);
    expect(s.hooks.PreToolUse).toEqual([
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'node guard.js' }] },
      { matcher: '*', hooks: [{ type: 'command', command: canonical() }] },
    ]);
    expect(commands(s, 'PostToolUse')).toEqual([canonical()]);
    expect(s.permissions.allow).toEqual(['Bash(ls:*)', ...ALLOW]);
    expect(JSON.stringify(s)).not.toContain('tck-session.js');
  });

  it('adds to an existing group with the same matcher, and drops a second copy of our command', async () => {
    writeSettings({
      hooks: {
        UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command: 'node a.js' }] }],
        PreToolUse: [
          { matcher: '*', hooks: [{ type: 'command', command: canonical() }] },
          { matcher: '*', hooks: [{ type: 'command', command: canonical() }] },
        ],
      },
    });
    await setup('--with-ticket-hook');
    const s = readSettings();
    expect(s.hooks.UserPromptSubmit).toEqual([{ matcher: '', hooks: [{ type: 'command', command: 'node a.js' }, { type: 'command', command: canonical() }] }]);
    expect(s.hooks.PreToolUse).toEqual([{ matcher: '*', hooks: [{ type: 'command', command: canonical() }] }]);
  });
});

describe('matchers', () => {
  it('moves our command from a group with the wrong matcher to the right one; match-all spellings are equal', async () => {
    writeSettings({
      hooks: {
        // '' and '*' both mean every tool: an existing '' group for PreToolUse is fine
        PreToolUse: [{ hooks: [{ type: 'command', command: canonical() }] }],
        // ExitPlanMode alone would never fire for the ticket tools: move it
        PostToolUse: [
          { matcher: 'ExitPlanMode', hooks: [{ type: 'command', command: 'node other.js' }, { type: 'command', command: canonical() }] },
        ],
      },
    });
    const line = await setup('--with-ticket-hook');
    expect(line).toMatch(/settings upgraded/);
    const s = readSettings();
    expect(s.hooks.PreToolUse).toEqual([{ hooks: [{ type: 'command', command: canonical() }] }]);
    expect(s.hooks.PostToolUse).toEqual([
      { matcher: 'ExitPlanMode', hooks: [{ type: 'command', command: 'node other.js' }] },
      { matcher: POST_MATCHER, hooks: [{ type: 'command', command: canonical() }] },
    ]);
    expect(await setup('--with-ticket-hook')).toMatch(/settings unchanged/);
  });
});

describe('--no-ticket-hook', () => {
  it('removes only our command and the copied script; other hooks and the allowed tools stay', async () => {
    writeSettings({
      hooks: { UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command: 'node keep.js' }] }] },
    });
    await setup('--with-ticket-hook');
    const line = await setup('--no-ticket-hook');
    expect(line).toMatch(/settings removed, script removed/);
    const s = readSettings();
    expect(s.hooks).toEqual({ UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command: 'node keep.js' }] }] });
    expect(s.permissions.allow).toEqual(ALLOW);
    expect(fs.existsSync(hookPath())).toBe(false);
    expect(await setup('--no-ticket-hook')).toMatch(/settings absent, script absent/);
  });

  it("never removes the owner's legacy hook (it is not ours)", async () => {
    writeSettings({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'node ~/.claude/hooks/tck-session.js' }] }] } });
    expect(await setup('--no-ticket-hook')).toMatch(/settings absent/);
    expect(commands(readSettings(), 'PreToolUse')).toEqual(['node ~/.claude/hooks/tck-session.js']);
  });
});

describe('--all', () => {
  it('turns on every opt-in: the restructure rule, the capture hook and the ticket hook', async () => {
    await setup('--all');
    const md = fs.readFileSync(claude('CLAUDE.md'), 'utf8');
    expect(md).toContain('<!-- noesis-mcp-server:start v4 -->');
    expect(md).toMatch(/<!-- noesis-mcp-server:restructure-on-sync:start v\d+ -->/);
    const s = readSettings();
    expect(commands(s, 'SessionEnd').some((c) => c.includes('noesis-capture-session-end'))).toBe(true);
    expect(commands(s, 'PreToolUse')).toEqual([canonical()]);
    expect(fs.existsSync(hookPath())).toBe(true);
  });

  it('an explicit --no-* still wins over --all', async () => {
    await setup('--all', '--no-capture', '--no-restructure-rule');
    const md = fs.readFileSync(claude('CLAUDE.md'), 'utf8');
    expect(md).not.toMatch(/restructure-on-sync:start/);
    const s = readSettings();
    expect(commands(s, 'SessionEnd')).toEqual([]);
    expect(commands(s, 'PreToolUse')).toEqual([canonical()]);
  });

  it('--all --no-ticket-hook leaves the ticket hook out', async () => {
    await setup('--all', '--no-ticket-hook');
    expect(commands(readSettings(), 'PreToolUse')).toEqual([]);
    expect(fs.existsSync(hookPath())).toBe(false);
  });
});

describe('safety', () => {
  it('--dry-run writes nothing', async () => {
    const line = await setup('--with-ticket-hook', '--dry-run');
    expect(line).toMatch(/settings created, script created, switch file created/);
    expect(fs.existsSync(settingsPath())).toBe(false);
    expect(fs.existsSync(hookPath())).toBe(false);
    expect(fs.existsSync(switchPath())).toBe(false);
  });

  it('a malformed settings.json aborts before anything is copied, and is never overwritten', async () => {
    fs.mkdirSync(claude(), { recursive: true });
    fs.writeFileSync(settingsPath(), '{ "hooks": ');
    // No --no-capture here: that would make the capture step read (and reject) the file
    // first, and the test would pass even if the ticket step copied before validating.
    await expect(setup('--with-ticket-hook')).rejects.toThrow(/Could not parse/);
    expect(fs.readFileSync(settingsPath(), 'utf8')).toBe('{ "hooks": ');
    expect(fs.existsSync(hookPath())).toBe(false);
    expect(fs.existsSync(switchPath())).toBe(false);
  });

  it('an unexpected shape (hooks.PreToolUse not an array) aborts without writing', async () => {
    writeSettings({ hooks: { PreToolUse: { matcher: '*' } } });
    const before = fs.readFileSync(settingsPath(), 'utf8');
    await expect(setup('--with-ticket-hook', '--no-capture')).rejects.toThrow(/hooks\.PreToolUse/);
    expect(fs.readFileSync(settingsPath(), 'utf8')).toBe(before);
    expect(fs.existsSync(hookPath())).toBe(false);
  });
});
