import { describe, it, expect } from 'vitest';
import { clampAllowedTools, clampMaxTurns } from '../src/agent/runner.js';

/**
 * This is the SECURITY BOUNDARY for the local agent daemon.
 *
 * Anything that survives clampAllowedTools runs under this machine's ambient Claude
 * Code login with no further prompt, so the daemon must never trust tool names the
 * server sent. The backend's own list is a request, not a boundary — these tests are
 * what stop the boundary from quietly widening (e.g. by relaxing back to an
 * `mcp__noesis__*` prefix, which also contains mutating tools).
 */
describe('clampAllowedTools — the daemon-side allowlist', () => {
  it('keeps exactly the four read-only Noesis lookups', () => {
    const ok = [
      'mcp__noesis__search_notes',
      'mcp__noesis__search_semantic',
      'mcp__noesis__get_note',
      'mcp__noesis__list_notes',
    ];
    expect(clampAllowedTools(ok)).toEqual(ok);
  });

  it('drops built-in tools that would grant shell, file or network access', () => {
    const attack = ['Bash', 'Write', 'Edit', 'Read', 'WebFetch', 'Task', 'NotebookEdit', 'Bash(rm -rf /)'];
    expect(clampAllowedTools(attack)).toEqual([]);
  });

  it('drops MUTATING Noesis tools even though they share the namespace', () => {
    // The whole reason the boundary is a literal set and not a /^mcp__noesis__/ prefix:
    // pull_notes writes to an arbitrary local path, add_root + sync_notes ingest local
    // files. A namespace clamp would hand a compromised server a filesystem primitive.
    const mutating = [
      'mcp__noesis__pull_notes', 'mcp__noesis__sync_notes', 'mcp__noesis__add_root',
      'mcp__noesis__trash_note', 'mcp__noesis__move_note', 'mcp__noesis__update_navi',
    ];
    expect(clampAllowedTools(mutating)).toEqual([]);
  });

  it('drops wildcards, prefix spoofs and smuggled separators', () => {
    expect(clampAllowedTools([
      '*', 'mcp__*', 'mcp__noesis__*', 'mcp__noesis',
      'mcp__noesisEVIL__get_note', 'notmcp__noesis__get_note',
      'mcp__noesis__get_note\nBash', 'mcp__noesis__get_note Bash',
      ' mcp__noesis__get_note', 'mcp__noesis__get_note ',
      'MCP__NOESIS__GET_NOTE',
    ])).toEqual([]);
  });

  it('survives non-array, non-string and hostile shapes', () => {
    expect(clampAllowedTools(undefined)).toEqual([]);
    expect(clampAllowedTools('mcp__noesis__get_note')).toEqual([]);
    expect(clampAllowedTools([null, 42, ['mcp__noesis__get_note'], { t: 'x' }])).toEqual([]);
    expect(clampAllowedTools([Object.create(null)])).toEqual([]);
  });

  it('keeps the good entries when they are mixed with bad ones', () => {
    expect(clampAllowedTools(['Bash', 'mcp__noesis__get_note', 'mcp__noesis__pull_notes']))
      .toEqual(['mcp__noesis__get_note']);
  });
});

describe('clampMaxTurns — a server cannot burn the subscription in a tool loop', () => {
  it('caps an absurd request', () => {
    expect(clampMaxTurns(10_000)).toBe(12);
  });

  it('floors nonsense to a single turn', () => {
    for (const bad of [undefined, null, 'many', NaN, Infinity, -5, 0]) {
      expect(clampMaxTurns(bad)).toBe(1);
    }
  });

  it('passes a sane request through', () => {
    expect(clampMaxTurns(6)).toBe(6);
  });
});
