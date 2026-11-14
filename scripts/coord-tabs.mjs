#!/usr/bin/env node
// coord-tabs.mjs — the Chrome tabs that /cc-loop sessions leave open, for the Chief of Staff (TCK-1930).
// The rules are in references/chief-conflict-catalogue.md, row C20.
//
//   node coord-tabs.mjs list [--json] [--closed <file>] [--repo <main checkout>] [--agents <agents.json>]
//   node coord-tabs.mjs close (--ids <id,id,...> | --orphans) [--closed <file>] [--repo <main checkout>] [--json]
//   node coord-tabs.mjs --selftest
//
// `list` reads every Chrome tab on this Mac through AppleScript and labels the loop tabs:
//   - left-for-you    its ticket is Ready to merge: the loop left it for your check;
//   - in-use          a live session works on its ticket;
//   - done            its ticket is Shipped, Merged or Dropped: its check is over;
//   - server-stopped  nothing listens on its local port any more;
//   - session-ended   no live session works on its ticket.
// A tab belongs to a loop by its host (tck-<n>.localhost or tck<n>.localhost), by a tab id that a
// session's transcript or the loop's tab record (~/.claude/coord/tabs/<session>.json) names, or by
// the worktree of the server on its local port. Only a match by host can make a tab a sure orphan:
// a tab id can come back after Chrome restarts, and a port can be reused.
//
// A sure orphan: its host names a ticket, and either the server says that ticket is Shipped,
// Merged or Dropped, or its local server has stopped and no live session works on that ticket.
// It is never the active tab of its window, and never a tab of a Ready to merge ticket.
//
// `close` reads the tabs again, and closes only the given tabs that are still sure orphans. Each
// close reads the tab's URL again in the same AppleScript, and refuses when it changed or the tab
// became active. When the tabs, the processes, the listening ports or `claude agents` cannot be
// read, it closes nothing. It never closes a non-local tab or a tab it cannot match to a loop.
//
// Privacy: the output lists only loop tabs (a local address matched to a ticket). Every other tab
// is only counted, so no other tab's title or URL leaves the Mac.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CLOSED_STATUSES, READ_ONLY_SCRIPTS, realDeps, gather, statusOf, short, readJson } from './coord-close.mjs';

const FS = String.fromCharCode(31); // between fields
const RS = String.fromCharCode(30); // between tabs
const TITLE_MAX = 80;
const URL_MAX = 200;

/** One line per tab: window id, tab id, active (true/false), URL, title. */
export const LIST_SCRIPT = `tell application "Google Chrome"
  set out to ""
  repeat with w in windows
    set act to active tab index of w
    set i to 0
    repeat with t in tabs of w
      set i to i + 1
      set out to out & (id of w) & (character id 31) & (id of t) & (character id 31) & (i = act) & (character id 31) & (URL of t) & (character id 31) & (title of t) & (character id 30)
    end repeat
  end repeat
  return out
end tell`;
READ_ONLY_SCRIPTS.add(LIST_SCRIPT);

const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/** Close one tab, only if it is still at the URL we judged and is not its window's active tab.
 *  The ids are compared as text: Chrome's id never equals a number written in the script
 *  (measured 2026-11-14: \`(id of t) is 11586684\` was false for that very tab). */
export function closeScript(windowId, tabId, url) {
  return `tell application "Google Chrome"
  repeat with w in windows
    if ((id of w) as text) is "${Number(windowId)}" then
      set act to active tab index of w
      set i to 0
      repeat with t in tabs of w
        set i to i + 1
        if ((id of t) as text) is "${Number(tabId)}" then
          if (URL of t) is not "${esc(url)}" then return "moved"
          if i = act then return "active"
          close t
          return "closed"
        end if
      end repeat
    end if
  end repeat
  return "gone"
end tell`;
}

