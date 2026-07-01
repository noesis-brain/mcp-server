---
description: Continuously capture one or more Claude Code sessions into Noesis notes — a deterministic Node watcher tails each transcript, renders readable Markdown, and pushes it to the Noesis cloud on every change (zero tokens, no model loop). Use when the user says 'capture', 'start capture', 'capture session', 'monitor session', 'mirror session to noesis', or '/noesis-capture <id-or-name>'. Sub-commands - stop [<id|name>], status, sync.
argument-hint: "<session-id | name> | stop [<id|name>] | status | sync"
---

# /noesis-capture — Live Session Capture into Noesis (multi-session)

You are executing the `/noesis-capture` slash command. It runs in a **second** Claude session (the **controller** session) and mirrors one or more **other** sessions into Noesis notes that update in place — both locally and in the cloud — as those sessions progress.

**Architecture (fully deterministic — no model in the periodic path).** A bundled Node watcher does *everything that must run continuously*: it tails the source transcript, renders JSONL→Markdown to the local `.md`, **and pushes that note to the Noesis cloud directly** (`POST /api/mcp/notes/upsert`) on every change. One watcher process runs per captured session. Both the local render and the cloud push cost **zero tokens** and need **no Claude session in the loop**. This controller session only does what genuinely needs a Claude session: resolve targets, start/stop watchers, and report status.

The watcher path is `{{NOESIS_CAPTURE_WATCHER_PATH}}` — invoke it with `node "<that path>"`.

> There is **no** model-driven sync loop and **no** wake-up/reschedule here. That earlier design was unreliable — a single missed/no-op model turn, an `Esc`, or a non-resumed restart killed cloud sync permanently while the local file kept updating. The watcher now owns the cloud push, so cloud freshness is as reliable as the local render. **Never** reintroduce a model-driven periodic sync.

The watcher writes each capture note to `<captureDir>/<session-id>.md`, where `<captureDir>` is a `captures/` folder under one of your registered Noesis roots (resolved in Step 0b), plus a per-session status sidecar `<captureDir>/.<session-id>.cloud.json` (last push time / action / error — read by the `status` sub-command for cloud freshness). All controller state lives in a single shared file **`~/.claude/noesis-capture-state.json`** (v3 schema below), keyed by session id so multiple captures coexist. If the optional `SessionEnd` hook is installed (via `noesis-mcp setup --with-capture`), it marks every capture stopped and kills lingering watchers when this controller session ends; otherwise stop them yourself with `/noesis-capture stop`.

**Cloud auth (handled by the watcher).** The watcher reads `NOESIS_API_TOKEN` / `NOESIS_API_URL` from its environment, else from `~/.claude.json → mcpServers.noesis.env`. The token is never logged or placed on a command line. If no token is found, the watcher runs **local-only** (renders but does not push); in that case the cloud copy is maintained only by the skill's `mcp__noesis__sync_notes` calls at Start / Stop / `sync`.

## Arguments

The raw argument string is: `$ARGUMENTS`

