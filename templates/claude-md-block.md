## Noesis MCP — conventions

### Writing notes
- Use plain `##` headings for primary sections — Noesis builds its sidebar outline from them. Reserve collapsible `<details>` blocks for appendix-style noise (logs, references, changelogs).

### Pushing notes to the cloud
- "Sync to Noesis" means push to the Noesis cloud database, not `cp` to a folder.
- Use `mcp__noesis__sync_notes` with `files: [<absolute paths>]`.
- Files must be within a registered root — check via `mcp__noesis__list_roots`.

### Reading and discovering notes
- Note relations and codebase links live in the Noesis **database**, not in `.md` frontmatter — don't grep `.md` files for them.
- Use `mcp__noesis__get_note` (read by ID or path), `mcp__noesis__find_similar_notes` (semantic similarity), `mcp__noesis__search_semantic` / `mcp__noesis__search_notes` (meaning / keyword search), `mcp__noesis__update_relations` (read-only when called without the `relations` param).

### Path-as-identifier (cross-machine)
For any path inside a Noesis-watched root, the path is a Noesis identifier — the cloud copy is always authoritative, and the local copy on this machine may be **missing** (other machine) or **stale** (the user edited the note via the Noesis web UI's Quick Fix; the web UI surfaces that state with the badge 「在线编辑 · 等待本地同步」). Either way, the local copy is not a trustworthy source of truth — reading it directly silently feeds outdated content into the rest of the turn.

A path is Noesis-watched if it contains `/.noesis/` **OR sits under a folder named `Noesis`** (the cloud root — e.g. `~/Noesis/…`, `%USERPROFILE%\Noesis\…`, or `C:\Users\<you>\Noesis\…`), **OR** is under any directory listed by `mcp__noesis__list_roots`. The `Noesis`/`.noesis` folder name is the cheap signal; when in doubt, treat a `.md` path that looks like a note as watched and let the MCP tool decide.

Trigger: when the user references such a path and you are about to read, edit, or otherwise consume it, sync first — once per path per turn, before the first tool call that touches it. Not before subsequent re-reads of the same path in the same turn.

**RECOVERY RULE:** if `Read` returns "file does not exist" for a `.md` path that looks like a note — especially one under a `.noesis`/`Noesis` folder — your immediate next action is the MCP tool below with the **same path**. Do NOT conclude the note is missing, on another machine, or that the path was mistyped until the MCP lookup also fails.

- **NORMAL mode (writes allowed):** call `mcp__noesis__sync_notes(files: [<that path>])`. The three-way merge handles every case: in-sync → cheap no-op (`'skip'`); cloud-newer → auto-pulls to local disk; local-newer → pushes to cloud; both diverged → conflict cascade (3-way merge); missing locally → auto-creates from cloud. In all five cases the next `Read`/`Edit`/`Write` sees the right bytes.
- **PLAN mode (writes forbidden):** call `mcp__noesis__get_note(path=<that path>)` for a read-only cloud lookup. Compare its `content_hash` / `updated_at` against the local file's hash / mtime; if drift exists, surface it in the plan and propose `sync_notes` as Step 1 of the implementation.
- In either mode, do NOT fall back to Glob/Grep to hunt for similar filenames; do NOT ask the user to disambiguate the path. The cloud is authoritative for Noesis-watched paths.
