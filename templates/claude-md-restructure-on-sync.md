### Restructuring notes that grew by accretion (optional)
Before syncing a note that shows the **accretion smell** — bolt-on sections (e.g. "a later round of testing exposed a case sections 1–7 didn't cover"), duplicated passages re-explaining the same point under different headings, or a chronological log of patches — do NOT push the sprawl as-is, and do NOT just append another section. Notes that grow by accretion become hard to study.

Restructure first:
1. Read the FULL current note (`mcp__noesis__get_note` or the local file) so you preserve the substance — diagrams, inventories, code snippets, instrumentation, repro tables.
2. Reorganize into ONE coherent narrative led by the **root cause / main finding**, not by chronology: Context & Symptom → Root Cause → supporting detail → inventory/appendix.
3. Merge the duplicated sections; fold each bolted-on "later round" addition into the section it belongs to. Revise the existing section rather than adding a new one.
4. Then sync, and briefly say which notes you restructured — never rewrite a note body silently.

This deliberately permits **body rewrites** on sync — broader than `/noesis-refine-note`, which only touches metadata and headings. You are reorganizing for clarity, not deleting content: preserve every fact, diagram, and snippet.
