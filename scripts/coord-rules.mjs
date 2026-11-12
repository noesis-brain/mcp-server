#!/usr/bin/env node
// coord-rules.mjs — what the Chief of Staff does about each conflict the scanner reports (TCK-1890).
// The rules in references/chief-conflict-catalogue.md, as code, so they are the same on every wake
// and testable without a model:
//
//   - a RULE is mechanical: a message to the sessions it concerns (rebase, re-read, run /mcp,
//     npm install, the next free phase number) or a lease or allocation step. It never makes a card.
//   - a JUDGMENT is recorded with coord_decide and its rubric: in observe mode it does not wait and
//     goes to the owner's review list (who rebases, which ticket ships first, a cleanup).
//   - an OWNER GATE always waits as a Decision Card: the ship order (C1), a second live session on a
//     ticket that ships (C1), a production schema apply (C6), an npm publish (C7), and merging two
//     tickets that share a worktree (C13).
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
/** A ship, a production schema apply or an npm publish: a one-way door (L3). */
const ONE_WAY = (touches) => ({ reversible: false, shared: true, userVisible: true, touches, confidence: 'high', evidence: 'measured' });
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
 *   allocate   {what: 'mcp-version', ticket, inBranches}   (inBranches: every version a ticket's branch
 *              or the main checkout holds, sorted; the server cannot see them, so the next version skips them)
 *   decide     {category, rubric, choice, reason, ticket, evidence, card?}   (a judgment or an owner gate)
 *   note       {text}   (a rule that needs no step: logged once in the report)
 * Conflicts whose key is in `done` give no action.
 */
