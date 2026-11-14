/**
 * The close check of the Chief of Staff (TCK-1930): scripts/coord-close.mjs answers "Can this
 * session close?" for each local Claude Code session. Its own selftest builds throwaway git
 * repositories, sessions, transcripts and processes, and checks each reason, the follow-ups, the
 * answer file and the read-only proof. It must pass from this package.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = path.join(__dirname, '..', 'scripts', 'coord-close.mjs');

describe('coord-close.mjs', () => {
  // About 2 s alone; more next to the other test files.
  it('passes its own selftest', { timeout: 120_000 }, () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--selftest'], { encoding: 'utf8', timeout: 100_000 });
    expect(r.status, `${r.stdout}\n${r.stderr}`.slice(-3000)).toBe(0);
    expect(r.stdout).toMatch(/\ball ok\b/);
    expect(r.stdout).not.toMatch(/^FAIL/m);
  });

  it('prints its usage for an unknown command', () => {
    const r = spawnSync(process.execPath, [SCRIPT, 'nope'], { encoding: 'utf8', timeout: 30_000 });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/usage:/);
  });

  it('saves the check for the scan only with --all alone, and never under --prove-read-only', () => {
    // A private config folder: if a refusal ever broke, the run would save there, never into the real ~/.claude.
    const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-close-save-'));
    try {
      const run = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, 'check', ...args], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, CLAUDE_CONFIG_DIR: cfg } });
      for (const args of [['--session', '00000000-aaaa-4bbb-8ccc-dddddddddddd', '--save'], ['--all', '--session', '00000000-aaaa-4bbb-8ccc-dddddddddddd', '--save'], ['--all', '--pid', '1', '--save']]) {
        const r = run(...args);
        expect(r.status, args.join(' ')).toBe(2);
        expect(r.stderr, args.join(' ')).toMatch(/--save needs --all/);
      }
      const proof = run('--all', '--save', '--prove-read-only');
      expect(proof.status).toBe(2);
      expect(proof.stderr).toMatch(/--prove-read-only cannot --save/);
      expect(fs.existsSync(path.join(cfg, 'coord', 'close-check.json'))).toBe(false);
    } finally {
      fs.rmSync(cfg, { recursive: true, force: true });
    }
  });

  it('refuses --prove-read-only on record, which writes by design', () => {
    const r = spawnSync(process.execPath, [SCRIPT, 'record', '--session', '00000000-aaaa-4bbb-8ccc-dddddddddddd', '--verdict', 'yes', '--prove-read-only'], { encoding: 'utf8', timeout: 30_000 });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--prove-read-only works with check and candidates only/);
  });
});
