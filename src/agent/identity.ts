/**
 * Which machine, and which process, a daemon is — sent with every claim.
 *
 * A user may run the agent on several computers. The server keeps one health record
 * per machine (online? over its Claude limit? logged out?) so a healthy Mac can take
 * the jobs a blocked Windows box should not, and so the right machine's status shows
 * in Settings. Older daemons sent nothing that identifies the machine, so the server
 * fell back to the API token — two machines sharing one token looked like one.
 *
 *  - daemonId: stable across restarts. Read from (or created in) `<run dir>/daemon-id`;
 *    `NOESIS_AGENT_ID` overrides it (tests, or several daemons deliberately run apart).
 *  - bootId: new for every process, so the server can tell a restart (which clears a
 *    stale block) from two processes running on the same machine.
 *  - label / platform: shown to the user to tell machines apart.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, hostname, platform } from 'node:os';
import { join } from 'node:path';

export interface DaemonIdentity {
  daemonId: string;
  bootId: string;
  label: string;
  platform: string;
}

type Env = Record<string, string | undefined>;

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,80}$/;

function validId(v: string | undefined): v is string {
  return !!v && ID_PATTERN.test(v) && !/^legacy:/i.test(v);
}

/** Where the daemon keeps its state — the same directory scripts/start-agent.sh runs it in. */
export function agentRunDir(env: Env = process.env): string {
  return env.NOESIS_AGENT_RUN_DIR || join(homedir(), '.noesis-agent');
}

/**
 * The stable machine id. If the file can be neither read nor written, a hash of
 * machine facts keeps restarts agreeing with each other instead of minting a new
 * "machine" every time.
 */
export function resolveDaemonId(env: Env = process.env): string {
  const override = env.NOESIS_AGENT_ID?.trim();
  if (validId(override)) return override;

  const dir = agentRunDir(env);
  const file = join(dir, 'daemon-id');
  try {
    const existing = readFileSync(file, 'utf8').trim();
    if (validId(existing)) return existing;
  } catch {
    /* not created yet */
  }
  const id = randomUUID();
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, `${id}\n`, { mode: 0o600 });
    return id;
  } catch {
    return `h-${createHash('sha256').update(`${hostname()}|${platform()}|${homedir()}`).digest('hex').slice(0, 32)}`;
  }
}

export function resolveIdentity(env: Env = process.env): DaemonIdentity {
  const label = (env.NOESIS_AGENT_LABEL?.trim() || hostname() || 'agent').slice(0, 80);
  return { daemonId: resolveDaemonId(env), bootId: randomUUID(), label, platform: platform() };
}
