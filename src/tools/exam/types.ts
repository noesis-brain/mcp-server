/**
 * ExamData shape accepted by the backend's POST /api/notes/from-exam.
 *
 * Ported from the frontend repo's
 * src/frontend/src/components/Chat/tools/exam/types.ts — kept as a verbatim
 * copy (zero external imports there, so this is safe) rather than shared via
 * a package, since the MCP server is a separate git repo/npm package with no
 * dependency path to the frontend. Keep in sync by hand if the frontend
 * shape changes; the backend's validateExamData
 * (src/backend/services/examSources/examDataValidator.ts) is the real,
 * authoritative gate either way.
 */

export interface TranslationQuestion {
  type: 'translation';
  id: string;
  questionNum: number;
  zhPrompt: string;
  answerEn: string;
  sourceWord?: string;
}

export interface SentenceCompletionQuestion {
  type: 'sentence-completion';
  id: string;
  questionNum: number;
  sentenceWithBlank: string;
  choices: string[];
  correctIndex: number;
  sourceWord?: string;
}

export interface VocabInContextQuestion {
  type: 'vocab-in-context';
  id: string;
  questionNum: number;
  sentence: string;
  underlinedWord: string;
  choices: string[];
  correctIndex: number;
  sourceWord?: string;
}

export interface MultipleChoiceQuestion {
  type: 'multiple-choice';
  id: string;
  questionNum: number;
  prompt: string;
  choices: string[];
  correctIndex: number;
  explanation?: string;
}

export interface CalculationQuestion {
  type: 'calculation';
  id: string;
  questionNum: number;
  prompt: string;
  answer: string;
  acceptedForms?: string[];
  tolerance?: number;
  unit?: string;
  explanation?: string;
}

export interface ShortAnswerQuestion {
  type: 'short-answer';
  id: string;
  questionNum: number;
  prompt: string;
  referenceAnswer: string;
  rubric?: string;
}

export interface FillInBlankQuestion {
  type: 'fill-in-the-blank';
  id: string;
  questionNum: number;
  prompt: string;
  answer: string;
  acceptedForms?: string[];
}

export type ExamQuestion =
  | TranslationQuestion
  | SentenceCompletionQuestion
  | VocabInContextQuestion
  | MultipleChoiceQuestion
  | CalculationQuestion
  | ShortAnswerQuestion
  | FillInBlankQuestion;

export interface ExamSection {
  title: string;
  instructions: string;
  points: number;
  questions: ExamQuestion[];
}

export interface ExamData {
  title: string;
  date: string;
  sections: ExamSection[];
  totalPoints: number;
}
