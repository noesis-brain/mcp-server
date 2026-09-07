/**
 * Matching a note against the scanned session index.
 *
 * The tiers matter: an absolute-path hit is trustworthy, a basename-only hit is not (two notes in
 * different roots share a filename all the time), and presenting the second as if it were the
 * first would send the owner into the wrong conversation.
 */
import { describe, it, expect } from 'vitest';
import { matchSessions, type SessionIndex } from '../src/tools/sessionIndex.js';

const ID_A = '87264607-83aa-425b-86f2-87bb05c942a6';
const ID_B = '1ace20bf-a81f-41e8-b76e-46d976f3a215';
const ID_C = '3ceaf0e6-4128-4a6e-a34c-fcbfc73b6dd2';

const NOTE = 'C:/Users/ccheng/Noesis/BPLAT-21294-bto-print-station.md';

const index: SessionIndex = {
  version: 1,
  entries: {
    [ID_A]: {
      file: 'x', size: 1, mtimeMs: 1,
      cwd: 'D:\\Perforce\\BarTender\\Bugs', branch: 'main', title: 'bplat-jira-note-refresh',
      lastActive: '2026-09-04T15:05:18.741Z',
      paths: [NOTE.toLowerCase()],
    },
    [ID_B]: {
      file: 'x', size: 1, mtimeMs: 1,
      cwd: '/home/me/other', branch: null, title: null,
      lastActive: '2026-09-02T10:00:00.000Z',
      // Same filename, different root — a weak signal, not the same note.
      paths: ['/home/me/elsewhere/bplat-21294-bto-print-station.md'],
    },
    [ID_C]: {
      file: 'x', size: 1, mtimeMs: 1,
      cwd: '/home/me/third', branch: null, title: null,
      lastActive: '2026-09-01T00:00:00.000Z',
      paths: ['/some/other/note.md'],
    },
  },
};

describe('matchSessions', () => {
  it('ranks an absolute-path hit above a basename-only one, and excludes non-matches', () => {
    const hits = matchSessions(index, { absolutePath: NOTE });
    expect(hits.map((h) => h.id)).toEqual([ID_A, ID_B]);
    expect(hits[0].confidence).toBe('absolute');
    expect(hits[1].confidence).toBe('basename');
    expect(hits.map((h) => h.id)).not.toContain(ID_C);
  });

  it('normalizes the stored cwd and carries title/branch through', () => {
    const [first] = matchSessions(index, { absolutePath: NOTE });
    expect(first.cwd).toBe('D:/Perforce/BarTender/Bugs');
    expect(first.title).toBe('bplat-jira-note-refresh');
    expect(first.branch).toBe('main');
    expect(first.last_active).toBe('2026-09-04T15:05:18.741Z');
  });

  it('matches case-insensitively, since Windows paths vary in case', () => {
    expect(matchSessions(index, { absolutePath: NOTE.toUpperCase() }).map((h) => h.id)).toContain(ID_A);
  });

  it('returns nothing when neither a path nor a relative path is supplied', () => {
    expect(matchSessions(index, {})).toEqual([]);
  });

  it('falls back to the file mtime when a transcript carried no timestamp', () => {
    const noTs: SessionIndex = {
      version: 1,
      entries: {
        [ID_A]: { ...index.entries[ID_A], lastActive: null, mtimeMs: Date.UTC(2026, 0, 2) },
      },
    };
    const [hit] = matchSessions(noTs, { absolutePath: NOTE });
    expect(hit.last_active).toBe(new Date(Date.UTC(2026, 0, 2)).toISOString());
  });
});
