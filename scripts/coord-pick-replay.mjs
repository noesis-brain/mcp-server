#!/usr/bin/env node
// coord-pick-replay.mjs — the pick replay of the Chief of Staff (TCK-1890, AC10). It asks: had the
// Chief ranked the waiting tickets by its default order, how often would the ticket the owner
// actually started next have been first, or in the top 3?
//
//   node coord-pick-replay.mjs --export <export.json> [--days 14] [--burst-seconds 120] [--min-wait-minutes 30] [--now <iso>] [--json]
//   node coord-pick-replay.mjs --selftest
//
// The export is the owner's Jot history, read once in a READ ONLY transaction, as
// {"issues": [...], "events": [...]}. The replay reads at least these fields:
//   issues: id, created_at, work_status, priority, pinned_at        (FROM backlog_issues WHERE user_id = $1)
//   events: id, issue_id, type, created_at, payload {from, to}      (FROM backlog_events WHERE user_id = $1)
// Event types it uses: binding.set, binding.cleared, status.changed, issue.pinned, issue.unpinned,
// refine.set, refine.marked, refine.cleared. Other columns and types are ignored.
//
// A pick is the first `binding.set` of a ticket (over its whole history): the moment a session
// started it. Three kinds of first bind are not a choice among waiting tickets, so they are left
// out and counted: a bind within --burst-seconds of another ticket's first bind (a script or a
// backfill bound them); a bind of a ticket created less than --min-wait-minutes before (a session
// made the ticket and started it at once: no recommender could have ranked it); and a pick whose
// ticket did not wait by the rebuilt state. At each pick the replay rebuilds every ticket's state from
// the events: its status (status.changed), whether a session held it (binding.set / cleared),
// whether it was marked up next (issue.pinned / unpinned) and whether it was still a Draft (no
// refine.set or refine.marked yet). Priority and size have no history in the events, so their
// current values stand in for the past ones. The tickets that waited (Created or Planning, held by
// no session) are ranked by the default order (the Chief view's Up next and /noesis-chief):
// not a Draft first, then marked up next, then priority, then the newest. The report also gives the
// old order, which ended with the oldest, for comparison.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PRIORITY_RANK = { urgent: 0, high: 1, medium: 2, low: 3 };
const T = (x) => new Date(x).getTime();

/** The events of each ticket, oldest first. */
export function byIssue(events) {
  const m = new Map();
  for (const e of [...events].sort((a, b) => T(a.created_at) - T(b.created_at) || a.id - b.id)) {
    if (!m.has(e.issue_id)) m.set(e.issue_id, []);
    m.get(e.issue_id).push(e);
  }
  return m;
}

/** A ticket's state just before time t, rebuilt from its events. */
export function stateAt(issue, evs, t) {
  const before = evs.filter((e) => T(e.created_at) < t);
  const after = evs.filter((e) => T(e.created_at) >= t);
  const lastOf = (types, list) => [...list].reverse().find((e) => types.includes(e.type));
  const st = lastOf(['status.changed'], before);
  const nextSt = after.find((e) => e.type === 'status.changed');
  const status = st ? st.payload.to : nextSt ? nextSt.payload.from : issue.work_status;
  const bind = lastOf(['binding.set', 'binding.cleared'], before);
  const pin = lastOf(['issue.pinned', 'issue.unpinned'], before);
  const pinned = pin ? pin.type === 'issue.pinned' : Boolean(issue.pinned_at) && T(issue.pinned_at) < t && !after.some((e) => e.type === 'issue.pinned');
  const refine = lastOf(['refine.set', 'refine.marked', 'refine.cleared'], before);
  return { status, held: Boolean(bind && bind.type === 'binding.set'), pinned, draft: status === 'created' && !(refine && refine.type !== 'refine.cleared') };
}

/** The default order (the Chief view's Up next): not a Draft first, then marked up next, then
 *  priority (none last), then the newest, then the higher id. */
