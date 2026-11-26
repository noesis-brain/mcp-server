#!/usr/bin/env node
// coord-hot.mjs — orphaned processes that keep a CPU busy (C21, TCK-1984).
// The rule is in references/chief-conflict-catalogue.md, row C21.
//
//   node coord-hot.mjs list [--repo <main checkout>] [--config-repo <claude-config>] [--no-save] [--json]
//   node coord-hot.mjs stop --pid <n> --started <start time> [--repo <main checkout>] [--config-repo <dir>] [--json]
//   node coord-hot.mjs --selftest
//
// Why: on 2026-11-25 two vitest fork workers (PID 28669 and 58923) from TCK-1972's hang mutants were
// left with parent PID 1 in that session's scratch folder. Each used 100% of one core for about 12
// hours (decision #229). C10 sees only port listeners, and nothing else looked.
//
// A process is HOT when all of these hold:
//   - its parent is PID 1 (its own parent is gone);
//   - its working folder is inside a ticket worktree (a worktree of the main checkout's repository or
//     of claude-config whose branch or folder names tck-<n>; never the main checkout itself), or
//     under the Claude scratch root (realpath(/tmp)/claude-<uid>, coord-close.mjs scratchRoot());
//   - it listens on no TCP port (a server is C10's business);
//   - it uses 50% or more of a CPU now (ps %cpu), and over at least 15 minutes: between a saved sample
//     that is 15 minutes old or older and now, or, before such a sample exists, over its whole life
//     (it must have run for 15 minutes).
//
// `list` prints the hot processes and saves this run's sample of every orphan in a Claude folder to
// ~/.claude/coord/cpu-samples.json (CLAUDE_CONFIG_DIR, or COORD_HOT_SAMPLES for tests). coord-scan.mjs
// calls the same code, so the Chief's pass and the watcher's scan see the same rows. --no-save only
// reads.
//
// `stop` reads every fact again, and stops the process only when its start time is --started (so a
// reused pid is never hit) and it is still hot: SIGTERM to that pid alone, SIGKILL after 5 s, then it
// checks the process is gone. Otherwise it sends no signal and says why. It never signals a group, a
// name or a pattern.
//
// It reads `ps`, `lsof` and `git worktree list` (with GIT_OPTIONAL_LOCKS=0). It writes only the
// samples file, and `stop` sends signals only to the one pid it checked.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadCwds, loadPorts, scratchRoot, mainCheckout, worktrees, ticketNumberOf, short } from './coord-close.mjs';

export const MIN_CPU = 50;
export const WINDOW_S = 15 * 60;
const KEEP_S = 2 * 3600;
const KEEP_PER_PROCESS = 40;
export const GRACE_MS = 5000;

const configDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
export const samplesFile = () => process.env.COORD_HOT_SAMPLES || path.join(configDir(), 'coord', 'cpu-samples.json');
const realOf = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
const within = (dir, root) => dir === root || dir.startsWith(root + path.sep);

/** "[[dd-]hh:]mm:ss[.ff]" (ps time and etime) -> seconds, or null. */
export function clockSeconds(text) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(String(text || '').trim());
  if (!m) return null;
  return Number(m[1] || 0) * 86400 + Number(m[2] || 0) * 3600 + Number(m[3]) * 60 + Number(m[4]);
}

const PS_RE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(\S+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/;
/** `ps -axo pid=,ppid=,pgid=,pcpu=,time=,etime=,lstart=,command=` -> pid -> facts, or null when nothing parses. */
export function parsePsCpu(stdout) {
  const out = new Map();
  for (const line of String(stdout || '').split('\n')) {
    const m = PS_RE.exec(line);
    if (!m) continue;
    const cpuS = clockSeconds(m[5]);
    const ageS = clockSeconds(m[6]);
    if (cpuS === null || ageS === null) continue;
    out.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), pcpu: Number(m[4]), cpuS, ageS, started: m[7].replace(/\s+/g, ' '), command: m[8].trim() });
  }
  return out.size ? out : null;
}
export function loadPsCpu(run = spawnSync) {
  const r = run('ps', ['-axo', 'pid=,ppid=,pgid=,pcpu=,time=,etime=,lstart=,command='], { encoding: 'utf8', timeout: 10_000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } });
  return r.status === 0 && !r.error ? parsePsCpu(r.stdout) : null;
}

