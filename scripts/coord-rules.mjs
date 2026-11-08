#!/usr/bin/env node
// coord-rules.mjs — what the Chief of Staff does about each conflict the scanner reports (TCK-1890).
// The rules in references/chief-conflict-catalogue.md, as code, so they are the same on every wake
// and testable without a model:
//
//   - a RULE is mechanical: a message to the sessions it concerns (rebase, re-read, run /mcp,
//     npm install, the next free phase number) or a lease or allocation step. It never makes a card.
//   - a JUDGMENT is recorded with coord_decide and its rubric: in observe mode it does not wait and
//     goes to the owner's review list (who rebases, which ticket ships first, a cleanup).
//   - an OWNER GATE always waits as a Decision Card (merging two tickets that share a worktree).
//
// Every action has a key (kind, the pair, the action), so the Chief acts once per conflict, not on
// every scan: it passes the keys it already acted on as `done`.
//
//   node coord-rules.mjs --scan <scan.json> [--done <keys.json>] [--json]
//   node coord-rules.mjs --selftest
//
// It only reads its inputs and prints the actions; the Chief carries them out with its MCP tools.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TICKET_RE = /^TCK-\d+$/;
const isTicket = (k) => TICKET_RE.test(String(k || ''));

/** A rubric for a two-way door on shared code: L1, which observe mode records for review. */
const SHARED_TWO_WAY = { reversible: true, shared: true, userVisible: false, touches: [], confidence: 'high', evidence: 'measured' };
/** A cleanup of another session's process: reversible only by restarting it, so it is user-visible. */
const CLEANUP = { reversible: false, shared: true, userVisible: true, touches: [], confidence: 'low', evidence: 'measured' };

const ticketNumber = (k) => Number(String(k).slice(4));

/** A pair's two tickets in number order. The scanner orders them, but a stored or hand-made row may not. */
function byNumber(c) {
  return ticketNumber(c.a) <= ticketNumber(c.b) ? [c.a, c.b] : [c.b, c.a];
}

const keyOf = (c, action) => `${c.kind}|${c.a}|${c.b || ''}|${action}`;
const list = (files, n = 5) => (Array.isArray(files) && files.length ? ` (${files.slice(0, n).join(', ')}${files.length > n ? ', …' : ''})` : '');

/** The session id of a ticket, from the scan's ticket rows. */
function sessionOf(scan, key) {
  const t = (scan.tickets || []).find((x) => x.key === key);
  return t && t.sessionId ? t.sessionId : null;
}

/**
 * The actions for one scan. Each is { key, type, ... } where type is:
 *   message    {to_session | null (everyone), ticket, body}; a message for one ticket whose
 *              ticket has no session becomes a note, so it never goes to everyone
 *   allocate   {what: 'mcp-version', ticket}
 *   decide     {category, rubric, choice, reason, ticket, evidence, card?}   (a judgment or an owner gate)
 *   note       {text}   (a rule that needs no step: logged once in the report)
 * Conflicts whose key is in `done` give no action.
 */
