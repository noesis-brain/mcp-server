---
description: Polish a Noesis note's metadata and structure. Use a scope (today/session/catalog/cascade) or pass a specific note to iterate over multiple notes.
---

Refine Noesis notes: fill missing metadata (title, description, keywords, aliases), tighten structure (heading hierarchy, frontmatter completeness), refresh AI-rated quality and importance scores. Works on a single note or a batch discovered by scope.

## Arguments

$ARGUMENTS

Accepted forms:

- (no args) — ask the user to pick a scope via `AskUserQuestion`.
- `<path-or-filename>.md` — refine this specific note.
- `<topic-or-query>` — search for matching notes and offer them to the user.
- `today` — discover and refine notes referenced in today's conversation logs.
- `session [id]` — discover and refine notes referenced in a specific session (or the latest).
- `catalog <name>` — refine all notes in a named Noesis catalog.
- `cascade <anchor>` — refine the anchor note plus its semantically-similar neighbors.
- `--limit <N>` — cap how many notes a batch mode processes (default: 15).
- `--dry-run` — show what would change without writing.

## Workflow

### Step 1 — Parse mode

From `$ARGUMENTS`, determine `MODE` using the first matching rule:

| Priority | Pattern | Mode |
|---|---|---|
| 1 | `cascade <anchor>` | CASCADE |
| 2 | `today` (anywhere) | TODAY |
| 3 | `catalog <name>` | CATALOG |
| 4 | `session [<id>]` | SESSION |
| 5 | Ends in `.md` (path or filename) | SINGLE |
| 6 | Non-empty string (treated as search query) | SEARCH |
| 7 | Empty | ASK |

For `ASK`, prompt the user via `AskUserQuestion` with options for each mode and proceed once they pick.

### Step 2 — Discover candidate notes

Cap the candidate list per mode:

- **SINGLE**: just the one note. Resolve filename to a path via `mcp__noesis__search_notes` if needed.
- **SEARCH**: call `mcp__noesis__search_notes(query)` with the user's query; show the top 10, ask the user to pick one or more.
- **TODAY**: read `~/.claude/logs/console_*.clog` files dated today, extract note paths and search terms mentioned, deduplicate, cap at `--limit` (default 15).
- **SESSION**: same as TODAY but scoped to the chosen session UUID (or the latest if unspecified).
- **CATALOG**: call `mcp__noesis__list_notes(catalog: <name>)`, cap at `--limit` (default 25).
- **CASCADE**: resolve the anchor note's ID via `mcp__noesis__get_note(path)`, then call `mcp__noesis__find_similar_notes(note_id, limit: --limit ?? 10)`. Include the anchor itself.

Show the discovered list to the user and ask them to confirm or trim before refining. Sort by ascending `quality_score` (worst first) so the most-needed refinement happens first.

### Step 3 — Refine each note sequentially

For each candidate note:

1. **Read current state:** `mcp__noesis__get_note(path|id)` to get the full metadata + content.
2. **Fill missing metadata:** call `mcp__noesis__enhance_note_metadata(note_id)` with the relevant fields requested (`title`, `description`, `keywords`, `aliases`). The MCP tool uses AI to derive values from the note content. Apply with user approval if the change looks substantial; auto-apply if filling pure gaps (e.g., empty `keywords`).
3. **Structural suggestions** (light touch — skip if `--dry-run`):
   - Frontmatter completeness: title / description / keywords / aliases / date / updated / status / importance_score / quality_score.
   - Heading hierarchy: surface any H3+ without parent H2, or duplicate H1s.
   - Suggest and apply with `Edit` after user approval per file.
4. **Refresh scores:** call `mcp__noesis__rate_quality(note_id)` and `mcp__noesis__rate_importance(note_id)` — these run an AI rating pass; track the delta vs the prior values.
5. **Push:** if anything changed locally, call `mcp__noesis__sync_notes(files: [<absolute path>])` to push.

### Step 4 — Report

Per-note line:

- `refined <path>: metadata filled (Δ desc / kw / aliases), quality <old> → <new>, importance <old> → <new>`
- `refined <path>: no changes needed`
- `skipped <path> (<reason>)`

Final tally:

- `Total: T. Refined: R. Score delta: avg +X quality / +Y importance. Skipped: S. Errors: E.`

## Constraints

- Never overwrite a user-authored description with an AI-generated one without confirmation. The MCP tool returns suggestions; you apply them only after the user OKs substantial replacements.
- Never touch note `content` body text in refinement — only frontmatter and structural markers (headings, list normalization). Body rewrites are out of scope; that's an editing task, not a refinement.
- One note at a time — sequential, not parallel. Each push uses `sync_notes(files:[...])` so conflicts surface per-note.
- If a sync push returns conflict, hand off to `/noesis-sync` (which has the conflict-resolution flow embedded) or stop the batch and report.

## Examples

- `/noesis-refine-note c:/path/to/note.md` — refine a single note.
- `/noesis-refine-note today` — refine notes touched today.
- `/noesis-refine-note catalog Work` — refine the Work catalog.
- `/noesis-refine-note cascade c:/path/to/anchor.md` — refine the anchor and its semantic neighbors.
- `/noesis-refine-note today --dry-run` — preview only.