/** The Claude folders: the ticket worktrees of the main checkout's repository and of claude-config, and the scratch root. */
export function claudeFolders({ repo, configRepo, scratch }) {
  const out = [];
  for (const r of [repo, configRepo]) {
    const main = r ? mainCheckout(r) : null;
    if (!main) continue;
    for (const w of worktrees(main)) {
      if (realOf(w.path) === realOf(main)) continue;
      const n = ticketNumberOf(w);
      if (n) out.push({ kind: 'worktree', path: realOf(w.path), ticket: `TCK-${n}` });
    }
  }
  if (scratch) out.push({ kind: 'scratch', path: realOf(scratch), ticket: null });
  return out;
}

/** The Claude folder a working folder is in (the longest match), or null. */
export function folderClass(cwd, folders) {
  if (!cwd) return null;
  const d = realOf(cwd);
  return folders.filter((f) => within(d, f.path)).sort((a, b) => b.path.length - a.path.length)[0] || null;
}

const keyOf = (p) => `${p.pid}@${p.started}`;

/**
 * The hot processes, and the samples to save. `samples`: {key: [{at, cpuS}]}, oldest first. Every orphan in a
 * Claude folder gets this run's sample; samples older than KEEP_S, and those of processes that are gone, are dropped.
 */
export function hotOrphans({ ps, cwds, ports, folders, samples = {}, now = Date.now(), minCpu = MIN_CPU, windowS = WINDOW_S }) {
  const hot = [];
  const next = {};
  for (const p of ps.values()) {
    if (p.ppid !== 1) continue;
    const folder = folderClass(cwds.get(p.pid), folders);
    if (!folder) continue;
    const key = keyOf(p);
    const old = (samples[key] || []).filter((s) => s && now - s.at <= KEEP_S * 1000 && s.at < now);
    next[key] = [...old, { at: now, cpuS: p.cpuS }].slice(-KEEP_PER_PROCESS);
    if ((ports && ports.get(p.pid) || []).length) continue;
    if (!(p.pcpu >= minCpu)) continue;
    // The newest sample that is at least windowS old measures the last window; before one exists, the whole life does.
    const base = old.filter((s) => now - s.at >= windowS * 1000).pop();
    let avg;
    let how;
    if (base) {
      avg = ((p.cpuS - base.cpuS) / ((now - base.at) / 1000)) * 100;
      how = `window of ${Math.round((now - base.at) / 60000)} min`;
    } else {
      if (!(p.ageS >= windowS)) continue;
      avg = (p.cpuS / p.ageS) * 100;
      how = `lifetime of ${Math.round(p.ageS / 60)} min`;
    }
    if (!(avg >= minCpu)) continue;
    hot.push({ pid: p.pid, started: p.started, pcpu: p.pcpu, avg: Math.round(avg), how, ageMin: Math.round(p.ageS / 60), folder: folder.path, kind: folder.kind, ticket: folder.ticket, command: short(p.command, 160) });
  }
  return { hot, samples: next };
}

export function readSamples(file = samplesFile()) {
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return j && typeof j === 'object' && j.samples && typeof j.samples === 'object' ? j.samples : {}; } catch { return {}; }
}
export function saveSamples(samples, file = samplesFile()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, samples }));
  fs.renameSync(tmp, file);
  return file;
}

const defaultConfigRepo = () => [path.join(os.homedir(), 'temp_cGit', 'claude-config'), 'C:\\temp_cGit\\claude-config'].find((p) => fs.existsSync(path.join(p, '.git'))) || null;

export function realHotDeps() {
  return { ps: loadPsCpu, cwds: loadCwds, ports: loadPorts, now: () => Date.now(), scratchRoot, samplesFile, kill: (pid, sig) => process.kill(pid, sig), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), graceMs: GRACE_MS };
}

/** One look: the facts, the hot list, and (save) the samples written. A fact that cannot be read is an error, never "nothing hot". */
export function look({ repo, configRepo, save = true, minCpu, windowS }, deps = realHotDeps()) {
  const ps = deps.ps();
  const cwds = deps.cwds();
  const ports = deps.ports();
  if (!ps) return { error: 'ps failed', hot: [] };
  if (!cwds) return { error: 'lsof (working folders) failed', hot: [] };
  if (!ports) return { error: 'lsof (listening ports) failed', hot: [] };
  const folders = claudeFolders({ repo, configRepo: configRepo === undefined ? defaultConfigRepo() : configRepo, scratch: deps.scratchRoot() });
  const file = deps.samplesFile();
  const r = hotOrphans({ ps, cwds, ports, folders, samples: readSamples(file), now: deps.now(), ...(minCpu ? { minCpu } : {}), ...(windowS ? { windowS } : {}) });
  if (save) saveSamples(r.samples, file);
  return { checkedAt: new Date(deps.now()).toISOString(), repo: repo ? mainCheckout(repo) : null, hot: r.hot, folders: folders.length, ...(save ? { savedTo: file } : {}) };
}

