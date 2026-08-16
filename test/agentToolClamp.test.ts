import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clampAllowedTools, clampMaxTurns, buildQueryOptions, buildCanUseTool, runSdkQuery } from '../src/agent/runner.js';

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

  // Cardinality, not just membership. The tests below enumerate names they expect to be
  // REJECTED, so the allowlist could be widened with any name nobody thought to enumerate
  // (`mcp__noesis__delete_navi`, `create_navi`, `LS`, …) and stay green. The MCP server
  // registers ~55 tools; a 6-name deny list is not a boundary. Pin the size.
  it('permits exactly four tools — the set cannot be widened unnoticed', () => {
    const everyRealTool = [
      'mcp__noesis__search_notes', 'mcp__noesis__search_semantic', 'mcp__noesis__get_note',
      'mcp__noesis__list_notes', 'mcp__noesis__list_roots', 'mcp__noesis__list_codebases',
      'mcp__noesis__delete_navi', 'mcp__noesis__create_navi', 'mcp__noesis__update_relations',
      'mcp__noesis__pull_notes', 'mcp__noesis__sync_notes', 'mcp__noesis__add_root',
      'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'LS', 'Task', 'WebFetch', 'WebSearch',
    ];
    expect(clampAllowedTools(everyRealTool)).toHaveLength(4);
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

/**
 * The OTHER half of the boundary, and the one that was missing until 2026-08-14.
 *
 * clampAllowedTools decides what is PRE-APPROVED; it never decided what EXISTS. With
 * the SDK's `tools` option unset the CLI defaults to its whole built-in set, whose
 * read-only members (Read/Grep/Glob) need no approval and therefore execute headless.
 * A transform-only English-coach Navi used them to grep the daemon's cwd and return
 * ~100 strings from the user's source tree (real jobs 527/528). `tools: []` is what
 * closes that, and it must stay unconditional — no payload field may re-open it.
 */
describe('buildQueryOptions — the built-in tool set is always suppressed', () => {
  const noMcp = () => ({});

  it('sets tools to an empty array for a bare payload', () => {
    expect(buildQueryOptions({}, noMcp).tools).toEqual([]);
  });

  // PRODUCTION-SHAPED payload: a real composed chat job carries `prompt` (required) and
  // `system` (the Navi persona) — the shape of incident jobs 527/528.
  it('still suppresses built-ins on a production-shaped payload (system + MCP tools)', () => {
    const opts = buildQueryOptions(
      { prompt: 'refine this', system: 'You are Nancy.', allowedTools: ['mcp__noesis__get_note'], maxTurns: 6 },
      noMcp,
    );
    expect(opts.tools).toEqual([]);
    expect(opts.allowedTools).toEqual(['mcp__noesis__get_note']);
    expect(opts.systemPrompt).toBe('You are Nancy.');
  });

  // The invariant is "ALWAYS `[]`, for EVERY payload" — so prove it over the whole field
  // space rather than over hand-picked shapes. Two review rounds died to this: the first
  // suite pinned `tools` only on payloads with no `system`, the second only on payloads
  // with `system` — both missed `prompt`, which is REQUIRED and truthy on every real job
  // (`agentJobChat.ts` always sets it), so a mutation keyed on it would leak built-ins on
  // 100% of jobs. Enumerating shapes loses that race every time a field is added to
  // `JobPayload`; the power set does not.
  it('emits tools: [] for every combination of JobPayload fields present/absent', () => {
    const fields: Array<[string, unknown]> = [
      ['prompt', 'refine this'],
      ['system', 'You are Nancy.'],
      ['allowedTools', ['mcp__noesis__get_note']],
      ['maxTurns', 6],
      ['images', [{ mimeType: 'image/png', data: 'AAAA' }]],
    ];
    for (let mask = 0; mask < 1 << fields.length; mask++) {
      const payload: Record<string, unknown> = {};
      fields.forEach(([k, v], i) => { if (mask & (1 << i)) payload[k] = v; });
      const opts = buildQueryOptions(payload as Parameters<typeof buildQueryOptions>[0], noMcp);
      // Assert EVERY security-relevant option here, not just one of them. This loop has
      // now caught the same defect three times, each on a field the previous fix forgot:
      // `system`, then `prompt`/`images`/omission, then `canUseTool` keyed on `maxTurns`
      // (which every real job carries, so the gate would vanish from 100% of traffic).
      // Adding a security-relevant option to buildQueryOptions means adding it HERE.
      expect({ mask, tools: opts.tools }).toEqual({ mask, tools: [] });
      expect({ mask, has: 'tools' in opts }).toEqual({ mask, has: true });
      expect({ mask, gate: typeof opts.canUseTool }).toEqual({ mask, gate: 'function' });
    }
  });

  it('cannot be re-opened by a hostile payload naming built-ins', () => {
    const opts = buildQueryOptions({ system: 'persona', allowedTools: ['Bash', 'Read', 'Write'] }, noMcp);
    expect(opts.tools).toEqual([]);
    expect(opts.allowedTools).toEqual([]);
  });

  // `JobPayload` is a compile-time interface with no runtime schema validation, so a
  // server-supplied payload can carry arbitrary extra fields. A `tools` key must never
  // reach the SDK — the function's stated invariant is that a payload can never ask for
  // a filesystem primitive.
  it('ignores a tools field smuggled in by the payload', () => {
    const hostile = { system: 'persona', tools: ['Bash', 'Read'] } as unknown as Parameters<typeof buildQueryOptions>[0];
    expect(buildQueryOptions(hostile, noMcp).tools).toEqual([]);
  });

  // ABSENCE is never asserted by a "does it contain X" test. Adding
  // `permissionMode: 'bypassPermissions'` or `allowDangerouslySkipPermissions: true` —
  // both real SDK options that map to CLI flags — would hand the model everything back
  // while every other assertion here stayed green. Pin the exact key set instead, so any
  // new option must be added here deliberately.
  it('emits exactly the expected option keys — no permission escape hatch can be slipped in', () => {
    const withTools = buildQueryOptions(
      { prompt: 'x', system: 'p', allowedTools: ['mcp__noesis__get_note'], maxTurns: 6 },
      () => ({ noesis: { command: 'node' } }),
    );
    expect(Object.keys(withTools).sort()).toEqual(
      ['allowedTools', 'canUseTool', 'includePartialMessages', 'maxTurns', 'mcpServers', 'systemPrompt', 'tools'],
    );
    const bare = buildQueryOptions({ prompt: 'x' }, () => ({ noesis: { command: 'node' } }));
    expect(Object.keys(bare).sort()).toEqual(
      ['allowedTools', 'canUseTool', 'includePartialMessages', 'maxTurns', 'tools'],
    );
  });

  it('spawns the MCP server only when a tool survived clamping', () => {
    const withMcp = () => ({ noesis: { command: 'node' } });
    expect(buildQueryOptions({ allowedTools: ['Bash'] }, withMcp).mcpServers).toBeUndefined();
    expect(buildQueryOptions({ allowedTools: ['mcp__noesis__get_note'] }, withMcp).mcpServers)
      .toEqual({ noesis: { command: 'node' } });
  });

  it('passes the composed system prompt through untouched, and omits it when absent', () => {
    expect(buildQueryOptions({ system: 'You are Nancy.' }, noMcp).systemPrompt).toBe('You are Nancy.');
    expect('systemPrompt' in buildQueryOptions({}, noMcp)).toBe(false);
  });
});

/**
 * The SECOND layer. `tools: []` depends on how the CLI handles `--tools ""`, which lives
 * in a minified bundle we cannot audit; this callback is a gate the daemon owns outright.
 * It must never widen past ALLOWED_TOOLS, and it must cover subagent calls — a `Task`
 * subagent, not the main loop, performed the file reads in the 2026-08-14 incident.
 */
describe('buildCanUseTool — the daemon-owned permission gate', () => {
  const silent = () => {};
  const ALL4 = ['mcp__noesis__search_notes', 'mcp__noesis__search_semantic', 'mcp__noesis__get_note', 'mcp__noesis__list_notes'];

  it('allows exactly the four read-only Noesis lookups', async () => {
    const gate = buildCanUseTool(ALL4, silent);
    for (const t of [
      'mcp__noesis__search_notes',
      'mcp__noesis__search_semantic',
      'mcp__noesis__get_note',
      'mcp__noesis__list_notes',
    ]) {
      expect({ t, behavior: (await gate(t, {})).behavior }).toEqual({ t, behavior: 'allow' });
    }
  });

  it('denies every built-in that grants shell, file or network access', async () => {
    const gate = buildCanUseTool(ALL4, silent);
    for (const t of ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob', 'Task', 'WebFetch', 'WebSearch', 'NotebookEdit']) {
      const d = await gate(t, {});
      expect({ t, behavior: d.behavior }).toEqual({ t, behavior: 'deny' });
    }
  });

  it('denies the MUTATING Noesis tools even though they share the namespace', async () => {
    const gate = buildCanUseTool(ALL4, silent);
    for (const t of ['mcp__noesis__pull_notes', 'mcp__noesis__sync_notes', 'mcp__noesis__add_root']) {
      expect({ t, behavior: (await gate(t, {})).behavior }).toEqual({ t, behavior: 'deny' });
    }
  });

  it('passes the original input through on allow, and names the tool on deny', async () => {
    const gate = buildCanUseTool(ALL4, silent);
    const allow = await gate('mcp__noesis__get_note', { id: 42 });
    expect(allow).toEqual({ behavior: 'allow', updatedInput: { id: 42 } });
    const deny = await gate('Bash', { command: 'rm -rf /' });
    expect(deny.behavior).toBe('deny');
    expect((deny as { message: string }).message).toContain('Bash');
  });

  it('reports the agentID so SUBAGENT tool calls are observable, not just main-loop ones', async () => {
    const seen: Array<[string, boolean, string | undefined]> = [];
    const gate = buildCanUseTool(ALL4, (t, allowed, agentID) => seen.push([t, allowed, agentID]));
    await gate('Bash', { command: 'ls' }, { agentID: 'agent-abc123' });
    await gate('mcp__noesis__get_note', {}, { agentID: 'agent-abc123' });
    expect(seen).toEqual([
      ['Bash', false, 'agent-abc123'],
      ['mcp__noesis__get_note', true, 'agent-abc123'],
    ]);
  });

  // The gate must be the INTERSECTION (what this job was clamped to), not the UNION of
  // everything the daemon could ever allow. An earlier version closed over the module-wide
  // ALLOWED_TOOLS, so a job clamped to one tool could still execute the other three. Chat
  // happens to request all four today, which is exactly why this would have gone unnoticed.
  it('allows only what THIS job was clamped to, not all of ALLOWED_TOOLS', async () => {
    const opts = buildQueryOptions({ prompt: 'x', allowedTools: ['mcp__noesis__get_note'] }, () => ({}));
    const gate = opts.canUseTool as (t: string, i?: unknown) => Promise<{ behavior: string }>;
    expect((await gate('mcp__noesis__get_note', {})).behavior).toBe('allow');
    for (const other of ['mcp__noesis__search_notes', 'mcp__noesis__search_semantic', 'mcp__noesis__list_notes']) {
      expect({ other, behavior: (await gate(other, {})).behavior }).toEqual({ other, behavior: 'deny' });
    }
  });

  // The gate must be fed the CLAMPED list, never the raw payload. Feeding it
  // `payload.allowedTools` would let a hostile server re-approve exactly what
  // clampAllowedTools exists to strip — `Bash`, `pull_notes` — through the second layer,
  // defeating the first. A mutant doing this survived until this test existed.
  it('is fed the clamped list, so a hostile payload cannot re-approve stripped tools', async () => {
    const opts = buildQueryOptions(
      { prompt: 'x', allowedTools: ['Bash', 'mcp__noesis__pull_notes', 'mcp__noesis__get_note'] },
      () => ({}),
    );
    expect(opts.allowedTools).toEqual(['mcp__noesis__get_note']); // clamp stripped the rest
    const gate = opts.canUseTool as (t: string, i?: unknown) => Promise<{ behavior: string }>;
    for (const stripped of ['Bash', 'mcp__noesis__pull_notes']) {
      expect({ stripped, behavior: (await gate(stripped, {})).behavior }).toEqual({ stripped, behavior: 'deny' });
    }
    expect((await gate('mcp__noesis__get_note', {})).behavior).toBe('allow');
  });

  // A job with nothing clamped in spawns no MCP server, so the correct gate denies all.
  it('denies everything when the job was clamped to no tools at all', async () => {
    const opts = buildQueryOptions({ prompt: 'x' }, () => ({}));
    const gate = opts.canUseTool as (t: string, i?: unknown) => Promise<{ behavior: string }>;
    for (const t of ['mcp__noesis__get_note', 'Bash', 'Read']) {
      expect({ t, behavior: (await gate(t, {})).behavior }).toEqual({ t, behavior: 'deny' });
    }
  });

  it('is wired into every query, for every payload shape', () => {
    const noMcp = () => ({});
    expect(typeof buildQueryOptions({}, noMcp).canUseTool).toBe('function');
    expect(typeof buildQueryOptions({ prompt: 'x', system: 'y' }, noMcp).canUseTool).toBe('function');
  });
});

/**
 * THE CALL SITE, not just the builders.
 *
 * The previous suite pinned `buildQueryOptions` with a power-set mutation battery and
 * still let the entire fix be reverted: nothing asserted that `executeJob` USES it, so
 * restoring the pre-fix inline options literal removed `tools: []` and `canUseTool` with
 * all 79 tests green. A correct builder nobody calls protects nothing.
 *
 * Two layers, because a unit test alone cannot pin a call site:
 *  1. a runtime seam (`runSdkQuery`) a fake SDK can capture, and
 *  2. a source-fitness assertion that `executeJob` delegates instead of hand-rolling.
 */
describe('runSdkQuery — what actually reaches sdk.query()', () => {
  const capture = () => {
    const seen: { args?: { prompt: unknown; options: Record<string, unknown> } } = {};
    const sdk = {
      query(args: { prompt: unknown; options: Record<string, unknown> }) {
        seen.args = args;
        return (async function* () { /* no messages */ })();
      },
    };
    return { sdk, seen };
  };

  it('hands the SDK tools: [] and a canUseTool gate on a production-shaped payload', () => {
    const { sdk, seen } = capture();
    runSdkQuery(sdk, { prompt: 'refine this', system: 'persona', allowedTools: ['mcp__noesis__get_note'], maxTurns: 6 }, 'chat', () => ({}));
    expect(seen.args!.options.tools).toEqual([]);
    expect(typeof seen.args!.options.canUseTool).toBe('function');
    expect(seen.args!.prompt).toBe('refine this');
  });

  it('suppresses built-ins for every job kind, including the non-chat kinds', () => {
    for (const kind of ['chat', 'skim-read', 'enhance-metadata', 'study-note']) {
      const { sdk, seen } = capture();
      runSdkQuery(sdk, { prompt: 'x' }, kind, () => ({}));
      expect({ kind, tools: seen.args!.options.tools }).toEqual({ kind, tools: [] });
      expect({ kind, gate: typeof seen.args!.options.canUseTool }).toEqual({ kind, gate: 'function' });
    }
  });

  it('falls back to a labelled prompt when the payload carries none', () => {
    const { sdk, seen } = capture();
    runSdkQuery(sdk, {}, 'study-note', () => ({}));
    expect(seen.args!.prompt).toBe('(study-note job with empty prompt)');
    expect(seen.args!.options.tools).toEqual([]);
  });

  it('still suppresses built-ins on the image path (generator prompt)', () => {
    const { sdk, seen } = capture();
    runSdkQuery(sdk, { prompt: 'caption', images: [{ mimeType: 'image/png', data: 'AAAA' }] }, 'chat', () => ({}));
    expect(seen.args!.options.tools).toEqual([]);
    expect(typeof (seen.args!.prompt as { next?: unknown }).next).toBe('function'); // generator, not a string
  });
});

describe('source fitness — executeJob may not hand-roll SDK options', () => {
  const stripComments = (t: string) =>
    t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // Count call sites across the WHOLE source tree, not one hard-coded path: asserting on
  // `runner.ts` alone reports "the boundary broke" if someone legitimately extracts
  // runSdkQuery into its own module. Comments are stripped first — this file documents
  // `sdk.query()` in three doc blocks, and a naive match counted those as calls.
  const SRC_DIR = fileURLToPath(new URL('../src', import.meta.url));
  const ALL_SRC = readdirSync(SRC_DIR, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts'))
    .map((f) => stripComments(readFileSync(join(SRC_DIR, f), 'utf8')))
    .join('\n');
  const SRC = stripComments(readFileSync(fileURLToPath(new URL('../src/agent/runner.ts', import.meta.url)), 'utf8'));

  it('calls sdk.query in exactly one place in the whole tree, and it uses the builders', () => {
    expect(ALL_SRC.match(/sdk\.query\(/g) ?? []).toHaveLength(1);
    expect(ALL_SRC).toMatch(/return sdk\.query\(\{/);
    expect(ALL_SRC).toMatch(/options: buildQueryOptions\(/);
  });

  it('executeJob delegates to runSdkQuery rather than calling the SDK itself', () => {
    const exec = SRC.slice(SRC.indexOf('async function executeJob'));
    expect(exec.includes('async function executeJob')).toBe(true);
    expect(exec).not.toMatch(/sdk\.query\(/);
    // Pin the ARGUMENTS, not just the delegation. Passing a doctored payload here —
    // `{...job.payload, allowedTools: [...ALLOWED_TOOLS]}` — re-creates the exact union
    // defect INC-2 removed, one frame above the seam, with the whole suite green.
    expect(exec).toMatch(/runSdkQuery\(sdk, job\.payload, job\.kind/);
  });

  it('requires an explicit permitted set — no default that silently restores the union', () => {
    // A default (`permitted: Iterable<string> = ALLOWED_TOOLS`) makes arity 1 and quietly
    // reinstates the widening for any caller that forgets the argument.
    expect(buildCanUseTool.length).toBe(1);
  });
});
