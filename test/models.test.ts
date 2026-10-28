import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chromeBuiltIn,
  createSiteAgent,
  custom,
  firstAvailable,
  proxy,
  renderPrompt,
  replySchema,
  simpleReplySchema,
  type ModelRequest,
} from '../src/index.js';
import { shopTools } from './helpers.js';

const g = globalThis as { LanguageModel?: unknown };

afterEach(() => {
  delete g.LanguageModel;
  vi.unstubAllGlobals();
});

const request: ModelRequest = {
  instructions: 'Be helpful.',
  messages: [{ role: 'user', content: 'find a mug' }],
  tools: [{ name: 'search', description: 'Search.', inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } }],
};

function fakeLanguageModel(state: string, outputs: Array<string | Error>) {
  const prompts: Array<{ text: string; schema: unknown }> = [];
  const created: unknown[] = [];
  const session = {
    prompt: vi.fn(async (text: string, options: { responseConstraint?: unknown }) => {
      prompts.push({ text, schema: options.responseConstraint });
      const next = outputs.shift();
      if (next instanceof Error) throw next;
      return next ?? '{"type":"answer","text":"(empty)"}';
    }),
    clone: vi.fn(async () => session),
    destroy: vi.fn(),
  };
  const lm = {
    availability: vi.fn(async () => state),
    create: vi.fn(async (options: { monitor?: (m: EventTarget) => void }) => {
      created.push(options);
      if (options.monitor) {
        const target = new EventTarget();
        options.monitor(target);
        const e = new Event('downloadprogress') as Event & { loaded: number };
        e.loaded = 0.5;
        target.dispatchEvent(e);
      }
      return session;
    }),
  };
  g.LanguageModel = lm;
  return { lm, session, prompts, created };
}

describe('chromeBuiltIn', () => {
  it('reports unavailable without the Prompt API', async () => {
    const model = chromeBuiltIn();
    expect(await model.availability!()).toBe('unavailable');
    await expect(model.respond(request)).rejects.toMatchObject({ code: 'model-unavailable' });
  });

  it('maps availability states and asks for a download when needed', async () => {
    for (const state of ['downloadable', 'downloading']) {
      fakeLanguageModel(state, []);
      const model = chromeBuiltIn();
      expect(await model.availability!()).toBe(state);
      await expect(model.respond(request)).rejects.toMatchObject({ code: 'model-download-required' });
    }
    fakeLanguageModel('something-new', []);
    expect(await chromeBuiltIn().availability!()).toBe('unavailable');
  });

  it('prepare() creates a session with a download monitor', async () => {
    const { created, session } = fakeLanguageModel('downloadable', []);
    const progress: number[] = [];
    await chromeBuiltIn({ languages: ['es'] }).prepare!({ onProgress: (f) => progress.push(f) });
    expect(progress).toEqual([0.5]);
    expect(created[0]).toMatchObject({ expectedInputs: [{ type: 'text', languages: ['es'] }] });
    expect(session.destroy).toHaveBeenCalled();
  });

  it('picks a tool through a JSON Schema response constraint', async () => {
    const { prompts, created } = fakeLanguageModel('available', ['{"type":"tool","name":"search","arguments":{"q":"mug"}}']);
    const reply = await chromeBuiltIn().respond(request);
    expect(reply).toEqual({ type: 'tool', name: 'search', arguments: { q: 'mug' } });
    expect(created[0]).toMatchObject({ initialPrompts: [{ role: 'system', content: 'Be helpful.' }] });
    expect(prompts[0]?.schema).toEqual(replySchema(request.tools));
    expect(prompts[0]?.text).toContain('- search: Search.');
    expect(prompts[0]?.text).toContain('Visitor: find a mug');
  });

  it('answers, and falls back to a flat schema once if the first is rejected', async () => {
    const { prompts } = fakeLanguageModel('available', [new Error('NotSupportedError'), '{"type":"answer","text":"hi"}', '{"type":"answer","text":"again"}']);
    const model = chromeBuiltIn();
    expect(await model.respond(request)).toEqual({ type: 'answer', text: 'hi' });
    expect(await model.respond(request)).toEqual({ type: 'answer', text: 'again' });
    expect(prompts.map((p) => p.schema)).toEqual([replySchema(request.tools), simpleReplySchema(request.tools), simpleReplySchema(request.tools)]);
  });

  it('rejects output that is not JSON', async () => {
    fakeLanguageModel('available', ['sure!']);
    await expect(chromeBuiltIn().respond(request)).rejects.toMatchObject({ code: 'bad-reply' });
  });

  it('reply schema: one branch per tool with its input schema, no $schema', () => {
    const schema = replySchema([{ name: 't', description: 'd', inputSchema: { $schema: 'x', type: 'object', properties: { a: { type: 'string' } } } }]);
    const branches = schema.anyOf as Array<{ properties: Record<string, unknown> }>;
    expect(branches).toHaveLength(2);
    expect(branches[1]?.properties.name).toEqual({ type: 'string', enum: ['t'] });
    expect(branches[1]?.properties.arguments).toEqual({ type: 'object', properties: { a: { type: 'string' } } });
  });

  it('keeps prompts within the history limits', () => {
    const messages = Array.from({ length: 30 }, (_, i) => ({ role: 'user' as const, content: `message ${i}` }));
    const text = renderPrompt({ ...request, messages }, 5, 10_000);
    expect(text).toContain('message 29');
    expect(text).not.toContain('message 24');
  });
});