export function parseTabs(stdout) {
  return String(stdout || '').split(RS).map((l) => l.replace(/^\n+/, '')).filter((l) => l.trim()).map((l) => {
    const [win, id, active, url, ...title] = l.split(FS);
    return { windowId: Number(win), id: Number(id), active: active === 'true', url: url || '', title: title.join(FS).trim() };
  }).filter((t) => Number.isFinite(t.id) && t.id > 0);
}

/** The tabs, [] when Chrome is not running, null when AppleScript fails. */
const pgrepChrome = () => spawnSync('pgrep', ['-x', 'Google Chrome'], { encoding: 'utf8', timeout: 5000 });

/** The tabs, [] when Chrome is not running, null when pgrep or AppleScript fails. */
export function listChromeTabs(run = osa, pgrep = pgrepChrome) {
  // Telling Chrome anything starts it, so look for its process first. pgrep: 0 found, 1 none, anything else an error.
  if (run === osa || pgrep !== pgrepChrome) {
    const running = pgrep();
    if (running.error || (running.status !== 0 && running.status !== 1)) return null;
    if (running.status === 1) return [];
  }
  try { return parseTabs(run(LIST_SCRIPT)); } catch { return null; }
}

function osa(script) {
  return execFileSync('osascript', ['-e', script], { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'ignore'] });
}

export function urlParts(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const local = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost');
    const port = Number(u.port) || (u.protocol === 'https:' ? 443 : u.protocol === 'http:' ? 80 : 0);
    const m = /^tck-?(\d+)\.localhost$/.exec(host);
    return { host, local, port, hostTicket: m ? `TCK-${Number(m[1])}` : null };
  } catch {
    return { host: '', local: false, port: 0, hostTicket: null };
  }
}

/**
 * Label each tab. Pure, so the selftest can feed it facts:
 *   status    Map ticket -> work status (null when it could not be read)
 *   liveTickets  Set of tickets a live interactive session works on
 *   tabOwners Map tab id -> { sessionId, name, live, ticket } from transcripts and loop tab records
 *   listening Set of local ports that have a listener (null when lsof failed)
 *   portTicket Map port -> ticket of the worktree that listens on it
 */
export function classify(tabs, facts) {
  const out = [];
  let otherLocal = 0;
  let nonLocal = 0;
  const nonLocalBySession = {}; // a session's own non-local tabs: only a count, never a URL or a title
  for (const t of tabs) {
    const p = urlParts(t.url);
    const owner = facts.tabOwners.get(t.id) || null;
    const byPort = p.local && facts.portTicket ? facts.portTicket.get(p.port) || null : null;
    const ticket = p.hostTicket || (p.local ? (owner && owner.ticket) || byPort : null);
    if (!p.local) {
      nonLocal++;
      if (owner) nonLocalBySession[owner.sessionId] = (nonLocalBySession[owner.sessionId] || 0) + 1;
      continue;
    }
    if (!ticket) { otherLocal++; continue; }
    const by = [p.hostTicket ? 'host' : null, owner ? `session:${String(owner.sessionId).slice(0, 8)}` : null, byPort ? 'port' : null].filter(Boolean);
    const status = facts.status.has(ticket) ? facts.status.get(ticket) : null;
    const closed = CLOSED_STATUSES.includes(status);
    const serverStopped = facts.listening ? !facts.listening.has(p.port) : null;
    const sessionLive = facts.liveTickets.has(ticket);
    const label = closed ? 'done' : status === 'ready_to_merge' ? 'left-for-you' : sessionLive ? 'in-use' : serverStopped ? 'server-stopped' : 'session-ended';
    // A Ready to merge tab waits for the owner's check: never closed, even with its server stopped.
    // An unknown status (null) may be Ready to merge: only a known one opens the stopped-server branch.
    const sureOrphan = Boolean(p.hostTicket) && !t.active && (closed || (serverStopped === true && !sessionLive && status !== null && status !== 'ready_to_merge'));
    out.push({ id: t.id, windowId: t.windowId, active: t.active, url: short(t.url, URL_MAX), title: short(t.title, TITLE_MAX), ticket, status, label, serverStopped, sessionLive, by, openedBy: owner ? { sessionId: owner.sessionId, name: owner.name || null, live: owner.live } : null, sureOrphan, fullUrl: t.url });
  }
  return { tabs: out, otherLocal, nonLocal, nonLocalBySession };
}