export function compare(a, b, oldestFirst = false) {
  const age = oldestFirst ? T(a.issue.created_at) - T(b.issue.created_at) || a.issue.id - b.issue.id : T(b.issue.created_at) - T(a.issue.created_at) || b.issue.id - a.issue.id;
  return (
    Number(a.state.draft) - Number(b.state.draft) ||
    Number(b.state.pinned) - Number(a.state.pinned) ||
    (PRIORITY_RANK[a.issue.priority] ?? 4) - (PRIORITY_RANK[b.issue.priority] ?? 4) ||
    age
  );
}

/** The picks: each ticket's first binding.set in the window, without the batches. */
export function picksOf(events, now, days, burstSeconds) {
  const first = new Map();
  for (const e of [...events].sort((a, b) => T(a.created_at) - T(b.created_at) || a.id - b.id)) if (e.type === 'binding.set' && !first.has(e.issue_id)) first.set(e.issue_id, e);
  const firsts = [...first.values()];
  const burst = (e) => firsts.some((o) => o !== e && Math.abs(T(o.created_at) - T(e.created_at)) <= burstSeconds * 1000);
  const inWindow = firsts.filter((e) => now - T(e.created_at) <= days * 864e5 && T(e.created_at) <= now);
  return { picks: inWindow.filter((e) => !burst(e)), batched: inWindow.filter(burst).length };
}

export function replay({ issues, events }, { now, days = 14, burstSeconds = 120, minWaitMinutes = 30 } = {}) {
  const evs = byIssue(events);
  const byId = new Map(issues.map((i) => [i.id, i]));
  const { picks: all, batched } = picksOf(events, now, days, burstSeconds);
  const picks = all.filter((p) => byId.has(p.issue_id) && T(p.created_at) - T(byId.get(p.issue_id).created_at) >= minWaitMinutes * 60e3);
  const instant = all.length - picks.length;
  const cases = [];
  let skipped = 0;
  for (const p of picks) {
    const t = T(p.created_at);
    const waiting = issues
      .filter((i) => T(i.created_at) < t)
      .map((issue) => ({ issue, state: stateAt(issue, evs.get(issue.id) || [], t) }))
      .filter((c) => (c.state.status === 'created' || c.state.status === 'planning') && !c.state.held);
    const rankBy = (oldestFirst) => [...waiting].sort((a, b) => compare(a, b, oldestFirst)).findIndex((c) => c.issue.id === p.issue_id) + 1;
    const rank = rankBy(false);
    if (rank === 0) {
      skipped++;
      continue;
    }
    cases.push({ key: `TCK-${p.issue_id}`, at: p.created_at, rank, oldRank: rankBy(true), waiting: waiting.length });
  }
  const n = cases.length;
  const count = (f) => cases.filter(f).length;
  const top1 = count((c) => c.rank === 1);
  const top3 = count((c) => c.rank <= 3);
  const oldTop1 = count((c) => c.oldRank === 1);
  const oldTop3 = count((c) => c.oldRank <= 3);
  const rate = (x) => (n ? x / n : 0);
  return { picks: n, batched, instant, skipped, top1, top3, top1Rate: rate(top1), top3Rate: rate(top3), oldTop1, oldTop3, cases };
}

const pct = (x) => `${Math.round(x * 100)}%`;

export function report(r, days) {
  const lines = [
    `Pick replay: ${r.picks} picks in the last ${days} days. Left out: ${r.batched} batched binds, ${r.instant} tickets started within the minimum wait of their creation, ${r.skipped} picks whose ticket did not wait by the rebuilt state.`,
    `Default order (not a Draft, marked up next, priority, the newest): top-1 ${r.top1}/${r.picks} (${pct(r.top1Rate)}), top-3 ${r.top3}/${r.picks} (${pct(r.top3Rate)}).`,
    `Old order (the same, then the oldest): top-1 ${r.oldTop1}/${r.picks}, top-3 ${r.oldTop3}/${r.picks}.`,
    `AC10 needs the top-3 rate at 50% or more: ${r.top3Rate >= 0.5 ? 'met' : 'NOT met'}.`,
    '',
    ...r.cases.map((c) => `${c.at}  ${c.key}  rank ${c.rank} of ${c.waiting} (old order: ${c.oldRank})`),
  ];
  return lines.join('\n');
}

