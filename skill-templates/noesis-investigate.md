---
description: Cross-domain context enrichment — given a prompt that mentions codebases AND Noesis notes, resolve the notes and enrich context by querying Noesis (relations, similar notes, codebase links, semantic/keyword search), then produce a consolidated context brief so you can proceed with full awareness. Read-only. Use when the user says 'investigate', 'gather context', 'enrich context', or a prompt references both codebases and notes.
argument-hint: "<investigation prompt mentioning codebases, notes, aliases, and intent>"
---

# /noesis-investigate — Cross-Domain Context Enrichment

You are executing the `/noesis-investigate` slash command. It takes a natural-language prompt that mentions codebases, Noesis notes, aliases, and/or intent, then enriches it by querying Noesis MCP tools to discover related knowledge. The result is a compiled **context brief** followed by the original prompt re-stated with full awareness, so you can proceed with the actual work.

This is a **read-only** skill — it enriches context and never writes, edits, syncs, or modifies anything.

## Step 1 — Parse the prompt

The raw arguments string is: `$ARGUMENTS`. If empty, check the conversation for a recent investigation request; else `AskUserQuestion` for one. Store it as `INVESTIGATION_PROMPT`.

Extract four categories using natural-language understanding (not rigid regex):
- **Codebases** — directory paths (contain `/` or `\`, do NOT end in `.md`). Store `{full_path, project_name}` where `project_name` is the last folder segment.
- **Notes** — paths ending in `.md`, bare `.md` filenames, or references like "the note about X". Store `{input, type}` with type `path` | `filename` | `query`.
- **Aliases** — informal names ("we call it X", "aka X", quoted labels). Store `{term, alias, source}`.
- **Intent** — a one-sentence summary of the goal (review / understand / compare / audit …).

If no codebases AND no notes are found, `AskUserQuestion` for paths, then re-parse. Display a short scope summary (intent, codebases, notes, aliases).

## Step 2 — Resolve notes to Noesis IDs (parallel)

- **`path`** → `mcp__noesis__get_note(path)`.
- **`filename`** → resolve under a registered Noesis root (get roots via `mcp__noesis__list_roots`, then `Glob` `<root>/**/<filename>`), then `get_note(path)`. Or find it via `mcp__noesis__list_notes`.
- **`query`** → `mcp__noesis__search_notes(query, limit:3)`; use the top hit, falling back to `search_semantic`.

For each resolved note store `note_id`, `note_path`, `note_title`, `note_description`, `note_keywords`, `note_aliases`, `note_relations` (typed links w/ target_id), `note_related_codebases` (resolved objects — read `entry.path`). Skip (don't abort on) individual resolution failures. If ALL notes fail and no codebases were given, stop with an error.

Merge aliases from the prompt + each note's `note_aliases`. Scan `note_related_codebases` for codebase paths not already listed and add them as `DISCOVERED_CODEBASES`.

## Step 3 — Enrichment (single maximum-parallel batch)

Dedupe first: collapse repeated note IDs and repeated codebase fragments so each `get_relation_graph` / `find_similar_notes` / `search_by_related_code` runs once. Then issue ALL of the following in one parallel batch:

- **Per resolved note:** `mcp__noesis__get_relation_graph(note_id, depth:2)` and `mcp__noesis__find_similar_notes(note_id, limit:10)`.
- **Per codebase** (input + discovered): `mcp__noesis__search_by_related_code(path: <project_name>, limit:15)`. **Path rule:** pass only a single distinctive folder segment — never slashes/backslashes (the lookup is SQL `ILIKE` where `\` escapes). Dedupe fragments.
- **Intent:** `mcp__noesis__search_semantic(query: INTENT, limit:15)` and `mcp__noesis__search_notes(query: INTENT key terms + alias values, limit:15)`.
- **Aliases** not already covered by the intent search: `mcp__noesis__search_notes(query: <alias>, limit:5)`.

Error handling: any individual call may fail (no embedding, no Gemini key, empty codebase link) — continue with the rest; record `SEMANTIC_AVAILABLE = false` if semantic search fails. Never abort for a single failure.

## Step 4 — Deduplicate and score

Collect results with a `discovery_source` tag (`relation-graph:<note>`, `similar:<note>`, `codebase-link:<project>`, `intent-semantic`, `intent-keyword`, `alias:<value>`), a `score`, and graph `depth` where applicable. Group by `note_id`, **excluding the input notes themselves**. Per unique note aggregate `discovery_sources`, `source_count`, `best_score`, and `is_formally_related`.

Composite relevance (0–100): reward notes found by **many distinct sources**, formally related, linked via a codebase, or reached from 2+ different input notes — not just a single high score. Sort descending and partition into Tier 1 (≥ 60, full detail), Tier 2 (40–59, compact), Tier 3 (< 40, count only).

## Step 5 — Compile the context brief

Present:
- **Header** — intent; counts (input notes / codebases / aliases; discovered notes / codebases); semantic available?
- **Input entities** — input notes (id, title, path, relation/related-code/alias counts) and input codebases (project, path, notes-linked).
- **Aliases** — term → alias (source: prompt / Noesis).
- **Discovered notes** — Tier 1 (score, title (id), found-via, path), Tier 2 (compact), Tier 3 (count only). Do **not** `get_note` discovered notes — search/similarity metadata is enough.
- **Additionally discovered codebases** — any found in note metadata but not in the prompt (path · referenced-by). Skip if none.
- **Connection map** — how input entities connect through discovered notes / shared codebases / aliases. Skip if none.
- **Enrichment stats** — MCP calls issued, raw vs deduped counts, tier sizes, failed calls.

## Step 6 — Proceed with enriched context

After the brief, hand off to the actual work:

```
Original request:
> [INVESTIGATION_PROMPT — full original text]

Key facts to carry forward:
- [Alias]: "[term]" is also known as "[alias]"
- [Connection]: [Note X] and [Note Y] connect through [relation / shared codebase]
- [Discovery]: [Title] (score N) may hold important context about [topic]
- [Coverage gap]: [N] codebases have no Noesis documentation yet
```

Then continue in the same conversation with full awareness — read the input notes and codebases as needed to fulfill the request. This skill does **not** spawn sub-agents or write anything.

**Follow-up actions:**
- `/noesis-find-related <note ID or path>` — deep-dive one note's relation web, or a codebase's related notes.
- `/noesis-refine-note <note path>` — enrich a discovered note's metadata and formal relations.
- `/noesis-create-study-note <topic or URL>` — turn the investigation into a new structured note.

## Implementation notes
- **Read-only.** Enriches context only — never writes, edits, or syncs.
- **Maximum parallelism.** Step 3 must issue all MCP calls in a single parallel batch.
- **Only input notes get `get_note`.** Discovered notes use search/similarity metadata (title, path, score).
- **Best-effort extraction.** Extract what you can from natural language and proceed; don't over-confirm every entity.
- **`search_by_related_code` path rule:** always a single folder name, no slashes/backslashes.
- **Graceful degradation.** Every enrichment call is optional; works keyword-only when semantic/embeddings are unavailable, and still presents the input entities even if all enrichment fails.
