/**
 * The hot-orphan check of the Chief of Staff (C21, TCK-1984): scripts/coord-hot.mjs finds a process whose parent is
 * gone (parent PID 1) and that keeps 50% or more of a CPU for 15 minutes in a ticket worktree or a Claude scratch
 * folder, and stops it by its pid after reading every fact again. Its own selftest builds throwaway git worktrees,
 * fake process tables and one real orphan, which it stops. It must pass from this package.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = path.join(__dirname, '..', 'scripts', 'coord-hot.mjs');

describe('coord-hot.mjs', () => {
  // About 3 s alone (the real orphan needs a moment for ps to see its CPU).
  it('passes its own selftest', { timeout: 120_000 }, () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--selftest'], { encoding: 'utf8', timeout: 100_000 });
    expect(r.status, `${r.stdout}\n${r.stderr}`.slice(-3000)).toBe(0);
    expect(r.stdout).toMatch(/\ball ok\b/);
    expect(r.stdout).not.toMatch(/^FAIL/m);
  });

  it('prints its usage for an unknown command or argument', () => {
    for (const args of [['nope'], ['list', '--what'], ['stop', '--pid']]) {
      const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 30_000 });
      expect(r.status, args.join(' ')).toBe(2);
      expect(r.stderr, args.join(' ')).toMatch(/usage:/);
    }
  });

  it('list --no-save reads this machine and writes no samples file; stop refuses a pid that is not hot', () => {
    const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-hot-cli-'));
    try {
      const env = { ...process.env, CLAUDE_CONFIG_DIR: cfg };
      const repo = path.join(__dirname, '..');
      const list = spawnSync(process.execPath, [SCRIPT, 'list', '--repo', repo, '--no-save', '--json'], { encoding: 'utf8', timeout: 30_000, env });
      expect(list.status, list.stderr).toBe(0);
      expect(Array.isArray(JSON.parse(list.stdout).hot)).toBe(true);
      expect(fs.existsSync(path.join(cfg, 'coord', 'cpu-samples.json'))).toBe(false);
      // This test's own process: its parent is vitest, not PID 1, so it is never hot and never signalled.
      const stop = spawnSync(process.execPath, [SCRIPT, 'stop', '--pid', String(process.pid), '--started', 'x', '--repo', repo, '--json'], { encoding: 'utf8', timeout: 30_000, env });
      expect(stop.status).toBe(1);
      expect(JSON.parse(stop.stdout).stopped).toBe(false);
    } finally {
      fs.rmSync(cfg, { recursive: true, force: true });
    }
  });
});
