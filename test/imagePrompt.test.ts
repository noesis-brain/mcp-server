import { describe, it, expect } from 'vitest';
import { buildSdkPrompt, buildImageContent, singleUserMessage } from '../src/agent/runner.js';

/**
 * Pins the daemon's half of picture recognition: without this, the model never
 * received image bytes at all, even when the enqueue succeeded — only a plain
 * text string ever reached sdk.query(). The shape here (session_id: '',
 * parent_tool_use_id: null, message.content as an array) was verified directly
 * against the shipped SDK (@anthropic-ai/claude-agent-sdk@0.1.77, sdk.mjs): it is
 * exactly what query()'s own string branch constructs internally before writing
 * it to the transport, not an invented shape.
 */
describe('buildSdkPrompt — chooses string vs multimodal based on images', () => {
  it('no images: returns the plain string, unchanged', () => {
    const result = buildSdkPrompt('hello', undefined);
    expect(result).toBe('hello');
  });

  it('empty images array: still the plain string (not an empty multimodal message)', () => {
    const result = buildSdkPrompt('hello', []);
    expect(result).toBe('hello');
  });

  it('with images: returns an AsyncGenerator, not a string', () => {
    const result = buildSdkPrompt('describe this', [{ mimeType: 'image/png', data: 'abc123' }]);
    expect(typeof result).not.toBe('string');
    expect(typeof (result as AsyncGenerator<unknown>)[Symbol.asyncIterator]).toBe('function');
  });

  it('the single yielded message has the exact confirmed SDKUserMessage shape', async () => {
    const gen = buildSdkPrompt('what is this?', [{ mimeType: 'image/jpeg', data: 'ZmFrZWRhdGE=' }]) as AsyncGenerator<any>;
    const { value, done } = await gen.next();
    expect(done).toBe(false);
    expect(value).toEqual({
      type: 'user',
      session_id: '',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'ZmFrZWRhdGE=' } },
          { type: 'text', text: 'what is this?' },
        ],
      },
    });
  });

  it('yields exactly one message, then the iterable ends', async () => {
    const gen = buildSdkPrompt('x', [{ mimeType: 'image/png', data: 'd' }]) as AsyncGenerator<any>;
    await gen.next();
    const second = await gen.next();
    expect(second.done).toBe(true);
  });
});

describe('buildImageContent — images first, text last, matches formatClaudeContent()', () => {
  it('puts every image block before the text block', () => {
    const blocks = buildImageContent('caption', [
      { mimeType: 'image/png', data: 'a' },
      { mimeType: 'image/jpeg', data: 'b' },
    ]);
    expect(blocks).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'a' } },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'b' } },
      { type: 'text', text: 'caption' },
    ]);
  });

  it('an empty prompt still gets a text block (Claude requires at least one)', () => {
    const blocks = buildImageContent('', [{ mimeType: 'image/png', data: 'a' }]);
    expect(blocks[blocks.length - 1]).toEqual({ type: 'text', text: '(Image attached)' });
  });
});

describe('singleUserMessage — the raw generator, independent of buildImageContent', () => {
  it('wraps arbitrary content blocks with no image-specific assumption', async () => {
    const gen = singleUserMessage([{ type: 'text', text: 'plain' }]);
    const { value } = await gen.next();
    expect((value as any).message.content).toEqual([{ type: 'text', text: 'plain' }]);
  });
});
