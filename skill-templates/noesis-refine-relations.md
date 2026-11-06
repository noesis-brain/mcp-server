---
description: Refine the typed relations (Related Notes) of a SET of Noesis notes so the Graph view shows real structure. Scopes by timeframe, topic, catalog or signal — "last two weeks", "notes about BTC", "BTO printing in the last month", "points over 100". Proposes a diff per note and writes only on approval. Use when the user says 'refine relations', 'refine note relations', 'fix my graph', 'link my notes', 'these notes have no relations', or names a batch of notes to connect.
argument-hint: "[recent <N> days|weeks|months] [topic <words>] [catalog <NAME>] [points over <N>] [<note path | note ID | query>]"
---

# /noesis-refine-relations — Batch relation refinement

You are executing `/noesis-refine-relations`. It selects a **set** of notes, works out which
other notes each one should formally link to, shows you the diff, and writes only what you
approve.

Relations live in the Noesis **database**, not in the markdown. This skill therefore never
edits a note body and never needs a sync.

## What this is NOT

The app already has a per-note **"Suggest relations"** in the graph's node menu. It reasons
over ≤20 candidates carrying only a title and a short description — **it never reads note
bodies**, and it runs on one note at a time.

This skill is the complement: many notes at once, and it *reads the content*, so it can find
the links a note states in its own text (cited file paths, note URLs, quoted titles). Where
the in-app suggester is the right tool for one note, say so and stop.

## Step 0 — Route on the argument

The raw arguments string is: `$ARGUMENTS`

First match wins:

| Argument looks like | Mode |
|---|---|
| "last N days/weeks/months", "recent", "this week" | **RECENT** |
| a topic phrase *and* a timeframe | **TOPIC ∩ RECENT** |
| a topic phrase ("about BTC", "BTO printing") | **TOPIC** |
| "points over N", "score above N", "favorite", "pinned", "starred" | **SIGNAL** |
| "catalog X" | **CATALOG** |
| a note ID, a `.md` path, or a bare query | **SINGLE** |
| empty | **ASK** — `AskUserQuestion` offering the modes above |

State the mode and the resolved parameters before doing anything.

## Step 1 — Resolve the note set

- **RECENT** — `mcp__noesis__list_notes(recent: <N_DAYS>, limit: 100)`.
- **TOPIC** — `mcp__noesis__search_semantic(query, limit: 20)` **and**
  `mcp__noesis__search_notes(query, limit: 50)`; union by ID.
- **TOPIC ∩ RECENT** — run both of the above and intersect.
- **SIGNAL** — `list_notes(limit: 100)`, then filter client-side on the `⭐` and `[N pts]`
  markers in the output.
- **CATALOG** — `list_notes(catalog: <NAME>, limit: 100)`.
- **SINGLE** — resolve directly (`get_note` by id/path, or `search_notes` then pick).

Then **always**:

1. **Drop capture notes** — anything under a `captures/` folder is an auto-pushed session
   mirror, not a note the user authored. Never link them unless explicitly asked.
2. **Cap the batch.** Default to 15 notes. If the scope resolved to more, take the 15 most
   recently modified and **say how many you dropped** — never present a truncated sweep as
   a complete one.
3. Print the candidate table (ID, title, path, current relation count) and confirm the set
   before moving on.

### Selection limits you must respect

These are properties of the MCP tools, not preferences:

- `list_notes` caps `limit` at **100** server-side and exposes no offset. A scope wider than
  100 notes cannot be enumerated in one call — narrow it and say so.
- When `recent` is set, `root` and `catalog` are **silently ignored**. Combined filters must
  be applied client-side.
- `list_notes` prints `⭐` and `[N pts]` but **not the note ID**, so resolve IDs from paths
  before writing anything.
- `search_semantic` and `find_similar_notes` need embeddings and fail without a Gemini key.
  Degrade to keyword-only and note it; never abort the run over it.

## Step 2 — Per note: build the proposed set

For each note in the confirmed set, in order:

**2a. Read the current relations.** `mcp__noesis__get_note(id)`. This is the only reliable
read — use it every time, even when you expect none.

**2b. Gather candidates** from seven sources, in one parallel batch where you can. Record,
for every candidate, which sources found it.

