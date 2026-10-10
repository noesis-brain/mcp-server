import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentRunDir, resolveDaemonId, resolveIdentity } from '../src/agent/identity.js';

/**
 * The machine identity a daemon sends with every claim. Every test runs in a temp run
 * dir — never the user's real ~/.noesis-agent.
 */
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'noesis-agent-id-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('resolveDaemonId', () => {
  it('creates <run dir>/daemon-id once and returns the same id on every later call', () => {
    const env = { NOESIS_AGENT_RUN_DIR: dir };
    const a = resolveDaemonId(env);
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(readFileSync(join(dir, 'daemon-id'), 'utf8').trim()).toBe(a);
    expect(resolveDaemonId(env)).toBe(a);
  });

  it('NOESIS_AGENT_ID overrides the file, and writes nothing', () => {
    expect(resolveDaemonId({ NOESIS_AGENT_RUN_DIR: dir, NOESIS_AGENT_ID: 'e2e-a' })).toBe('e2e-a');
    expect(existsSync(join(dir, 'daemon-id'))).toBe(false);
  });

  it('rejects a reserved legacy: or malformed override and a corrupt file', () => {
    expect(resolveDaemonId({ NOESIS_AGENT_RUN_DIR: dir, NOESIS_AGENT_ID: 'legacy:token:9' })).not.toBe('legacy:token:9');
    writeFileSync(join(dir, 'daemon-id'), 'not valid / id\n');
    const id = resolveDaemonId({ NOESIS_AGENT_RUN_DIR: dir, NOESIS_AGENT_ID: 'has space' });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(readFileSync(join(dir, 'daemon-id'), 'utf8').trim()).toBe(id);
  });

  it('accepts an 80-character override and rejects an 81-character one', () => {
    const ok = 'b'.repeat(80);
    expect(resolveDaemonId({ NOESIS_AGENT_RUN_DIR: dir, NOESIS_AGENT_ID: ok })).toBe(ok);
    const long = 'a'.repeat(81);
    expect(resolveDaemonId({ NOESIS_AGENT_RUN_DIR: dir, NOESIS_AGENT_ID: long })).not.toBe(long);
  });

  it('falls back to a stable machine hash when the run dir cannot be written', () => {
    const blocker = join(dir, 'file');
    writeFileSync(blocker, 'x');
    const env = { NOESIS_AGENT_RUN_DIR: join(blocker, 'sub') }; // a dir under a FILE can't be created
    const a = resolveDaemonId(env);
    expect(a).toMatch(/^h-[0-9a-f]{32}$/);
    expect(resolveDaemonId(env)).toBe(a);
  });

  it('defaults the run dir to ~/.noesis-agent', () => {
    expect(agentRunDir({})).toMatch(/\.noesis-agent$/);
  });
});

describe('resolveIdentity', () => {
  it('keeps daemonId across processes but mints a new bootId each time', () => {
    const env = { NOESIS_AGENT_RUN_DIR: dir };
    const a = resolveIdentity(env);
    const b = resolveIdentity(env);
    expect(a.daemonId).toBe(b.daemonId);
    expect(a.bootId).not.toBe(b.bootId);
    expect(a.platform).toBe(process.platform);
  });

  it('uses NOESIS_AGENT_LABEL when set, capped at 80 chars', () => {
    expect(resolveIdentity({ NOESIS_AGENT_RUN_DIR: dir, NOESIS_AGENT_LABEL: 'e2e-mac' }).label).toBe('e2e-mac');
    expect(resolveIdentity({ NOESIS_AGENT_RUN_DIR: dir, NOESIS_AGENT_LABEL: 'L'.repeat(200) }).label).toHaveLength(80);
  });
});
