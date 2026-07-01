---
description: Generate Skim-Read key parts for a Noesis note YOURSELF (no in-app AI) and persist them as suggested marks — the Gemini-free fallback for the Skim-Read panel. Accepts a note ID or file path.
argument-hint: <note path or ID> [--style gist|balanced|thorough|structure|keyword] [--intensity light|normal|heavy]
---

Generate the KEY PARTS a reader should focus on in a Noesis note and persist them, so the note's Skim-Read panel surfaces them. YOU do the extraction (using your own model) and the server only anchors + saves — no in-app Gemini call. This is the fallback to use when the app's built-in Skim-Read is rate-limited / 503, or any time you want to drive it from Claude Code.

## Arguments

$ARGUMENTS

Accepted forms:

- `<path>.md` — a file path (e.g. from the Noesis web UI "Copy File Path" button). Quote paths with spaces.
- `<id>` — a numeric Note ID.
- Natural language — e.g. `Create skim-read for the note "/path/to/note.md"`; extract the path/ID from the request.
- `--style <s>` — reading strategy: `gist` | `balanced` (default) | `thorough` | `structure` | `keyword`.
- `--intensity <i>` — how many parts: `light` | `normal` (default) | `heavy`.

## Workflow

### Step 1 — Resolve the note

From `$ARGUMENTS`, extract the target: an all-digits token is a Note ID; anything else (a path, possibly quoted) is a file path. Capture optional `--style` / `--intensity`. If neither an ID nor a path is present, ask the user which note via `AskUserQuestion`.

### Step 2 — Read the note content

Call `mcp__noesis__get_note(id: <id>)` or `mcp__noesis__get_note(path: <path>)`. Use the returned `content` as the source of truth. Do NOT call `mcp__noesis__get_note_skim_read` — that uses the in-app AI, which this skill deliberately bypasses.

### Step 3 — Generate the key parts

Pick the spans a reader should focus on to get the gist efficiently — spread across the note's sections, each a DISTINCT idea (don't spend several parts on the same point). For each part produce `{ granularity, quote, headingPath?, importance, reason }`:

- **quote** — copied CHARACTER-FOR-CHARACTER (verbatim) from `content`. Do NOT paraphrase, translate, fix typos, summarize, or add ellipses. Make each quote long enough to occur exactly once (add surrounding words if a short phrase repeats).
  - `section` → the heading line text · `sentence` → the full sentence · `paragraph` → its first ~12 words · `keyword` → the exact token(s).
- **granularity** — `section` | `paragraph` | `sentence` | `keyword`.
- **importance** — 0..1; reserve > 0.8 for the few genuinely load-bearing parts.
- **reason** — ≤ 12 words, plainly what the span says (no hype words).
- Only quote VISIBLE prose. Skip code fences (```), YAML frontmatter, HTML tags, and any COLLAPSED `<details>` block (one without the `open` attribute).
- `headingPath` — ancestor heading texts (top-most first) to disambiguate a repeated quote; omit or `[]` if unknown.

Prefer fewer high-confidence parts over filling a quota; it is correct to return few parts for a short or list-like note.

### Step 4 — Apply

Call `mcp__noesis__apply_note_skim_read` with `{ id | path, keyParts: [...], style?, intensity? }`. The server anchors each verbatim quote and persists matches as `suggested` marks (replacing prior un-accepted suggestions; accepted/dismissed marks are preserved).

### Step 5 — Fix unmatched quotes (loop)

The result includes `unmatchedQuotes` — quotes that did not occur verbatim in the note. If non-empty:

1. Re-read those spans in `content` and correct each quote to the note's EXACT text.
2. Call `mcp__noesis__apply_note_skim_read` again with the corrected full set.
3. Repeat until `unmatchedQuotes` is empty (or you've corrected every quote you reasonably can — typically ≤ 3 rounds).

### Step 6 — Report

State how many key parts were applied (`keyPartCount`), list any quotes that still didn't anchor, and tell the user to open the note's **Skim-Read** panel to see them.

## Constraints

- Quotes MUST be verbatim slices of the note content — never invented or edited. A verbatim quote is what lets the server anchor the mark.
- This skill never calls the in-app Skim-Read AI; generating the parts yourself is the entire point (it works when Gemini is down).
- The path must sit under one of the user's registered Noesis roots, and the note must exist in the database the MCP server targets. If the lookup 404s, confirm the path/ID and that the MCP server points at the right backend.
- Do not edit the note's body — Skim-Read only adds non-destructive `suggested` marks.

## Examples

- `/noesis-skim-read "/path/to/note.md"` — skim-read by file path.
- `/noesis-skim-read 2302 --style gist` — terse gist of note 2302.
- `/noesis-skim-read 2302 --intensity heavy` — more key parts.
- `Create skim-read for the note "/path/to/note.md"` — natural-language invocation.
