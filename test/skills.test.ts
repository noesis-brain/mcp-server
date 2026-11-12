import { describe, it, expect } from 'vitest';
import { parseSkillFile, toSkillName } from '../src/tools/skills.js';

/**
 * TCK-1894 — upsert_skill reads a Claude Code command file: frontmatter description and
 * argument-hint, the body after the frontmatter, and a name from the file name.
 */
describe('parseSkillFile', () => {
  it('reads the frontmatter fields and the body; the name comes from the file', () => {
    const text = '---\ndescription: Turn the chat into a note\nargument-hint: "[focus]"\n---\n\n# Rules\nTakeaway first.\n';
    expect(parseSkillFile('/Users/x/.claude/commands/cc-session-note.md', text)).toEqual({
      name: 'cc-session-note',
      description: 'Turn the chat into a note',
      argument_hint: '[focus]',
      body_md: '# Rules\nTakeaway first.\n',
    });
  });

  it('accepts an unquoted [focus] (a YAML list), a frontmatter name, and CRLF', () => {
    const text = '---\r\nname: Session Note\r\nargument-hint: [focus]\r\n---\r\nBody\r\n';
    const p = parseSkillFile('x.md', text);
    expect(p.name).toBe('session-note');
    expect(p.argument_hint).toBe('[focus]');
    expect(p.body_md).toBe('Body\n');
  });

  it('treats a file without frontmatter as all body', () => {
    expect(parseSkillFile('Recap.md', 'Just recap.').body_md).toBe('Just recap.\n');
  });

  it('keeps every field when a line is not strict YAML (colon in the value, several brackets)', () => {
    const text = '---\ndescription: Review code: find bugs\nargument-hint: [pr-number] [priority] [assignee]\n---\nBody\n';
    const p = parseSkillFile('review.md', text);
    expect(p.description).toBe('Review code: find bugs');
    expect(p.argument_hint).toBe('[pr-number] [priority] [assignee]');
    expect(p.body_md).toBe('Body\n');
    const unclosed = parseSkillFile('b.md', '---\ndescription: [unclosed\n---\nStill read\n');
    expect(unclosed.description).toBe('[unclosed');
    expect(unclosed.body_md).toBe('Still read\n');
  });
});

describe('toSkillName', () => {
  it('lowercases and replaces characters a skill name cannot hold', () => {
    expect(toSkillName('CC Session Note.md')).toBe('cc-session-note');
    expect(toSkillName('/cc-x')).toBe('cc-x');
  });
});
