import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/**
 * `scripts/start-agent.sh` KILLS any daemon it grades UNFIXED. Its grade greps the compiled
 * runner.js, so a refactor of runner.ts that it no longer recognises is not a cosmetic
 * failure — every user's daemon dies on their next restart. That nearly shipped with 2.2.0:
 * the check only knew the literal `tools: []`, which the web-tools change removes.
 *
 * So the script's real check runs here against runner.ts compiled by the TypeScript
 * emitter, plus controls that MUST grade UNFIXED — a check that cannot fail proves nothing.
 */
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(ROOT, 'scripts/start-agent.sh');
const VERSION: string = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const COMPILED = ts.transpileModule(readFileSync(join(ROOT, 'src/agent/runner.ts'), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;

function grade(runnerJs: string, version = VERSION): { code: number | null; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'noesis-grade-'));
  try {
    mkdirSync(join(dir, 'dist/agent'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@noesis-brain/mcp-server', version }));
    writeFileSync(join(dir, 'dist/agent/runner.js'), runnerJs);
    const r = spawnSync('bash', [SCRIPT, '--grade', dir], { encoding: 'utf8' });
    return { code: r.status, out: r.stdout.trim() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Replace exactly one occurrence, failing loudly if the anchor moved. */
function mutate(source: string, from: string, to: string): string {
  expect(source.split(from).length - 1).toBe(1);
  return source.replace(from, to);
}

describe('start-agent.sh --grade', () => {
  it('grades this checkout\'s runner.ts, compiled, as FIXED', () => {
    expect(grade(COMPILED)).toEqual({ code: 0, out: `${VERSION} FIXED` });
  });

  it('still grades a 2.1.5-shaped build (`tools: []`) as FIXED', () => {
    const legacy = 'export function buildQueryOptions() {\n  return { tools: [], canUseTool: gate };\n}\n';
    expect(grade(legacy, '2.1.5')).toEqual({ code: 0, out: '2.1.5 FIXED' });
  });

  it('UNFIXED when the built-in tool set is not restricted at all', () => {
    expect(grade(mutate(COMPILED, 'tools: webTools,', 'tools: undefined,'))).toEqual({ code: 1, out: `${VERSION} UNFIXED(code)` });
  });

  it('UNFIXED when the web allowlist is widened', () => {
    const widened = mutate(COMPILED, "ALLOWED_WEB_TOOLS = ['WebFetch', 'WebSearch']", "ALLOWED_WEB_TOOLS = ['WebFetch', 'WebSearch', 'Bash']");
    expect(grade(widened).code).toBe(1);
  });

  it('UNFIXED when the permission gate is gone', () => {
    expect(grade(COMPILED.replaceAll('canUseTool:', 'permissionHook:')).code).toBe(1);
  });

  it('UNFIXED when the markers survive only in comments', () => {
    const commentedOut = mutate(COMPILED, 'tools: webTools,', '// tools: webTools,\n        tools: undefined,');
    expect(grade(commentedOut).code).toBe(1);
  });

  it('UNFIXED below the 2.1.5 security floor, whatever the code says', () => {
    expect(grade(COMPILED, '2.1.4')).toEqual({ code: 1, out: '2.1.4 UNFIXED(v<2.1.5)' });
  });

  // The artifact that actually ships, when this checkout has been built.
  it.skipIf(!existsSync(join(ROOT, 'dist/agent/runner.js')))('grades the built dist/ as FIXED', () => {
    const r = spawnSync('bash', [SCRIPT, '--grade', ROOT], { encoding: 'utf8' });
    expect({ code: r.status, out: r.stdout.trim() }).toEqual({ code: 0, out: `${VERSION} FIXED` });
  });
});
