/**
 * Stamping a Claude Code session into a note's frontmatter.
 *
 * The two behaviours that carry real weight in production:
 *   - the no-op guards, without which every repeat sync inside one session rewrites the file and
 *     turns a "skipped (unchanged)" into a full push plus a backend version snapshot;
 *   - byte-preservation of everything that is not the `claude_sessions:` block, blank lines
 *     included — this is exactly where updateFrontmatter would have damaged the file.
 */
import { describe, it, expect } from 'vitest';
import { upsertSessionFrontmatter, encodeProjectDir, normalizeCwd, MAX_CLAUDE_SESSIONS, type ClaudeSessionRef } from '../src/tools/claudeSessions.js';
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
