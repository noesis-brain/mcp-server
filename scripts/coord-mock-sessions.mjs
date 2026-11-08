#!/usr/bin/env node
// coord-mock-sessions.mjs — the Chief of Staff's incident replay (TCK-1890, AC9).
//
// Four scripted ticket sessions on a scratch git repository, against a LOCAL backend on a test
// database. The harness:
//   1. signs up a fresh @example.test user and makes its API token;
//   2. creates the tickets, binds each to its session and sets its status;
//   3. builds the worktrees that reproduce this week's incidents
//      (references/chief-conflict-catalogue.md in claude-config, "The incidents behind the rows");
//   4. runs the real scanner and rules, and carries out every action the way the Chief does
//      (messages, an MCP version allocation, decisions and cards, the conflict report);
//   5. plays the sessions (heartbeats, a lease queue, ports, a handoff, inbox reads) and the owner
//      (answers, a policy switch, pause and continue) through the real routes;
//   6. checks each AC9 bullet and each of the 25 incident rows, and exits 0 only if all pass.
//
//   node coord-mock-sessions.mjs --api http://127.0.0.1:5790 [--json <file>] [--keep]
//
// It refuses an API that is not on this machine (localhost, 127.0.0.1, ::1, *.localhost). It writes
// only the new user's rows and its own scratch folder (removed at the end unless --keep).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scan } from './coord-scan.mjs';
import { rulesFor } from './coord-rules.mjs';

const MCP_DIR = 'md-manager-mcp-server';
const NPM_LATEST = '2.13.0';
const LOCAL_HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\]|[a-z0-9-]+\.localhost)$/i;

/** True only for an http(s) URL whose host is this machine. */
export function isLocalApi(url) {
  try {
    const u = new URL(url);
    return (u.protocol === 'http:' || u.protocol === 'https:') && LOCAL_HOST_RE.test(u.hostname);
  } catch {
    return false;
  }
}

/** The incident rows (catalogue, 2026-11-01 to 11-07) and the conditions each one needs. */
export const INCIDENTS = [
  [1, ['C1']], [2, ['C1', 'C6', 'C7']], [3, ['C7']], [4, ['C8']], [5, ['C19']], [6, ['C2', 'C9', 'C20']],
  [7, ['C2', 'C20']], [8, ['C20']], [9, ['C9']], [10, ['C20']], [11, ['C9', 'C10']], [12, ['C15']],
  [13, ['C9']], [14, ['C4']], [15, ['C1']], [16, ['C17']], [17, ['C10']], [18, ['C17', 'C20']],
  [19, ['C7', 'C8']], [20, ['C7', 'C8', 'C16']], [21, ['C4', 'C7']], [22, ['C19']], [23, ['C11']],
  [24, ['C12']], [25, ['C20']],
];

const clip = (s, n) => {
  const chars = Array.from(String(s));
  return chars.length <= n ? String(s) : `${chars.slice(0, n - 1).join('')}…`;
};