const LABEL_TEXT = {
  'left-for-you': 'left for your check',
  'in-use': 'in use by its loop',
  done: 'its ticket is closed: the check is over',
  'server-stopped': 'its server has stopped',
  'session-ended': 'its session has ended',
};
export const labelText = (l) => LABEL_TEXT[l] || l;

/** The tab ids each session's transcript or loop tab record names. */
function tabOwnersOf(F) {
  const owners = new Map();
  for (const [sid, info] of F.bySid || new Map()) {
    for (const id of info.transcript.tabIds || []) owners.set(id, { sessionId: sid, name: info.agent.name, live: true, ticket: info.ev.key });
  }
  // The loop tab records (cc-loop close-out writes one per session).
  const dir = path.join(F.cfg, 'coord', 'tabs');
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { /* none */ }
  for (const f of names) {
    const rec = readJson(path.join(dir, f));
    const sid = f.replace(/\.json$/, '');
    // A record is one {tabId, url, ticket} (cc-loop's close-out), a list of them, or {tabs: [...]}.
    const entries = Array.isArray(rec) ? rec : rec && Array.isArray(rec.tabs) ? rec.tabs : rec && typeof rec === 'object' && rec.tabId ? [rec] : [];
    for (const e of entries) {
      const id = Number(e && e.tabId);
      if (id && !owners.has(id)) owners.set(id, { sessionId: sid, name: null, live: (F.bySid || new Map()).has(sid), ticket: /^TCK-\d+$/.test(e.ticket || '') ? e.ticket : null });
    }
  }
  return owners;
}

/** Every fact `classify` needs except the statuses, from the close check's shared facts. */
export async function tabFacts(F) {
  const owners = tabOwnersOf(F);
  const listening = F.ports ? new Set([...F.ports.values()].flat()) : null;
  const portTicket = new Map();
  if (F.ports && F.cwds) {
    for (const [pid, ports] of F.ports) {
      const n = F.ticketOfDir ? F.ticketOfDir(F.cwds.get(pid)) : null;
      if (n) for (const port of ports) portTicket.set(port, n);
    }
  }
  const liveTickets = new Set([...(F.bySid || new Map()).values()].map((i) => i.ev.key).filter(Boolean));
  return { tabOwners: owners, listening, portTicket, liveTickets };
}

/** The status of each ticket a local tab may belong to, from the close check's lists (never a keyed GET). */
export function statusMapFor(tabs, facts, F) {
  const status = new Map();
  for (const t of tabs) {
    const p = urlParts(t.url);
    for (const key of [p.hostTicket, (facts.tabOwners.get(t.id) || {}).ticket, p.local ? facts.portTicket.get(p.port) : null]) {
      if (key && !status.has(key)) status.set(key, statusOf(key, F));
    }
  }
  return status;
}

/** List and label: { ok, error?, tabs, otherLocal, nonLocal }. `given` replaces the gathered facts (selftest). */
export async function list(args, deps, run = osa, given = null) {
  const F = given || await gather({ ...args, withTabs: false }, deps);
  const tabs = listChromeTabs(run);
  if (tabs === null) return { ok: false, error: 'AppleScript could not read the Chrome tabs', tabs: [], otherLocal: 0, nonLocal: 0, F };
  const facts = await tabFacts(F);
  const c = classify(tabs, { ...facts, status: statusMapFor(tabs, facts, F) });
  const failed = [!F.agents && '`claude agents`', !F.ports && 'the listening ports', !F.cwds && 'the process folders', !F.statuses && 'the ticket lists'].filter(Boolean);
  return { ok: failed.length === 0, error: failed.length ? `could not read ${failed.join(', ')}` : null, ...c, F };
}