/** Stop one hot process, after reading every fact again. */
export async function stopHot({ pid, started, repo, configRepo, minCpu, windowS }, deps = realHotDeps()) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 1) return { stopped: false, why: `not a pid: ${pid}` };
  if (!started) return { stopped: false, why: '--started is required (the start time the scan reported)' };
  const now = look({ repo, configRepo, save: false, minCpu, windowS }, deps);
  if (now.error) return { stopped: false, why: `the facts cannot be read again: ${now.error}` };
  const row = now.hot.find((h) => h.pid === n);
  if (!row) {
    const all = deps.ps();
    if (!all) return { stopped: false, why: 'the facts cannot be read again: ps failed' };
    const p = all.get(n);
    return { stopped: false, why: !p ? `pid ${n} is gone` : p.started !== String(started).replace(/\s+/g, ' ') ? `pid ${n} is another process now (started ${p.started})` : `pid ${n} is no longer hot (parent ${p.ppid}, ${p.pcpu}% CPU now)` };
  }
  if (row.started !== String(started).replace(/\s+/g, ' ')) return { stopped: false, why: `pid ${n} is another process now (started ${row.started})` };
  const steps = [];
  // 'alive' while this pid runs with the same start time; 'gone' when it is not listed, or another process has the pid;
  // 'unknown' when ps cannot be read: that is never read as gone.
  const state = () => { const p = deps.ps(); if (!p) return 'unknown'; const q = p.get(n); return q && q.started === row.started ? 'alive' : 'gone'; };
  try { deps.kill(n, 'SIGTERM'); steps.push(`sent SIGTERM to pid ${n}`); } catch (e) { return { stopped: false, why: `could not signal pid ${n}: ${e.message}`, steps }; }
  const waitGone = async (ms) => { for (let t = 0; t < ms; t += 100) { if (state() === 'gone') return 'gone'; await deps.sleep(100); } return state(); };
  if ((await waitGone(deps.graceMs)) !== 'gone') {
    try { deps.kill(n, 'SIGKILL'); steps.push(`sent SIGKILL to pid ${n} (not seen gone ${deps.graceMs / 1000} s after SIGTERM)`); } catch (e) { return { stopped: false, why: `could not SIGKILL pid ${n}: ${e.message}`, steps }; }
    const last = await waitGone(2000);
    if (last === 'unknown') return { stopped: false, why: `cannot confirm that pid ${n} is gone: ps cannot be read`, steps };
    if (last !== 'gone') return { stopped: false, why: `pid ${n} still runs after SIGKILL`, steps };
  }
  steps.push(`pid ${n} is gone`);
  return { stopped: true, pid: n, command: row.command, folder: row.folder, cpu: row.pcpu, avg: row.avg, how: row.how, steps };
}

export function renderHot(r) {
  if (r.error) return `coord-hot: ${r.error}`;
  if (!r.hot.length) return `no hot orphan (checked ${r.checkedAt})`;
  return r.hot.map((h) => `pid ${h.pid} (started ${h.started}) ${h.pcpu}% CPU now, ${h.avg}% over its ${h.how}, in ${h.kind === 'scratch' ? 'a scratch folder' : `the ${h.ticket} worktree`} ${h.folder}: ${h.command}`).join('\n');
}

// ── Selftest ────────────────────────────────────────────────────────────────────────────────

