import { describe, it, expect } from 'vitest';
import { splitFrontmatter, parseMarkdownStructure, mergeContent, updateFrontmatter } from '../src/tools/index.js';

/**
 * Regression tests for the sync frontmatter/merge helpers.
 *
 * The original bug: parseMarkdownStructure used /^(#\s+.+?)(\r?\n|$)/m, whose /m flag
 * matched a `# ...` line INSIDE a fenced code block (e.g. a shell comment) and dropped
 * every line above it. On the sync push path that truncated notes to ~10% and made
 * updateFrontmatter prepend a second `---...---` block. (Corrupted real note 2864.)
 */
describe('markdown sync helpers', () => {
  it('does not treat a "# comment" inside a code fence as the note H1 (regression: note 2864)', () => {
    const note = [
      '## Table of Contents',
      '',
      '- [Summary](#summary)',
      '',
      '## Summary',
      '',
      'Some analysis before the code block.',
      '',
      '```bash',
      '# genuine SYNs = TTL 124, injected RSTs = TTL 62, same source IP',
      'tshark -r cap.pcapng',
      '```',
      '',
      '## Conclusion',
      'The end.',
      '',
    ].join('\n');

    // The shell comment must NOT be picked up as the note H1.
    const struct = parseMarkdownStructure(note);
    expect(struct.h1).toBeNull();
    expect(struct.body).toContain('## Table of Contents');
    expect(struct.body).toContain('## Conclusion');

    // Full sync push path: merge against self, then enrich with cloud metadata.
    const merged = mergeContent(note, note);
    const enriched = updateFrontmatter(merged, {
      title: 'My Note',
      description: 'desc',
      keywords: ['a', 'b'],
    });

    // Every original section survives (no 75% truncation).
    for (const marker of [
      '## Table of Contents',
      '## Summary',
      'Some analysis before the code block.',
      '# genuine SYNs = TTL 124',
      '## Conclusion',
    ]) {
      expect(enriched).toContain(marker);
    }
    expect(enriched.length).toBeGreaterThan(note.length); // grew by frontmatter, not shrank

    // Exactly one frontmatter block at the very top — no embedded/duplicated block.
    const s = splitFrontmatter(enriched);
    expect(s.inner).toContain('title: My Note');
    expect(s.body).not.toMatch(/^---/);
    expect(s.body).toContain('## Table of Contents');
  });

  it('splitFrontmatter is line-anchored (ignores --- inside a value or the body)', () => {
    const withDashInValue = '---\ntitle: a--b---c\ndescription: x\n---\n# Body\ncontent';
    const s = splitFrontmatter(withDashInValue);
    expect(s.inner).toContain('title: a--b---c');
    expect(s.body.startsWith('# Body')).toBe(true);

    // A '----' thematic break in a note WITHOUT frontmatter is not treated as frontmatter.
    const noFm = '# Title\n\nsome text\n\n----\n\nmore text';
    const s2 = splitFrontmatter(noFm);
    expect(s2.raw).toBe('');
    expect(s2.body).toBe(noFm);
  });

  it('preserves a genuine leading H1 and round-trips a normal note without loss', () => {
    const note = '# Real Title\n\nbody paragraph\n\n## Section\ntext';
    const struct = parseMarkdownStructure(note);
    expect(struct.h1).toBe('# Real Title');
    const merged = mergeContent(note, note);
    expect(merged).toContain('# Real Title');
    expect(merged).toContain('## Section');
    expect(merged).toContain('body paragraph');
  });

  it('updates existing frontmatter in place without dropping body', () => {
    const note = '---\ntitle: Old\nkeywords:\n  - x\n---\n## Heading\nbody line 1\nbody line 2';
    const updated = updateFrontmatter(note, { title: 'New', keywords: ['y', 'z'] });
    expect(updated).toContain('title: New');
    // js-yaml quotes the bare 'y' (YAML 1.1 boolean-like token) to keep it a string on re-parse.
    expect(updated).toContain("- 'y'");
    expect(updated).toContain('## Heading');
    expect(updated).toContain('body line 1');
    expect(updated).toContain('body line 2');
    expect(updated.startsWith('---\n')).toBe(true);
    expect(splitFrontmatter(updated).body).not.toMatch(/^---/);
  });
});
