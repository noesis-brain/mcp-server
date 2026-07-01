---
description: Discover related Noesis notes for either a NOTE (its formal relations, similar notes, and relation graph) or a CODEBASE (notes matching its tech stack, domain, and concepts). Read-only. Use when the user says 'find related notes', 'related docs', 'discover relations', 'what relates to this', 'what notes relate to this project', or 'find notes for this codebase'.
argument-hint: "[N results] <note path | note ID | codebase directory | search query>"
---

# /noesis-find-related — Discover Related Content in Noesis

You are executing the `/noesis-find-related` slash command. It discovers related content in the Noesis knowledge base from one of two starting points:

- **Note mode** — given a note (ID, `.md` path, filename, or search query), find its formal relations, semantically similar notes, keyword/semantic matches, reverse codebase links, and relation-graph neighbours.
- **Codebase mode** — given a codebase directory, profile its tech stack / domain / concepts and search Noesis for notes related to it.

This is a **read-only** skill — it never writes, edits, syncs, or modifies anything.

## Step 0 — Route on the argument

The raw arguments string is: `$ARGUMENTS`

Parse an optional leading integer **N** (1–50, how many results to display; default 10). Then classify the remaining `<target>`:

- **Numeric only** → a note **ID** → Note mode.
- **Path ending in `.md`** (has `/` or `\`) → a note **path** → Note mode.
- **`.md` filename** (no path separator) → Note mode (resolve the file via `mcp__noesis__list_notes` or a root-relative `Glob` under a registered Noesis root — get roots from `mcp__noesis__list_roots`).
- **Path without `.md`** (a directory, or `.`) → a **codebase directory** → Codebase mode.
- **Anything else** → a **search query** → Note mode (resolve to a note first).
- **Empty** → Codebase mode with the current working directory.

Clamp N to [1, 50], then go to the matching part below.

---

## Part A — Codebase mode (codebase → related notes)

### A1. Analyze the codebase
Read key identity files (skip any that are absent), in parallel:
- `Glob` for `{README*,CLAUDE.md,package.json,Cargo.toml,go.mod,pyproject.toml,requirements.txt,*.csproj,*.sln,pom.xml,build.gradle*,docker-compose.yml,Dockerfile}` and `Read` the matches (first ~100 lines of large files).
- `git -C <dir> log --oneline -20` for recent focus, and `ls` for top-level layout.
- If `src/` `lib/` `app/` `cmd/` exist, `ls` them; read the main entry point (≤ 2–3 source files total).

Synthesize a profile: **PROJECT_NAME**, **PURPOSE** (one sentence), **TECH_STACK**, **DOMAIN**, **KEY_CONCEPTS** (5–10 terms), **RECENT_FOCUS**. Display it. If essentially nothing is found, say so and `AskUserQuestion` for a description or a different path (use a description directly as queries).

### A2. Generate 6 diverse queries
Two each across **tech stack**, **domain**, and **concepts** — each query targeting a genuinely different facet (avoid 6 variations of one search).

### A3. Search in parallel (single batch)
For each of the 6 queries call **both** `mcp__noesis__search_notes` (`limit: N`) and `mcp__noesis__search_semantic` (`limit: min(N,20)`). In the same batch, call `mcp__noesis__search_by_related_code` with the **last folder segment** of the codebase path (never include slashes/backslashes — the lookup is SQL `ILIKE` where `\` escapes; use one distinctive folder name). These reverse-lookup hits are high-confidence explicit links.

Error handling: if all searches fail, say Noesis is unavailable and stop. If only `search_semantic` fails (common without a Gemini key), continue keyword-only and note it.

### A4. Deduplicate, rank, present
Group by note ID; per note track hit_count, best_score, categories hit (tech/domain/concept/codebase-link), and search types (keyword/semantic). Rank by a composite that rewards notes found by **many diverse** queries and by the reverse codebase lookup — not just a single high BM25 score. Show the top N as a ranked table (score, title, path, "found via"), then a one-line "why relevant" per result tying it to the profile (from title/path/snippet — do **not** `get_note` each result). Close with brief stats (unique notes, queries with 0 results, semantic available/unavailable).

If nothing is found, show the profile and suggest creating notes as you work, or retrying with a different path.

---

## Part B — Note mode (note → related content)

### B1. Resolve the target note
- **ID** → `mcp__noesis__get_note(id)`. **Path** → `mcp__noesis__get_note(path)`. **Query** → `mcp__noesis__search_notes(query, limit:5)`, pick via `AskUserQuestion` if several, then `get_note`.
- If it fails, show the error and stop.

From the response, store: `NOTE_ID`, `NOTE_PATH`, `NOTE_TITLE`, `NOTE_DESCRIPTION`, `NOTE_KEYWORDS`, `NOTE_ALIASES`, `NOTE_RELATIONS` (typed links w/ target_id + context), `NOTE_RELATED_CODEBASES` (resolved objects w/ `path`, `label`), `NOTE_IMPORTANCE`, `NOTE_QUALITY`. Display `Discovering relations for: <title> (ID: <id>)`.

### B2. Discover (single parallel batch)
- **Relation targets:** for each unique `target_id` in `NOTE_RELATIONS`, `get_note` (≤ 10 parallel) to resolve titles.
- **Similar:** `mcp__noesis__find_similar_notes(note_id, limit:15)`. Record status `ok` / `no_embedding` / `no_api_key`.
- **Search:** `search_semantic(query: title + first 50 chars of description, limit:10)` and `search_notes(query: keywords or title, limit:10)`. Note if semantic is unavailable.
- **Reverse codebase:** for each `NOTE_RELATED_CODEBASES` path (≤ 5), `search_by_related_code` with a **single distinctive folder segment** (never slashes/backslashes; dedupe fragments).
- **Relation graph:** `mcp__noesis__get_relation_graph(note_id, depth:2)` for 2-hop neighbours.

### B3. Consolidate and present
Merge all discovered notes (exclude the target itself by ID). Per note track discovery_sources (e.g. "formal relation", "similar 82%", "keyword", "semantic", "reverse codebase", "graph depth 2"), best_score, and whether it's a formal relation (+ type). Present:
- **Formal Relations** — type · target title (ID) · context.
- **Related Codebase** — the linked paths.
- **Discovered Similar Notes** — notes not already formally related, sorted by best_score (score · title (ID) · discovery · path).
- **Discovery stats** — counts per method; embedding/semantic availability.
- **Next actions** — e.g. `/noesis-refine-note <path>` to enrich metadata and create formal relations; `update_relations` to formally link promising matches; `generate_embeddings` if `no_embedding`.

If nothing is found, note the note may be new/unique, embeddings may be missing (`generate_embeddings`), or metadata may be thin (`/noesis-refine-note`).

---

## Implementation notes
- **Read-only.** Never write, edit, sync, or modify — this skill only reads and searches.
- **Parallelism matters.** Batch the codebase file reads (A1) and the discovery calls (A3 / B2) into single parallel batches.
- **Don't `get_note` every result.** Search/similarity tools return enough metadata (title, path, snippet, score) for the tables; only `get_note` to resolve formal-relation target titles.
- **Composite ranking over raw scores.** A note surfaced by many diverse queries (or an explicit codebase link) is more relevant than one with a slightly higher single-query score.
- **Graceful degradation.** Every discovery method is optional — proceed with whatever succeeds (down to keyword-only when Gemini is unavailable).
