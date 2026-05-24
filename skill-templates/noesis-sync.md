---
description: Sync local Noesis notes with the cloud — pulls web-UI edits, pushes local changes, resolves conflicts inline.
---

The one-stop sync command for Noesis notes. Discovers notes edited via the Noesis web UI (Quick Fix), pulls them locally first, pushes your local changes, and resolves any conflicts inline with your input.

## Arguments

$ARGUMENTS

Accepted forms:
- (no args) — auto-scope: sync files edited in this conversation, else the current project root.
- `--files <absolute-paths>` — push these specific files (still pulls web-UI edits first for the matching root).
- `<root-name>` — bulk sync the named root (full scan).
- `--dry-run` — preview all actions without writing anything.
- `--skip-online-edits` — skip the web-UI-edit pull step (advanced; rarely needed).

## Workflow

CRITICAL: never start backend servers, write temporary scripts, or improvise HTTP calls. The cloud API at noesis-notes.vercel.app is always available through the MCP tool or the bundled script.

### Step 1 — Discover web-UI edits (unless `--skip-online-edits`)

Call `mcp__noesis__list_edited_online_notes` (filter by `root_id` if `$ARGUMENTS` names a root). For each returned note inspect the `localStatus`:

- `unchanged` — local file matches the last sync baseline; pull is safe and silent.
- `not_on_disk` — file does not exist locally; pull creates it (auto-pull, no conflict possible).
- `also_modified` — local file has diverged from the baseline. Tell the user the conflict cascade will run for those entries and ask `AskUserQuestion` to confirm before proceeding. If they decline, skip Step 2 for the `also_modified` entries and continue to Step 3 for the rest.

If `list_edited_online_notes` returns an empty list, skip to Step 3.

### Step 2 — Pull web-UI edits

For each pending note from Step 1 (excluding any the user declined), call:

```
mcp__noesis__sync_notes(files: ["<absolute path = root_path + '/' + relative_path>"])
```

Process one file at a time so per-file conflicts surface immediately. Track each result for the Step 5 summary.

### Step 3 — Push local changes

Apply scoping:

1. **Specific files just edited in this conversation** → pass `files: [<paths>]` (do NOT sync everything else).
2. **User passed `--files <paths>`** → use those paths.
3. **User passed a root name** → pass `root: "<name>"` (slow full scan).
4. **No context, no args** → pass `root` matching the current project directory if it maps to a registered root; otherwise fall back to `files` of the files edited in this conversation.

Choose the tier:

- **Tier 1 (preferred):** call `mcp__noesis__sync_notes` with the resolved scope (and `dryRun: true` if `--dry-run`).
- **Tier 2 (MCP unavailable):** run `node "{{NOESIS_MCP_SCRIPT_PATH}}" [args]` — the bundled script reads its token from `~/.claude.json` → `mcpServers.noesis.env.NOESIS_API_TOKEN` and talks to the cloud API directly. Pass the same CLI args (`--files`, `--root`, `--dry-run`).
- **Tier 3 (no Node.js):** call the cloud HTTPS endpoints directly via `curl`. Read the token from `~/.claude.json` as above.
  ```bash
  curl -H "Authorization: Bearer $TOKEN" https://noesis-notes.vercel.app/api/mcp/roots?forSync=true
  curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    https://noesis-notes.vercel.app/api/mcp/notes/upsert \
    -d '{"file":{"path":"...","relativePath":"...","content":"...","hash":"...","rootId":N,"rootName":"...","project":"..."},"metadata":{}}'
  ```

### Step 4 — Resolve conflicts inline (if any)

If Step 2 or Step 3 reported `conflicts.length > 0` (Tier C of the bidirectional sync — overlapping hunks that anchor reapply and `node-diff3` could not auto-merge), do this PER conflicting file rather than reporting "run another skill":

1. **Gather three sides:**
   - **CLOUD** — `mcp__noesis__get_note(id)` (id is in the conflict payload, or resolve via `mcp__noesis__list_notes` filtered to the relative path).
   - **LOCAL** — `Read` the local file at the resolved absolute path.
   - **BASE** — read `.noesis/baseline/<relative_path>` under the root. If the baseline file is missing (legacy sync state), tell the user and ask whether to treat as a two-way merge or skip the file.

2. **Classify each pair of overlapping hunks:**
   - **Trivial overlap** (one side adds, other doesn't touch; or one side is a strict superset) → auto-merge silently with the inclusive result.
   - **Mixed overlap** → resolve the trivial parts automatically; STOP and ask only about the irreconcilable parts.
   - **Semantic overlap** (opposing edits, contradictory rewrites) → present the diff and ask via `AskUserQuestion`: `keep-local` / `keep-cloud` / paste merged text. NEVER silently overwrite.

3. **Apply the merge:**
   - `Write` the merged content to the local file.
   - Call `mcp__noesis__sync_notes(files: [<absolute path>])` to push the resolved version.
   - If the push returns 409 (cloud changed since this step started), the cloud was updated concurrently — repeat Step 4 for that file from the top.
   - After a clean push, call `POST /api/mcp/notes/:id/clear-conflict` (via `Bash` + `curl` with the API token) to clear the cloud `conflict_marker`.

Process one file at a time. Do NOT batch a chosen-text response across multiple files.

### Step 5 — Report

Print one line per file processed:

- `pulled (web-UI edit applied locally)` — Step 2 succeeded with no conflict.
- `pushed (local change applied to cloud)` — Step 3 succeeded with no conflict.
- `merged auto for <path>` — Step 4 resolved trivial overlap without user input.
- `merged by user for <path>` — Step 4 resolved with explicit user choice.
- `skipped <path> (<reason>)` — user declined, baseline missing, or other.

End with a final tally: `Pulled: N. Pushed: M. Merged: K (auto X / by-user Y). Skipped: Z. Errors: E.`

## Constraints

- Never silently overwrite opposing edits — always present the diff and ask.
- Never modify cloud-side content directly via `PUT /api/notes/:id` — go through `sync_notes` so the optimistic-concurrency 409 catches concurrent changes.
- Never strip frontmatter or H1 from either side during merge — preserve verbatim from whichever side wrote them.
- One file at a time for conflict resolution.

## Examples

- `/noesis-sync` — auto-scope to recent conversation edits or current project root.
- `/noesis-sync --dry-run` — preview the full flow without writing.
- `/noesis-sync --files <absolute-path>` — push a specific file (still pulls web-UI edits first).
- `/noesis-sync <root-name>` — bulk sync a named root.
- `/noesis-sync --skip-online-edits` — push only, skip the web-UI pull step.
