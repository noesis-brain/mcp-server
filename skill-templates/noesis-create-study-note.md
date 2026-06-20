---
description: "Research a URL or topic from the web and create a polished Noesis study note with structural diagrams, then refine its metadata and sync to the cloud. Use when the user says 'create study note', 'study note from <url>', 'make a note about', 'note from this video/article/URL', or 'summarize this link into a note'."
---

Research a source from the web and turn it into a well-structured Noesis study note: fetch and corroborate the material, author accurate prose with proper ASCII diagrams, then fill metadata, link it into your knowledge base, and sync to the cloud. Works from a URL (video, article, docs) or a plain topic.

This skill is self-contained — it embeds the note-structure and diagram rules below, so it does not depend on any local reference files or external scripts.

## Arguments

$ARGUMENTS

Accepted forms:

- `<url>` — research this page / video / article and build a note from it. Extra URLs after the first are treated as additional sources.
- `<topic>` or `"quoted title"` — research the topic from scratch (no URL).
- `--path <file.md>` — explicit output path. Otherwise a path is derived under a registered Noesis root.
- `--type reference|procedure|investigation|architecture|strategy` — force the content type. Otherwise it is classified.
- `--catalog <name>` — force a catalog assignment.
- `--no-sync` — author locally but do not push to the Noesis cloud.
- `--no-refine` — skip the `/noesis-refine-note` hand-off (just author, enrich, and sync).

## Workflow

### Step 1 — Parse

Detect URL vs topic; extract the flags above and remove them from the subject string. If the subject is empty, ask the user what URL or topic to create a note about, then stop until answered.

### Step 2 — Research (never write from memory)

1. **Fetch the primary URL** with `WebFetch`, asking for title, author/date, and a full content summary.
   - **YouTube / JS-page caveat:** a `youtube.com/watch` page (or any JS-heavy page) fetched via `WebFetch` usually returns only nav/footer chrome — no transcript or description. When the result is thin, do not give up: use the title as a search seed and rely on the next two sub-steps.
