/**
 * scripts/git-hooks/prepare-commit-msg — the "Ticket: TCK-<n>" trailer (TCK-1838).
 *
 * Each case makes a real git repo, installs the hook into its .git/hooks, and runs real git
 * commands with an isolated HOME that holds the per-computer switch file, a copy of the ticket
 * hook (~/.claude/hooks/noesis-ticket-session.mjs) and a binding cache. Nothing touches the
 * live ~/.claude. CLAUDE_CODE_SESSION_ID plays the Claude Code session that runs git.
 *
 * The RED cases matter most: a commit that is not this session's work (another tool, a reused
 * message, a rebase or cherry-pick, NOESIS_TICKET=none) must never get a trailer, and the hook
 * must never block or hang a commit.
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';

const ROOT = path.resolve(__dirname, '..');
const HOOK_SRC = path.join(ROOT, 'scripts', 'noesis-ticket-session.mjs');
const PCM = path.join(ROOT, 'scripts', 'git-hooks', 'prepare-commit-msg');
const SID = '7c1e2d3f-aaaa-4bbb-8ccc-000000000001';
const BOUND = { key: 'TCK-42', status: 'implementing', bound_session_id: SID, machine: "Tester's Mac" };

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

function home(opts: { switchFile?: Record<string, unknown> | null; cache?: Record<string, Record<string, unknown>> } = {}): string {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'trl-home-'));
  dirs.push(h);
  fs.mkdirSync(path.join(h, '.claude', 'hooks'), { recursive: true });
  fs.copyFileSync(HOOK_SRC, path.join(h, '.claude', 'hooks', 'noesis-ticket-session.mjs'));
  const sw = opts.switchFile === undefined ? { enabled: true, repos: [] } : opts.switchFile;
  if (sw) fs.writeFileSync(path.join(h, '.claude', 'noesis-ticket.json'), JSON.stringify(sw));
  const cache = opts.cache ?? { [SID]: BOUND };
  fs.mkdirSync(path.join(h, '.claude', 'tck-bindings'), { recursive: true });
  for (const [name, e] of Object.entries(cache)) {
    fs.writeFileSync(path.join(h, '.claude', 'tck-bindings', `${name}.json`), JSON.stringify({ checkedAt: Date.now(), ...e }));
  }
  return h;
}

const plain = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore', env: cleanEnv({}) });

/** The environment of a command outside Claude Code (no session id), plus `extra`. */
function cleanEnv(extra: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of ['CLAUDE_CODE_SESSION_ID', 'NOESIS_TICKET', 'NOESIS_TICKET_CONFIG', 'NOESIS_TICKET_HOOK', 'TCK_BINDINGS_DIR', 'TCK_SESSION_HOOK', 'GIT_REFLOG_ACTION']) delete env[k];
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env as NodeJS.ProcessEnv;
}

/** A repo on main with one commit, made before the hook was installed. */
function repo(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trl-repo-')));
  dirs.push(d);
  plain(d, 'init', '-q', '-b', 'main');
  plain(d, 'config', 'user.email', 't@example.invalid');
  plain(d, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(d, 'a.txt'), 'a\n');
  plain(d, 'add', 'a.txt');
  plain(d, 'commit', '-q', '-m', 'init');
  const dst = path.join(d, '.git', 'hooks', 'prepare-commit-msg');
  fs.copyFileSync(PCM, dst);
  fs.chmodSync(dst, 0o755);
  return d;
}

/** Run git as the Claude Code session (HOME = h, CLAUDE_CODE_SESSION_ID = SID unless overridden). */
function asSession(dir: string, h: string, args: string[], extra: Record<string, string | undefined> = {}) {
  return spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: cleanEnv({ HOME: h, USERPROFILE: h, CLAUDE_CODE_SESSION_ID: SID, ...extra }) });
}

function change(dir: string, name = 'b.txt'): void {
  fs.appendFileSync(path.join(dir, name), `${name} ${Date.now()} ${Math.random()}\n`);
  plain(dir, 'add', name);
}

const lastMsg = (dir: string, rev = 'HEAD') => execFileSync('git', ['-C', dir, 'log', '-1', '--format=%B', rev], { encoding: 'utf8' });
const trailers = (dir: string, rev = 'HEAD') =>
  execFileSync('git', ['-C', dir, 'log', '-1', '--format=%(trailers:key=Ticket,valueonly)', rev], { encoding: 'utf8' }).trim();

