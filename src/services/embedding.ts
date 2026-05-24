/**
 * Embedding service using Gemini API
 * Generates 768-dimensional vectors for semantic search
 */

import { GoogleGenAI } from '@google/genai';

let genAI: GoogleGenAI | null = null;

/**
 * Initialize the Gemini client
 */
export function initEmbeddingService(apiKey: string): void {
  genAI = new GoogleGenAI({ apiKey });
}

/**
 * Generate embedding for text using Gemini
 * Returns 768-dimensional vector
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  if (!genAI) {
    throw new Error('Embedding service not initialized. Call initEmbeddingService first.');
  }

  // Truncate text if too long (Gemini has token limits)
  const maxChars = 25000; // ~6000 tokens
  const truncatedText = text.length > maxChars
    ? text.substring(0, maxChars) + '...'
    : text;

  const result = await genAI.models.embedContent({
    model: 'gemini-embedding-001',
    contents: truncatedText,
    config: { outputDimensionality: 768 },
  });

  return result.embeddings![0].values!;
}

/**
 * Generate embeddings for multiple texts (batch processing)
 * Includes rate limiting to respect API limits
 */
export async function generateEmbeddingsBatch(
  texts: Array<{ id: number; text: string }>,
  onProgress?: (current: number, total: number, id: number) => void
): Promise<Array<{ id: number; embedding: number[] }>> {
  const results: Array<{ id: number; embedding: number[] }> = [];

  for (let i = 0; i < texts.length; i++) {
    const { id, text } = texts[i];

    try {
      const embedding = await generateEmbedding(text);
      results.push({ id, embedding });

      if (onProgress) {
        onProgress(i + 1, texts.length, id);
      }

      // Rate limiting: ~100ms between requests to stay well under 1500 req/min
      if (i < texts.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } catch (error) {
      console.error(`Error generating embedding for note ${id}:`, error);
      // Continue with other notes
    }
  }

  return results;
}

/**
 * Generated metadata structure
 */
export interface GeneratedMetadata {
  title?: string;
  description?: string;
  keywords?: string[];
}

/**
 * Generate metadata (title, description, keywords) for a document using AI
 * Used during sync when frontmatter metadata is missing
 */
export async function generateMetadata(content: string): Promise<GeneratedMetadata> {
  if (!genAI) {
    throw new Error('AI service not initialized. Call initEmbeddingService first.');
  }

  // Remove existing frontmatter from content for analysis
  let contentToAnalyze = content;
  if (content.startsWith('---')) {
    const endIndex = content.indexOf('---', 3);
    if (endIndex !== -1) {
      contentToAnalyze = content.substring(endIndex + 3).trim();
    }
  }

  // Truncate if too long
  const maxChars = 15000;
  if (contentToAnalyze.length > maxChars) {
    contentToAnalyze = contentToAnalyze.substring(0, maxChars) + '...';
  }

  const prompt = `Analyze this markdown document and generate metadata for it.

Document content:
---
${contentToAnalyze}
---

Generate the following metadata in JSON format:
1. title: A concise, descriptive title (max 80 chars). IMPORTANT: If the document starts with a # heading on the first line, use that FIRST heading as the title (clean it up if needed). Only generate a new title if there's no H1 heading at the start.
2. description: A brief summary of what this document is about (1-2 sentences, max 200 chars)
3. keywords: An array of 5-15 relevant keywords/tags including:
   - Main topics and concepts
   - Technical terms and technologies (Redis, SignalR, MongoDB, etc.)
   - Component/service/class names found in code (e.g., PrintController, BtXmlExecutor, DevicesInternalController)
   - Include BOTH CamelCase (PrintController) AND space-separated (Print Controller) versions of component names
   - API endpoint patterns or route names if mentioned
   Avoid generic words like "document", "file", "note", "example", "sample".

Respond with ONLY valid JSON in this exact format, no markdown code blocks:
{"title": "...", "description": "...", "keywords": ["...", "..."]}`;

  try {
    const result = await genAI.models.generateContent({
      model: 'gemini-1.5-flash',
      contents: prompt,
    });
    const responseText = (result.text ?? '').trim();

    // Parse JSON response (handle potential markdown code blocks)
    let jsonStr = responseText;
    if (jsonStr.startsWith('```')) {
      // Remove markdown code blocks
      jsonStr = jsonStr.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    }

    const parsed = JSON.parse(jsonStr);

    return {
      title: typeof parsed.title === 'string' ? parsed.title.substring(0, 100) : undefined,
      description: typeof parsed.description === 'string' ? parsed.description.substring(0, 300) : undefined,
      keywords: Array.isArray(parsed.keywords)
        ? parsed.keywords.filter((k: any) => typeof k === 'string').slice(0, 20)
        : undefined
    };
  } catch (error) {
    console.error('Error generating metadata:', error);
    return {};
  }
}
