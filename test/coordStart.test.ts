/**
 * The Chief of Staff's start of a ticket session (TCK-1974): scripts/coord-start.mjs checks whether a
 * ticket may start, makes its worktree, and starts a Claude Code session for it. Its own selftest
 * builds throwaway repositories (with a submodule and a remote), a fake board and fake sessions, and
 * checks each refusal, the worktree it makes and the read-only proof. It must pass from this package.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const SCRIPT = path.join(__dirname, '..', 'scripts', 'coord-start.mjs');
const run = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 30_000 });

describe('coord-start.mjs', () => {
  it('passes its own selftest', { timeout: 180_000 }, () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--selftest'], { encoding: 'utf8', timeout: 170_000 });
    expect(r.status, `${r.stdout}\n${r.stderr}`.slice(-3000)).toBe(0);
    expect(r.stdout).toMatch(/\ball ok\b/);
    expect(r.stdout).not.toMatch(/^FAIL/m);
  });

  it('prints its usage for an unknown command, an unknown flag or a bad value, and runs nothing', () => {
    for (const args of [['nope'], [], ['check', '--nope'], ['check', '--ticket'], ['check', '--max', '0'], ['check', '--max', '21'], ['check', '--max', '2.5'], ['check', '--self-pid', '-1'],
      ['prepare', '--prove-read-only', '--ticket', 'TCK-1'], ['start', '--prove-read-only', '--ticket', 'TCK-1'], ['check', '--ticket', 'TCK-1', '--prompt', 'x'],
      ['start', '--ticket', 'TCK-1', '--prompt', 'a\nb'], ['start', '--ticket', 'TCK-1', '--prompt', ''], ['start', '--ticket', 'TCK-1', '--prompt', 'x'.repeat(301)], ['toString']]) {
      const r = run(...args);
      expect(r.status, args.join(' ')).toBe(2);
      expect(r.stderr, args.join(' ')).toMatch(/usage:|needs|works with check and list only|works with start only/);
    }
  });
});
