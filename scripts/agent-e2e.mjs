#!/usr/bin/env node
/**
 * Manual e2e for the Noesis Local Agent daemon (ai_mode = claude-subscription).
 *
 * Drives the full queue plumbing against a running backend WITHOUT needing a real
 * Claude login by running the daemon in FAKE mode (NOESIS_AGENT_FAKE=1): enqueue a
 * job → the daemon claims it → streams lease-fenced chunk events → completes it →
 * assert the job reaches `done` with the streamed text.
 *
 * Usage:
 *   NOESIS_API_URL=http://localhost:5555 \
 *   NOESIS_JWT=<a web-session access token for a claude-subscription user> \
 *   node scripts/agent-e2e.mjs
 *
 * (Get NOESIS_JWT from the browser devtools, or a POST /api/auth/login response.)
 * Builds must be current: `npm run build` first.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BASE = (process.env.NOESIS_API_URL || 'http://localhost:5555').replace(/\/$/, '');
const JWT = process.env.NOESIS_JWT;
if (!JWT) {
  console.error('Set NOESIS_JWT (a web access token for a claude-subscription user).');
  process.exit(1);
}
const here = dirname(fileURLToPath(import.meta.url));

const authed = (headers = {}) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${JWT}`, ...headers });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // 1. Ensure the user is in claude-subscription mode + mint a daemon token.
  await fetch(`${BASE}/api/auth/profile`, { method: 'PUT', headers: authed(), body: JSON.stringify({ aiMode: 'claude-subscription' }) });
  const tokRes = await fetch(`${BASE}/api/auth/tokens`, { method: 'POST', headers: authed(), body: JSON.stringify({ name: 'agent-e2e' }) });
  const tok = await tokRes.json();
  const noe = tok.token || tok.apiToken;
  if (!noe) throw new Error('could not mint a noe_ token');

  // 2. Enqueue a job with a composed payload (what the server will produce in B4).
  const enq = await fetch(`${BASE}/api/agent/jobs`, {
    method: 'POST', headers: authed(),
    body: JSON.stringify({ kind: 'study-note', payload: { prompt: 'Summarize loop engineering in one line.' } }),
  });
  const { jobId } = await enq.json();
  if (!jobId) throw new Error('enqueue failed (is ai_mode=claude-subscription?)');
  console.log(`enqueued ${jobId}`);

  // 3. Run the daemon (FAKE mode) briefly.
  const daemon = spawn('node', [join(here, '..', 'dist', 'index.js'), 'agent'], {
    env: { ...process.env, NOESIS_API_URL: BASE, NOESIS_API_TOKEN: noe, NOESIS_AGENT_FAKE: '1' },
    stdio: 'inherit',
  });
  await sleep(5000);
  daemon.kill('SIGTERM');
  await sleep(500);

  // 4. Assert the job completed with streamed output.
  const poll = await fetch(`${BASE}/api/agent/jobs/${jobId}?since=0`, { headers: authed() });
  const job = await poll.json();
  const streamed = (job.events || []).map((e) => e.data?.text || '').join('');
  console.log(`status=${job.status} events=${job.events?.length ?? 0} result=${JSON.stringify(job.result)}`);
  if (job.status !== 'done') throw new Error(`expected done, got ${job.status}`);
  if (!streamed) throw new Error('no streamed text');
  console.log('PASS — daemon claimed, streamed (lease-fenced), and completed the job.');
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