2. **Web-search** with 2–4 `WebSearch` queries (exact title, product/feature name, "official docs", "announcement"/"release", a how-it-works phrasing) to find the authoritative primary sources and corroborate facts.
3. **Fetch the top 2–3 primary sources** (official docs, the vendor's own announcement, a reputable deep-dive) with `WebFetch`. Prefer primary over aggregators. Skip any source that returns 403/blocked — do not retry endlessly.
4. **Build a fact sheet**: the 1-line "what it is", the problem it solves, key mechanics/constraints/requirements, dates/versions, and the **Sources** list (every URL you actually used). Resolve contradictions across sources before writing; if a genuine disagreement cannot be resolved, state it in the note rather than picking silently.

### Step 3 — Plan

- **Classify** the content type (default `reference` for a feature/concept/talk explainer; `procedure` for a how-to; `investigation` for a bug study; `architecture` for system design; `strategy` for a decision).
- **Derive identity**: a descriptive title; a 1–2 sentence description (anchor a date/version if time-bound); 6–12 keywords; 3–5 aliases (alternative names / query phrasings).
- **Derive the path** (unless `--path`): `lowercase-hyphenated-title.md`, punctuation stripped, placed in a registered Noesis root. Call `mcp__noesis__list_roots` and pick a writable root (prefer one ending in `/.noesis` or the `~/Noesis` cloud root). Use today's date (absolute `YYYY-MM-DD`) for `date`/`updated`.
- **Plan sections** from the content-type table (see rules below); always lead with an Overview. **Plan diagrams** per the trigger checklist and the density tier.

### Step 4 — Author the note (one pass)

Compose the **entire** note — frontmatter + H1 + TOC + all prose + all diagrams — and `Write` it in a single pass.

- **Never** retro-fit diagrams by bulk-replacing fenced blocks in an already-written file: ` ```text ` / ` ```markdown ` fences mis-pair against plain ` ``` ` fences and corrupt the document. Author the whole file at once, or insert via anchored string replacement on a unique heading.
- Author framed / nested / multi-column / sequence diagrams with the **coordinate-grid generator** (below) so columns are guaranteed to align. Trees (`├── └──`) and tiny 2–3 box flows may be authored inline.

### Step 5 — Verify diagrams

Re-read every fenced diagram and confirm: ASCII-only inside the fence, right walls aligned, no Unicode arrows (`→ ← ↑ ↓`), no `│` glitches, no trailing spaces. Fix drift by **regenerating** that diagram with the grid script — not by hand-patching columns. If a diagram will not converge after a few tries, surface it rather than claiming success.

### Step 6 — Refine metadata + sync (delegate)

Unless `--no-refine`, invoke the **`/noesis-refine-note`** skill on the new file by passing just its path (this runs it in single-note mode):

```
/noesis-refine-note <NOTE_PATH>
```

That fills missing metadata, refreshes the AI quality/importance scores, and pushes the note to the Noesis cloud. Do not duplicate that logic here.

If `--no-refine`: push the note yourself with `mcp__noesis__sync_notes(files: ["<NOTE_PATH>"])`, unless `--no-sync`.

### Step 7 — Link it into the knowledge base (this skill)

`/noesis-refine-note` does not assign catalogs or create relations, so do those here:

1. Get the note id and current cloud metadata: `mcp__noesis__get_note(path: "<NOTE_PATH>")`.
2. **Persist aliases/keywords** (frontmatter-only additions do not stick in the cloud fields): `mcp__noesis__enhance_note_metadata(note_id, apply_suggestions: { aliases: [...], keywords: [...] })` with your authored values.
3. **Catalogs**: `mcp__noesis__list_catalogs`, then assign up to 2 confident best-fit catalogs via `mcp__noesis__set_note_catalogs` (honor `--catalog`). Skip if nothing fits.
4. **Relations**: `mcp__noesis__find_similar_notes(note_id)` (optionally also `mcp__noesis__search_semantic`); create 2–5 genuinely meaningful bidirectional links via `mcp__noesis__update_relations`. Reject weak / generic-vocabulary matches — the cap is a ceiling, not a target.

### Step 8 — Report

```
=== STUDY NOTE CREATED ===
Path:      <NOTE_PATH>
Type:      <content type>
Sections:  <N primary> | TOC links verified
Diagrams:  <N> (<types>) — alignment verified
Sources:   <count> (primary: <url>)
Catalogs:  <list>   Relations: <count>
Synced:    <yes | skipped (--no-sync)>
```

Remind the user to **check the diagram rendering** in their markdown viewer (box-drawing alignment) before relying on the note.

---

## Note structure rules (inlined)

- **Frontmatter** (YAML between `---`): `title`, `description`, `keywords` (list), `aliases` (list), `date`, `updated` (`YYYY-MM-DD`), `status` (`active`/`draft`/`completed`). Only add fields with real values.
- **Headings**: exactly one H1 = the title. Major sections are H2. Use **plain `##`** for primary sections (Noesis builds its sidebar outline from them). Reserve collapsible `<details><summary>…</summary>` for noise (raw logs, long tables, references, appendix); put an `id="<slug>"` on a `<summary>` only if you link to it from the TOC.
- **Table of Contents**: if there are 4+ primary sections, add a standalone `## Table of Contents` immediately below the H1, listing each primary section as `- [Title](#slug)`. Compute slugs GitHub-style: lowercase, strip punctuation (keep `-`/`_`/space), spaces → `-`, collapse repeats. Verify every link resolves.
- **Content-type sections**: reference → Overview, (Problem It Solves), What It Is, How It Works, core mechanics, Constraints, Availability; procedure → Overview, Prerequisites, Steps, Verification; investigation → Overview, Symptoms, Root Cause, Fix, Verification; architecture → Overview, Components, Data Flow, Key Decisions; strategy → Overview, Context, Recommendation, Action Plan, Risks. Only include sections you have content for.
- **No emojis** in headings or `<summary>` tags.
- **Do not** write "Related Notes" / "Related Codebase" sections into the file — those are database metadata (Step 7).
- End with a `<details><summary>Sources</summary>…</summary>` appendix listing the URLs used.

## Diagram rules (inlined)

- **ASCII is the default** — author diagrams in an untagged fenced code block. Reserve Mermaid (```` ```mermaid ````) for small (≤10 nodes), balanced decision/hierarchy graphs.
- **Density** scales with the note: 1–2 diagrams for a short note (≤4 sections), 3–5 for a moderate note (5–7), **6–10 for a complex reference/architecture note** (8+ sections).
- **Quality bar**: ≥5 elements per diagram (a 3-box A→B→C is a sentence, not a diagram); when a note has 4+ diagrams they must span **≥3 distinct types** from {workflow, component, sequence, state, tree, data-flow, comparison}; every branching diagram labels its secondary/error/HALT path; sequence diagrams show **response** messages, not just requests; component/data-flow diagrams show at least one **labeled direction** arrow.
- **ASCII-only inside fences**: use box-drawing `─ │ ┌ ┐ └ ┘ ┬ ┴ ├ ┤ ┼` for frames and plain-ASCII markers `> < v ^` for arrows. **Never** use Unicode arrows `→ ← ↑ ↓` inside a fence — editors using Consolas/Courier fall back to a CJK font for them and render at 2 cells wide, breaking column alignment. (Unicode arrows are fine in prose, headings, and tables.)
- **Type → shape**: workflow/procedure → boxes + branch points; architecture/services → nested boxes with data-flow arrows; request/response → sequence (vertical lifelines, horizontal labeled arrows); lifecycle/status → state boxes + labeled transitions; hierarchy → `├── └──` tree; pipeline → boxes with typed arrows.

## Diagram grid generator (alignment technique)

Hand-drawn box/framed/sequence ASCII almost always drifts (misaligned right walls, trailing spaces, skewed nested boxes). Generate those diagrams with a small Python coordinate grid that places every wall at a fixed column. Write this to a throwaway script, build each diagram, have the script assemble the whole note (interpolating the rendered diagrams into the prose), then run it to write the file:

```python
class Grid:
    def __init__(self, w, h): self.g = [[" "]*w for _ in range(h)]
    def put(self, r, c, s):
        for i, ch in enumerate(s): self.g[r][c+i] = ch
    def box(self, r, c, w, h, lines):
        self.put(r, c, "┌"+"─"*(w-2)+"┐"); self.put(r+h-1, c, "└"+"─"*(w-2)+"┘")
        for i in range(1, h-1): self.put(r+i, c, "│"); self.put(r+i, c+w-1, "│")
        for i, ln in enumerate(lines): self.put(r+1+i, c+2, ln)
    def render(self):
        rows = ["".join(row).rstrip() for row in self.g]
        while rows and rows[-1] == "": rows.pop()
        return "\n".join(rows)
```

Guidance:

- Place boxes at fixed `(row, col)`; connect them with arrows in the gutters between boxes — keep each box's text shorter than its inner width so it never overwrites the right wall.
- Write the file with `encoding="utf-8", newline="\n"`. Do **not** `print()` box-drawing to a Windows console (cp1252 will crash) — write to the file and read it back to verify.
- Delete the throwaway script when done if it sits inside a Noesis-watched folder.

## Constraints

- **Accuracy over volume.** Ground every claim in a fetched source; cite what you used; resolve contradictions before writing.
- **One-pass authoring.** Never bulk-replace fenced blocks in an existing file — it desyncs on `text`/`markdown` fences.
- **Self-contained.** Do not reference machine-specific files (e.g. `~/.claude/...`) or external scripts; the rules and the grid technique above are everything you need.
- **Stay inside a registered Noesis root** so `mcp__noesis__sync_notes` works. Confirm with `mcp__noesis__list_roots`.
- **Delegate metadata/scores/sync** to `/noesis-refine-note`; this skill owns research, authoring, diagrams, catalogs, and relations.

## Examples

- `/noesis-create-study-note https://www.youtube.com/watch?v=XXXX` — research a video and build a note.
- `/noesis-create-study-note "Event sourcing vs CRUD" --type architecture` — research a topic from scratch.
- `/noesis-create-study-note https://example.com/post --catalog Work` — force a catalog.
- `/noesis-create-study-note https://example.com/post --no-refine --no-sync` — author locally only.
