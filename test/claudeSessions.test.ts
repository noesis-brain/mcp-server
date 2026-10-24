/**
 * Stamping a Claude Code session into a note's frontmatter.
 *
 * The two behaviours that carry real weight in production:
 *   - the no-op guards, without which every repeat sync inside one session rewrites the file and
 *     turns a "skipped (unchanged)" into a full push plus a backend version snapshot;
 *   - byte-preservation of everything that is not the `claude_sessions:` block, blank lines
 *     included — this is exactly where updateFrontmatter would have damaged the file.
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { upsertSessionFrontmatter, readTranscriptMeta, currentSessionRef, encodeProjectDir, normalizeCwd, MAX_CLAUDE_SESSIONS, type ClaudeSessionRef } from '../src/tools/claudeSessions.js';
import { updateFrontmatter } from '../src/tools/index.js';

const REF: ClaudeSessionRef = {
  id: '87264607-83aa-425b-86f2-87bb05c942a6',
  cwd: 'D:/Perforce/BarTender/Dev/New/Epsilon/Bugs',
  last_active: '2026-09-04T15:05:18.741Z',
  title: 'bplat-jira-note-refresh',
  branch: 'main',
};
const OTHER: ClaudeSessionRef = {
  id: '1ace20bf-a81f-41e8-b76e-46d976f3a215',
  cwd: '/home/me/repo',
  last_active: '2026-09-02T10:00:00.000Z',
};

describe('encodeProjectDir', () => {
  it('replaces every non-alphanumeric with a dash', () => {
    // The old watcher used /[:\\/_]/ and silently mis-encoded any path with a dot or a space.
    expect(encodeProjectDir('C:\\Users\\ccheng\\.noesis-agent')).toBe('C--Users-ccheng--noesis-agent');
    expect(encodeProjectDir('C:\\temp_cGit\\md-manager')).toBe('C--temp-cGit-md-manager');
    expect(encodeProjectDir('/home/me/my project')).toBe('-home-me-my-project');
  });
});

describe('normalizeCwd', () => {
  it('forward-slashes and drops a trailing separator', () => {
    expect(normalizeCwd('D:\\Perforce\\Bugs\\')).toBe('D:/Perforce/Bugs');
  });
});

describe('upsertSessionFrontmatter', () => {
  it('adds the block to a note that has frontmatter, preserving other keys and blank lines', () => {
    const before = [
      '---',
      "title: 'A note'",
      '',
      'keywords:',
      '  - one',
      '  - two',
      "updated: '2026-09-04'",
      '---',
      '# A note',
      '',
      'Body.',
      '',
    ].join('\n');

    const after = upsertSessionFrontmatter(before, REF);

    expect(after).toContain('claude_sessions:');
    expect(after).toContain(REF.id);
    expect(after).toContain('D:/Perforce/BarTender/Dev/New/Epsilon/Bugs');
    // Everything else survives byte-for-byte, including the blank line inside frontmatter that
    // updateFrontmatter's trailing filter would have eaten.
    expect(after).toContain("title: 'A note'");
    expect(after).toContain('\n\nkeywords:');
    expect(after).toContain('  - one');
    expect(after).toContain("updated: '2026-09-04'");
    expect(after.endsWith('# A note\n\nBody.\n')).toBe(true);
  });

  it('creates frontmatter when the note has none', () => {
    const after = upsertSessionFrontmatter('# Plain\n\nBody.\n', REF);
    expect(after.startsWith('---\n')).toBe(true);
    expect(after).toContain('claude_sessions:');
    expect(after).toContain('# Plain');
  });

  it('leaves a malformed unterminated --- opener completely alone', () => {
    const broken = '---\ntitle: never closed\n\n# Heading\n';
    expect(upsertSessionFrontmatter(broken, REF)).toBe(broken);
  });

  it('leaves unparseable frontmatter alone rather than rewriting around a guess', () => {
    const bad = '---\nclaude_sessions: [unclosed\n---\n# Doc\n';
    expect(upsertSessionFrontmatter(bad, REF)).toBe(bad);
  });

  it('is a byte-identical no-op when the same session is stamped again within the window', () => {
    const first = upsertSessionFrontmatter('---\ntitle: t\n---\n# Doc\n', REF);
    // Same id, same cwd, last_active only seconds newer: not worth rewriting the file.
    const nudged = { ...REF, last_active: '2026-09-04T15:06:00.000Z' };
    expect(upsertSessionFrontmatter(first, nudged)).toBe(first);
  });

  it('does refresh once last_active has moved past the window', () => {
    const first = upsertSessionFrontmatter('---\ntitle: t\n---\n# Doc\n', REF);
    const later = { ...REF, last_active: '2026-09-04T16:30:00.000Z' };
    const second = upsertSessionFrontmatter(first, later);
    expect(second).not.toBe(first);
    expect(second).toContain('2026-09-04T16:30:00.000Z');
    expect(second).not.toContain('2026-09-04T15:05:18.741Z');
  });

  it('records the machine name, and a machine change is NOT swallowed by the time guard', () => {
    const onA = { ...REF, machine_name: 'CCHENGLT2' };
    const first = upsertSessionFrontmatter('---\ntitle: t\n---\n# Doc\n', onA);
    expect(first).toContain('machine_name: CCHENGLT2');

    // Same session id, same clock, different machine. The 5-minute no-op guard must NOT treat
    // this as unchanged: a Claude Code session lives in ~/.claude/projects on ONE machine, so
    // which machine an entry came from is exactly what tells the reader it is unresumable here.
    const onB = { ...REF, machine_name: 'OTHER-LAPTOP' };
    const second = upsertSessionFrontmatter(first, onB);
    expect(second).not.toBe(first);
    expect(second).toContain('OTHER-LAPTOP');

    // ...but re-stamping the identical ref is still a byte-identical no-op.
    expect(upsertSessionFrontmatter(second, onB)).toBe(second);
  });

  it('accumulates distinct sessions, newest first, without duplicating the block', () => {
    const one = upsertSessionFrontmatter('---\ntitle: t\n---\n# Doc\n', OTHER);
    const two = upsertSessionFrontmatter(one, REF);
    expect(two.match(/claude_sessions:/g)).toHaveLength(1);
    expect(two.indexOf(REF.id)).toBeLessThan(two.indexOf(OTHER.id)); // newest first
  });

  it('caps the list, dropping the oldest', () => {
    let content = '---\ntitle: t\n---\n# Doc\n';
    for (let i = 0; i < MAX_CLAUDE_SESSIONS + 3; i++) {
      content = upsertSessionFrontmatter(content, {
        id: `${String(i).padStart(8, '0')}-83aa-425b-86f2-87bb05c942a6`,
        cwd: '/repo',
        last_active: new Date(Date.UTC(2026, 0, i + 1)).toISOString(),
      });
    }
    expect(content.match(/^\s+- id:/gm)).toHaveLength(MAX_CLAUDE_SESSIONS);
    expect(content).not.toContain('00000000-83aa'); // the oldest fell off
  });

  it('round-trips a cwd containing spaces and a colon', () => {
    // Emitted via yaml.dump, never string concatenation — a hand-built line would break here.
    const odd = { ...REF, cwd: 'C:/Users/me/My Documents: drafts' };
    const after = upsertSessionFrontmatter('---\ntitle: t\n---\n# Doc\n', odd);
    expect(after).toContain('My Documents: drafts');
    // And it survives a re-parse: stamping the same ref again must be a no-op, which is only
    // possible if the YAML we wrote reads back as the same value.
    expect(upsertSessionFrontmatter(after, odd)).toBe(after);
  });

  it('survives a later updateFrontmatter call — the ordering the merge branch depends on', () => {
    const stamped = upsertSessionFrontmatter('---\ntitle: t\n---\n# Doc\n', REF);
    const enriched = updateFrontmatter(stamped, {
      title: 'Cloud Title',
      description: 'Cloud description',
      keywords: ['a', 'b'],
    });
    expect(enriched).toContain('claude_sessions:');
    expect(enriched).toContain(REF.id);
    expect(enriched).toContain('Cloud Title');
  });
});

describe('readTranscriptMeta — skip_permissions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-transcript-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  const header = { type: 'summary', leafUuid: 'x' };
  const first = { type: 'user', cwd: '/repo', gitBranch: 'main', timestamp: '2026-10-24T01:00:00.000Z', permissionMode: 'plan' };
  const mode = (m: string) => ({ type: 'permission-mode', permissionMode: m, sessionId: 's' });
  const turn = (ts: string) => ({ type: 'assistant', timestamp: ts, message: { content: 'x' } });
  // ~2 MB of ordinary turns: pushes a record out of both the 256 KB head and the 1 MB tail.
  const filler = (n: number) => Array.from({ length: n }, (_, i) =>
    ({ type: 'assistant', timestamp: '2026-10-24T02:00:00.000Z', message: { content: `${i} ${'y'.repeat(200)}` } }));

  function write(name: string, records: object[]): string {
    const file = path.join(dir, `${name}.jsonl`);
    fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return file;
  }

  it('is true when bypass appears only in the head, after the first cwd and branch', () => {
    // The head loop used to break as soon as it had a cwd and a branch; the bypass record
    // comes later, so the old break would have hidden it.
    const file = write('head', [header, first, mode('plan'), mode('bypassPermissions'), ...filler(9000), turn('2026-10-24T03:00:00.000Z')]);
    const meta = readTranscriptMeta(file);
    expect(meta.skip_permissions).toBe(true);
    expect(meta.cwd).toBe('/repo');
    expect(meta.branch).toBe('main');
  });

  it('is true when bypass appears only in the tail', () => {
    const file = write('tail', [header, first, ...filler(9000), mode('bypassPermissions'), turn('2026-10-24T03:00:00.000Z')]);
    expect(readTranscriptMeta(file).skip_permissions).toBe(true);
  });

  it('is true for a typed prompt that carries the mode (plan, then bypass)', () => {
    const file = write('plan-then-bypass', [header, first, mode('plan'),
      { type: 'user', timestamp: '2026-10-24T01:30:00.000Z', permissionMode: 'bypassPermissions', message: { content: 'go' } }]);
    expect(readTranscriptMeta(file).skip_permissions).toBe(true);
  });

  it('is false for a session that never reached bypass', () => {
    const file = write('never', [header, first, mode('plan'), mode('acceptEdits'), mode('auto'), turn('2026-10-24T03:00:00.000Z')]);
    expect(readTranscriptMeta(file).skip_permissions).toBe(false);
  });

  it('currentSessionRef stamps skip_permissions only for a bypass session', () => {
    const saved = process.env.CLAUDE_CONFIG_DIR;
    const config = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-config-'));
    try {
      process.env.CLAUDE_CONFIG_DIR = config;
      fs.mkdirSync(path.join(config, 'projects', '-repo'), { recursive: true });
      const bypassId = '11111111-2222-4333-8444-555555555555';
      const planId = '66666666-7777-4888-8999-aaaaaaaaaaaa';
      const put = (id: string, records: object[]) => fs.writeFileSync(
        path.join(config, 'projects', '-repo', `${id}.jsonl`), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
      put(bypassId, [header, first, mode('bypassPermissions'), turn('2026-10-24T03:00:00.000Z')]);
      put(planId, [header, first, mode('plan'), turn('2026-10-24T03:00:00.000Z')]);

      expect(currentSessionRef(bypassId)?.ref.skip_permissions).toBe(true);
      expect(currentSessionRef(planId)?.ref).not.toHaveProperty('skip_permissions');
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved;
      fs.rmSync(config, { recursive: true, force: true });
    }
  });

  it('does not read past the windows: bypass only in the middle of a big file is not seen', () => {
    // Documents the bounded-read trade-off rather than hiding it.
    const file = write('middle', [header, first, ...filler(4000), mode('bypassPermissions'), ...filler(9000), turn('2026-10-24T03:00:00.000Z')]);
    expect(readTranscriptMeta(file).skip_permissions).toBe(false);
  });
});

describe('upsertSessionFrontmatter — skip_permissions', () => {
  const BYPASS: ClaudeSessionRef = { ...REF, skip_permissions: true };

  it('writes skip_permissions: true only when set', () => {
    expect(upsertSessionFrontmatter('---\ntitle: t\n---\n# Doc\n', REF)).not.toContain('skip_permissions');
    expect(upsertSessionFrontmatter('---\ntitle: t\n---\n# Doc\n', BYPASS)).toContain('skip_permissions: true');
  });

  it('a newly seen bypass mode is NOT swallowed by the 5-minute guard', () => {
    const first = upsertSessionFrontmatter('---\ntitle: t\n---\n# Doc\n', REF);
    const nudged = { ...BYPASS, last_active: '2026-09-04T15:06:00.000Z' };
    const second = upsertSessionFrontmatter(first, nudged);
    expect(second).not.toBe(first);
    expect(second).toContain('skip_permissions: true');
  });

  it('adds the flag even when nothing else about the entry changed', () => {
    // Identical id, cwd and clock: only the merge's sameRefs check can tell the two apart.
    const first = upsertSessionFrontmatter('---\ntitle: t\n---\n# Doc\n', REF);
    const second = upsertSessionFrontmatter(first, BYPASS);
    expect(second).not.toBe(first);
    expect(second).toContain('skip_permissions: true');
  });

  it('is sticky: a later stamp without the flag keeps it, inside and past the window', () => {
    const first = upsertSessionFrontmatter('---\ntitle: t\n---\n# Doc\n', BYPASS);
    // Inside the window, the same ref without the flag is a byte-identical no-op.
    expect(upsertSessionFrontmatter(first, { ...REF, last_active: '2026-09-04T15:06:00.000Z' })).toBe(first);
    // Past the window the entry is rewritten, and the flag survives the rewrite.
    const later = upsertSessionFrontmatter(first, { ...REF, last_active: '2026-09-04T16:30:00.000Z' });
    expect(later).toContain('2026-09-04T16:30:00.000Z');
    expect(later).toContain('skip_permissions: true');
  });

  it('never mutates the caller\'s ref', () => {
    const first = upsertSessionFrontmatter('---\ntitle: t\n---\n# Doc\n', BYPASS);
    const plain = { ...REF, last_active: '2026-09-04T16:30:00.000Z' };
    upsertSessionFrontmatter(first, plain);
    expect(plain).not.toHaveProperty('skip_permissions');
  });

  it('leaves another session\'s flag alone', () => {
    const one = upsertSessionFrontmatter('---\ntitle: t\n---\n# Doc\n', { ...OTHER, skip_permissions: true });
    const two = upsertSessionFrontmatter(one, REF);
    const block = two.slice(0, two.indexOf('\n---', 4));
    expect(block.match(/skip_permissions: true/g)).toHaveLength(1);
  });
});