function git(cwd, args, env) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...(env || {}) } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${(r.stderr || '').trim()}`);
  return (r.stdout || '').trim();
}

function write(dir, file, text) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
}

/** The HTTP side: the loop surface (API token) and the owner surface (JWT). */
function client(api) {
  const call = async (method, route, bearer, body) => {
    const res = await fetch(api + route, {
      method,
      headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: json, text: text.slice(0, 300) };
  };
  return { call };
}

/**
 * The scratch repository: main, one worktree per ticket, and a worktree of a finished ticket for the
 * orphan server. Main's base is dated 3 hours ago; main moves on after the worktrees are cut.
 */
function buildRepo(root, t) {
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  for (const [k, v] of [['user.email', 'mock@example.test'], ['user.name', 'mock'], ['commit.gpgsign', 'false']]) git(repo, ['config', k, v]);
  write(repo, 'scripts/phase75-main.sql', 'CREATE TABLE main_t (id int);\n');
  write(repo, `${MCP_DIR}/package.json`, `{ "version": "${NPM_LATEST}" }\n`);
  write(repo, `${MCP_DIR}/src/a.ts`, 'export const a = 1;\n');
  write(repo, 'src/x.ts', 'export const x = 1;\n');
  write(repo, 'src/y.ts', 'export const y = 1;\n');
  write(repo, 'package-lock.json', '{ "lockfileVersion": 3 }\n');
  git(repo, ['add', '-A']);
  const old3h = new Date(Date.now() - 3 * 3600_000).toISOString();
  git(repo, ['commit', '-q', '-m', 'base'], { GIT_AUTHOR_DATE: old3h, GIT_COMMITTER_DATE: old3h });
  const wt = (n) => {
    const p = path.join(root, `repo-tck-${n}`);
    git(repo, ['worktree', 'add', '-q', '-b', `loop/tck-${n}`, p, 'main']);
    return p;
  };
  const w = { repo, A: wt(t.A.n), B: wt(t.B.n), C: wt(t.C.n), D: wt(t.D.n), F: wt(t.F.n) };
  // A: ready to merge, with a new migration (phase76) and an MCP change at 2.14.0.
  write(w.A, 'scripts/phase76-a.sql', 'CREATE TABLE a_t (id int);\n');
  write(w.A, `${MCP_DIR}/package.json`, '{ "version": "2.14.0" }\n');
  write(w.A, `${MCP_DIR}/src/a.ts`, 'export const a = 2;\n');
  git(w.A, ['add', '-A']); git(w.A, ['commit', '-q', '-m', 'A']);
  // B: ready to merge; changes src/y.ts.
  write(w.B, 'src/y.ts', 'export const y = 2;\n');
  git(w.B, ['add', '-A']); git(w.B, ['commit', '-q', '-m', 'B']);
  // C: being built; the same phase76 number as A, the same MCP version as A, src/y.ts against B,
  // src/x.ts against main's later change, and a lockfile change.
  write(w.C, 'scripts/phase76-c.sql', 'CREATE TABLE c_t (id int);\n');
  write(w.C, `${MCP_DIR}/package.json`, '{ "version": "2.14.0" }\n');
  write(w.C, 'src/y.ts', 'export const y = 3;\n');
  write(w.C, 'src/x.ts', 'export const x = 3;\n');
  write(w.C, 'package-lock.json', '{ "lockfileVersion": 3, "c": 1 }\n');
  git(w.C, ['add', '-A']); git(w.C, ['commit', '-q', '-m', 'C']);
  // F: a finished ticket's worktree, where a dev server still runs.
  write(w.F, 'src/f.ts', 'export const f = 1;\n');
  git(w.F, ['add', '-A']); git(w.F, ['commit', '-q', '-m', 'F']);
  // Main moves on after D's plan was written: it changes src/x.ts, which D's plan names.
  write(repo, 'src/x.ts', 'export const x = 0;\n');
  git(repo, ['commit', '-q', '-am', 'main changes x']);
  // The main checkout's MCP build is older than its source.
  write(repo, `${MCP_DIR}/dist/index.js`, '// built\n');
  const old2h = new Date(Date.now() - 2 * 3600_000);
  fs.utimesSync(path.join(repo, MCP_DIR, 'dist', 'index.js'), old2h, old2h);
  // D's plan, written 2 hours ago, names src/x.ts.
  const plan = path.join(root, 'plan-d.md');
  fs.writeFileSync(plan, '# Plan\n\n## Critical files\n- `src/x.ts`\n');
  fs.utimesSync(plan, old2h, old2h);
  w.plan = plan;
  return w;
}

export async function run({ api, keep = false, log = console.log }) {
  if (!isLocalApi(api)) throw new Error(`refused: ${api} is not a local API (localhost, 127.0.0.1, ::1 or *.localhost only)`);
  const { call } = client(api.replace(/\/+$/, ''));
  const runId = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
  const results = [];
  const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok), detail }); log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`); return Boolean(ok); };
  const need = (r, what) => { if (r.status >= 300) throw new Error(`${what}: HTTP ${r.status} ${r.text}`); return r.body; };

  // 1. A fresh owner, and the token its sessions use.
  const email = `chief-mock-${runId}@example.test`;
  const password = randomBytes(18).toString('base64url');
  const jwt = need(await call('POST', '/api/auth/signup', null, { email, password, displayName: 'Chief mock' }), 'signup').accessToken;
  const token = need(await call('POST', '/api/auth/tokens', jwt, { name: `coord-mock-${runId}` }), 'API token').token;
  const mcp = (method, route, body) => call(method, `/api/mcp/coordination${route}`, token, body);
  const owner = (method, route, body) => call(method, `/api/coordination${route}`, jwt, body);

  // 2. Tickets: A and B wait to ship, C is being built, D is being planned, E shares C's worktree,
  //    F is finished (its worktree keeps an old dev server).
  const S = { A: `mock-a-${runId}`, B: `mock-b-${runId}`, B2: `mock-b2-${runId}`, C: `mock-c-${runId}`, D: `mock-d-${runId}`, chief: `mock-chief-${runId}` };
  const t = {};
  for (const k of ['A', 'B', 'C', 'D', 'E', 'F']) {
    const created = need(await call('POST', '/api/backlog/issues', jwt, { title: `Chief mock ticket ${k} for the incident replay run ${runId}` }), `ticket ${k}`);
    t[k] = { key: created.issue.key, n: Number(created.issue.key.slice(4)) };
  }
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coord-mock-')));
  try {
    const w = buildRepo(root, t);
    const status = { A: 'ready_to_merge', B: 'ready_to_merge', C: 'implementing', D: 'planning' };
    for (const k of ['A', 'B', 'C', 'D']) {
      const cwd = w[k];
      need(await call('POST', `/api/mcp/backlog/issues/${t[k].key}/binding`, token, { session_id: S[k], machine: 'mock', cwd }), `bind ${k}`);
      if (status[k] !== 'planning') need(await call('POST', `/api/mcp/backlog/issues/${t[k].key}/status`, token, { session_id: S[k], machine: 'mock', cwd, status: status[k] }), `status ${k}`);
    }
    // 3. The sessions report in; one of B's two sessions and C's idle session are what C1 and C17 see.
    const live = [
      { k: 'A', sid: S.A, cwd: w.A, state: 'running', agent: 'busy' },
      { k: 'B', sid: S.B, cwd: w.B, state: 'running', agent: 'busy' },
      { k: 'B', sid: S.B2, cwd: path.join(w.B, 'src'), state: 'running', agent: 'busy' },
      { k: 'C', sid: S.C, cwd: w.C, state: 'idle', agent: 'idle' },
      { k: 'D', sid: S.D, cwd: w.D, state: 'waiting', agent: 'waiting' },
    ];
    for (const s of live) need(await mcp('POST', '/sessions/heartbeat', { session_id: s.sid, machine: 'mock', cwd: s.cwd, ticket: t[s.k].key, state: s.state }), `heartbeat ${s.sid}`);
    need(await mcp('POST', '/sessions/heartbeat', { session_id: S.chief, machine: 'mock', cwd: w.repo, state: 'running', note: 'Chief of Staff (mock)' }), 'heartbeat chief');

    // 4. The Chief's scan, report and rules.
    const board = { issues: [
      { key: t.A.key, work_status: 'ready_to_merge', bound_session_id: S.A }, { key: t.B.key, work_status: 'ready_to_merge', bound_session_id: S.B },
      { key: t.C.key, work_status: 'implementing', bound_session_id: S.C }, { key: t.D.key, work_status: 'planning', bound_session_id: S.D },
      { key: t.E.key, work_status: 'implementing', worktree: w.C },
    ] };
    const agents = [...live.map((s) => ({ sessionId: s.sid, cwd: s.cwd, status: s.agent })), { sessionId: S.chief, cwd: w.repo, status: 'busy' }];
    const listen = () => [{ pid: 424242, command: 'node', ports: [5799], cwd: path.join(w.F, 'src') }, { pid: 434343, command: 'node', ports: [5798], cwd: w.A }];
    const result = scan({ repo: w.repo, board, agents, npm: NPM_LATEST, plans: { [t.D.key]: w.plan }, listen });
    const has = (kind, pred = () => true) => result.conflicts.some((c) => c.kind === kind && pred(c));
    const actions = rulesFor(result);
    const before = need(await owner('GET', '/decisions?limit=200'), 'decisions').decisions.length;
    const done = [];
    const outcomes = new Map();
    for (const a of actions) {
      let r = null;
      if (a.type === 'message') r = await mcp('POST', '/messages', { to_session: a.to_session, ticket: a.ticket || null, kind: 'message', body: a.body, from_session: S.chief, as_chief: true });
      else if (a.type === 'allocate') {
        // As the rules emit it: the versions the branches hold go with the request (the server cannot
        // see them), and npm_latest is npm's real latest.
        r = await mcp('POST', '/allocations/mcp-version', { npm_latest: NPM_LATEST, ticket: a.ticket, holder: S.chief, in_branches: a.inBranches || [] });
      }
      else if (a.type === 'decide') {
        r = await mcp('POST', '/decisions', {
          category: a.category, rubric: a.rubric, choice: clip(a.choice, 500), reason: a.reason ? clip(a.reason, 500) : null,
          evidence: (a.evidence || []).slice(0, 10), ticket: a.ticket || null, session_id: S.chief, actor: 'chief', ...(a.card ? { card: a.card } : {}),
        });
      }
      if (r && r.status >= 300) check(`the Chief carries out ${a.key}`, false, `HTTP ${r.status} ${r.text}`);
      outcomes.set(a.key, r ? r.body : null);
      done.push(a.key);
    }
    const report = need(await mcp('POST', '/report', { conflicts: result.conflicts }), 'report');
    const decisions = need(await owner('GET', '/decisions?limit=200'), 'decisions').decisions;
    const decided = (category, pred = () => true) => decisions.filter((d) => d.category === category && pred(d));
    const inbox = async (sid) => need(await mcp('GET', `/inbox?session=${encodeURIComponent(sid)}`), `inbox ${sid}`);
    const bodies = async (sid) => (await inbox(sid)).messages.map((m) => m.body);
    const SESSIONS = [S.A, S.B, S.B2, S.C, S.D];
    const heardOnlyBy = async (pred, who) => {
      const got = await Promise.all(SESSIONS.map(async (sid) => (await bodies(sid)).some(pred)));
      return SESSIONS.every((sid, i) => got[i] === who.includes(sid));
    };
    // T2: each owner gate blocks exactly these tickets.
    const BLOCKS = { ship: [t.A.key, t.B.key], 'stop-session': [t.B.key], 'prod-schema': [t.A.key], 'mcp-publish': [t.A.key], 'merge-tickets': [t.C.key, t.E.key] };
    const blocksRight = (d) => {
      const want = BLOCKS[d.category];
      const got = (d.card && d.card.blocks ? d.card.blocks.map((b) => b.key) : []).sort();
      return Array.isArray(want) && JSON.stringify(got) === JSON.stringify([...want].sort());
    };

    // 5. AC9: every collision is found, rules run without a card, judgments, owner gates, answers, C15.
    const C = {};
    C.C1 = check('C1: the lane card waits for the owner and blocks A and B; B\'s second session is a stop-session card',
      has('C1', (c) => c.b === t.B.key || c.a === t.B.key) && has('C1', (c) => c.b === 'sessions' && c.a === t.B.key)
      && decided('ship', (d) => d.status === 'pending' && blocksRight(d)).length === 1
      && decided('stop-session', (d) => d.status === 'pending' && blocksRight(d)).length === 1);
    C.C2 = check('C2: B and C change src/y.ts; who rebases is a judgment for review (observe)', has('C2', (c) => [c.a, c.b].includes(t.B.key) && [c.a, c.b].includes(t.C.key))
      && decided('rebase', (d) => d.status === 'review' && d.card === null).length >= 1);
    C.C4 = check('C4: A and C both use phase76; only C (the later ticket) is told to rename, to the next free number phase77', has('C4', (c) => [c.a, c.b].includes(t.A.key) && [c.a, c.b].includes(t.C.key))
      && await heardOnlyBy((b) => b.startsWith('Migration number clash') && b.includes('the next free number is phase77'), [S.C]));
    C.C6 = check('C6: A ships a migration; the production apply waits for the owner, blocking A', decided('prod-schema', (d) => d.status === 'pending' && d.ticket === t.A.key && blocksRight(d)).length === 1);
    const clash = result.conflicts.find((c) => c.kind === 'C7' && c.severity === 'high' && c.evidence && c.evidence.later === t.C.key);
    const allocated = [...outcomes.entries()].find(([k]) => k.endsWith('|allocate'));
    C.C7 = check('C7: A and C hold 2.14.0; C gets the scanner\'s next version (above npm and A); A\'s npm publish waits for the owner',
      Boolean(clash) && allocated && allocated[1] && allocated[1].version === clash.evidence.next && clash.evidence.next !== '2.14.0'
      && decided('mcp-publish', (d) => d.status === 'pending' && d.ticket === t.A.key && blocksRight(d)).length === 1
      && await heardOnlyBy((b) => b.startsWith('MCP version clash'), [S.C]), JSON.stringify({ next: clash && clash.evidence.next, allocated: allocated && allocated[1] }));
    const everyone = [S.A, S.B, S.B2, S.C, S.D];
    const heardBy = async (prefix) => (await Promise.all(everyone.map(async (s) => (await bodies(s)).some((b) => b.startsWith(prefix))))).every(Boolean);
    C.C8 = check('C8: the old MCP build: every session is told to run /mcp after the rebuild', has('C8') && await heardBy("The main checkout's MCP build is older"));
    // C9: one full suite at a time on the shared test database.
    const l1 = need(await mcp('POST', '/leases/test-db/acquire', { holder: S.A, note: 'full suite' }), 'lease A');
    const l2 = need(await mcp('POST', '/leases/test-db/acquire', { holder: S.C, note: 'full suite' }), 'lease C');
    need(await mcp('POST', '/leases/test-db/release', { holder: S.A }), 'release A');
    const l3 = need(await mcp('POST', '/leases/test-db/acquire', { holder: S.C, note: 'full suite' }), 'lease C again');
    need(await mcp('POST', '/leases/test-db/release', { holder: S.C }), 'release C');
    C.C9 = check('C9: two full suites: one runs, the other queues behind it and runs when it ends',
      l1.granted === true && l2.granted === false && l2.holder && l2.holder.holder === S.A && l2.position === 1 && l3.granted === true, JSON.stringify([l1, l2, l3]).slice(0, 300));
    const cleanupOff = await owner('PUT', '/policy/cleanup', { mode: 'auto' });
    C.C10 = check('C10: the old dev server in a finished worktree is a cleanup for review; cleanup never goes auto (409 OBSERVE_ONLY)',
      has('C10', (c) => c.a === 'pid-424242') && !has('C10', (c) => c.a === 'pid-434343')
      && decided('cleanup', (d) => d.status === 'review').length === 1 && cleanupOff.status === 409 && cleanupOff.body && cleanupOff.body.error_code === 'OBSERVE_ONLY', `PUT cleanup auto -> ${cleanupOff.status} ${cleanupOff.text}`);
    const pA = need(await mcp('POST', '/allocations/port', { holder: S.A, ticket: t.A.key }), 'port A').port;
    const pC = need(await mcp('POST', '/allocations/port', { holder: S.C, ticket: t.C.key }), 'port C').port;
    C.C11 = check('C11: two loops get different ports and their own .localhost hosts',
      pA.slot !== pC.slot && pA.backend_port !== pC.backend_port && pA.host === `tck-${t.A.n}.localhost` && pC.host === `tck-${t.C.n}.localhost`, JSON.stringify([pA, pC]));
    C.C12 = check('C12: C changes package-lock.json: every session is told to npm install after it ships', has('C12', (c) => c.a === t.C.key) && await heardBy(`${t.C.key} changes package-lock.json`));
    C.C13 = check('C13: C and E share a worktree: merging or splitting waits for the owner, blocking both', decided('merge-tickets', (d) => d.status === 'pending' && blocksRight(d)).length === 1);
    C.C15 = check('C15: only D, still being planned, is told main changed src/x.ts, which its plan names',
      has('C15', (c) => c.a === t.D.key) && await heardOnlyBy((b) => b.includes('src/x.ts') && b.includes('re-read'), [S.D]));
    C.C16 = check('C16: C is behind main and conflicts with it: only its session is told to rebase, with the conflict named',
      await heardOnlyBy((b) => b.startsWith('Your branch is behind main') && /conflict/i.test(b), [S.C]));
    const sessions = need(await mcp('GET', '/sessions'), 'sessions').sessions;
    C.C17 = check('C17: C\'s session is idle while C is being built: a stopped loop, shown with its state',
      has('C17', (c) => c.a === t.C.key && c.evidence && c.evidence.stopped === true) && sessions.some((s) => s.session_id === S.C && s.state === 'idle'));
    const pending = need(await owner('GET', '/decisions?status=pending&limit=200'), 'pending').decisions;
    C.C19 = check('C19: every owner gate waits as a card that names exactly what it blocks and how long it has waited',
      pending.length === 5 && pending.every((d) => d.owner_gate && blocksRight(d) && typeof d.waiting_min === 'number'), `pending: ${pending.map((d) => `${d.category}:${(d.card && d.card.blocks || []).map((b) => b.key).join('+')}`).join(', ')}`);
    // C20: a handoff relayed between sessions, and one pause and one continue for everyone.
    const handoff = `Handoff from ${t.A.key}: the ship notes are in the ticket.`;
    need(await mcp('POST', '/messages', { to_session: S.B, kind: 'message', body: handoff, from_session: S.A, ticket: t.A.key }), 'handoff');
    need(await owner('POST', '/messages', { kind: 'pause', body: 'Pause at a safe point: the owner is away.' }), 'pause');
    const paused = await Promise.all(everyone.map(async (s) => (await inbox(s)).pause));
    need(await owner('POST', '/messages', { kind: 'continue', body: 'Continue.' }), 'continue');
    const resumed = await Promise.all(everyone.map(async (s) => (await inbox(s)).pause));
    C.C20 = check('C20: a handoff reaches only its session; one pause and one continue reach every session',
      (await bodies(S.B)).includes(handoff) && !(await bodies(S.C)).includes(handoff)
      && paused.every((p) => p && p.paused === true) && resumed.every((p) => p && p.paused === false), JSON.stringify([paused[0], resumed[0]]));

    // The other AC9 bullets.
    const RULE_KINDS = ['C3', 'C4', 'C8', 'C12', 'C15', 'C16', 'C17', 'C18'];
    const DECIDING_KINDS = ['C1', 'C2', 'C5', 'C6', 'C7', 'C10', 'C13', 'C14'];
    const kindOf = (a) => a.key.split('|')[0];
    check('AC9: rules run without a card: a rule kind never records a decision, only judgment and gate kinds do, and only decide actions made decisions',
      decisions.length - before === actions.filter((a) => a.type === 'decide').length
      && actions.every((a) => (a.type === 'decide' ? DECIDING_KINDS.includes(kindOf(a)) : !a.card))
      && actions.filter((a) => RULE_KINDS.includes(kindOf(a))).every((a) => a.type === 'message' || a.type === 'note'),
      `${decisions.length - before} decisions; decide kinds: ${[...new Set(actions.filter((a) => a.type === 'decide').map(kindOf))].join(',')}`);
    const ownerMessages = need(await owner('GET', '/messages?limit=200'), 'messages').messages;
    const chiefSent = ownerMessages.filter((m) => m.from_session === S.chief);
    check('AC9: the Chief speaks as the Chief: its messages come from the Chief session, its decisions carry the Chief session and actor',
      chiefSent.length === actions.filter((a) => a.type === 'message').length && chiefSent.every((m) => m.from_actor === 'chief')
      && decisions.length > before && decisions.slice(0, decisions.length - before).every((d) => d.actor === 'chief' && d.session_id === S.chief),
      `${chiefSent.length} Chief messages for ${actions.filter((a) => a.type === 'message').length} message actions`);
    check('AC9: acting once: the same scan with the done keys gives no action; the same report opens nothing new',
      rulesFor(result, done).length === 0 && need(await mcp('POST', '/report', { conflicts: result.conflicts }), 'report again').new === 0 && report.new === report.open);
    const rebase = actions.find((a) => a.type === 'decide' && a.category === 'rebase');
    const judgmentName = 'AC9: a judgment call is review in observe mode and auto after the owner switches its category';
    if (!rebase || !decided('rebase')[0]) {
      check(judgmentName, false, 'no rebase decision was recorded');
    } else {
      const switched = await owner('PUT', '/policy/rebase', { mode: 'auto', maxLevel: 1 });
      const again = await mcp('POST', '/decisions', { category: 'rebase', rubric: rebase.rubric, choice: clip(rebase.choice, 500), ticket: rebase.ticket, session_id: S.chief, actor: 'chief' });
      check(judgmentName,
        decided('rebase')[0].status === 'review' && switched.status === 200 && again.status === 201 && again.body.decision.status === 'auto' && again.body.result === 'proceed', `${switched.status} ${again.status} ${again.text}`);
    }
    const lane = decided('ship')[0];
    const gateName = 'AC9: owner gates always escalate: the ship policy is locked, and the loop surface cannot answer a card';
    const answerName = 'AC9: the owner\'s answer reaches the right sessions: the Chief that asked, and A and B, whose ship it blocks; not C or D';
    if (!lane) {
      check(gateName, false, 'no ship card was recorded');
      check(answerName, false, 'no ship card was recorded');
    } else {
    const shipAuto = await owner('PUT', '/policy/ship', { mode: 'auto' });
    const mcpAnswer = await mcp('POST', `/decisions/${lane.id}/answer`, { option: 'A' });
    check(gateName,
      shipAuto.status === 409 && mcpAnswer.status === 409 && mcpAnswer.body && mcpAnswer.body.error_code === 'OWNER_GATE', `${shipAuto.status} ${mcpAnswer.status}`);
    const answered = await owner('POST', `/decisions/${lane.id}/answer`, { option: 'A' });
    const heard = async (sid) => (await bodies(sid)).filter((b) => b.startsWith(`The owner answered card #${lane.id} `)).length;
    const counts = { chief: await heard(S.chief), A: await heard(S.A), B: await heard(S.B), C: await heard(S.C), D: await heard(S.D) };
    check(answerName,
      answered.status === 200 && counts.chief === 1 && counts.A === 1 && counts.B === 1 && counts.C === 0 && counts.D === 0, JSON.stringify(counts));
    }
    check('AC9: C15 (the planning-ticket message) — see C15 above', C.C15);

    // The incident replay: each row passes when every condition it needs passed.
    const rows = INCIDENTS.map(([n, kinds]) => ({ n, kinds, ok: kinds.every((k) => C[k] === true) }));
    for (const r of rows) check(`incident ${String(r.n).padStart(2)}: ${r.kinds.join(', ')}`, r.ok);
    return { ok: results.every((r) => r.ok), results, user: email, tickets: Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v.key])), root: keep ? root : null, scan: { conflicts: result.conflicts.length, actions: actions.length } };
  } finally {
    if (!keep) {
      // The repository and its worktrees all live in this one folder.
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const arg = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
  const api = arg('api');
  if (argv.includes('--selftest')) {
    const cases = [['http://127.0.0.1:5790', true], ['http://localhost:5790/', true], ['http://chief.localhost:3700', true], ['http://[::1]:5790', true],
      ['https://noesisbrain.com', false], ['http://127.0.0.1.evil.com', false], ['http://localhost.evil.com', false], ['file:///etc/passwd', false], ['nonsense', false]];
    const bad = cases.filter(([u, want]) => isLocalApi(u) !== want);
    console.log(bad.length ? `FAIL isLocalApi: ${JSON.stringify(bad)}` : 'ok    isLocalApi: only this machine');
    const kinds = new Set(INCIDENTS.flatMap(([, k]) => k));
    console.log(INCIDENTS.length === 25 && kinds.size === 15 ? 'ok    the 25 incident rows need 15 conditions' : `FAIL incidents: ${INCIDENTS.length} rows, ${kinds.size} conditions`);
    process.exit(bad.length || INCIDENTS.length !== 25 || kinds.size !== 15 ? 1 : 0);
  }
  if (!api) {
    console.error('usage: coord-mock-sessions.mjs --api http://127.0.0.1:<port> [--json <file>] [--keep] | --selftest');
    process.exit(2);
  }
  run({ api, keep: argv.includes('--keep') }).then((r) => {
    if (arg('json')) fs.writeFileSync(arg('json'), JSON.stringify(r, null, 2));
    console.log(r.ok ? `\nALL PASSED (${r.results.length} checks; user ${r.user})` : `\n${r.results.filter((x) => !x.ok).length} FAILED of ${r.results.length}`);
    process.exit(r.ok ? 0 : 1);
  }, (e) => {
    console.error(`ERROR ${e.message}`);
    process.exit(3);
  });
}
