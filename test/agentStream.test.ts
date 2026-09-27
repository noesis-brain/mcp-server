import { describe, it, expect } from 'vitest';
import { consumeAgentStream, TURN_LIMIT_NOTE } from '../src/agent/runner.js';

/**
 * How the daemon turns an SDK message stream into the saved reply. Web research makes
 * multi-turn runs the norm — "let me read both pages" -> tools -> the answer — so the
 * shapes below are what a real WebFetch job emits (see the 2026-09-27 spike transcripts).
 */
const start = () => ({ type: 'stream_event', event: { type: 'message_start', message: {} } });
const delta = (text: string) => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
const assistant = (...content: unknown[]) => ({ type: 'assistant', message: { content } });
const toolUse = (name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id: `t-${name}`, name, input });
const result = (subtype = 'success') => ({ type: 'result', subtype });

async function* fromArray(messages: unknown[]) {
  for (const m of messages) yield m;
}

function sink(closeAfter = Infinity) {
  const pushed: string[] = [];
  return {
    pushed,
    push(text: string) { pushed.push(text); },
    isClosed() { return pushed.length >= closeAfter; },
  };
}

const quiet = () => {};

describe('consumeAgentStream', () => {
  it('passes a single-turn reply through unchanged', async () => {
    const out = sink();
    const text = await consumeAgentStream(fromArray([start(), delta('Hello'), delta(' world'), assistant({ type: 'text', text: 'Hello world' }), result()]), out, quiet);
    expect(text).toBe('Hello world');
    expect(out.pushed.join('')).toBe('Hello world');
  });

  // Without the break the saved reply read "讓我先擷取兩個頁面的資訊：成功取得兩個產品的資訊！".
  it('separates the narration turn from the answer turn with one paragraph break', async () => {
    const out = sink();
    const text = await consumeAgentStream(fromArray([
      start(), delta('Let me read both pages:'), assistant({ type: 'text', text: 'Let me read both pages:' }, toolUse('WebFetch', { url: 'https://a.example/' })),
      start(), delta('Here is the comparison.'), result(),
    ]), out, quiet);
    expect(text).toBe('Let me read both pages:\n\nHere is the comparison.');
    expect(out.pushed.join('')).toBe(text); // the live stream and the saved text agree
  });

  it('adds exactly one break across a tool-only turn in between', async () => {
    const text = await consumeAgentStream(fromArray([
      start(), delta('A'),
      start(), assistant(toolUse('WebSearch', { query: 'q' })),       // tool-only turn: no text
      start(), delta('B'),
    ]), sink(), quiet);
    expect(text).toBe('A\n\nB');
  });

  it('adds no break before the first text, even after tool-only turns', async () => {
    const text = await consumeAgentStream(fromArray([
      start(), assistant(toolUse('WebFetch', { url: 'https://a.example/' })),
      start(), delta('Answer'),
    ]), sink(), quiet);
    expect(text).toBe('Answer');
  });

  it('does not stack breaks when the earlier turn already ended with one', async () => {
    expect(await consumeAgentStream(fromArray([start(), delta('A\n'), start(), delta('B')]), sink(), quiet)).toBe('A\n\nB');
    expect(await consumeAgentStream(fromArray([start(), delta('A\n\n'), start(), delta('B')]), sink(), quiet)).toBe('A\n\nB');
  });

  it('falls back to terminal assistant text when no deltas arrive, one paragraph per turn', async () => {
    const out = sink();
    const text = await consumeAgentStream(fromArray([
      assistant({ type: 'text', text: 'First' }, toolUse('WebFetch', { url: 'https://a.example/' })),
      assistant({ type: 'text', text: 'Second' }),
      result(),
    ]), out, quiet);
    expect(text).toBe('First\n\nSecond');
    expect(out.pushed).toEqual(['First\n\nSecond']);
  });

  it('never emits the reply twice when both deltas and terminal messages arrive', async () => {
    const text = await consumeAgentStream(fromArray([start(), delta('Once'), assistant({ type: 'text', text: 'Once' }), result()]), sink(), quiet);
    expect(text).toBe('Once');
  });

  it('says so when the run hit the turn limit, instead of saving narration as the answer', async () => {
    const out = sink();
    const text = await consumeAgentStream(fromArray([start(), delta('Let me check the official page.'), assistant(toolUse('WebFetch', { url: 'https://a.example/' })), result('error_max_turns')]), out, quiet);
    expect(text).toBe(`Let me check the official page.${TURN_LIMIT_NOTE}`);
    expect(out.pushed.join('')).toBe(text);
  });

  it('shows the limit note without leading blank lines when nothing else was said', async () => {
    const text = await consumeAgentStream(fromArray([start(), assistant(toolUse('WebSearch', { query: 'q' })), result('error_max_turns')]), sink(), quiet);
    expect(text).toBe(TURN_LIMIT_NOTE.trimStart());
  });

  it('adds no note to a run that finished normally', async () => {
    const text = await consumeAgentStream(fromArray([start(), delta('Done'), result('success')]), sink(), quiet);
    expect(text).toBe('Done');
  });

  // canUseTool never sees WebFetch to the ~85 doc hosts the CLI pre-approves itself, so the
  // stream is the only complete record of what a Navi fetched.
  it('logs every tool call from the stream with its URL or query', async () => {
    const calls: Array<[string, string | undefined]> = [];
    await consumeAgentStream(fromArray([
      start(),
      assistant(
        toolUse('WebFetch', { url: 'https://docs.python.org/3/', prompt: 'x' }),
        toolUse('WebSearch', { query: 'BenQ ScreenBar Pro specs' }),
        toolUse('mcp__noesis__get_note', { id: 7 }),
      ),
    ]), sink(), (name, detail) => calls.push([name, detail]));
    expect(calls).toEqual([
      ['WebFetch', 'https://docs.python.org/3/'],
      ['WebSearch', 'BenQ ScreenBar Pro specs'],
      ['mcp__noesis__get_note', undefined],
    ]);
  });

  it('stops consuming once the sink is closed (lease lost)', async () => {
    const out = sink(1);
    const text = await consumeAgentStream(fromArray([start(), delta('A'), delta('B'), result('error_max_turns')]), out, quiet);
    expect(out.pushed).toEqual(['A']);
    expect(text).toBe('A');
  });
});