describe('prepare-commit-msg: the Ticket trailer (TCK-1838)', () => {
  it('a bound session\'s commit gets "Ticket: TCK-42" (-m and -F messages)', () => {
    const h = home();
    const d = repo();
    change(d);
    const r = asSession(d, h, ['commit', '-q', '-m', 'feat: one']);
    expect(r.status, r.stderr).toBe(0);
    expect(trailers(d)).toBe('TCK-42');
    expect(lastMsg(d)).toMatch(/^feat: one\n\nTicket: TCK-42\n/);

    change(d);
    const msgFile = path.join(d, '..', `${path.basename(d)}-msg.txt`);
    dirs.push(msgFile);
    fs.writeFileSync(msgFile, 'fix: two\n\nA body line.\n');
    expect(asSession(d, h, ['commit', '-q', '-F', msgFile]).status).toBe(0);
    expect(trailers(d)).toBe('TCK-42');
  });

  it('a merge commit gets the trailer (--no-edit and -m)', () => {
    const h = home();
    const d = repo();
    plain(d, 'checkout', '-q', '-b', 'feature');
    change(d, 'f.txt');
    plain(d, 'commit', '-q', '-m', 'feature work');
    plain(d, 'checkout', '-q', 'main');
    change(d, 'm.txt');
    plain(d, 'commit', '-q', '-m', 'main work');
    const r = asSession(d, h, ['merge', '--no-ff', '--no-edit', 'feature']);
    expect(r.status, r.stderr).toBe(0);
    expect(trailers(d)).toBe('TCK-42');
    expect(lastMsg(d)).not.toMatch(/^#/m); // the comment lines are gone, the trailer stays

    plain(d, 'checkout', '-q', '-b', 'feature2', 'HEAD~1');
    change(d, 'g.txt');
    plain(d, 'commit', '-q', '-m', 'more');
    plain(d, 'checkout', '-q', 'main');
    expect(asSession(d, h, ['merge', '--no-ff', '-m', 'Merge feature2', 'feature2']).status).toBe(0);
    expect(trailers(d)).toBe('TCK-42');
  });

  it('RED: a commit outside Claude Code (no CLAUDE_CODE_SESSION_ID) gets no trailer', () => {
    const h = home();
    const d = repo();
    change(d);
    expect(asSession(d, h, ['commit', '-q', '-m', 'by hand'], { CLAUDE_CODE_SESSION_ID: undefined }).status).toBe(0);
    expect(trailers(d)).toBe('');
  });

  it('RED: NOESIS_TICKET=none (unrelated work) gets no trailer', () => {
    const h = home();
    const d = repo();
    change(d);
    expect(asSession(d, h, ['commit', '-q', '-m', 'chore: other'], { NOESIS_TICKET: 'none' }).status).toBe(0);
    expect(trailers(d)).toBe('');
  });

  it('an existing Ticket: trailer is kept, never doubled', () => {
    const h = home();
    const d = repo();
    change(d);
    expect(asSession(d, h, ['commit', '-q', '-m', 'feat: x\n\nTicket: TCK-7']).status).toBe(0);
    expect(trailers(d)).toBe('TCK-7');
  });

  it('RED: the switch off (no file, or enabled: false) means no trailer', () => {
    for (const sw of [null, { enabled: false, repos: [] }]) {
      const h = home({ switchFile: sw });
      const d = repo();
      change(d);
      expect(asSession(d, h, ['commit', '-q', '-m', 'feat: x']).status).toBe(0);
      expect(trailers(d), JSON.stringify(sw)).toBe('');
    }
  });

  it('RED: a closed (shipped) cached ticket, or no binding, means no trailer', () => {
    for (const cache of [{ [SID]: { ...BOUND, status: 'shipped' } }, {}]) {
      const h = home({ cache });
      const d = repo();
      change(d);
      expect(asSession(d, h, ['commit', '-q', '-m', 'feat: x']).status).toBe(0);
      expect(trailers(d)).toBe('');
    }
  });

  it('after /clear: a cache file under another id whose bound_session_id matches (any case) still names the ticket', () => {
    const h = home({ cache: { 'payload-id-after-clear': { ...BOUND, bound_session_id: SID.toUpperCase() } } });
    const d = repo();
    change(d);
    expect(asSession(d, h, ['commit', '-q', '-m', 'feat: x']).status).toBe(0);
    expect(trailers(d)).toBe('TCK-42');
  });

  it('RED: a reused message (--amend --no-edit) is left as it was', () => {
    const h = home();
    const d = repo();
    change(d);
    plain(d, 'commit', '-q', '-m', 'feat: made by hand');
    change(d);
    expect(asSession(d, h, ['commit', '-q', '--amend', '--no-edit']).status).toBe(0);
    expect(lastMsg(d)).toBe('feat: made by hand\n\n');
  });

  it('RED: an amend with a NEW message (--amend -m) gets no trailer either', () => {
    const h = home();
    const d = repo();
    change(d);
    plain(d, 'commit', '-q', '-m', 'feat: by the owner');
    change(d);
    expect(asSession(d, h, ['commit', '-q', '--amend', '-m', 'feat: reworded by the session']).status).toBe(0);
    expect(lastMsg(d)).toBe('feat: reworded by the session\n\n');
  });

  it('a revert made by the bound session is its own work: it gets the trailer', () => {
    const h = home();
    const d = repo();
    change(d);
    plain(d, 'commit', '-q', '-m', 'feat: to be reverted');
    expect(asSession(d, h, ['revert', '--no-edit', 'HEAD']).status).toBe(0);
    expect(lastMsg(d)).toMatch(/^Revert "feat: to be reverted"/);
    expect(trailers(d)).toBe('TCK-42');
  });

  it('RED: the kill switch TCK_SESSION_HOOK=off means no trailer', () => {
    const h = home();
    const d = repo();
    change(d);
    expect(asSession(d, h, ['commit', '-q', '-m', 'feat: x'], { TCK_SESSION_HOOK: 'off' }).status).toBe(0);
    expect(trailers(d)).toBe('');
  });

  it('RED: a cherry-pick and a rebase never stamp this session\'s ticket on other commits', () => {
    const h = home();
    const d = repo();
    plain(d, 'checkout', '-q', '-b', 'feature');
    change(d, 'f1.txt');
    plain(d, 'commit', '-q', '-m', 'other ticket work 1');
    change(d, 'f2.txt');
    plain(d, 'commit', '-q', '-m', 'other ticket work 2');
    plain(d, 'checkout', '-q', 'main');
    change(d, 'm.txt');
    plain(d, 'commit', '-q', '-m', 'main moved');

    const pick = asSession(d, h, ['cherry-pick', 'feature~1']);
    expect(pick.status, pick.stderr).toBe(0);
    expect(lastMsg(d)).toMatch(/^other ticket work 1\n/);
    expect(trailers(d)).toBe('');

    plain(d, 'checkout', '-q', 'feature');
    const rb = asSession(d, h, ['rebase', '-q', 'main']);
    expect(rb.status, rb.stderr).toBe(0);
    expect(trailers(d)).toBe('');
    expect(trailers(d, 'HEAD~1')).toBe('');
  });

  it('a broken cache file or a missing node never blocks the commit', () => {
    const h = home({ cache: {} });
    fs.writeFileSync(path.join(h, '.claude', 'tck-bindings', `${SID}.json`), '{not json');
    const d = repo();
    change(d);
    expect(asSession(d, h, ['commit', '-q', '-m', 'feat: x']).status).toBe(0);
    expect(trailers(d)).toBe('');

    // PATH with git only (no node): the hook steps aside
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'trl-bin-'));
    dirs.push(bin);
    const gitPath = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim();
    fs.symlinkSync(gitPath, path.join(bin, 'git'));
    const h2 = home();
    change(d);
    const r = asSession(d, h2, ['commit', '-q', '-m', 'feat: no node'], { PATH: `${bin}:/usr/bin:/bin` });
    expect(r.status, r.stderr).toBe(0);
    expect(trailers(d)).toBe('');
  });

  it('--trailer-key never waits on stdin (a git hook may leave it open)', async () => {
    const h = home();
    const started = Date.now();
    const out = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
      const child = spawn(process.execPath, [path.join(h, '.claude', 'hooks', 'noesis-ticket-session.mjs'), '--trailer-key'], {
        env: cleanEnv({ HOME: h, USERPROFILE: h, CLAUDE_CODE_SESSION_ID: SID }),
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      let stdout = '';
      child.stdout.on('data', (c) => (stdout += c));
      child.on('close', (code) => resolve({ code, stdout }));
      // stdin is deliberately never ended
    });
    expect(out.code).toBe(0);
    expect(out.stdout).toBe('TCK-42');
    expect(Date.now() - started).toBeLessThan(3000);
  }, 10_000);
});