export function rulesFor(scan, done = []) {
  const skip = new Set(done);
  const out = [];
  const push = (c, action, a) => {
    const key = keyOf(c, action);
    if (skip.has(key) || out.some((x) => x.key === key)) return;
    out.push({ key, ...a });
  };
  /** A message to one ticket's session. With no session to address, it is logged as a note instead. */
  const toTicket = (c, ticket, body) => {
    const session = isTicket(ticket) ? sessionOf(scan, ticket) : null;
    if (session) push(c, 'message', { type: 'message', to_session: session, ticket, body });
    else push(c, 'note', { type: 'note', text: `${ticket || c.a} has no session to tell: ${body}` });
  };
  for (const c of scan.conflicts || []) {
    const ticketSide = isTicket(c.a) ? c.a : isTicket(c.b) ? c.b : null;
    const both = isTicket(c.a) && isTicket(c.b);
    const [first, later] = both ? byNumber(c) : [ticketSide, ticketSide];
    switch (c.kind) {
      case 'C15':
        toTicket(c, c.a, `main changed file(s) your plan names since you wrote it${list(c.evidence && c.evidence.files)}. Pull main and re-read them before you build.`);
        break;
      case 'C16':
        toTicket(c, c.a, `Your branch is behind main: ${c.detail}. Rebase or merge main before your next commit.`);
        break;
      case 'C4':
        toTicket(c, later, `Migration number clash: ${c.detail}. Rename your file to the next free number when you ship.`);
        break;
      case 'C7':
        if (c.severity === 'high' && c.evidence && isTicket(c.evidence.later)) {
          push(c, 'allocate', { type: 'allocate', what: 'mcp-version', ticket: c.evidence.later });
          toTicket(c, c.evidence.later, `MCP version clash: ${c.detail}. Take the version coord_allocate_mcp_version hands you; an npm publish is the owner's.`);
        } else if (ticketSide) {
          push(c, 'note', { type: 'note', text: `${ticketSide}: ${c.detail}` });
        }
        break;
      case 'C8':
        push(c, 'message', { type: 'message', to_session: null, ticket: null, body: `The main checkout's MCP build is older than its source. After it is rebuilt, run /mcp so your tools are current.` });
        break;
      case 'C12':
        push(c, 'message', { type: 'message', to_session: null, ticket: c.a, body: `${c.a} changes package-lock.json: after it ships, run npm install in your worktree.` });
        break;
      case 'C18':
        push(c, 'message', { type: 'message', to_session: null, ticket: null, body: `A shared Claude Code setting or hook changed (${c.detail}). Check that your loop still runs as expected.` });
        break;
      case 'C2':
        push(c, 'decide', { type: 'decide', category: 'rebase', rubric: SHARED_TWO_WAY, ticket: later, choice: `${later} rebases on ${first} after ${first} ships`, reason: `Both change files outside the shared list: ${c.detail}. The later ticket by number rebases, so the first one ships unchanged.`, evidence: [c.a, c.b] });
        break;
      case 'C5':
      case 'C14':
        push(c, 'decide', { type: 'decide', category: 'ship-order', rubric: SHARED_TWO_WAY, ticket: later, choice: `${first} ships before ${later}`, reason: `${c.detail}. The lower ticket number ships first unless the owner says otherwise.`, evidence: [c.a, c.b] });
        break;
      case 'C10':
        push(c, 'decide', { type: 'decide', category: 'cleanup', rubric: CLEANUP, ticket: ticketSide, choice: `Stop the stale process: ${c.detail}`, reason: 'A process of a session that is gone holds a port or the shared test database.', evidence: ticketSide ? [ticketSide] : undefined });
        break;
      case 'C13':
        push(c, 'decide', {
          type: 'decide',
          category: 'merge-tickets',
          rubric: { reversible: false, shared: true, userVisible: true, touches: [], confidence: 'high', evidence: 'measured' },
          ticket: c.a,
          choice: `Merge ${c.b} into ${c.a}, or split them into two worktrees`,
          reason: c.detail,
          evidence: [c.a, c.b],
          card: {
            question: `${c.a} and ${c.b} work in one worktree. Merge them into one ticket, or split them?`,
            recommended: 'A',
            reason: 'Two tickets in one worktree ship together anyway; one ticket keeps the ship order and the status true.',
            options: [
              { label: `Merge ${c.b} into ${c.a}`, ifChosen: `${c.b} is marked Merged; its words move into ${c.a}`, undo: 'one-way: a merged ticket stays merged' },
              { label: 'Split them', ifChosen: `${c.b} gets its own worktree and branch`, undo: 'merge them later' },
            ],
            blocks: [{ key: c.a }, { key: c.b }],
            whyNotDecided: 'merge-tickets is always the owner\'s',
            proof: [c.a, c.b],
          },
        });
        break;
      case 'C3':
        push(c, 'note', { type: 'note', text: `${c.a} and ${c.b} share low-risk files; the later one re-merges them at rebase.` });
        break;
      case 'C17':
        push(c, 'note', { type: 'note', text: `${c.a}: ${c.detail}` });
        break;
      default:
        push(c, 'note', { type: 'note', text: `${c.kind} ${c.a}${c.b ? ` / ${c.b}` : ''}: ${c.detail}` });
    }
  }
  return out;
}

