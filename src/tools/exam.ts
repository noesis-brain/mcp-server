/**
 * Exam creation tool for the md-manager MCP server.
 *
 * Creates a real, DB-backed exam note (fillable answer markers, hidden answer
 * key, gradeable via the app's own grading pipeline) from a hand-authored
 * ExamData object — the same shape the app's AI exam generator produces, so
 * the resulting note is indistinguishable from one created in-app.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NoesisClient } from '../api/NoesisClient.js';
import type { ExamData } from './exam/types.js';

// Top-level shape is strongly typed; sections[].questions[] is intentionally
// loose (z.record(z.any())) rather than re-encoding the 7-question-type
// discriminated union a third time (it already lives in the frontend's
// types.ts and the backend's examDataValidator.ts) — the backend's
// validateExamData is the real gate and feedback loop (a malformed shape
// comes back as a descriptive error with a retry hint, not a silent failure).
const examSectionShape = z.object({
  title: z.string().describe('Section heading, e.g. "Technical Architecture"'),
  instructions: z.string().describe('One-line instructions shown under the section heading'),
  points: z.number().describe('Total points for this section (individual questions do not carry their own point value)'),
  questions: z.array(z.record(z.any())).min(1).describe(
    'Array of question objects. Each needs at minimum {type, id, questionNum}. ' +
    'Supported types: translation {zhPrompt, answerEn}, sentence-completion {sentenceWithBlank, choices[], correctIndex}, ' +
    'vocab-in-context {sentence, underlinedWord, choices[], correctIndex}, multiple-choice {prompt, choices[], correctIndex}, ' +
    'calculation {prompt, answer, acceptedForms?, tolerance?, unit?}, short-answer {prompt, referenceAnswer, rubric?}, ' +
    'fill-in-the-blank {prompt (with "____" placeholders), answer, acceptedForms?}. ' +
    'Question ids must be unique across the whole exam.'
  ),
});

export function registerExamTools(server: McpServer, client: NoesisClient): void {
  // ─── create_exam_note ────────────────────────────────────────
  server.tool(
    'create_exam_note',
    'Create a real, DB-backed exam note — fillable answer-marker boxes at each question, a hidden answer key, and gradeable via the app\'s own grading pipeline (POST /:id/exam/grade). This is the actual "exam" note type the app recognizes (NoteTypeBadge, grading UI) — not just markdown that looks like one. On a malformed examData, returns a descriptive error including a retry hint; fix the shape and call again.',
    {
      title: z.string().describe('Exam title, shown as the note\'s H1 heading'),
      date: z.string().describe('Date string shown under the title, e.g. "2026-07-31"'),
      totalPoints: z.number().describe('Must equal the sum of all sections\' points'),
      sections: z.array(examSectionShape).min(1).describe('At least one section, each with at least one question'),
    },
    async (args) => {
      const examData = args as ExamData;
      const result = await client.createExamFromData(examData);
      const questionCount = Object.keys(result.questionMarks).length;
      return {
        content: [{
          type: 'text',
          text: `Created exam note #${result.noteId}: "${examData.title}" (${examData.totalPoints} points, ${questionCount} question${questionCount === 1 ? '' : 's'} across ${examData.sections.length} section${examData.sections.length === 1 ? '' : 's'}). Fillable answer markers and the hidden answer key are already in place — open the note in the app to answer, then grade via the app's exam UI (or POST /api/notes/${result.noteId}/exam/grade).`
        }]
      };
    }
  );
}