describe('proxy', () => {
  it('posts the protocol body and returns the reply', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ type: 'answer', text: 'ok' }), { status: 200 }));
    const model = proxy({ url: '/api/agent', headers: { 'x-site': '1' }, fetch: fetchMock as typeof fetch });
    expect(await model.respond(request)).toEqual({ type: 'answer', text: 'ok' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/agent');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'content-type': 'application/json', 'x-site': '1' });
    expect(JSON.parse(init.body as string)).toEqual({ version: 1, instructions: 'Be helpful.', messages: request.messages, tools: request.tools });
  });

  it('turns HTTP errors and network failures into typed errors', async () => {
    const failing = proxy({ url: '/x', fetch: (async () => new Response(JSON.stringify({ error: 'Too many requests.' }), { status: 429 })) as typeof fetch });
    await expect(failing.respond(request)).rejects.toMatchObject({ code: 'model-error', message: 'The model endpoint answered 429: Too many requests..' });
    const offline = proxy({ url: '/x', fetch: (async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch });
    await expect(offline.respond(request)).rejects.toMatchObject({ code: 'model-unavailable' });
    const notJson = proxy({ url: '/x', fetch: (async () => new Response('<html>', { status: 200 })) as typeof fetch });
    await expect(notJson.respond(request)).rejects.toMatchObject({ code: 'bad-reply' });
  });

  it('requires a url', () => {
    expect(() => proxy({} as never)).toThrow(TypeError);
  });
});

describe('firstAvailable', () => {
  it('uses the first available model and records which one answered', async () => {
    const slow = custom(async () => ({ type: 'answer', text: 'from a' }), { name: 'a', availability: async () => 'downloadable' });
    const ready = custom(async () => ({ type: 'answer', text: 'from b' }), { name: 'b' });
    const chain = firstAvailable(slow, ready);
    expect(chain.name).toBe('first-available(a,b)');
    expect(await chain.availability!()).toBe('available');
    const result = await createSiteAgent({ model: chain, tools: shopTools() }).run('hi').done;
    expect(result.answer).toBe('from b');
    expect(result.trace.steps.find((s) => s.type === 'model')).toMatchObject({ model: 'b' });
    expect(result.trace.model).toBe('first-available(a,b)');
  });

  it('reports the best state and prepares the model that needs it', async () => {
    const prepare = vi.fn(async () => {});
    const a = { ...custom(async () => ({ type: 'answer' as const, text: '' }), { name: 'a', availability: async () => 'downloadable' as const }), prepare };
    const b = custom(async () => ({ type: 'answer', text: '' }), { name: 'b', availability: async () => 'unavailable' });
    const chain = firstAvailable(b, a);
    expect(await chain.availability!()).toBe('downloadable');
    await expect(chain.respond(request)).rejects.toMatchObject({ code: 'model-download-required' });
    await chain.prepare!();
    expect(prepare).toHaveBeenCalled();
    const none = firstAvailable(b);
    await expect(none.respond(request)).rejects.toMatchObject({ code: 'model-unavailable' });
    expect(() => firstAvailable()).toThrow(TypeError);
  });
});
