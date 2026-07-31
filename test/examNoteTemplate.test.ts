import { describe, it, expect } from 'vitest';
import { buildExamMarkdown, buildAnchorText } from '../src/tools/exam/examNoteTemplate.js';
import type { ExamData } from '../src/tools/exam/types.js';

/**
 * Pure-function tests for the ported exam renderer. This is a verbatim copy
 * of the frontend's buildExamMarkdown/buildAnchorText — the point of these
 * tests is to catch drift early: every anchor these functions emit MUST be
 * findable via a literal indexOf() in the markdown they also emit, because
 * the backend's POST /api/notes/from-exam throws mid-transaction on any
 * mismatch (see examNotes.ts's own header comment on buildAnchorText).
 */
describe('buildAnchorText', () => {
  it('builds a plain answer anchor with no blank index', () => {
    expect(buildAnchorText('sa-1')).toBe('Answer sa-1:');
  });

  it('builds a 1-based blank-indexed anchor', () => {
    expect(buildAnchorText('fb-1', 1)).toBe('Answer fb-1.1:');
    expect(buildAnchorText('fb-1', 2)).toBe('Answer fb-1.2:');
  });

  it('ignores a zero or negative blank index (treated as no index)', () => {
    expect(buildAnchorText('fb-1', 0)).toBe('Answer fb-1:');
  });
});

describe('buildExamMarkdown', () => {
  it('renders the header with title, date, totalPoints, and a Name/Score line', () => {
    const examData: ExamData = {
      title: 'Sample Exam',
      date: '2026-07-31',
      totalPoints: 5,
      sections: [
        {
          title: 'Section I',
          instructions: 'Answer the question.',
          points: 5,
          questions: [
            { type: 'short-answer', id: 'sa-1', questionNum: 1, prompt: 'What is 2+2?', referenceAnswer: '4' },
          ],
        },
      ],
    };
    const { markdown, anchors } = buildExamMarkdown(examData);

    expect(markdown).toContain('# Sample Exam');
    expect(markdown).toContain('2026-07-31 — 5 points total');
    expect(markdown).toContain('**Name:**');
    expect(markdown).toContain('**Score:** _______ / 5');
    expect(markdown).toContain('## I. Section I (5 points)');

    expect(anchors).toEqual([{ id: 'sa-1', anchorText: 'Answer sa-1:' }]);
    for (const a of anchors) {
      expect(markdown.indexOf(a.anchorText)).not.toBe(-1);
    }
  });

  it('finds every anchor for a mix of all 7 question types', () => {
    const examData: ExamData = {
      title: 'All Types',
      date: '2026-07-31',
      totalPoints: 7,
      sections: [
        {
          title: 'Mixed',
          instructions: 'One of each.',
          points: 7,
          questions: [
            { type: 'translation', id: 't-1', questionNum: 1, zhPrompt: '你好', answerEn: 'Hello' },
            { type: 'sentence-completion', id: 'sc-1', questionNum: 2, sentenceWithBlank: 'I ___ happy.', choices: ['am', 'is'], correctIndex: 0 },
            { type: 'vocab-in-context', id: 'vc-1', questionNum: 3, sentence: 'The cat sat.', underlinedWord: 'cat', choices: ['animal', 'vehicle'], correctIndex: 0 },
            { type: 'multiple-choice', id: 'mc-1', questionNum: 4, prompt: 'Pick one.', choices: ['A', 'B'], correctIndex: 1 },
            { type: 'calculation', id: 'calc-1', questionNum: 5, prompt: '1+1?', answer: '2' },
            { type: 'short-answer', id: 'sa-1', questionNum: 6, prompt: 'Explain.', referenceAnswer: 'Because.' },
            { type: 'fill-in-the-blank', id: 'fb-1', questionNum: 7, prompt: 'The sky is ____.', answer: 'blue' },
          ],
        },
      ],
    };
    const { markdown, anchors } = buildExamMarkdown(examData);
    expect(anchors).toHaveLength(7);
    for (const a of anchors) {
      expect(markdown.indexOf(a.anchorText)).not.toBe(-1);
    }
  });

  it('produces N correctly 1-based-indexed anchors for a multi-blank fill-in-the-blank question', () => {
    const examData: ExamData = {
      title: 'Multi-blank',
      date: '2026-07-31',
      totalPoints: 3,
      sections: [
        {
          title: 'Section I',
          instructions: 'Fill in all blanks.',
          points: 3,
          questions: [
            { type: 'fill-in-the-blank', id: 'fb-1', questionNum: 1, prompt: 'The ___ jumped over the ___ and landed near the ___.', answer: 'fox, fence, barn' },
          ],
        },
      ],
    };
    const { markdown, anchors } = buildExamMarkdown(examData);

    expect(anchors).toEqual([
      { id: 'fb-1', anchorText: 'Answer fb-1.1:', blankIndex: 1 },
      { id: 'fb-1', anchorText: 'Answer fb-1.2:', blankIndex: 2 },
      { id: 'fb-1', anchorText: 'Answer fb-1.3:', blankIndex: 3 },
    ]);
    for (const a of anchors) {
      expect(markdown.indexOf(a.anchorText)).not.toBe(-1);
    }
  });

  it('joins multiple sections with a horizontal rule and numbers them with roman numerals', () => {
    const examData: ExamData = {
      title: 'Two Sections',
      date: '2026-07-31',
      totalPoints: 2,
      sections: [
        { title: 'First', instructions: 'A', points: 1, questions: [{ type: 'short-answer', id: 'sa-1', questionNum: 1, prompt: 'Q1', referenceAnswer: 'A1' }] },
        { title: 'Second', instructions: 'B', points: 1, questions: [{ type: 'short-answer', id: 'sa-2', questionNum: 2, prompt: 'Q2', referenceAnswer: 'A2' }] },
      ],
    };
    const { markdown } = buildExamMarkdown(examData);
    expect(markdown).toContain('## I. First (1 point)');
    expect(markdown).toContain('## II. Second (1 point)');
    expect(markdown).toContain('\n\n---\n\n');
  });
});
