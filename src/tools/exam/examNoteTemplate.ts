/**
 * Ported from the frontend repo's
 * src/frontend/src/components/Chat/tools/exam/examNoteTemplate.ts — kept as a
 * verbatim copy (pure functions, zero external deps) rather than shared via a
 * package, since the MCP server is a separate git repo/npm package with no
 * dependency path to the frontend.
 *
 * buildAnchorText MUST stay identical to the frontend's version AND the
 * backend's own copy (src/backend/routes/examNotes.ts) — all three derive the
 * anchor strings embedded in / expected from the markdown, and the backend
 * throws mid-transaction (rolled back) on any mismatch. If the frontend's
 * template changes, update this file and confirm the backend's copy still
 * agrees.
 */
import type {
  ExamData,
  ExamSection,
  TranslationQuestion,
  SentenceCompletionQuestion,
  VocabInContextQuestion,
  MultipleChoiceQuestion,
  CalculationQuestion,
  ShortAnswerQuestion,
  FillInBlankQuestion,
  ExamQuestion,
} from './types.js';

const CHOICE_LABELS = ['A', 'B', 'C', 'D', 'E', 'F'];
const ROMAN = ['I', 'II', 'III', 'IV', 'V'];

export function buildAnchorText(questionId: string, blankIndex?: number): string {
  if (typeof blankIndex === 'number' && blankIndex > 0) {
    return `Answer ${questionId}.${blankIndex}:`;
  }
  return `Answer ${questionId}:`;
}

function renderQuestion(q: ExamQuestion): string {
  switch (q.type) {
    case 'translation':
      return renderTranslation(q);
    case 'sentence-completion':
      return renderSentenceCompletion(q);
    case 'vocab-in-context':
      return renderVocabInContext(q);
    case 'multiple-choice':
      return renderMultipleChoice(q);
    case 'calculation':
      return renderCalculation(q);
    case 'short-answer':
      return renderShortAnswer(q);
    case 'fill-in-the-blank':
      return renderFillInBlank(q);
  }
}

function renderTranslation(q: TranslationQuestion): string {
  return `**${q.questionNum}.** ${q.zhPrompt}\n\n> **${buildAnchorText(q.id)}** _______________________`;
}

function renderSentenceCompletion(q: SentenceCompletionQuestion): string {
  const choices = q.choices
    .map((c, i) => `- (${CHOICE_LABELS[i]}) ${c}`)
    .join('\n');
  return `**${q.questionNum}.** ${q.sentenceWithBlank}\n\n${choices}\n\n> **${buildAnchorText(q.id)}** _ (A/B/C/D)`;
}

function renderVocabInContext(q: VocabInContextQuestion): string {
  const sentence = q.sentence.replace(
    new RegExp(`\\b${q.underlinedWord.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'),
    (match) => `<u>${match}</u>`
  );
  const choices = q.choices
    .map((c, i) => `- (${CHOICE_LABELS[i]}) ${c}`)
    .join('\n');
  return `**${q.questionNum}.** ${sentence}\n\n*The underlined word is closest in meaning to:*\n\n${choices}\n\n> **${buildAnchorText(q.id)}** _ (A/B/C/D)`;
}

function renderMultipleChoice(q: MultipleChoiceQuestion): string {
  const choices = q.choices
    .map((c, i) => `- (${CHOICE_LABELS[i]}) ${c}`)
    .join('\n');
  const letterHint = q.choices
    .map((_, i) => CHOICE_LABELS[i])
    .filter(Boolean)
    .join('/');
  return `**${q.questionNum}.** ${q.prompt}\n\n${choices}\n\n> **${buildAnchorText(q.id)}** _ (${letterHint})`;
}

function renderCalculation(q: CalculationQuestion): string {
  const unitHint = q.unit ? ` ${q.unit}` : '';
  return `**${q.questionNum}.** ${q.prompt}\n\n> **${buildAnchorText(q.id)}** _______________________${unitHint}`;
}

function renderShortAnswer(q: ShortAnswerQuestion): string {
  return `**${q.questionNum}.** ${q.prompt}\n\n> **${buildAnchorText(q.id)}** _______________________`;
}

function renderFillInBlank(q: FillInBlankQuestion): string {
  const blankCount = countBlanks(q.prompt);
  if (blankCount <= 1) {
    return `**${q.questionNum}.** ${q.prompt}\n\n> **${buildAnchorText(q.id)}** _______________________`;
  }
  const answerLines = Array.from({ length: blankCount }, (_, i) => {
    const oneBased = i + 1;
    return `> **${buildAnchorText(q.id, oneBased)}** _______________________`;
  }).join('\n');
  return `**${q.questionNum}.** ${q.prompt}\n\n${answerLines}`;
}

function countBlanks(prompt: string): number {
  return (prompt.match(/_{3,}/g) ?? []).length;
}

function renderSection(section: ExamSection, sectionNum: number): string {
  const numeral = ROMAN[sectionNum - 1] || String(sectionNum);
  const pointsLabel = `${section.points} point${section.points !== 1 ? 's' : ''}`;
  const body = section.questions.map(renderQuestion).join('\n\n');
  return `## ${numeral}. ${section.title} (${pointsLabel})\n\n*${section.instructions}*\n\n${body}`;
}

/**
 * Build the markdown representation of an exam for storage as a note, plus
 * the anchor list the backend needs to pre-create one text_note marker per
 * question. Mirrors the frontend's buildExamMarkdown exactly (no
 * referenceImageDataUri support here — that's an AI-generated-source feature
 * not needed for hand-authored exams created via create_exam_note).
 */
export function buildExamMarkdown(
  examData: ExamData
): {
  markdown: string;
  anchors: Array<{ id: string; anchorText: string; blankIndex?: number }>;
} {
  const header = `# ${examData.title}\n\n*${examData.date} — ${examData.totalPoints} points total*\n\n**Name:** _________________________   **Score:** _______ / ${examData.totalPoints}`;

  const sectionsMd = examData.sections
    .map((section, i) => renderSection(section, i + 1))
    .join('\n\n---\n\n');

  const markdown = `${header}\n\n---\n\n${sectionsMd}\n`;

  const anchors: Array<{ id: string; anchorText: string; blankIndex?: number }> = [];
  for (const section of examData.sections) {
    for (const q of section.questions) {
      if (q.type === 'fill-in-the-blank') {
        const blanks = countBlanks(q.prompt);
        if (blanks > 1) {
          for (let i = 1; i <= blanks; i++) {
            anchors.push({ id: q.id, anchorText: buildAnchorText(q.id, i), blankIndex: i });
          }
          continue;
        }
      }
      anchors.push({ id: q.id, anchorText: buildAnchorText(q.id) });
    }
  }

  return { markdown, anchors };
}