export function rulesFor(scan, done = []) {
  const skip = new Set(done);
  // The MCP versions the branches and the main checkout hold (as the scanner counts them): the server
  // knows only the versions it handed out, so a version set by hand and never published stays taken.
  const held = [scan.main && scan.main.mcpVersion, ...(scan.tickets || []).map((t) => t && t.mcp && t.mcp.version)];
  const inBranches = [...new Set(held.filter((v) => typeof v === 'string' && v))]
    .sort((x, y) => x.localeCompare(y, undefined, { numeric: true }));
  // How many conflicts in this scan name a ticket: the one with fewer ships first (fewer rebases after it).
  const load = (k) => (scan.conflicts || []).filter((x) => x.a === k || x.b === k).length;
  // C1: every ticket in a waiting-to-ship pair is in one ship lane, in the recommended order: fewer
  // conflicts first, then the lower number.
  const lane = [...new Set((scan.conflicts || []).filter((x) => x.kind === 'C1' && isTicket(x.a) && isTicket(x.b)).flatMap((x) => [x.a, x.b]))]
    .sort((x, y) => load(x) - load(y) || ticketNumber(x) - ticketNumber(y));
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
      case 'C1':
        if (both) {
          // A pair in the ship lane: the one lane card below covers it.
        } else if (ticketSide && c.evidence && Array.isArray(c.evidence.sessions)) {
          const sessions = c.evidence.sessions;
          const keep = sessions.includes(c.evidence.bound) ? c.evidence.bound : sessions[0];
          const short = (s) => String(s).slice(0, 8);
          const others = sessions.filter((s) => s !== keep).map(short).join(', ');
          push(c, 'decide', {
            type: 'decide', category: 'stop-session', rubric: ONE_WAY([]), ticket: ticketSide,
            choice: `Only ${short(keep)} ships ${ticketSide}; stop ${others}`, reason: c.detail, evidence: [ticketSide],
            card: {
              question: `${sessions.length} live sessions work in ${ticketSide}'s worktree. Which one may ship it?`,
              recommended: 'A',
              reason: keep === c.evidence.bound ? `${short(keep)} is the session bound to ${ticketSide}.` : `No live session is bound to ${ticketSide}; ${short(keep)} is the first one.`,
              options: [
                { label: `Only ${short(keep)} ships; stop the others`, ifChosen: `${others} stop before the ship`, undo: 'start a new session later' },
                { label: 'Leave every session running', ifChosen: `two sessions may both merge and push ${ticketSide}`, undo: 'none once both have pushed' },
              ],
              blocks: [{ key: ticketSide }],
              whyNotDecided: 'stopping a session is always the owner\'s decision',
              proof: [ticketSide],
            },
          });
        } else {
          push(c, 'note', { type: 'note', text: `C1 ${c.a}${c.b ? ` / ${c.b}` : ''}: ${c.detail}` });
        }
        break;
      case 'C6': {
        const allPhases = c.evidence && Array.isArray(c.evidence.phases) ? c.evidence.phases : [];
        const phases = allPhases.slice(0, 5);
        const more = allPhases.length > phases.length ? ` and ${allPhases.length - phases.length} more` : '';
        const tables = c.evidence && Array.isArray(c.evidence.tables) && c.evidence.tables.length ? c.evidence.tables.slice(0, 5).join(', ') : 'the tables it changes';
        push(c, 'decide', {
          type: 'decide', category: 'prod-schema', rubric: ONE_WAY(['production']), ticket: c.a,
          choice: `Apply ${phases.map((p) => path.basename(p)).join(', ')}${more} to production before ${c.a} ships`, reason: c.detail, evidence: [c.a, ...phases],
          card: {
            question: `${c.a} adds ${allPhases.length} migration file(s). Apply them to production before it ships?`,
            recommended: 'A',
            reason: 'The new code expects the new schema, so the schema goes first.',
            options: [
              { label: 'Apply the schema first, then ship', ifChosen: `${phases.map((p) => path.basename(p)).join(', ')}${more} run on production; the code that needs them ships after`, undo: 'one-way, unless the SQL has a written rollback' },
              { label: 'Ship without the schema change', ifChosen: `the new code may fail on ${tables}`, undo: 'apply the SQL later' },
              { label: 'Hold the ship', ifChosen: 'nothing changes on production', undo: 'answer again later' },
            ],
            blocks: [{ key: c.a }],
            whyNotDecided: 'a production schema apply is always the owner\'s decision',
            proof: [c.a, ...phases],
          },
        });
        break;
      }
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
        if (c.evidence && c.evidence.publish === true && isTicket(c.a)) {
          const v = c.evidence.version ? `version ${c.evidence.version}` : 'the new version';
          push(c, 'decide', {
            type: 'decide', category: 'mcp-publish', rubric: ONE_WAY(['npm']), ticket: c.a,
            choice: `Publish the MCP package (${v}) to npm when ${c.a} ships`, reason: c.detail, evidence: [c.a],
            card: {
              question: `${c.a} changes the MCP package. Publish ${v} to npm when it ships?`,
              recommended: 'A',
              reason: 'Other machines and sessions get the new tools only from npm.',
              options: [
                { label: 'Publish it after the ship', ifChosen: 'sessions get the new tools after an update and /mcp; it needs your npm login and 2FA', undo: 'one-way: a published version number cannot be used again' },
                { label: 'Ship without publishing', ifChosen: 'only the main checkout\'s own build has the new tools', undo: 'publish later' },
              ],
              blocks: [{ key: c.a }],
              whyNotDecided: 'an npm publish is always the owner\'s decision',
              proof: [c.a],
            },
          });
        } else if (c.severity === 'high' && c.evidence && isTicket(c.evidence.later)) {
          push(c, 'allocate', { type: 'allocate', what: 'mcp-version', ticket: c.evidence.later, inBranches });
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
  // C1: one card for the whole lane, keyed by its tickets, so a ticket that joins the lane makes a new card.
  if (lane.length >= 2) {
    const byNum = [...lane].sort((x, y) => ticketNumber(x) - ticketNumber(y));
    const [rec, ...rest] = lane;
    const why = lane.every((k) => load(k) === load(rec))
      ? 'They have the same number of open conflicts, so the lower ticket numbers ship first.'
      : `${rec} has the fewest open conflicts (${load(rec)}), so fewer tickets rebase after it.`;
    const oneWay = 'one-way: a ship reaches production';
    const order = (x, y) => ({ label: `Ship ${x} first, then ${y}`, ifChosen: `${y} waits until ${x} is verified on production, then rebases and runs its gates again`, undo: oneWay });
    const hold = { label: 'Hold every ship for now', ifChosen: 'nothing ships; every session in the lane keeps waiting', undo: 'answer again later' };
    const options = lane.length === 2
      ? [order(rec, rest[0]), order(rest[0], rec), hold]
      : [
        { label: lane.length <= 8 ? `Ship in this order: ${lane.join(', ')}` : 'Ship in the recommended order', ifChosen: `${lane.length <= 8 ? lane.join(', then ') : `the ${lane.length} tickets, ${rec} first,`} ship one at a time; each waits until the one before it is verified on production, then rebases and runs its gates again`, undo: oneWay },
        { label: `Ship only ${rec} now`, ifChosen: `${rest.join(', ')} keep waiting for a later card`, undo: 'answer again later' },
        hold,
      ];
    push({ kind: 'C1', a: 'ship-lane', b: byNum.join(',') }, 'decide', {
      type: 'decide', category: 'ship', rubric: ONE_WAY(['production']), ticket: rec,
      choice: `Ship ${lane.join(', then ')}`, reason: `${lane.length} tickets wait to ship; one ship at a time, each verified on production before the next`, evidence: byNum.slice(0, 10),
      card: {
        question: lane.length === 2 ? `${byNum[0]} and ${byNum[1]} both wait to ship. Which one ships first?` : lane.length <= 6 ? `${lane.length} tickets wait to ship: ${byNum.join(', ')}. In which order should they ship?` : `${lane.length} tickets wait to ship. In which order should they ship?`,
        recommended: 'A',
        reason: why,
        options,
        blocks: lane.slice(0, 20).map((key) => ({ key })),
        whyNotDecided: 'a ship to production is always the owner\'s decision',
        proof: byNum.slice(0, 10),
      },
    });
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
  eq('rules: an MCP version clash allocates for the later ticket, naming the versions the branches hold', by('allocate'), [{ key: 'C7|TCK-1|TCK-2|allocate', type: 'allocate', what: 'mcp-version', ticket: 'TCK-2', inBranches: [] }]);
  const versioned = rulesFor({ tickets: [{ key: 'TCK-1', mcp: { version: '2.9.0' } }, { key: 'TCK-2', mcp: { version: '2.14.0' } }, { key: 'TCK-3', mcp: { version: '2.14.0' } }, { key: 'TCK-4', mcp: null }, { key: 'TCK-5', mcp: { version: null } }],
    conflicts: [{ kind: 'C7', severity: 'high', a: 'TCK-2', b: 'TCK-3', detail: 'same 2.14.0', evidence: { later: 'TCK-3', next: '2.15.0' } }] });
  eq('rules: inBranches lists each branch version once, in version order (2.9.0 before 2.14.0)', versioned.find((a) => a.type === 'allocate').inBranches, ['2.9.0', '2.14.0']);
  // The main checkout's version counts too: set by hand and never published, it is still taken.
  const withMain = rulesFor({ main: { mcpVersion: '2.15.0' }, tickets: [{ key: 'TCK-2', mcp: { version: '2.14.0' } }, { key: 'TCK-3', mcp: { version: '2.14.0' } }],
    conflicts: [{ kind: 'C7', severity: 'high', a: 'TCK-2', b: 'TCK-3', detail: 'same 2.14.0', evidence: { later: 'TCK-3', next: '2.16.0' } }] });
  eq('rules: the main checkout\'s version is in inBranches', withMain.find((a) => a.type === 'allocate').inBranches, ['2.14.0', '2.15.0']);
  eq('rules: judgments for C2, C5, C14 and C10, an owner gate with a card for C13', by('decide').map((d) => [d.category, d.ticket, Boolean(d.card)]), [
    ['rebase', 'TCK-2', false], ['ship-order', 'TCK-2', false], ['ship-order', 'TCK-2', false], ['merge-tickets', 'TCK-1', true], ['cleanup', 'TCK-9', false],
  ]);
  eq('rules: the owner-gate card blocks both tickets', by('decide').find((d) => d.card).card.blocks, [{ key: 'TCK-1' }, { key: 'TCK-9' }]);
  eq('rules: no card for a rule or a judgment', acts.filter((a) => a.type !== 'decide' && a.card).length + by('decide').filter((d) => d.category !== 'merge-tickets' && d.card).length, 0);
  eq('rules: notes for C3, C17 and a low C7', by('note').map((n) => n.key.split('|')[0]), ['C7', 'C3', 'C17']);
  eq('rules: every key is unique', new Set(acts.map((a) => a.key)).size, acts.length);
  // The ship lane and what a ship carries: owner gates, each with a card.
  const shipScan = {
    tickets: [{ key: 'TCK-9', sessionId: 's9' }, { key: 'TCK-10', sessionId: 's10' }],
    conflicts: [
      { kind: 'C1', severity: 'high', a: 'TCK-9', b: 'TCK-10', detail: 'both wait to ship', evidence: { status: { 'TCK-9': 'ready_to_merge', 'TCK-10': 'ready_to_merge' } } },
      { kind: 'C1', severity: 'high', a: 'TCK-10', b: 'sessions', detail: '2 live sessions', evidence: { sessions: ['aaaaaaaa-1', 's10'], bound: 's10' } },
      { kind: 'C6', severity: 'high', a: 'TCK-9', b: 'prod-schema', detail: 'it ships phase80-x.sql', evidence: { phases: ['scripts/phase80-x.sql'], tables: ['x'] } },
      { kind: 'C7', severity: 'medium', a: 'TCK-10', b: 'npm-publish', detail: 'MCP change', evidence: { publish: true, version: '2.14.0' } },
      { kind: 'C2', severity: 'high', a: 'TCK-10', b: 'TCK-11', detail: 'both change src/y.ts', evidence: {} },
    ],
  };
  const gates = rulesFor(shipScan).filter((a) => a.type === 'decide' && a.card);
  const gate = (category) => gates.find((d) => d.category === category);
  eq('rules: the ship lane, a second session, a schema apply and a publish are owner gates with cards', gates.map((d) => [d.category, d.ticket, d.rubric.reversible, d.card.blocks.map((b) => b.key)]), [
    ['stop-session', 'TCK-10', false, ['TCK-10']], ['prod-schema', 'TCK-9', false, ['TCK-9']], ['mcp-publish', 'TCK-10', false, ['TCK-10']], ['ship', 'TCK-9', false, ['TCK-9', 'TCK-10']],
  ]);
  const laneCard = (conflicts) => rulesFor({ conflicts }).find((a) => a.category === 'ship');
  eq('rules: the ticket with fewer conflicts ships first; a tie goes to the lower number', [gate('ship').card.options[0].label, laneCard([shipScan.conflicts[0]]).card.options[0].label], ['Ship TCK-9 first, then TCK-10', 'Ship TCK-9 first, then TCK-10']);
  eq('rules: with more conflicts on the lower number, the other ships first', laneCard([shipScan.conflicts[0], { kind: 'C3', a: 'TCK-9', b: 'TCK-12', detail: 'x' }, { kind: 'C3', a: 'TCK-9', b: 'TCK-13', detail: 'x' }]).card.options[0].label, 'Ship TCK-10 first, then TCK-9');
  eq('rules: a second session: the bound one keeps the ticket', gate('stop-session').card.options[0].label, 'Only s10 ships; stop the others');
  // Three tickets wait to ship: one card for the lane, not three pairwise cards.
  const pair = (a, b) => ({ kind: 'C1', severity: 'high', a, b, detail: 'both wait to ship', evidence: {} });
  const three = rulesFor({ conflicts: [pair('TCK-9', 'TCK-10'), pair('TCK-9', 'TCK-11'), pair('TCK-10', 'TCK-11'), { kind: 'C3', a: 'TCK-9', b: 'TCK-12', detail: 'x' }] });
  const ships = three.filter((a) => a.category === 'ship');
  eq('rules: three tickets in the lane get ONE ship card, keyed by the lane, blocking all three', ships.map((d) => [d.key, d.card.blocks.map((b) => b.key), d.card.options.map((o) => o.label)]), [[
    'C1|ship-lane|TCK-9,TCK-10,TCK-11|decide', ['TCK-10', 'TCK-11', 'TCK-9'], ['Ship in this order: TCK-10, TCK-11, TCK-9', 'Ship only TCK-10 now', 'Hold every ship for now'],
  ]]);
  eq('rules: the lane card names the tickets in number order', ships[0].card.question, '3 tickets wait to ship: TCK-9, TCK-10, TCK-11. In which order should they ship?');
  eq('rules: a fourth ticket joining the lane makes a new card', rulesFor({ conflicts: [pair('TCK-9', 'TCK-10'), pair('TCK-9', 'TCK-11'), pair('TCK-10', 'TCK-11'), pair('TCK-9', 'TCK-12'), pair('TCK-10', 'TCK-12'), pair('TCK-11', 'TCK-12')] }, [ships[0].key]).filter((a) => a.category === 'ship').map((d) => d.key), ['C1|ship-lane|TCK-9,TCK-10,TCK-11,TCK-12|decide']);
  const nine = Array.from({ length: 9 }, (_, i) => `TCK-${i + 1}`);
  const big = laneCard(nine.slice(1).map((k) => pair('TCK-1', k)));
  eq('rules: a lane of nine still fits the card rules (no list in the question or the label)', [big.card.question, big.card.options[0].label, big.card.blocks.length], ['9 tickets wait to ship. In which order should they ship?', 'Ship in the recommended order', 9]);
  // The server's caps: a lane of 25 blocks 20 tickets and names 10 in its proof and evidence.
  const twentyFive = Array.from({ length: 25 }, (_, i) => `TCK-${i + 1}`);
  const huge = laneCard(twentyFive.slice(1).map((k) => pair('TCK-1', k)));
  eq('rules: a lane of 25 keeps to the caps: 20 blocks, 10 proofs, 10 evidence', [huge.card.blocks.length, huge.card.proof.length, huge.evidence.length], [20, 10, 10]);
  // Ten migration files: the question counts all of them; the card names five and stays within 10 proofs.
  const tenPhases = Array.from({ length: 10 }, (_, i) => `scripts/phase${80 + i}-x.sql`);
  const c6 = rulesFor({ conflicts: [{ kind: 'C6', severity: 'high', a: 'TCK-9', b: 'prod-schema', detail: 'ten files', evidence: { phases: tenPhases, tables: [] } }] })[0];
  eq('rules: a schema card with ten files counts ten, names five, and fits the caps', [c6.card.question, c6.card.proof.length, /and 5 more/.test(c6.choice)], ['TCK-9 adds 10 migration file(s). Apply them to production before it ships?', 6, true]);
  // No live session is bound: the first one is kept, and the choice names the same session as the card.
  const unbound = rulesFor({ conflicts: [{ kind: 'C1', severity: 'high', a: 'TCK-10', b: 'sessions', detail: '2 live sessions', evidence: { sessions: ['zz-11111', 'aa-22222', 'mm-33333'], bound: 'gone-0000' } }] })[0];
  eq('rules: with no bound session the first is kept; the choice and the card agree', [unbound.choice, unbound.card.options[0].label, unbound.card.options[0].ifChosen], ['Only zz-11111 ships TCK-10; stop aa-22222, mm-33333', 'Only zz-11111 ships; stop the others', 'aa-22222, mm-33333 stop before the ship']);
  eq('rules: the bound session is kept in the choice too; a two-ticket lane can hold; the ship decision names the first ticket to ship', [gate('stop-session').choice, gate('ship').card.options.length, laneCard([shipScan.conflicts[0], { kind: 'C3', a: 'TCK-9', b: 'TCK-12', detail: 'x' }, { kind: 'C3', a: 'TCK-9', b: 'TCK-13', detail: 'x' }]).ticket], ['Only s10 ships TCK-10; stop aaaaaaaa', 3, 'TCK-10']);
  eq('rules: a C1 with one ticket and no session list is a note', rulesFor({ conflicts: [{ kind: 'C1', severity: 'high', a: 'TCK-10', b: 'x', detail: 'odd', evidence: {} }] }).map((a) => a.type), ['note']);
  const orphan = rulesFor({ conflicts: [{ kind: 'C10', severity: 'low', a: 'pid-4242', b: '', detail: 'node (pid 4242) listens on 5701', evidence: { pid: 4242 } }] });
  eq('rules: an orphan server is a cleanup judgment with no ticket and no card', orphan.map((a) => [a.type, a.category, a.ticket, Boolean(a.card)]), [['decide', 'cleanup', null, false]]);
  const words = (s) => String(s).trim().split(/\s+/).filter(Boolean).length;
  // proofKind in src/shared/coordination/card.ts: a URL, a ticket key, a commit or a path.
  const proofOk = (p) => /^https?:\/\/\S+$/.test(p) || /^TCK-[1-9]\d{0,8}$/.test(p) || /^[0-9a-f]{7,40}$/.test(p) || (!/[\s`]/.test(p) && (/^(?:~|\.{1,2})?\/./.test(p) || /[^/]\/[^/]/.test(p)));
  const cardProblems = (card) => [
    words(card.question) > 25 && 'question', (words(card.reason) < 3 || words(card.reason) > 25) && 'reason',
    !(card.options.length >= 2 && card.options.length <= 4) && 'options', ...card.options.map((o, i) => (words(o.label) > 12 || !o.ifChosen || !o.undo) && `option ${i}`),
    !['A', 'B', 'C', 'D'].slice(0, card.options.length).includes(card.recommended) && 'recommended', !card.whyNotDecided && 'why',
    // The server's own limits (src/shared/coordination/card.ts): 0-20 blocks, 1-10 proofs of a known kind, 600-character consequences.
    !(Array.isArray(card.blocks) && card.blocks.length <= 20 && card.blocks.every((b) => /^TCK-[1-9]\d{0,8}$/.test(b.key))) && 'blocks',
    !(Array.isArray(card.proof) && card.proof.length >= 1 && card.proof.length <= 10 && card.proof.every(proofOk)) && 'proof',
    ...card.options.map((o, i) => (Array.from(o.ifChosen).length > 600 || Array.from(o.undo).length > 300) && `option ${i} length`),
  ].filter(Boolean);
  eq('rules: every card fits the card rules (words, options, recommendation, why, proof)', [...gates, ...ships, big, huge, c6, unbound, ...acts.filter((a) => a.card)].map((d) => cardProblems(d.card)), [[], [], [], [], [], [], [], [], [], []]);
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