/** Close the given tabs (or every sure orphan) that are still sure orphans now. */
export async function close(args, deps, run = osa, given = null) {
  const l = await list(args, deps, run, given);
  if (!l.ok) return { closed: [], refused: [], error: `${l.error}: nothing was closed` };
  const want = args.orphans ? l.tabs.filter((t) => t.sureOrphan).map((t) => t.id) : (args.ids || []);
  const closed = [];
  const refused = [];
  for (const id of want) {
    const t = l.tabs.find((x) => x.id === id);
    if (!t) { refused.push({ id, why: 'not a loop tab, or no longer open' }); continue; }
    if (!t.sureOrphan) { refused.push({ id, why: t.active ? 'it is the active tab of its window' : `not a sure orphan (${labelText(t.label)})` }); continue; }
    let r;
    try { r = String(run(closeScript(t.windowId, t.id, t.fullUrl))).trim(); } catch (e) { r = `error: ${short(e.message, 80)}`; }
    if (r === 'closed') closed.push({ id, ticket: t.ticket, url: t.url, label: t.label });
    else refused.push({ id, why: r === 'moved' ? 'its URL changed' : r === 'active' ? 'it became the active tab' : r === 'gone' ? 'it was already closed' : r });
  }
  return { closed, refused, error: null };
}

export function render(l) {
  if (!l.ok && !l.tabs.length) return `Chrome tabs: ${l.error}`;
  const out = [`Chrome loop tabs: ${l.tabs.length}${l.error ? ` (warning: ${l.error}; nothing would be closed)` : ''}`];
  for (const t of l.tabs) out.push(`  ${t.sureOrphan ? 'ORPHAN' : '      '} tab ${t.id} ${t.ticket} ${t.status || '?'}: ${labelText(t.label)}${t.active ? ' (active tab)' : ''} — ${t.url} "${t.title}"`);
  out.push(`Other tabs: ${l.otherLocal} local, ${l.nonLocal} not local (not listed)`);
  return out.join('\n');
}

// ── selftest ─────────────────────────────────────────────────────────────────