| Source | How | Counts as |
|---|---|---|
| S1 body citation | The body scan below | enough alone |
| S2 graph neighbour | `mcp__noesis__get_relation_graph(<each S1 target>, depth: 1)` | topical |
| S3 shared identifier | Ticket IDs (`[A-Z]+-\d+`), PR numbers and distinctive names from the body and keywords; `mcp__noesis__search_notes` for each. A hit counts when the term is in its title, description or keywords | topical |
| S4 topic query | `mcp__noesis__search_semantic` on the note's key lines plus its keywords, **with the template's genre words removed** ("Teams Chat", "meeting", "digest", people's names) | topical |
| S5 shared code | `mcp__noesis__search_by_related_code(<path>)` for each related codebase of the note | corroboration only |
| S6 own embedding | `mcp__noesis__find_similar_notes(note_id, limit: 20)` (captures are left out) | corroboration only |
| S7 reading | `mcp__noesis__get_reading_signals` on every candidate, plus `mcp__noesis__list_most_read_notes(codebase_id)` for each related codebase | lowers the bar only |

`mcp__noesis__update_relations(note_id)` **without** `relations` runs S2, S3, S5, S6 and S7 on
the server and returns ranked candidates with their sources, evidence and reading tier. Use it
as the first batch, then add S1 and S4.

**The body scan — the highest-precision source, and the reason this skill exists.** Read the
note content and extract every note it already cites:
- file paths ending in `.md` (absolute, `~/Noesis/...`, or bare filenames)
- `noesisbrain.com/notes/<id>` URLs — the `<id>` is the target, use it directly
- quoted note titles

Resolve each to an ID with `mcp__noesis__search_notes`. An edge grounded in a line of the
note's own text is worth more than any similarity score; keep the line as evidence.

**Accept rule.** Accept a candidate when S1 found it, or two of S2-S4 found it, or one of S2-S4
found it together with S5, S6 or a **read closely** tier from S7 (5+ own marks, 15+ minutes of
reading, or 3+ separate days). A source alone, S7 included, is never enough: a note the user
read closely about another subject is not related.

**Rank** accepted candidates by the number of sources, then by the S7 reading score, then by
similarity. So, within the cap, the notes the user has read closely come first.

**2c. Filter.** Drop captures, drop the note itself (the MCP write path does **not** reject
self-links), drop anything that fails to resolve. Never invent an ID — if a cited note cannot
be resolved, report it as unresolved rather than guessing.

**2d. Choose a type** per edge, from exactly these five:
`related` · `references` · `implements` · `extends` · `supersedes`.
Default to `references` when the note merely cites the target, `related` when the connection
is thematic.

**2e. Union with the existing set from 2a.** Keep every existing entry unless the user has
explicitly asked to prune. This matters — see the write contract below.

**2f. Apply a cap.** 2–5 relations for a focused note; up to 8 for a comprehensive
architecture, workflow, or strategy note. **Tracker, sprint and index notes are exempt** —
being a hub is their job, and a tracker citing 25 notes should link to 25.

## Step 3 — Propose

Print, per note:

```
Note 2923  BTO 12.3 Aug Sprint 0        edges 0 -> 25
  = keep  references  4424  IDEA-1579 HTTPS support
  + add   references  3611  BPLAT-14016 UltraLite Simple Serialization
          evidence: "my-git/issues/BPLAT-14016-phoenix-tsc-ultralite...md"
  + add   related     2924  Epsilon Branch Merge Convention
          evidence: [S3+S6] shares IDEA-1579; similar 0.81 · read closely: 17 marks, 4 days
  ! unresolved: "support-https-print-portal-investigation.md" (no match)
```

Then ask once, for the whole batch, via `AskUserQuestion`: apply all / pick per note / cancel.
**Never write before this point.**

## Step 4 — Write

For each approved note, issue **exactly one** `mcp__noesis__update_relations` call carrying
the **complete** desired set.

> **The write REPLACES the note's whole relation set.** It clears the column and stores what
> you send. One call per relation — a pattern that exists elsewhere in this repo's older
> commands — leaves the note with only the last relation written and silently deletes the
> rest. Send the union from 2e, always.

No inverse relation is created on the target, and you must not try to write one. Backlinks
are **derived**: the app scans every note's one-way array to build the graph, so a single
edge already shows up on both notes — as "linked to" on the source and "linked by" on the
target. Writing the mirror by hand would double-store derived data and turn every edge into
"mutual", destroying the direction the user can currently see.

Do **not** write a "Related Notes" section into the markdown body. Relations are database
metadata; a section in the file is a stale duplicate. If a previous run left one, remove it.

## Step 5 — Report

A table of note · edges before → after · skipped-and-why, plus every unresolved citation.
Then suggest `mcp__noesis__get_relation_graph(note_id, depth: 1)` or the Graph view to
confirm the shape.

## Implementation notes

- **Read before write, every time.** The write is a replace; skipping 2a loses relations.
- **The body scan is the differentiator.** If you skip it, this skill is just a slower
  version of the in-app suggester.
- **Evidence or no edge.** Every proposed link needs a quoted line from the note, or the
  sources the accept rule asks for. "These feel related" is not a reason, and neither is
  "the user read it a lot".
- **Sequential per note.** Parallel `get_note` batches race the API rate limit; the
  *candidate gathering* inside one note (2b) is the part to parallelize.
- **Report every cap.** A truncated batch, a dropped candidate, an unresolved citation — all
  of it goes in the Step 5 report. A sweep that hides what it skipped is worse than no sweep.