async function selftest() {
  let failed = 0;
  const eq = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
  };

  eq('clockSeconds: mm:ss.ff, hh:mm:ss, dd-hh:mm:ss, and junk', [clockSeconds('746:15.32'), clockSeconds('12:26:15'), clockSeconds('10-19:23:25'), clockSeconds('0:00.46'), clockSeconds(''), clockSeconds('12'), clockSeconds('a:b')], [44775.32, 44775, 933805, 0.46, null, null, null]);
  const psText = [
    '28669     1 28075 104.4 746:15.32    12:26:15 Wed Nov 25 21:53:29 2026     /opt/homebrew/bin/node --require x vitest/dist/workers/forks.js',
    '    1     0     1   0.5  66:25.61 10-19:23:25 Sun Nov 15 23:03:17 2026     /sbin/launchd',
    'garbage line',
    '  77  1  77  0.0  0:00.10  01:00 Thu Nov  5 09:01:02 2026 /bin/zsh -l',
  ].join('\n');
  const parsed = parsePsCpu(psText);
  eq('parsePsCpu: pid, parent, %cpu, cpu and age in seconds, start time (one space), command; junk skipped', [parsed.size, parsed.get(28669), parsed.get(77).started], [3, { pid: 28669, ppid: 1, pgid: 28075, pcpu: 104.4, cpuS: 44775.32, ageS: 44775, started: 'Wed Nov 25 21:53:29 2026', command: '/opt/homebrew/bin/node --require x vitest/dist/workers/forks.js' }, 'Thu Nov 5 09:01:02 2026']);
  eq('parsePsCpu: nothing parses -> null', parsePsCpu('x\ny'), null);
  const realPs = loadPsCpu();
  eq('loadPsCpu reads this machine: pid 1 and this process are there, with a start time', [Boolean(realPs && realPs.get(1)), Boolean(realPs && realPs.get(process.pid) && /\d{4}$/.test(realPs.get(process.pid).started))], [true, true]);

  // The Claude folders, from real git worktrees.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coord-hot-test-')));
  const sh = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8' }); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
  const repo = path.join(root, 'md-manager');
  fs.mkdirSync(repo);
  sh(repo, 'init', '-q', '-b', 'main'); sh(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  const wt = path.join(root, 'md-manager-tck-7');
  const other = path.join(root, 'md-manager-feature');
  sh(repo, 'worktree', 'add', '-q', '-b', 'loop/tck-7', wt); sh(repo, 'worktree', 'add', '-q', '-b', 'feature', other);
  const cfgRepo = path.join(root, 'claude-config');
  fs.mkdirSync(cfgRepo);
  sh(cfgRepo, 'init', '-q', '-b', 'main'); sh(cfgRepo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  const cwt = path.join(root, 'claude-config-tck-7');
  sh(cfgRepo, 'worktree', 'add', '-q', '-b', 'loop/tck-7', cwt);
  const scratch = path.join(root, 'claude-501');
  const sdir = path.join(scratch, '-proj', '0000000a-aaaa-4bbb-8ccc-dddddddddddd', 'scratchpad', 'chk3r2', 'mrepo', 'src', 'backend');
  fs.mkdirSync(sdir, { recursive: true });
  const folders = claudeFolders({ repo: wt, configRepo: cfgRepo, scratch });
  eq('claudeFolders: the ticket worktrees of both repositories and the scratch root; never a main checkout or a worktree without a ticket', folders.map((f) => [f.kind, path.basename(f.path), f.ticket]), [['worktree', 'md-manager-tck-7', 'TCK-7'], ['worktree', 'claude-config-tck-7', 'TCK-7'], ['scratch', 'claude-501', null]]);
  { const nested = [...folders, { kind: 'worktree', path: path.join(wt, '.claude', 'worktrees', 'tck-9'), ticket: 'TCK-9' }]; eq('folderClass: a ticket worktree nested inside another one is the inner one (the longest match)', folderClass(path.join(wt, '.claude', 'worktrees', 'tck-9', 'src'), nested).ticket, 'TCK-9'); }
  { const tmain = path.join(root, 'md-manager-tck-5'); fs.mkdirSync(tmain); sh(tmain, 'init', '-q', '-b', 'loop/tck-5'); sh(tmain, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
    eq('claudeFolders: a main checkout whose branch and folder name a ticket (loop/tck-5) is still never a Claude folder', claudeFolders({ repo: tmain, configRepo: null, scratch: null }), []); }
  eq('folderClass: inside a worktree, inside the scratch root, the main checkout, a sibling whose name only starts with a worktree, none', [folderClass(path.join(wt, 'src'), folders).kind, folderClass(sdir, folders).kind, folderClass(repo, folders), folderClass(`${wt}-old`, folders), folderClass(null, folders)], ['worktree', 'scratch', null, null, null]);

  // The rule, on fake facts. NOW is fixed; 28669 is the real case of decision #229 (12 h at ~100%).
  const NOW = Date.UTC(2026, 10, 26, 2, 0, 0);
  const P = (pid, o) => [pid, { pid, ppid: 1, pgid: pid, pcpu: 100, cpuS: 3600, ageS: 3600, started: `Wed Nov 25 21:00:0${pid % 10} 2026`, command: `node w${pid}.js`, ...o }];
  const ps = new Map([
    P(101, {}), // hot in the scratch folder: lifetime 100% over 60 min
    P(102, { pcpu: 49.9 }), // under 50% now
    P(103, { ppid: 555 }), // its parent lives
    P(104, {}), // listens on a port
    P(105, {}), // in the main checkout
    P(106, { ageS: 899, cpuS: 899 }), // younger than 15 min
    P(107, { cpuS: 1700 }), // lifetime average 47%
    P(108, {}), // in a worktree with no ticket
    P(109, {}), // in the md-manager ticket worktree
    P(110, {}), // in the claude-config ticket worktree
    P(111, { ageS: 900, cpuS: 450 }), // exactly 15 min old, exactly 50%
  ]);
  const cwds = new Map([[101, sdir], [102, sdir], [103, sdir], [104, sdir], [105, repo], [106, sdir], [107, sdir], [108, other], [109, path.join(wt, 'src', 'backend')], [110, cwt], [111, sdir]]);
  const ports = new Map([[104, [5555]]]);
  const r1 = hotOrphans({ ps, cwds, ports, folders, now: NOW });
  eq('hot on first sight: an orphan at >= 50% now and >= 50% over a life of >= 15 min, in the scratch root or a ticket worktree of either repository', r1.hot.map((h) => h.pid), [101, 109, 110, 111]);
  eq('the 50% boundary of the CPU now: exactly 50 is hot, 49.99 is not', hotOrphans({ ps: new Map([P(301, { pcpu: 50 }), P(302, { pcpu: 49.99 })]), cwds: new Map([[301, sdir], [302, sdir]]), ports: new Map(), folders, now: NOW }).hot.map((h) => h.pid), [301]);
  eq('the row says how, where and what', r1.hot[0], { pid: 101, started: 'Wed Nov 25 21:00:01 2026', pcpu: 100, avg: 100, how: 'lifetime of 60 min', ageMin: 60, folder: scratch, kind: 'scratch', ticket: null, command: 'node w101.js' });
  eq('every orphan in a Claude folder gets a sample, listening or not; the others none', Object.keys(r1.samples).map((k) => Number(k.split('@')[0])).sort((a, b) => a - b), [101, 102, 104, 106, 107, 109, 110, 111]);

  // The window: a sample 15 min or older measures the last window, and then the lifetime no longer counts.
  const k = (pid) => `${pid}@${ps.get(pid).started}`;
  const idleThenBusy = new Map([P(201, { cpuS: 1000, ageS: 36000 })]); // 10 h old, lifetime 3%: idle for hours
  const cw2 = new Map([[201, sdir]]);
  function k2(pid) { return `${pid}@${idleThenBusy.get(pid).started}`; }
  eq('window: idle for hours, then busy for the last 20 min: hot (the window, not the lifetime)', hotOrphans({ ps: idleThenBusy, cwds: cw2, ports: new Map(), folders, samples: { [k2(201)]: [{ at: NOW - 20 * 60_000, cpuS: 0 }] }, now: NOW }).hot.map((h) => [h.pid, h.how, h.avg]), [[201, 'window of 20 min', 83]]);
  eq('window: busy over its life, but idle over the last 16 min: not hot', hotOrphans({ ps, cwds, ports, folders, samples: { [k(101)]: [{ at: NOW - 16 * 60_000, cpuS: 3599 }] }, now: NOW }).hot.map((h) => h.pid), [109, 110, 111]);
  eq('window: the newest sample that is 15 min old is the base (a 30-min-old busy start, a 15-min-old idle base)', hotOrphans({ ps, cwds, ports, folders, samples: { [k(101)]: [{ at: NOW - 30 * 60_000, cpuS: 0 }, { at: NOW - 15 * 60_000, cpuS: 3590 }] }, now: NOW }).hot.some((h) => h.pid === 101), false);
  eq('window: only a younger sample (10 min): the lifetime decides, so a first-sight hot row stays hot', hotOrphans({ ps, cwds, ports, folders, samples: { [k(101)]: [{ at: NOW - 10 * 60_000, cpuS: 3000 }] }, now: NOW }).hot.some((h) => h.pid === 101), true);
  eq('samples: a reused pid (another start time) does not inherit the old samples', hotOrphans({ ps: new Map([P(101, { started: 'Thu Nov 26 09:00:00 2026', ageS: 600, cpuS: 600 })]), cwds, ports, folders, samples: { [k(101)]: [{ at: NOW - 60 * 60_000, cpuS: 0 }] }, now: NOW }).hot.length, 0);
  const pruned = hotOrphans({ ps, cwds, ports, folders, samples: { [k(101)]: [{ at: NOW - 3 * 3600_000, cpuS: 0 }, { at: NOW - 121 * 60_000, cpuS: 0 }, { at: NOW - 90 * 60_000, cpuS: 10 }, { at: NOW - 60_000, cpuS: 3500 }], 'gone@x': [{ at: NOW - 60_000, cpuS: 1 }] }, now: NOW }).samples;
  eq('samples: older than 2 h, and of processes that are gone, are dropped (a 90-min sample stays); this run is appended', [pruned[k(101)].map((s) => NOW - s.at), 'gone@x' in pruned], [[90 * 60_000, 60_000, 0], false]);
  eq('samples: at most 40 per process', hotOrphans({ ps, cwds, ports, folders, samples: { [k(101)]: Array.from({ length: 60 }, (_, i) => ({ at: NOW - (60 - i) * 1000, cpuS: i })) }, now: NOW }).samples[k(101)].length, 40);

  // look() and the samples file.
  const file = path.join(root, 'coord', 'cpu-samples.json');
  const fake = (over = {}) => ({ ps: () => ps, cwds: () => cwds, ports: () => ports, now: () => NOW, scratchRoot: () => scratch, samplesFile: () => file, kill: () => { throw new Error('no kill in look'); }, sleep: async () => {}, graceMs: 300, ...over });
  const l1 = look({ repo: wt, configRepo: cfgRepo }, fake());
  eq('look: the hot list, and the samples saved to the file', [l1.hot.map((h) => h.pid), Object.keys(readSamples(file)).length, l1.savedTo === file], [[101, 109, 110, 111], 8, true]);
  eq('look: it names the main checkout it looked at (from a worktree too)', [l1.repo, look({ repo, configRepo: cfgRepo, save: false }, fake()).repo], [repo, repo]);
  fs.rmSync(file);
  eq('look --no-save writes nothing', [look({ repo: wt, configRepo: cfgRepo, save: false }, fake()).hot.length, fs.existsSync(file)], [4, false]);
  eq('look: a fact that cannot be read is an error, never "nothing hot"', [look({ repo: wt, configRepo: cfgRepo }, fake({ ps: () => null })).error, look({ repo: wt, configRepo: cfgRepo }, fake({ cwds: () => null })).error, look({ repo: wt, configRepo: cfgRepo }, fake({ ports: () => null })).error], ['ps failed', 'lsof (working folders) failed', 'lsof (listening ports) failed']);
  eq('readSamples: a missing or broken file is empty', [readSamples(path.join(root, 'none.json')), (fs.writeFileSync(path.join(root, 'bad.json'), '{'), readSamples(path.join(root, 'bad.json')))], [{}, {}]);

  eq('the real stop waits 5 s after SIGTERM before SIGKILL', [GRACE_MS, realHotDeps().graceMs], [5000, 5000]);
  // stop, on fake facts: it re-checks everything, then SIGTERM, then SIGKILL after the grace.
  const killed = [];
  const stopFake = (over = {}) => fake({ samplesFile: () => path.join(root, 'stop-samples.json'), kill: (p, s) => { killed.push([p, s]); }, ...over });
  const started101 = ps.get(101).started;
  const goneAfter = (sig) => { let dead = false; return { kill: (p, s) => { killed.push([p, s]); if (s === sig) dead = true; }, ps: () => (dead ? new Map([...ps].filter(([p]) => p !== 101)) : ps) }; };
  killed.length = 0;
  let s = await stopHot({ pid: 101, started: started101, repo: wt, configRepo: cfgRepo }, stopFake(goneAfter('SIGTERM')));
  eq('stop: a hot process that ends at SIGTERM: one SIGTERM to its pid alone, stopped', [s.stopped, killed], [true, [[101, 'SIGTERM']]]);
  killed.length = 0;
  s = await stopHot({ pid: 101, started: started101, repo: wt, configRepo: cfgRepo }, stopFake(goneAfter('SIGKILL')));
  eq('stop: one that ignores SIGTERM gets SIGKILL after the grace', [s.stopped, killed, s.steps.some((x) => /SIGKILL/.test(x))], [true, [[101, 'SIGTERM'], [101, 'SIGKILL']], true]);
  killed.length = 0;
  { let reads = 0; let termAt = null; const slow = { kill: (p, sig) => { killed.push([p, sig]); if (sig === 'SIGTERM') termAt = reads; }, ps: () => { reads += 1; return termAt !== null && reads > termAt + 3 ? new Map([...ps].filter(([p]) => p !== 101)) : ps; } };
    s = await stopHot({ pid: 101, started: started101, repo: wt, configRepo: cfgRepo }, stopFake(slow));
    eq('stop: one that ends a moment after SIGTERM, within the grace, gets no SIGKILL', [s.stopped, killed], [true, [[101, 'SIGTERM']]]); }
  killed.length = 0;
  s = await stopHot({ pid: 101, started: started101, repo: wt, configRepo: cfgRepo }, stopFake());
  eq('stop: one that survives SIGKILL is reported, not "stopped"', [s.stopped, /still runs after SIGKILL/.test(s.why)], [false, true]);
  killed.length = 0;
  { let after = false; s = await stopHot({ pid: 101, started: started101, repo: wt, configRepo: cfgRepo }, stopFake({ kill: (p, sig) => { killed.push([p, sig]); after = true; }, ps: () => (after ? null : ps) }));
    eq('stop: when ps cannot be read after SIGTERM, the process is never called gone: SIGKILL follows, and it is not "stopped"', [s.stopped, killed, /cannot confirm that pid 101 is gone/.test(s.why)], [false, [[101, 'SIGTERM'], [101, 'SIGKILL']], true]); }
  killed.length = 0;
  { let after = false; const reused = new Map([...ps]); reused.set(101, { ...ps.get(101), started: 'Thu Nov 26 09:59:59 2026' }); s = await stopHot({ pid: 101, started: started101, repo: wt, configRepo: cfgRepo }, stopFake({ kill: (p, sig) => { killed.push([p, sig]); after = true; }, ps: () => (after ? reused : ps) }));
    eq('stop: a pid that another process takes during the grace is never sent SIGKILL (the start time is checked on every read)', [s.stopped, killed], [true, [[101, 'SIGTERM']]]); }
  { let reads = 0; s = await stopHot({ pid: 102, started: ps.get(102).started, repo: wt, configRepo: cfgRepo }, stopFake({ ps: () => (++reads === 1 ? ps : null) }));
    eq('stop: a pid that is not hot, with ps unreadable on the second read: a reason, not a crash', [s.stopped, s.why], [false, 'the facts cannot be read again: ps failed']); }
  const refuse = async (args, over) => { killed.length = 0; const r = await stopHot({ repo: wt, configRepo: cfgRepo, ...args }, stopFake(over)); return [r.stopped, r.why, killed.length]; };
  eq('stop refuses, with no signal: another start time (a reused pid)', await refuse({ pid: 101, started: 'Thu Nov 26 09:00:00 2026' }), [false, `pid 101 is another process now (started ${started101})`, 0]);
  eq('stop refuses: no --started', (await refuse({ pid: 101 }))[0], false);
  eq('stop refuses: a pid that is not hot (under 50% now)', await refuse({ pid: 102, started: ps.get(102).started }), [false, 'pid 102 is no longer hot (parent 1, 49.9% CPU now)', 0]);
  eq('stop refuses: its parent lives', (await refuse({ pid: 103, started: ps.get(103).started }))[2], 0);
  eq('stop refuses: it listens on a port', (await refuse({ pid: 104, started: ps.get(104).started }))[2], 0);
  eq('stop refuses: it runs in the main checkout', (await refuse({ pid: 105, started: ps.get(105).started }))[2], 0);
  eq('stop refuses: a pid that is gone', await refuse({ pid: 999, started: 'x' }), [false, 'pid 999 is gone', 0]);
  eq('stop refuses: pid 1, 0 and junk', [(await refuse({ pid: 1, started: 'x' }))[2], (await refuse({ pid: 0, started: 'x' }))[0], (await refuse({ pid: 'abc', started: 'x' }))[1]], [0, false, 'not a pid: abc']);
  eq('stop refuses: a fact that cannot be read', (await refuse({ pid: 101, started: started101 }, { cwds: () => null }))[1], 'the facts cannot be read again: lsof (working folders) failed');
  { const moved = new Map([...cwds]); moved.set(101, repo); eq('stop refuses: it moved to the main checkout since the scan', (await refuse({ pid: 101, started: started101 }, { cwds: () => moved }))[2], 0); }

  // A real orphan: a detached parent forks a busy worker into the scratch folder and exits, so the worker's parent is PID 1.
  if (process.platform !== 'win32') {
    const pidFile = path.join(root, 'worker.pid');
    const busy = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => { const t = Date.now(); while (Date.now() - t < 45) {} }, 50);`;
    const parent = `const c = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(busy)}], { cwd: ${JSON.stringify(sdir)}, stdio: 'ignore' }); c.unref(); setTimeout(() => process.exit(0), 200);`;
    spawnSync(process.execPath, ['-e', parent], { stdio: 'ignore', timeout: 10_000 });
    let wpid = null;
    for (let i = 0; i < 50 && !wpid; i++) { try { wpid = Number(fs.readFileSync(pidFile, 'utf8')) || null; } catch { /* not yet */ } if (!wpid) await new Promise((r) => setTimeout(r, 100)); }
    try {
      let row = null;
      // ps %cpu needs a moment to rise; the window is shortened to 2 s for this one process only.
      for (let i = 0; i < 40 && !row; i++) {
        await new Promise((r) => setTimeout(r, 250));
        const l = look({ repo: wt, configRepo: cfgRepo, save: false, windowS: 2 }, { ...realHotDeps(), scratchRoot: () => scratch, samplesFile: () => path.join(root, 'real-samples.json') });
        row = l.hot.find((h) => h.pid === wpid) || null;
      }
      eq('real: a busy worker whose parent exited (parent PID 1) in the scratch folder is hot', [Boolean(wpid), row && row.kind, row && row.folder], [true, 'scratch', scratch]);
      const st = row ? await stopHot({ pid: wpid, started: row.started, repo: wt, configRepo: cfgRepo, windowS: 2 }, { ...realHotDeps(), scratchRoot: () => scratch, samplesFile: () => path.join(root, 'real-samples.json') }) : { stopped: false };
      let alive = true;
      try { process.kill(wpid, 0); } catch { alive = false; }
      eq('real: stop ends it with SIGTERM, by its pid', [st.stopped, alive], [true, false]);
    } finally {
      if (wpid) { try { process.kill(wpid, 'SIGKILL'); } catch { /* gone */ } }
    }
  }

  fs.rmSync(root, { recursive: true, force: true });
  console.log(failed ? `\n${failed} FAILED` : '\nall ok');
  return failed ? 1 : 0;
}

// ── Command line ────────────────────────────────────────────────────────────────────────────

const USAGE = 'usage: coord-hot.mjs list [--repo <main checkout>] [--config-repo <dir>] [--no-save] [--json] | stop --pid <n> --started <time> [--repo <dir>] [--config-repo <dir>] [--json] | --selftest';

export function parseArgs(argv) {
  const out = { cmd: argv[0] };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--no-save') out.save = false;
    else if (['--repo', '--config-repo', '--pid', '--started'].includes(a)) {
      if (argv[i + 1] === undefined) throw new Error(`${a} needs a value`);
      out[a === '--config-repo' ? 'configRepo' : a.slice(2)] = argv[++i];
    } else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

async function main(argv) {
  if (argv[0] === '--selftest') return selftest();
  let args;
  try { args = parseArgs(argv); } catch (e) { console.error(`${e.message}\n${USAGE}`); return 2; }
  const repo = path.resolve(args.repo || process.cwd());
  if (args.cmd === 'list') {
    const r = look({ repo, configRepo: args.configRepo, save: args.save !== false });
    console.log(args.json ? JSON.stringify(r, null, 2) : renderHot(r));
    return r.error ? 1 : 0;
  }
  if (args.cmd === 'stop') {
    const r = await stopHot({ pid: args.pid, started: args.started, repo, configRepo: args.configRepo });
    console.log(args.json ? JSON.stringify(r, null, 2) : r.stopped ? [`stopped pid ${r.pid}: ${r.command}`, ...r.steps.map((x) => `  ${x}`)].join('\n') : `not stopped: ${r.why}`);
    return r.stopped ? 0 : 1;
  }
  console.error(USAGE);
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