async function selftest() {
  let failed = 0;
  const eq = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
  };
  const row = (w, id, active, url, title) => [w, id, active, url, title].join(FS) + RS;
  // parseTabs
  const raw = row(1, 11, 'false', 'http://tck-7.localhost:3701/notes/1', 'TCK-7 sweep') + row(1, 12, 'true', 'https://noesisbrain.com/backlog', 'Backlog') + `\n${row(2, 21, 'false', 'http://127.0.0.1:3500/', `a${FS}b`)}`;
  eq('parseTabs reads each field, the active flag, and a title with the separator in it', parseTabs(raw).map((t) => [t.windowId, t.id, t.active, t.url, t.title]), [[1, 11, false, 'http://tck-7.localhost:3701/notes/1', 'TCK-7 sweep'], [1, 12, true, 'https://noesisbrain.com/backlog', 'Backlog'], [2, 21, false, 'http://127.0.0.1:3500/', `a${FS}b`]]);
  eq('urlParts: host ticket with and without the hyphen; .localhost is local; noesisbrain is not', ['http://tck-1926.localhost:3701/x', 'http://tck1899.localhost:3899/', 'https://noesisbrain.com/', 'http://[::1]:5555/', 'chrome://newtab/'].map((u) => { const p = urlParts(u); return [p.hostTicket, p.local, p.port]; }), [['TCK-1926', true, 3701], ['TCK-1899', true, 3899], [null, false, 443], [null, true, 5555], [null, false, 0]]);

  // classify
  const tabs = [
    { windowId: 1, id: 1, active: false, url: 'http://tck-1.localhost:3701/a', title: 'shipped, server up' },
    { windowId: 1, id: 2, active: false, url: 'http://tck-2.localhost:3702/a', title: 'ready to merge, server stopped' },
    { windowId: 1, id: 3, active: false, url: 'http://tck-3.localhost:3703/a', title: 'implementing, live session' },
    { windowId: 1, id: 4, active: false, url: 'http://tck-4.localhost:3704/a', title: 'implementing, session ended, server stopped' },
    { windowId: 1, id: 5, active: false, url: 'http://tck-5.localhost:3705/a', title: 'implementing, session ended, server up' },
    { windowId: 1, id: 6, active: true, url: 'http://tck-1.localhost:3701/b', title: 'shipped but the active tab' },
    { windowId: 1, id: 7, active: false, url: 'http://127.0.0.1:3706/', title: 'matched by its port only, ticket shipped' },
    { windowId: 1, id: 8, active: false, url: 'http://localhost:3500/', title: 'owner dev, no loop' },
    { windowId: 1, id: 9, active: false, url: 'https://noesisbrain.com/notes/1', title: 'secret title' },
    { windowId: 1, id: 10, active: false, url: 'chrome://newtab/', title: 'New Tab' },
    { windowId: 1, id: 11, active: false, url: 'http://localhost:3707/', title: 'opened by a session, ticket shipped' },
    { windowId: 1, id: 12, active: false, url: 'http://tck-6.localhost:3708/', title: 'status unknown, server up' },
    { windowId: 1, id: 14, active: false, url: 'http://tck-8.localhost:3709/', title: 'deploying, server stopped, live session' },
    { windowId: 1, id: 15, active: false, url: 'http://tck-12.other.localhost:3720/', title: 'a .localhost host that does not name a ticket' },
    { windowId: 1, id: 17, active: false, url: 'http://tck-6.localhost:3730/', title: 'status unknown, server stopped, no session' },
    { windowId: 1, id: 18, active: false, url: 'http://tck-11.localhost:3731/', title: 'a merged ticket by its host' },
  ];
  const facts = {
    status: new Map([['TCK-1', 'shipped'], ['TCK-2', 'ready_to_merge'], ['TCK-3', 'implementing'], ['TCK-4', 'implementing'], ['TCK-5', 'implementing'], ['TCK-9', 'shipped'], ['TCK-11', 'merged'], ['TCK-6', null], ['TCK-8', 'deploying'], ['TCK-12', 'shipped']]),
    liveTickets: new Set(['TCK-3', 'TCK-8']),
    tabOwners: new Map([[11, { sessionId: 'abcdef12-0000', name: 'x', live: false, ticket: 'TCK-11' }], [10, { sessionId: 's-nonlocal', name: 'y', live: true, ticket: null }]]),
    listening: new Set([3701, 3703, 3705, 3706, 3708]),
    portTicket: new Map([[3706, 'TCK-9']]),
  };
  const c = classify(tabs, facts);
  const by = (id) => c.tabs.find((t) => t.id === id);
  eq('labels: done, left for you, in use, server stopped, session ended', [1, 2, 3, 4, 5].map((i) => by(i).label), ['done', 'left-for-you', 'in-use', 'server-stopped', 'session-ended']);
  eq('sure orphans: a closed ticket by host, and a stopped server with no live session', c.tabs.filter((t) => t.sureOrphan).map((t) => t.id), [1, 4, 18]);
  eq('a Ready to merge tab is never an orphan, even with its server stopped', by(2).sureOrphan, false);
  eq('the active tab is never an orphan', [by(6).label, by(6).sureOrphan], ['done', false]);
  eq('a tab matched only by port or by tab id gets a label, never an orphan', [by(7).label, by(7).sureOrphan, by(11).label, by(11).sureOrphan, by(11).openedBy.name], ['done', false, 'done', false, 'x']);
  eq('unknown status with a server up is no orphan', [by(12).label, by(12).sureOrphan], ['session-ended', false]);
  eq('a Deploying ticket is not closed: its tab is in use, never an orphan', [by(14).label, by(14).sureOrphan], ['in-use', false]);
  eq('a .localhost host that only starts with tck-<n> names no ticket: counted, never listed', [Boolean(by(15)), c.otherLocal], [false, 2]);
  eq('an unknown status with a stopped server and no session is no orphan (it may be Ready to merge)', [by(17).label, by(17).sureOrphan], ['server-stopped', false]);
  eq('a merged ticket by its host: done, and a sure orphan', [by(18).label, by(18).sureOrphan], ['done', true]);
  eq('a session\'s own non-local tab is only counted, per session', c.nonLocalBySession, { 's-nonlocal': 1 });
  eq('only a host that is exactly tck-<n>.localhost names a ticket', ['http://notck-5.localhost:1/', 'http://foo.tck-5.localhost:1/', 'http://tck-5.localhost.evil.com/', 'http://TCK-5.localhost:1/'].map((u) => urlParts(u).hostTicket), [null, null, null, 'TCK-5']);
  eq('other tabs are only counted: no title or URL of them is in the output', [c.otherLocal, c.nonLocal, JSON.stringify(c).includes('secret title'), c.tabs.some((t) => t.id === 8 || t.id === 9 || t.id === 10)], [2, 2, false, false]);
  const noLsof = classify(tabs, { ...facts, listening: null });
  eq('without the listening ports, only a closed ticket makes an orphan', noLsof.tabs.filter((t) => t.sureOrphan).map((t) => t.id), [1, 18]);
  eq('a long title and URL are cut', (() => { const t = classify([{ windowId: 1, id: 1, active: false, url: `http://tck-1.localhost:1/${'x'.repeat(300)}`, title: 'y'.repeat(200) }], facts).tabs[0]; return [t.url.length, t.title.length]; })(), [URL_MAX, TITLE_MAX]);

  // close: with a fake AppleScript runner and fake facts.
  const fakeF = { agents: [], ports: new Map([[1, [3701]], [3, [3703]], [5, [3705]], [8, [3708]]]), cwds: new Map(), statusByKey: new Map(facts.status), statuses: { map: new Map(), truncated: false }, bySid: new Map(), cfg: '/nonexistent' };
  const scripts = [];
  const runner = (answers) => (script) => {
    scripts.push(script);
    if (script === LIST_SCRIPT) return tabs.map((t) => row(t.windowId, t.id, String(t.active), t.url, t.title)).join('');
    const id = Number((/\(\(id of t\) as text\) is "(\d+)"/.exec(script) || [])[1]);
    return answers[id] || 'closed';
  };
  // The facts come from fakeF; no GET leaves the selftest.
  const deps = { ...realDeps({}), get: async () => null };
  const r1 = await close({ ids: [1, 2, 4, 6, 9, 99] }, deps, runner({}), fakeF);
  eq('close: only the sure orphans close; the others are refused with a reason', [r1.closed.map((x) => x.id), r1.refused.map((x) => [x.id, x.why])], [[1, 4], [[2, 'not a sure orphan (left for your check)'], [6, 'it is the active tab of its window'], [9, 'not a loop tab, or no longer open'], [99, 'not a loop tab, or no longer open']]]);
  const cs = closeScript(1, 2, 'http://tck-1.localhost:3701/a');
  eq('the close script returns on a moved URL or an active tab, and closes only the tab', [/then return "moved"\n/.test(cs), /then return "active"\n/.test(cs), /\n\s*close t\n/.test(cs), /close w\b/.test(cs)], [true, true, true, false]);
  eq('close: each close script names the tab, its window and its URL, and compares the ids as text', scripts.filter((s) => s !== LIST_SCRIPT).every((s) => /if \(URL of t\) is not "http:\/\/tck-[14]\.localhost/.test(s) && /if i = act then return "active"/.test(s) && /\(\(id of w\) as text\) is "1"/.test(s) && /\(\(id of t\) as text\) is "\d+"/.test(s)), true);
  const r2 = await close({ ids: [1, 4] }, deps, runner({ 1: 'moved', 4: 'active' }), fakeF);
  eq('close: a tab whose URL changed, or that became active, is not closed', [r2.closed, r2.refused.map((x) => x.why)], [[], ['its URL changed', 'it became the active tab']]);
  scripts.length = 0;
  const r3 = await close({ ids: [1, 4] }, deps, runner({}), { ...fakeF, ports: null });
  eq('close: when the listening ports cannot be read, nothing closes and no close script runs', [r3.closed, Boolean(r3.error), scripts.filter((s) => s !== LIST_SCRIPT).length], [[], true, 0]);
  scripts.length = 0;
  const r4 = await close({ ids: [1, 4] }, deps, runner({}), { ...fakeF, agents: null });
  eq('close: when claude agents cannot be read, nothing closes', [r4.closed, Boolean(r4.error), scripts.filter((s) => s !== LIST_SCRIPT).length], [[], true, 0]);
  scripts.length = 0;
  const r4c = await close({ ids: [1, 4] }, deps, runner({}), { ...fakeF, cwds: null });
  eq('close: when the process folders cannot be read, nothing closes', [r4c.closed, /process folders/.test(r4c.error || ''), scripts.filter((s) => s !== LIST_SCRIPT).length], [[], true, 0]);
  scripts.length = 0;
  const r4b = await close({ ids: [1, 4] }, deps, runner({}), { ...fakeF, statuses: null });
  eq('close: when the ticket lists cannot be read, nothing closes', [r4b.closed, /ticket lists/.test(r4b.error || ''), scripts.filter((s) => s !== LIST_SCRIPT).length], [[], true, 0]);
  const r5 = await close({ ids: [1, 4] }, deps, () => { throw new Error('osascript: not allowed'); }, fakeF);
  eq('close: when AppleScript cannot read the tabs, nothing closes', [r5.closed, /nothing was closed/.test(r5.error || '')], [[], true]);
  const r6 = await close({ orphans: true }, deps, runner({}), fakeF);
  eq('close --orphans closes every sure orphan (here also the Deploying tab: its server stopped and no session works on it)', r6.closed.map((x) => x.id), [1, 4, 14, 18]);
  eq('the list script is registered as read-only for --prove-read-only', READ_ONLY_SCRIPTS.has(LIST_SCRIPT), true);

  // pgrep: 0 running, 1 not running, anything else (or a spawn error) is a failure.
  const okRun = () => tabs.map((t) => row(t.windowId, t.id, String(t.active), t.url, t.title)).join('');
  eq('listChromeTabs: Chrome running, not running, pgrep error, pgrep failure', [listChromeTabs(okRun, () => ({ status: 0 })).length, listChromeTabs(okRun, () => ({ status: 1 })), listChromeTabs(okRun, () => ({ status: 2 })), listChromeTabs(okRun, () => ({ error: new Error('ENOENT') }))], [tabs.length, [], null, null]);

  // tabFacts from real close-check facts: live sessions (background agents too), transcript tab ids, loop tab records.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-tabs-test-'));
  try {
    const recDir = path.join(tmp, 'coord', 'tabs');
    fs.mkdirSync(recDir, { recursive: true });
    fs.writeFileSync(path.join(recDir, 'rec-object.json'), JSON.stringify({ tabId: 16, url: 'http://tck-1.localhost:3701/', ticket: 'TCK-1' }));
    fs.writeFileSync(path.join(recDir, 'rec-list.json'), JSON.stringify([{ tabId: 19, ticket: 'TCK-2' }]));
    fs.writeFileSync(path.join(recDir, 'rec-wrapped.json'), JSON.stringify({ tabs: [{ tabId: 20, ticket: 'not-a-key' }] }));
    fs.writeFileSync(path.join(recDir, 'rec-junk.json'), JSON.stringify('junk'));
    fs.writeFileSync(path.join(recDir, 'rec-empty.json'), '{}');
    const F2 = { cfg: tmp, ports: new Map(), cwds: new Map(), bySid: new Map([
      ['sid-live', { agent: { name: 'live', kind: 'interactive' }, transcript: { tabIds: [11] }, ev: { key: 'TCK-11' } }],
      ['sid-bg', { agent: { name: 'bg', kind: 'background' }, transcript: { tabIds: [] }, ev: { key: 'TCK-4' } }],
    ]) };
    const tf = await tabFacts(F2);
    eq('tabFacts: the transcript\'s tab ids give their session and its ticket', tf.tabOwners.get(11), { sessionId: 'sid-live', name: 'live', live: true, ticket: 'TCK-11' });
    eq('tabFacts: a loop tab record (one object, a list, or wrapped) gives its tab; junk is skipped', [tf.tabOwners.get(16), (tf.tabOwners.get(19) || {}).ticket, (tf.tabOwners.get(20) || {}).ticket, tf.tabOwners.size], [{ sessionId: 'rec-object', name: null, live: false, ticket: 'TCK-1' }, 'TCK-2', null, 4]);
    eq('tabFacts: the tickets of live sessions, background agents included', [...tf.liveTickets].sort(), ['TCK-11', 'TCK-4']);
    const kept = await close({ ids: [4] }, deps, runner({}), { ...fakeF, bySid: F2.bySid });
    eq('close: a tab whose ticket a live (background) session works on is kept, even with its server stopped', [kept.closed, kept.refused.map((x) => x.why)], [[], ['not a sure orphan (in use by its loop)']]);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  console.log(failed ? `\n${failed} FAILED` : '\nall ok');
  return failed ? 1 : 0;
}

// ── main ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {};
  const [cmd, ...rest] = argv;
  args.cmd = cmd;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const val = () => rest[++i];
    if (a === '--json') args.json = true;
    else if (a === '--orphans') args.orphans = true;
    else if (a === '--ids') args.ids = String(val() || '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
    else if (a === '--closed') args.closed = val();
    else if (a === '--repo') args.repo = val();
    else if (a === '--agents') args.agents = val();
    else if (a === '--config-repo') args.configRepo = val();
    else throw new Error(`unknown argument ${a}`);
  }
  return args;
}

const USAGE = 'usage: coord-tabs.mjs list [--json] [--closed <file>] [--repo <main checkout>] | close (--ids <id,...> | --orphans) [--repo <main checkout>] [--json] | --selftest';

// No top-level await: coord-close.mjs imports this file while its own main runs, and a module that
// is still evaluating would make that import wait forever.
async function main(argv) {
  if (argv[0] === '--selftest') return selftest();
  let args;
  try { args = parseArgs(argv); } catch (e) { console.error(`${e.message}\n${USAGE}`); return 2; }
  const deps = realDeps(args);
  try {
    if (args.cmd === 'list') {
      const l = await list(args, deps);
      delete l.F;
      for (const t of l.tabs) delete t.fullUrl;
      console.log(args.json ? JSON.stringify(l, null, 2) : render(l));
      return l.ok ? 0 : 1;
    }
    if (args.cmd === 'close') {
      if (!args.orphans && !(args.ids || []).length) { console.error(USAGE); return 2; }
      const r = await close(args, deps);
      console.log(args.json ? JSON.stringify(r, null, 2) : [r.error || `closed ${r.closed.length}: ${r.closed.map((t) => `${t.id} (${t.ticket})`).join(', ') || 'none'}`, ...r.refused.map((x) => `  kept ${x.id}: ${x.why}`)].join('\n'));
      return r.error ? 1 : 0;
    }
    console.error(USAGE);
    return 2;
  } catch (e) {
    console.error(`coord-tabs: ${e.message}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