Forms:
- `<session-id>` (a UUID) or `<name>` (a substring of the session's ai-title / summary), optionally followed by `--max-life <dur>` (or a trailing bare `<dur>`) — **start** capturing that session (adds to any already running). `--max-life` sets an optional **hard lifetime cap**: the capture auto-stops (with a final sync) after `<dur>` of wall-clock time.
- `stop [<id|name>]` — stop **all** captures, or just the one matching `<id|name>`. Final cloud sync each stopped note.
- `status` — report every capture currently tracked (incl. cloud freshness).
- `sync` — one-shot: force an immediate cloud sync of every capture via `mcp__noesis__sync_notes`. **Not a loop** — the watcher already keeps the cloud current; use this only to force/confirm a push right now.
- empty — treat as `status`.

**Duration `<dur>`** (for `--max-life`): one or both of `<N>h` and `<N>m` — e.g. `2h`, `90m`, `1h30m`. Convert to milliseconds as `(hours*60 + minutes) * 60000`; treat as **no cap** if it parses to 0 or is absent. Default: no cap (monitor until `/noesis-capture stop`). The cap is **per-capture**.

## State schema (`~/.claude/noesis-capture-state.json`, version 3)

```json
{
  "version": 3,
  "controllerSessionId": "<this-capture-session-id (SELF)>",
  "sessions": {
    "<session-id>": {
      "title": "<display-title> — Capture",
      "outPath": "<captureDir>/<id>.md",
      "transcriptPath": "<path-to-source-.jsonl>",
      "bgTaskId": "<background-task-id>",
      "watching": true,
      "startedAt": 0,
      "maxLifetimeMs": null,
      "lastChangeTime": 0
    }
  }
}
```

- **Global:** `version`, `controllerSessionId` (this controller's own id / `SELF` — lets the optional `SessionEnd` hook auto-dispose captures when the controller closes).
- **Per-session** (under `sessions[<id>]`): `title`, `outPath`, `transcriptPath`, `bgTaskId`, `watching`, `startedAt` (unix-ms the capture began — the lifetime-cap clock), `maxLifetimeMs` (hard cap in ms, or `null`), `lastChangeTime` (unix-ms). The session id is the map key — do not duplicate it inside the object.
- All timestamps are **unix milliseconds**. Cloud freshness is **not** stored here — it lives in each watcher's `.<id>.cloud.json` sidecar next to the note.

### Read + migrate (do this at the top of every sub-command that touches state)

Read `~/.claude/noesis-capture-state.json` with the Read tool and normalize **in memory** to v3:
- Missing / unparseable → start a fresh v3 object: `{version:3, controllerSessionId:null, sessions:{}}`.
- Has a `sessions` object (v2 or v3) → keep `sessions`; **drop** any obsolete model-loop / cost-guard globals if present (`baseDelaySeconds`, `maxDelaySeconds`, `idleLevel`, `lastSyncTime`, `nextSyncTime`, `model`, `effort`, `costGuardOk`). For each session, default `startedAt` to its `lastChangeTime` (or `<now-ms>` if unset) and `maxLifetimeMs` to `null` when absent. Set `version:3`.
- Has a top-level `sessionId` (the **old singleton** format) → fold it into `sessions[sessionId]`, drop legacy globals, set `version:3`, `controllerSessionId:null` (recorded on the next Start/Sync).

Only **Start**, **Sync**, and **Stop** write the file back (Write tool, whole object). **Status** never writes.

## Instructions

### Step 0a — Discover THIS session id (for the self-monitor guard)

Ask the watcher for the current session's id so it can refuse to capture itself:

```bash
node "{{NOESIS_CAPTURE_WATCHER_PATH}}" --print-self
```

It prints `SELF=<id>` (possibly empty if it can't resolve — then omit `--self`). Keep `SELF` for the `--self` flag.

### Step 0b — Resolve the capture directory (under a registered Noesis root)

Call `mcp__noesis__list_roots`. Pick the target root: the one the user named if they specified one, else the first registered root. Let `<captureDir>` = that root's local path (for this OS) + `/captures`. All capture notes for this run go under `<captureDir>` so the watcher's cloud push always finds a matching root. If `list_roots` returns no roots, tell the user to register a root first (in the Noesis app or via `mcp__noesis__add_root`) and stop.

### Step 1 — Route on the sub-command

- `stop` (with or without an argument) -> go to **Stop** (pass the remainder of the argument).
- `status` or empty -> go to **Status**.
- `sync`   -> go to **Sync (one-shot)**.
- anything else -> treat the whole argument as a session id/name and go to **Start**.

### Start — `/noesis-capture <id-or-name>`

1. **Parse the lifetime cap, then resolve.** First strip an optional lifetime cap from `$ARGUMENTS`: a `--max-life <dur>` / `--max-life=<dur>` flag, or a trailing standalone `<dur>` token (see **Duration**). Convert it to `maxLifetimeMs` (or `null`). The remaining text is `<target>`. Then resolve `<target>` with the watcher's read-only mode and respect the self-guard:

   ```bash
   node "{{NOESIS_CAPTURE_WATCHER_PATH}}" --resolve-only --self "<SELF>" --session "<target>"
   ```

   - Non-zero exit / `ERROR: could not resolve` -> tell the user no session matched and stop. Suggest the session id (UUID) or a more specific name fragment.
   - Exit code 3 (`REFUSED: self-monitor guard`) -> they pointed capture at the current session; refuse and stop.
   - Success -> parse the JSON (`sessionId`, `transcriptPath`, `title`, `candidates`). If `candidates` has more than one entry, briefly say which match was chosen (most recently modified) and list the alternatives. Compute `outPath = <captureDir>/<sessionId>.md`.

2. **Read + migrate state.** Compute `activeCount` = number of sessions with `watching === true` **before** this start (informational only — there is no shared loop to start).

3. **Dedup / restart guard** on `resolved.sessionId`:
   - Already present AND `watching === true` -> tell the user it's already being captured (its `title` + `outPath`) and offer a restart. On restart: `TaskStop` the old `bgTaskId` (tolerate failure), then continue and overwrite just that one entry. Never spawn a second watcher for the same id.
   - Present AND `watching === false` (previously stopped/paused) -> treat as restart: reuse the entry with a fresh watcher.

4. **Decide `startedAt`, then start the watcher in the background** (the long-running tail + render + cloud push).
   - **`startedAt`:** if this is a brand-new entry, or `maxLifetimeMs` was supplied on this call, set `startedAt = <now-ms>` (fresh lifetime window). On a restart with no new duration, keep the existing `startedAt` and `maxLifetimeMs`.
   - Launch the watcher. Append `--max-life-ms <remaining>` **only** when `maxLifetimeMs` is set, where `remaining = max(1000, maxLifetimeMs - (<now-ms> - startedAt))` — the watcher self-exits (after a final cloud push) when its own lifetime elapses:

   ```bash
   node "{{NOESIS_CAPTURE_WATCHER_PATH}}" --session "<sessionId>" --self "<SELF>" --out "<outPath>" [--max-life-ms <remaining>]
   ```

   Run with `run_in_background: true`. Record the returned background **task id** as `bgTaskId`. The watcher self-loads the Noesis token and begins pushing to the cloud on its first render — there is **nothing to schedule**.

5. **Upsert the session entry** (never overwrite siblings):
   `sessions[sessionId] = { title, outPath, transcriptPath, bgTaskId, watching: true, startedAt, maxLifetimeMs, lastChangeTime: <now-ms> }`.
   Ensure global `version:3` and `controllerSessionId = <SELF>` are present. Write state once.

6. **Immediate confirmation sync.** Give the watcher ~2 s to write the first render, then call `mcp__noesis__sync_notes` with `files: ["<outPath>"]` for an instant cloud copy; report `create`/`push`/`skip`. (This is a one-shot confirmation only — thereafter the watcher keeps the cloud current automatically, and it also covers the case where the watcher is running local-only.)

7. **Tell the user:** what is being captured (`title` + `sessionId`), the note path, and that **both** the local note and the **cloud** copy now update in real time via the watcher (deterministic, no token cost, no model loop) until `/noesis-capture stop`. If the watcher's sidecar reports `cloudEnabled:false` (no token), say so and note that the cloud copy will only refresh on `/noesis-capture sync` / `stop`.

### Sync (one-shot) — `/noesis-capture sync`

This is **not** a loop and never reschedules anything. Use it to force/confirm a cloud push right now.

1. **Read + migrate state.** If `sessions` is empty or no session has `watching === true` -> say nothing is being captured and stop.
2. For each `sessions[id]` with `watching === true`: call `mcp__noesis__sync_notes` with `files: ["<outPath>"]`. `skip` (unchanged — the watcher already pushed it) is normal and expected. On `conflict`: report it and tell the user to inspect the note (these notes are auto-generated, so a conflict means the cloud copy was hand-edited); do not auto-resolve.
3. Keep output to one short line, e.g. "Captures: 2 synced · 1 already current".

### Status — `/noesis-capture status`

Read + migrate state and report:
- Global: the controller session id (`controllerSessionId`) and the active count.
- Per session in `sessions`: `title`, short id (`id[:8]`), `watching` (true/false), **local** last-updated (mtime of `outPath`), **cloud** freshness — read the sidecar `<dirname(outPath)>/.<id>.cloud.json` and report `lastAction` + age of `lastPushTime`, or `lastError` if set, or `local-only` when `cloudEnabled:false` (missing sidecar → "cloud: starting…"), the lifetime cap (from `maxLifetimeMs`/`startedAt` → e.g. "2h cap · 1h12m left", or "no cap"), and `outPath`.

If there is no state file or `sessions` is empty, say nothing is being captured.

### Stop — `/noesis-capture stop [<id-or-name>]`

Read + migrate state first.

- **No argument** -> stop **all** `watching:true` sessions. For each: `TaskStop` its `bgTaskId` (if stale/unknown, warn that the node watcher may still be running and that closing it or ending the `noesis-capture-watcher.mjs` process will stop it), then a **final** `mcp__noesis__sync_notes` with its `outPath`, then set `watching:false`. List every stopped session (title + outPath).
- **With an argument** -> match it against `sessions`: exact id key first; else case-insensitive substring on `title` (if ambiguous, list the matches and ask which). Stop **only that one** (TaskStop + final sync + `watching:false`); **leave siblings running**. Unknown arg -> say it isn't being captured and list the current sessions.

Write state once at the end. Confirm to the user with the final note path(s).

## Constraints

- **Never** sync this skill file or the watcher to Noesis — only the generated `<captureDir>/*.md` capture notes.
- The watcher owns the **periodic** cloud push; the controller **never** runs a sync loop or reschedule. The only cloud pushes the controller issues are the one-shot `mcp__noesis__sync_notes` at Start (confirmation), `sync`, and Stop (final).
- Push to Noesis **only** via the watcher or `mcp__noesis__sync_notes` (never `cp` into a folder).
- Never edit a watcher's output `.md` by hand — it is fully regenerated on every change.
- Multiple sessions coexist under one state file; each has its own independent watcher. Start adds; it never overwrites a sibling.
- Capture costs **no tokens while monitoring** (the watcher is a plain Node process), so there is no cost guard, no idle auto-pause, and no model/effort prompt — capture any session on any model.

## Examples

- `/noesis-capture 1b1bcf99-f520-4bf5-9575-247d7574e8f5` — capture that session by id (adds to any already running)
- `/noesis-capture Implement auth redesign` — capture by name (ai-title substring)
- `/noesis-capture 1b1bcf99-… --max-life 2h` — capture with a hard 2-hour lifetime cap; `--max-life 90m` and a trailing `1h30m` also work
- `/noesis-capture status` — list every capture, with local + cloud freshness
- `/noesis-capture sync` — force an immediate cloud push of every capture (normally unnecessary)
- `/noesis-capture stop 1b1bcf99-…` — stop just that one capture, leave the rest running
- `/noesis-capture stop` — stop all captures and do a final cloud sync of each
