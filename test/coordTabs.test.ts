/**
 * The Chrome loop tabs of the Chief of Staff (TCK-1930): scripts/coord-tabs.mjs labels each tab
 * that a /cc-loop session left open, and closes only sure orphans. Its own selftest feeds it fake
 * tabs and a fake AppleScript runner, so it needs no Chrome. It must pass from this package.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const SCRIPT = path.join(__dirname, '..', 'scripts', 'coord-tabs.mjs');

describe('coord-tabs.mjs', () => {
  it('passes its own selftest', { timeout: 60_000 }, () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--selftest'], { encoding: 'utf8', timeout: 50_000 });
    expect(r.status, `${r.stdout}\n${r.stderr}`.slice(-3000)).toBe(0);
    expect(r.stdout).toMatch(/\ball ok\b/);
    expect(r.stdout).not.toMatch(/^FAIL/m);
  });

  it('prints its usage for an unknown command, and for close without tabs', () => {
    for (const args of [['nope'], ['close']]) {
      const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 30_000 });
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/usage:/);
    }
  });
});
