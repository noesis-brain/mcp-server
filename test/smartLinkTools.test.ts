/**
 * Smart links tools (TCK-1883): each tool calls the right client method with the right
 * arguments, candidate settings stay a dry run (only smart_links_set_settings saves), the
 * previous settings come back for a rollback, a server refusal is an error result, and the
 * text shows the markdown each context would produce.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { z } from 'zod';

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

const CANDIDATE = {
  enabled: true,
  types: [{ id: 'j', preset: 'jira', host: 'acme.atlassian.net', projects: ['ABC'], style: { lineStart: 'id+title', inSentence: 'id' }, typed: 'suggest', pasted: 'suggest' }],
};

describe('smart links tools → client', () => {
  const handlers = new Map<string, Handler>();
  const schemas = new Map<string, Record<string, z.ZodTypeAny>>();
  const calls: Array<[string, ...unknown[]]> = [];
  let reply: unknown = {};
  let fail: Error | null = null;

  beforeAll(async () => {
    const { registerSmartLinkTools } = await import('../src/tools/smartLinks.js');
    const server = {
      tool: (name: string, _desc: string, schema: Record<string, z.ZodTypeAny>, handler: Handler) => {
        handlers.set(name, handler);
        schemas.set(name, schema);
      },
    };
    const client = new Proxy(
      {},
      {
        get: (_t, prop) => async (...args: unknown[]) => {
          calls.push([String(prop), ...args]);
          if (fail) throw fail;
          return reply;
        },
      },
    );
    registerSmartLinkTools(server as never, client as never);
  });
  afterEach(() => {
    calls.length = 0;
    reply = {};
    fail = null;
  });

  const run = (name: string, args: Record<string, unknown>) => handlers.get(name)!(args);

  it('registers the five tools', () => {
    expect([...handlers.keys()].sort()).toEqual([
      'smart_links_get_settings',
      'smart_links_preview_note',
      'smart_links_scan_notes',
      'smart_links_set_settings',
      'smart_links_test',
    ]);
  });

  it('test and preview pass candidate settings through and never save', async () => {
    reply = [
      {
        input: 'ABC-1',
        match: { typeId: 'j', preset: 'jira', id: 'ABC-1', href: 'https://acme.atlassian.net/browse/ABC-1', form: 'short' },
        title: 'Fix [it]',
        titleStatus: 'ok',
        lineStart: { style: 'id+title', linkText: 'ABC-1', after: ' Fix [it]' },
        inSentence: { style: 'id', linkText: 'ABC-1', after: '' },
      },
      { input: 'hello', match: null, title: null, titleStatus: 'none', lineStart: null, inSentence: null },
    ];
    const out = await run('smart_links_test', { samples: ['ABC-1', 'hello'], settings: CANDIDATE });
    expect(calls).toEqual([['testSmartLinks', ['ABC-1', 'hello'], CANDIDATE]]);
    expect(out.content[0].text).toContain('line start: [ABC-1](https://acme.atlassian.net/browse/ABC-1) Fix [it]');
    expect(out.content[0].text).toContain('in a sentence: [ABC-1](https://acme.atlassian.net/browse/ABC-1)');
    expect(out.content[0].text).toContain('no link type matches');

    calls.length = 0;
    reply = [{ line: 3, original: 'ABC-2', replacement: '[ABC-2](https://acme.atlassian.net/browse/ABC-2)', href: 'x', title: null, titleStatus: 'no_credentials', typeId: 'j', style: 'id' }];
    const preview = await run('smart_links_preview_note', { note_id: 42, settings: CANDIDATE });
    expect(calls).toEqual([['previewSmartLinksInNote', 42, CANDIDATE]]);
    expect(preview.content[0].text).toContain('line 3: ABC-2');
    expect(calls.some(([m]) => m === 'saveSmartLinkSettings')).toBe(false);
  });

  it('set returns the previous settings for a rollback, and a refusal is an error', async () => {
    reply = { settings: CANDIDATE, previous: { enabled: false, types: [] } };
    const out = await run('smart_links_set_settings', { settings: CANDIDATE });
    expect(calls).toEqual([['saveSmartLinkSettings', CANDIDATE]]);
    expect(out.content[0].text).toContain('"enabled": false');

    fail = new Error('types[0].projects[0] must be a project key such as BPLAT');
    const refused = await run('smart_links_set_settings', { settings: CANDIDATE });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('types[0].projects[0]');
  });

  it('the settings schema needs enabled and a list of at most 20 typed entries', () => {
    const schema = z.object(schemas.get('smart_links_set_settings')!);
    expect(schema.safeParse({ settings: CANDIDATE }).success).toBe(true);
    expect(schema.safeParse({ settings: { types: [] } }).success).toBe(false);
    expect(schema.safeParse({ settings: { enabled: true, types: [{ id: 'x', preset: 'nope' }] } }).success).toBe(false);
    const samples = z.object(schemas.get('smart_links_test')!);
    expect(samples.safeParse({ samples: [] }).success).toBe(false);
    expect(samples.safeParse({ samples: Array(51).fill('x') }).success).toBe(false);
  });

  it('scan lists what was found and the proposals', async () => {
    reply = {
      jira: [{ host: 'acme.atlassian.net', total: 4, projects: [{ key: 'ABC', count: 4 }] }],
      github: [{ host: 'github.com', owner: 'o', repo: 'r', count: 2 }],
      noesisLinks: 7,
      otherSites: [],
      proposals: [{ type: CANDIDATE.types[0], selected: true, count: 4 }],
    };
    const out = await run('smart_links_scan_notes', {});
    expect(calls).toEqual([['scanSmartLinkTypes']]);
    expect(out.content[0].text).toContain('Jira acme.atlassian.net: ABC (4)');
    expect(out.content[0].text).toContain('GitHub github.com/o/r: 2');
    expect(out.content[0].text).toContain('"selected": true');
  });
});