function selftest() {
  let failed = 0;
  const eq = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
  };
  const scan = {
    tickets: [{ key: 'TCK-1', sessionId: 's1' }, { key: 'TCK-2', sessionId: 's2' }, { key: 'TCK-9', sessionId: null }],
    conflicts: [
      { kind: 'C15', severity: 'medium', a: 'TCK-1', b: 'main', detail: 'd', evidence: { files: ['src/a.ts', 'src/b.ts'] } },
      { kind: 'C16', severity: 'high', a: 'TCK-2', b: 'main', detail: '3 commit(s) behind main', evidence: {} },
      { kind: 'C4', severity: 'medium', a: 'main', b: 'TCK-2', detail: 'phase75 twice', evidence: {} },
      { kind: 'C7', severity: 'high', a: 'TCK-1', b: 'TCK-2', detail: 'same 2.13.0', evidence: { later: 'TCK-2', next: '2.14.0' } },
      { kind: 'C7', severity: 'low', a: 'TCK-1', b: 'npm', detail: 'below npm', evidence: {} },
      { kind: 'C8', severity: 'medium', a: 'main', b: 'all', detail: 'dist old', evidence: {} },
      { kind: 'C12', severity: 'low', a: 'TCK-1', b: 'all', detail: 'lockfile', evidence: {} },
      { kind: 'C18', severity: 'low', a: 'TCK-1', b: 'all', detail: 'settings.json', evidence: {} }, // TCK-1's session changed it; everyone hears
      { kind: 'C2', severity: 'high', a: 'TCK-1', b: 'TCK-2', detail: 'both change src/x.ts', evidence: {} },
      { kind: 'C5', severity: 'high', a: 'TCK-1', b: 'TCK-2', detail: 'both alter t', evidence: {} },
      { kind: 'C14', severity: 'medium', a: 'TCK-1', b: 'TCK-2', detail: 'same component', evidence: {} },
      { kind: 'C13', severity: 'high', a: 'TCK-1', b: 'TCK-9', detail: 'both in wt', evidence: {} },
      { kind: 'C10', severity: 'low', a: 'TCK-9', b: '', detail: 'pid 1 on :5701', evidence: {} },
      { kind: 'C3', severity: 'low', a: 'TCK-1', b: 'TCK-2', detail: 'locales', evidence: {} },
      { kind: 'C17', severity: 'medium', a: 'TCK-2', b: 's2', detail: 'its loop has stopped', evidence: {} },
    ],
  };
  const acts = rulesFor(scan);
  const by = (type) => acts.filter((x) => x.type === type);
  eq('rules: messages go to the right session, everyone only for C8, C12 and C18', by('message').map((m) => [m.key.split('|')[0], m.to_session, m.ticket]), [
    ['C15', 's1', 'TCK-1'], ['C16', 's2', 'TCK-2'], ['C4', 's2', 'TCK-2'], ['C7', 's2', 'TCK-2'], ['C8', null, null], ['C12', null, 'TCK-1'], ['C18', null, null],
  ]);
  eq('rules: the C15 message names the files', by('message')[0].body.includes('src/a.ts, src/b.ts'), true);
  eq('rules: an MCP version clash allocates for the later ticket', by('allocate'), [{ key: 'C7|TCK-1|TCK-2|allocate', type: 'allocate', what: 'mcp-version', ticket: 'TCK-2' }]);
  eq('rules: judgments for C2, C5, C14 and C10, an owner gate with a card for C13', by('decide').map((d) => [d.category, d.ticket, Boolean(d.card)]), [
    ['rebase', 'TCK-2', false], ['ship-order', 'TCK-2', false], ['ship-order', 'TCK-2', false], ['merge-tickets', 'TCK-1', true], ['cleanup', 'TCK-9', false],
  ]);
  eq('rules: the owner-gate card blocks both tickets', by('decide').find((d) => d.card).card.blocks, [{ key: 'TCK-1' }, { key: 'TCK-9' }]);
  eq('rules: no card for a rule or a judgment', acts.filter((a) => a.type !== 'decide' && a.card).length + by('decide').filter((d) => d.category !== 'merge-tickets' && d.card).length, 0);
  eq('rules: notes for C3, C17 and a low C7', by('note').map((n) => n.key.split('|')[0]), ['C7', 'C3', 'C17']);
  eq('rules: every key is unique', new Set(acts.map((a) => a.key)).size, acts.length);
  const again = rulesFor(scan, acts.map((a) => a.key));
  eq('rules: an action already done is not repeated', again, []);
  eq('rules: the same conflict twice in one scan acts once', rulesFor({ tickets: scan.tickets, conflicts: [scan.conflicts[0], scan.conflicts[0]] }).length, 1);
  eq('rules: an unknown kind is a note, never a message or a card', rulesFor({ conflicts: [{ kind: 'C19', a: 'TCK-1', b: '', detail: 'x' }] }).map((a) => a.type), ['note']);
  const lone = rulesFor({ tickets: [], conflicts: [scan.conflicts[1]] });
  eq('rules: a ticket with no session gets a note, never a message to everyone', [lone.map((a) => a.type), lone[0].key, lone[0].text.startsWith('TCK-2 has no session to tell: ')], [['note'], 'C16|TCK-2|main|note', true]);
  // The note has its own key, so the message still goes out once the ticket's session appears.
  const appeared = rulesFor({ tickets: [{ key: 'TCK-2', sessionId: 's2' }], conflicts: [scan.conflicts[1]] }, lone.map((a) => a.key));
  eq('rules: once the session appears, the noted ticket still gets its message', appeared.map((a) => [a.type, a.key, a.to_session]), [['message', 'C16|TCK-2|main|message', 's2']]);
  const sessionless = rulesFor({ tickets: [], conflicts: scan.conflicts });
  eq('rules: with no sessions, only C8, C12 and C18 go to everyone', sessionless.filter((a) => a.type === 'message').map((m) => [m.key.split('|')[0], m.to_session]), [['C8', null], ['C12', null], ['C18', null]]);
  // A pair that arrives out of order (a stored row, a hand-made scan): the later ticket is the higher number, as a number.
  const reversed = rulesFor({ tickets: [{ key: 'TCK-9', sessionId: 's9' }, { key: 'TCK-10', sessionId: 's10' }], conflicts: [
    { kind: 'C2', severity: 'high', a: 'TCK-10', b: 'TCK-9', detail: 'both change src/x.ts', evidence: {} },
    { kind: 'C14', severity: 'medium', a: 'TCK-10', b: 'TCK-9', detail: 'same component', evidence: {} },
    { kind: 'C4', severity: 'medium', a: 'TCK-10', b: 'TCK-9', detail: 'phase80 twice', evidence: {} },
  ] });
  eq('rules: the later ticket is the higher number, whatever the pair order', reversed.map((a) => [a.type, a.ticket, a.choice || a.to_session]), [
    ['decide', 'TCK-10', 'TCK-10 rebases on TCK-9 after TCK-9 ships'], ['decide', 'TCK-10', 'TCK-9 ships before TCK-10'], ['message', 'TCK-10', 's10'],
  ]);
  console.log(failed ? `${failed} FAILED` : 'all passed');
  return failed ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const arg = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
  if (argv.includes('--selftest')) process.exit(selftest());
  const scanFile = arg('scan');
  if (!scanFile || !fs.existsSync(scanFile)) {
    console.error('usage: coord-rules.mjs --scan <scan.json> [--done <keys.json>] [--json] | --selftest');
    process.exit(2);
  }
  const doneFile = arg('done');
  const actions = rulesFor(JSON.parse(fs.readFileSync(scanFile, 'utf8')), doneFile ? JSON.parse(fs.readFileSync(doneFile, 'utf8')) : []);
  console.log(argv.includes('--json') ? JSON.stringify(actions, null, 2) : actions.map((a) => `${a.type.padEnd(8)} ${a.key}`).join('\n'));
}