export function parseArgs(argv) {
  const out = { days: 14, burstSeconds: 120, minWaitMinutes: 30, json: false, exportFile: '', now: null };
  const num = (name, v) => {
    const n = Number(v);
    if (v === undefined || v === '' || !Number.isFinite(n) || n < 0) throw new Error(`${name} needs a number of 0 or more`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--export') out.exportFile = argv[++i] || '';
    else if (a === '--days') out.days = num(a, argv[++i]);
    else if (a === '--burst-seconds') out.burstSeconds = num(a, argv[++i]);
    else if (a === '--min-wait-minutes') out.minWaitMinutes = num(a, argv[++i]);
    else if (a === '--now') out.now = argv[++i] || null;
    else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

function selftest() {
  let n = 0;
  let bad = 0;
  const eq = (name, got, want) => {
    n++;
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) bad++;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
  };
  const day = (d, h = 0) => new Date(Date.UTC(2026, 10, d, h)).toISOString();
  const issue = (id, created, over = {}) => ({ id, created_at: created, work_status: 'created', priority: null, pinned_at: null, ...over });
  let eid = 1;
  const ev = (issue_id, type, at, payload = {}) => ({ id: eid++, issue_id, type, created_at: at, payload });

  // The rebuilt state.
  const two = [ev(1, 'status.changed', day(2), { from: 'created', to: 'planning' }), ev(1, 'status.changed', day(3), { from: 'planning', to: 'implementing' }), ev(1, 'status.changed', day(5), { from: 'implementing', to: 'shipped' })];
  eq('state: the last status change before t, else the first one after t, else the current status',
    [stateAt(issue(1, day(1)), two, T(day(4))).status, stateAt(issue(1, day(1)), two, T(day(1, 12))).status, stateAt(issue(1, day(1), { work_status: 'iterating' }), [], T(day(4))).status],
    ['implementing', 'created', 'iterating']);
  eq('state: held after a binding.set, free after a binding.cleared',
    [stateAt(issue(1, day(1)), [ev(1, 'binding.set', day(2))], T(day(3))).held, stateAt(issue(1, day(1)), [ev(1, 'binding.set', day(2)), ev(1, 'binding.cleared', day(2, 3))], T(day(3))).held], [true, false]);
  eq('state: pinned by the last pin event before t; the current pin counts only with no later pin event',
    [stateAt(issue(1, day(1)), [ev(1, 'issue.pinned', day(2)), ev(1, 'issue.unpinned', day(3))], T(day(4))).pinned,
     stateAt(issue(1, day(1)), [ev(1, 'issue.pinned', day(2))], T(day(1, 12))).pinned,
     stateAt(issue(1, day(1), { pinned_at: day(2) }), [], T(day(3))).pinned,
     stateAt(issue(1, day(1), { pinned_at: day(5) }), [ev(1, 'issue.pinned', day(5))], T(day(3))).pinned], [false, false, true, false]);
  eq('state: a Created ticket is a Draft until refined or kept; a clear makes it one again; a Planning ticket never is',
    [stateAt(issue(1, day(1)), [], T(day(2))).draft,
     stateAt(issue(1, day(1)), [ev(1, 'refine.set', day(2))], T(day(3))).draft,
     stateAt(issue(1, day(1)), [ev(1, 'refine.marked', day(2))], T(day(3))).draft,
     stateAt(issue(1, day(1)), [ev(1, 'refine.set', day(2)), ev(1, 'refine.cleared', day(2, 3))], T(day(3))).draft,
     stateAt(issue(1, day(1), { work_status: 'planning' }), [], T(day(2))).draft], [true, false, false, true, false]);

  // Which first binds are picks.
  const evs1 = [
    ev(1, 'binding.set', day(1)), ev(1, 'binding.cleared', day(1, 2)), ev(1, 'binding.set', day(8)), // first bound before the window
    ev(2, 'binding.set', day(9)),
    ev(3, 'binding.set', day(10)), ev(4, 'binding.set', new Date(T(day(10)) + 120e3).toISOString()), // 120 s apart: a batch
    ev(5, 'binding.set', day(12)), // after --now
  ];
  const pk = picksOf(evs1, T(day(11)), 7, 120);
  eq('picks: a first bind before the window is not a pick for its later re-bind; a batch at 120 s is left out; nothing after now',
    [pk.picks.map((e) => e.issue_id), pk.batched], [[2], 2]);
  eq('picks: no burst window, and a wider day window', [picksOf(evs1, T(day(11)), 7, 0).picks.map((e) => e.issue_id), picksOf(evs1, T(day(11)), 30, 0).picks.map((e) => e.issue_id)], [[2, 3, 4], [1, 2, 3, 4]]);

  // The order.
  const c = (id, created, state = {}, priority = null) => ({ issue: { id, created_at: created, priority }, state: { draft: false, pinned: false, ...state } });
  const order = (list, old) => [...list].sort((a, b) => compare(a, b, old)).map((x) => x.issue.id);
  const prio = [c(1, day(1), {}, 'urgent'), c(2, day(1), {}, 'high'), c(3, day(1), {}, 'medium'), c(4, day(1), {}, 'low'), c(5, day(1))];
  eq('order: priority urgent, high, medium, low, none, before the age (the ids run with the priority, so a tie would swap them)', order(prio), [1, 2, 3, 4, 5]);
  eq('order: not a Draft first, then marked up next', order([c(1, day(5), { draft: true, pinned: true }), c(2, day(1), { pinned: true }), c(3, day(4))]), [2, 3, 1]);
  eq('order: the newest first, then the higher id; the old order the oldest first, then the lower id',
    [order([c(1, day(1)), c(2, day(3)), c(3, day(3))]), order([c(1, day(1)), c(2, day(3)), c(3, day(3))], true)], [[3, 2, 1], [1, 2, 3]]);

  // The replay and its counts.
  const iss = [issue(1, day(1)), issue(2, day(2)), issue(3, day(3)), issue(4, day(4)), issue(5, day(5)), issue(6, day(9)), issue(7, day(1))];
  const evs2 = [
    ev(7, 'binding.set', day(2)), // TCK-7 is held from day 2 (its first bind is before the 7-day window)
    ev(4, 'binding.set', day(6)), // waiting: 1,2,3,4,5 -> newest order 5,4,3,2,1: rank 2
    ev(1, 'binding.set', day(8)), // waiting: 1,2,3,5 -> 5,3,2,1: rank 4 (old order: rank 1)
    ev(6, 'binding.set', new Date(T(day(9)) + 10 * 60e3).toISOString()), // created 10 min before: instant
    ev(7, 'binding.cleared', day(9, 6)), ev(3, 'status.changed', day(9, 7), { from: 'created', to: 'implementing' }),
    ev(5, 'binding.set', day(9, 8)), // waiting: 2,5,7 (3 is in progress) -> 5,2,7: rank 1 (old order 7,2,5: rank 3)
  ];
  const r = replay({ issues: iss, events: evs2 }, { now: T(day(10)), days: 7, burstSeconds: 120, minWaitMinutes: 30 });
  eq('replay: ranks by the newest, and the old order beside it', r.cases.map((x) => [x.key, x.rank, x.oldRank, x.waiting]), [['TCK-4', 2, 4, 5], ['TCK-1', 4, 1, 4], ['TCK-5', 1, 3, 3]]);
  eq('replay: counts (top-1 is rank 1 only; an instant bind is left out and counted)', [r.picks, r.top1, r.top3, r.oldTop1, r.oldTop3, r.instant, r.skipped, r.batched], [3, 1, 2, 1, 2, 1, 0, 0]);
  const held = replay({ issues: [issue(1, day(1), { work_status: 'implementing' }), issue(2, day(1))], events: [ev(1, 'status.changed', day(1, 1), { from: 'created', to: 'implementing' }), ev(1, 'binding.set', day(3)), ev(2, 'binding.set', day(4))] }, { now: T(day(5)), days: 30, burstSeconds: 0, minWaitMinutes: 30 });
  eq('replay: a pick whose ticket did not wait is skipped, not counted as a hit or in the denominator',
    [held.picks, held.skipped, held.top3, held.top3Rate], [1, 1, 1, 1]);
  const notWaiting = replay({ issues: [issue(1, day(1), { work_status: 'implementing' })], events: [ev(1, 'status.changed', day(1, 1), { from: 'created', to: 'implementing' }), ev(1, 'binding.set', day(3))] }, { now: T(day(4)), days: 30, burstSeconds: 0, minWaitMinutes: 30 });
  eq('replay: a pick of a ticket already in progress is skipped', [notWaiting.picks, notWaiting.skipped, notWaiting.top3Rate], [0, 1, 0]);

  // The old order counted on its own: here every pick is the oldest waiting ticket.
  const oldest = replay({ issues: [1, 2, 3, 4, 5].map((id) => issue(id, day(id))), events: [ev(1, 'binding.set', day(6)), ev(2, 'binding.set', day(7)), ev(4, 'binding.set', day(8))] }, { now: T(day(9)), days: 30, burstSeconds: 0, minWaitMinutes: 30 });
  eq('replay: the old order counted from its own ranks', [oldest.cases.map((x) => [x.rank, x.oldRank]), oldest.top1, oldest.top3, oldest.oldTop1, oldest.oldTop3], [[[5, 1], [4, 1], [2, 2]], 0, 1, 2, 3]);
  eq('report: the old-order line and each pick show the old ranks', [report(oldest, 30).split('\n')[2], report(oldest, 30).split('\n')[5]], ['Old order (the same, then the oldest): top-1 2/3, top-3 3/3.', `${day(6)}  TCK-1  rank 5 of 5 (old order: 1)`]);

  // The report and the verdict at exactly 50%.
  const half = { picks: 2, batched: 0, instant: 0, skipped: 0, top1: 1, top3: 1, top1Rate: 0.5, top3Rate: 0.5, oldTop1: 0, oldTop3: 0, cases: [] };
  eq('report: at exactly 50% AC10 is met', report(half, 14).split('\n')[3], 'AC10 needs the top-3 rate at 50% or more: met.');
  eq('report: below 50% it is not', report({ ...half, top3: 0, top3Rate: 0.49 }, 14).split('\n')[3], 'AC10 needs the top-3 rate at 50% or more: NOT met.');
  eq('report: the counts and both orders', report(r, 7).split('\n').slice(0, 3), [
    'Pick replay: 3 picks in the last 7 days. Left out: 0 batched binds, 1 tickets started within the minimum wait of their creation, 0 picks whose ticket did not wait by the rebuilt state.',
    'Default order (not a Draft, marked up next, priority, the newest): top-1 1/3 (33%), top-3 2/3 (67%).',
    'Old order (the same, then the oldest): top-1 1/3, top-3 2/3.',
  ]);
  let errs = [];
  for (const argv of [['--days', 'x'], ['--burst-seconds'], ['--min-wait-minutes', '-1'], ['--bogus']]) {
    try {
      parseArgs(argv);
      errs.push('accepted');
    } catch (e) {
      errs.push('refused');
    }
  }
  eq('args: a missing, negative or not-a-number value is refused, not silently replaced', errs, ['refused', 'refused', 'refused', 'refused']);
  eq('args: 0 is a value (no burst window), and the defaults', [parseArgs(['--burst-seconds', '0']).burstSeconds, parseArgs([]).days, parseArgs([]).minWaitMinutes], [0, 14, 30]);
  console.log(`\n${n - bad}/${n} passed`);
  return bad ? 1 : 0;
}

const isMain = (() => {
  try {
    return process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) {
  if (process.argv.includes('--selftest')) process.exit(selftest());
  try {
    const args = parseArgs(process.argv.slice(2));
    if (!args.exportFile) throw new Error('--export <export.json> is required');
    const data = JSON.parse(fs.readFileSync(path.resolve(args.exportFile), 'utf8'));
    const now = args.now ? T(args.now) : data.exported_at ? T(data.exported_at) : Date.now();
    const r = replay(data, { now, days: args.days, burstSeconds: args.burstSeconds, minWaitMinutes: args.minWaitMinutes });
    console.log(args.json ? JSON.stringify(r, null, 2) : report(r, args.days));
    process.exit(r.top3Rate >= 0.5 ? 0 : 1);
  } catch (e) {
    console.error(`coord-pick-replay: ${e.message}`);
    process.exit(2);
  }
}
