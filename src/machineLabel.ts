/**
 * The computer name shown on a Jot ticket that a Claude Code session is working on.
 *
 * Sources, in order:
 *  1. env `NOESIS_AGENT_LABEL` — the same override the agent daemon uses
 *     (agent/identity.ts), so a user who named a machine once sees that name everywhere;
 *  2. on macOS, `scutil --get ComputerName` ("Chandler's MacBook Pro") — `os.hostname()`
 *     there follows the network the Mac has joined (`Mac.hitronhub.home`), so it changes;
 *  3. `os.hostname()` — stable on Windows (the computer name) and Linux.
 *
 * The scutil answer is cached for the life of the process: the MCP server runs once per
 * Claude Code session, and the computer's name does not change under it.
 */
import os from 'node:os';
import { execFileSync } from 'node:child_process';

type ExecFile = (file: string, args: string[], opts: { encoding: 'utf8'; timeout: number }) => string;

export interface MachineLabelDeps {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  hostname?: () => string;
  execFile?: ExecFile;
}

let cached: string | null = null;

/** Compute the label (no cache) — exported for tests. */
export function computeMachineLabel(deps: MachineLabelDeps = {}): string {
  const env = deps.env ?? process.env;
  const fromEnv = (env.NOESIS_AGENT_LABEL || '').trim();
  if (fromEnv) return fromEnv.slice(0, 200);
  const platform = deps.platform ?? process.platform;
  if (platform === 'darwin') {
    try {
      const run: ExecFile = deps.execFile ?? ((f, a, o) => execFileSync(f, a, o));
      const name = run('scutil', ['--get', 'ComputerName'], { encoding: 'utf8', timeout: 1000 }).trim();
      if (name) return name.slice(0, 200);
    } catch {
      /* no scutil answer — fall back to the hostname */
    }
  }
  return (deps.hostname ?? os.hostname)().slice(0, 200);
}

/** The cached label for this process. */
export function machineLabel(): string {
  if (cached === null) cached = computeMachineLabel();
  return cached;
}
