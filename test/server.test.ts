import { describe, expect, it, vi } from 'vitest';
import {
  createProxyHandler,
  fromAnthropic,
  fromGemini,
  fromOpenAI,
  geminiSchema,
  nameMap,
  RateLimiter,
  toAnthropic,
  toGemini,
  toOpenAI,
  type ProxyHandlerOptions,
} from '../src/server.js';
import type { AgentMessage, ModelTool } from '../src/index.js';

const ORIGIN = 'https://shop.example';

const tools: ModelTool[] = [
  { name: 'search', description: 'Search.', inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } },
];
const messages: AgentMessage[] = [
  { role: 'user', content: 'find a mug' },
  { role: 'assistant', toolCall: { id: 'c1', name: 'search', arguments: { q: 'mug' } } },
  { role: 'tool', toolCallId: 'c1', name: 'search', content: 'Found a mug.' },
];
const body = { version: 1, instructions: 'Be brief.', messages, tools };

function upstream(json: unknown, status = 200) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(json), { status }));
}

function handler(overrides: Partial<ProxyHandlerOptions> = {}, fetchMock = upstream({ content: [{ type: 'text', text: 'Hi' }] })) {
  return {
    fetchMock,
    handle: createProxyHandler({
      provider: 'anthropic',
      model: 'test-model',
      apiKey: 'sk-test',
      allowedOrigins: [ORIGIN],
      fetch: fetchMock as typeof fetch,
      ...overrides,
    }),
  };
}

function post(payload: unknown = body, headers: Record<string, string> = {}) {
  return new Request('https://api.example/agent', {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json', ...headers },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
}

describe('createProxyHandler: options', () => {
  it('requires provider, model, key and exact origins', () => {
    const base = { provider: 'anthropic', model: 'm', apiKey: 'k', allowedOrigins: [ORIGIN] } as ProxyHandlerOptions;
    expect(() => createProxyHandler({ ...base, provider: 'other' as never })).toThrow(TypeError);
    expect(() => createProxyHandler({ ...base, model: '' })).toThrow(/model/);
    expect(() => createProxyHandler({ ...base, apiKey: '' })).toThrow(/apiKey/);
    expect(() => createProxyHandler({ ...base, allowedOrigins: [] })).toThrow(/allowedOrigins/);
    expect(() => createProxyHandler({ ...base, allowedOrigins: ['*'] })).toThrow(/exact origin/);
    expect(() => createProxyHandler({ ...base, allowedOrigins: ['https://a.example/path'] })).toThrow(/exact origin/);
  });
});

describe('createProxyHandler: origin and CORS', () => {
  it('rejects a missing or unlisted origin without CORS headers', async () => {
    const { handle, fetchMock } = handler();
    for (const origin of [undefined, 'https://evil.example']) {
      const res = await handle(new Request('https://api.example/agent', { method: 'POST', headers: origin ? { origin } : {}, body: '{}' }));
      expect(res.status).toBe(403);
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers a preflight from an allowed origin', async () => {
    const { handle } = handler({ allowHeaders: ['X-Site'] });
    const res = await handle(new Request('https://api.example/agent', { method: 'OPTIONS', headers: { origin: ORIGIN } }));
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(res.headers.get('access-control-allow-methods')).toBe('POST, OPTIONS');
    expect(res.headers.get('access-control-allow-headers')).toBe('content-type, x-site');
    expect(res.headers.get('vary')).toBe('Origin');
  });

  it('allows only POST with JSON', async () => {
    const { handle } = handler();
    const get = await handle(new Request('https://api.example/agent', { headers: { origin: ORIGIN } }));
    expect(get.status).toBe(405);
    const text = await handle(post('hi', { 'content-type': 'text/plain' }));
    expect(text.status).toBe(415);
  });

  it('returns the reply with CORS and no-store headers', async () => {
    const { handle } = handler();
    const res = await handle(post());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ type: 'answer', text: 'Hi' });
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('createProxyHandler: limits', () => {
  it('rate-limits per client IP and says when to retry', async () => {
    const { handle } = handler({ rateLimit: { max: 2, windowMs: 60_000 } });
    const from = (ip: string) => post(body, { 'cf-connecting-ip': ip });
    expect((await handle(from('1.1.1.1'))).status).toBe(200);
    expect((await handle(from('1.1.1.1'))).status).toBe(200);
    const limited = await handle(from('1.1.1.1'));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(limited.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect((await handle(from('2.2.2.2'))).status).toBe(200);
  });

  it('uses connection info from the platform context and does not trust X-Forwarded-For', async () => {
    const { handle } = handler({ rateLimit: { max: 1 } });
    expect((await handle(post(body, { 'x-forwarded-for': '9.9.9.9' }), { ip: '10.0.0.1' })).status).toBe(200);
    expect((await handle(post(body, { 'x-forwarded-for': '8.8.8.8' }), { ip: '10.0.0.1' })).status).toBe(429);
    expect((await handle(post(), { remoteAddr: { hostname: '10.0.0.2' } })).status).toBe(200);
    expect((await handle(post(), { requestIP: () => ({ address: '10.0.0.3' }) })).status).toBe(200);
  });

  it('can turn the rate limit off', async () => {
    const { handle } = handler({ rateLimit: false });
    for (let i = 0; i < 25; i++) expect((await handle(post())).status).toBe(200);
  });

  it('sliding window frees a slot after the window', () => {
    let now = 0;
    const limiter = new RateLimiter(1000, 1, () => now);
    expect(limiter.take('a')).toBe(0);
    now = 400;
    expect(limiter.take('a')).toBe(600);
    now = 1001;
    expect(limiter.take('a')).toBe(0);
  });

  it('caps the body size, by header and by actual bytes', async () => {
    const { handle, fetchMock } = handler({ maxBodyBytes: 100 });
    const big = JSON.stringify({ ...body, instructions: 'x'.repeat(200) });
    expect((await handle(post(big))).status).toBe(413);
    const chunked = new Request('https://api.example/agent', {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(big));
          c.close();
        },
      }),
      duplex: 'half',
    } as RequestInit);
    expect((await handle(chunked)).status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('caps messages and tools, and rejects malformed bodies', async () => {
    const { handle } = handler({ maxMessages: 2, maxTools: 0 });
    const tooMany = await handle(post());
    expect(tooMany.status).toBe(400);
    expect(await tooMany.json()).toEqual({ error: 'Too many messages (max 2).' });
    const { handle: h2 } = handler({ maxTools: 0 });
    expect(await (await h2(post())).json()).toEqual({ error: 'Too many tools (max 0).' });
    const { handle: h3 } = handler();
    expect((await h3(post('{not json'))).status).toBe(400);
    expect((await h3(post({ messages: [] }))).status).toBe(400);
    expect((await h3(post({ messages: [{ role: 'system', content: 'x' }] }))).status).toBe(400);
  });

  it('sends max tokens and the server instructions first', async () => {
    const { handle, fetchMock } = handler({ maxTokens: 77, instructions: 'Server rules.' });
    await handle(post());
    const sent = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(sent.max_tokens).toBe(77);
    expect(sent.system).toBe('Server rules.\n\nBe brief.');
    const { handle: strict, fetchMock: f2 } = handler({ instructions: 'Only mine.', allowClientInstructions: false });
    await strict(post());
    expect(JSON.parse(f2.mock.calls[0]![1]!.body as string).system).toBe('Only mine.');
  });

  it('hides upstream error details from the client and reports them to onError', async () => {
    const onError = vi.fn();
    const { handle } = handler({ onError }, upstream({ error: { message: 'invalid x-api-key' } }, 401));
    const res = await handle(post());
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'The model provider answered 401.' });
    expect(String(onError.mock.calls[0]?.[0])).toContain('invalid x-api-key');
  });

  it('times out a slow provider', async () => {
    const slow = vi.fn((_u: unknown, init?: RequestInit) => new Promise<Response>((_r, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))));
    const { handle } = handler({ timeoutMs: 20 }, slow as never);
    expect((await handle(post())).status).toBe(504);
  });
});

describe('provider mapping', () => {
  const req = { instructions: 'Rules.', messages, tools, model: 'm-1', maxTokens: 100 };

  it('Anthropic Messages API', () => {
    const call = toAnthropic(req, 'key');
    expect(call.url).toBe('https://api.anthropic.com/v1/messages');
    expect(call.headers).toMatchObject({ 'x-api-key': 'key', 'anthropic-version': '2023-06-01' });
    expect(call.body).toEqual({
      model: 'm-1',
      max_tokens: 100,
      system: 'Rules.',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'find a mug' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'search', input: { q: 'mug' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'Found a mug.' }] },
      ],
      tools: [{ name: 'search', description: 'Search.', input_schema: tools[0]!.inputSchema }],
      tool_choice: { type: 'auto', disable_parallel_tool_use: true },
    });
    expect(fromAnthropic({ content: [{ type: 'text', text: 'Let me check.' }, { type: 'tool_use', id: 't9', name: 'search', input: { q: 'x' } }] })).toEqual({
      type: 'tool',
      id: 't9',
      name: 'search',
      arguments: { q: 'x' },
    });
    expect(fromAnthropic({ content: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }] })).toEqual({ type: 'answer', text: 'AB' });
  });

  it('Anthropic: merges same-role turns, marks errors, drops a leading assistant turn, omits tools when none', () => {
    const call = toAnthropic(
      {
        ...req,
        tools: [],
        messages: [
          { role: 'assistant', content: 'stale' },
          { role: 'user', content: 'a' },
          { role: 'user', content: 'b' },
          { role: 'assistant', toolCall: { id: 'c', name: 's', arguments: {} } },
          { role: 'tool', toolCallId: 'c', name: 's', content: 'denied', isError: true },
        ],
      },
      'k',
      'https://gateway.example/anthropic/',
    );
    const b = call.body as { messages: Array<{ role: string; content: unknown[] }>; tools?: unknown; tool_choice?: unknown };
    expect(call.url).toBe('https://gateway.example/anthropic/v1/messages');
    expect(b.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(b.messages[0]?.content).toHaveLength(2);
    expect(b.messages[2]?.content[0]).toMatchObject({ is_error: true });
    expect(b.tools).toBeUndefined();
    expect(b.tool_choice).toBeUndefined();
  });

  it('OpenAI Chat Completions, with a custom baseURL', () => {
    const call = toOpenAI(req, 'key', 'http://localhost:11434/v1/');
    expect(call.url).toBe('http://localhost:11434/v1/chat/completions');
    expect(call.headers.authorization).toBe('Bearer key');
    expect(call.body).toEqual({
      model: 'm-1',
      max_completion_tokens: 100,
      messages: [
        { role: 'system', content: 'Rules.' },
        { role: 'user', content: 'find a mug' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search', arguments: '{"q":"mug"}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'Found a mug.' },
      ],
      tools: [{ type: 'function', function: { name: 'search', description: 'Search.', parameters: tools[0]!.inputSchema } }],
      tool_choice: 'auto',
      parallel_tool_calls: false,
    });
    expect(toOpenAI(req, 'k').url).toBe('https://api.openai.com/v1/chat/completions');
    expect(
      fromOpenAI({ choices: [{ message: { content: null, tool_calls: [{ id: 'x1', type: 'function', function: { name: 'search', arguments: '{"q":"tea"}' } }] } }] }),
    ).toEqual({ type: 'tool', id: 'x1', name: 'search', arguments: { q: 'tea' } });
    expect(fromOpenAI({ choices: [{ message: { tool_calls: [{ function: { name: 's', arguments: '{bad' } }] } }] })).toEqual({ type: 'tool', name: 's', arguments: '{bad' });
    expect(fromOpenAI({ choices: [{ message: { content: 'Hello' } }] })).toEqual({ type: 'answer', text: 'Hello' });
  });

  it('Gemini generateContent, with thought signatures and call ids round-tripped', () => {
    const withMeta: AgentMessage[] = [
      messages[0]!,
      { role: 'assistant', toolCall: { id: 'g1', name: 'search', arguments: { q: 'mug' }, meta: { thoughtSignature: 'sig==', callId: 'g1' } } },
      { role: 'tool', toolCallId: 'g1', name: 'search', content: 'Found a mug.' },
    ];
    const call = toGemini({ ...req, model: 'models/x y', messages: withMeta }, 'key');
    expect(call.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/models%2Fx%20y:generateContent');
    expect(call.headers['x-goog-api-key']).toBe('key');
    expect(call.body).toEqual({
      systemInstruction: { parts: [{ text: 'Rules.' }] },
      contents: [
        { role: 'user', parts: [{ text: 'find a mug' }] },
        { role: 'model', parts: [{ functionCall: { id: 'g1', name: 'search', args: { q: 'mug' } }, thoughtSignature: 'sig==' }] },
        { role: 'user', parts: [{ functionResponse: { id: 'g1', name: 'search', response: { result: 'Found a mug.' } } }] },
      ],
      generationConfig: { maxOutputTokens: 100 },
      tools: [{ functionDeclarations: [{ name: 'search', description: 'Search.', parameters: tools[0]!.inputSchema }] }],
      toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
    });
    expect(
      fromGemini({ candidates: [{ content: { parts: [{ text: 'thinking', thought: true }, { functionCall: { name: 'search', args: { q: 'x' } }, thoughtSignature: 'abc' }] } }] }),
    ).toEqual({ type: 'tool', name: 'search', arguments: { q: 'x' }, meta: { thoughtSignature: 'abc' } });
    expect(fromGemini({ candidates: [{ content: { parts: [{ text: 'secret', thought: true }, { text: 'Hello' }] } }] })).toEqual({ type: 'answer', text: 'Hello' });
    expect(fromGemini({})).toEqual({ type: 'answer', text: '' });
  });

  it('Gemini: schema subset, errors as error responses, no parameters for empty schemas', () => {
    expect(
      geminiSchema({ $schema: 'x', type: 'object', additionalProperties: false, properties: { a: { type: ['string', 'null'] }, b: { const: 'k' } } }),
    ).toEqual({ type: 'object', properties: { a: { type: 'string', nullable: true }, b: { enum: ['k'] } } });
    const call = toGemini(
      {
        ...req,
        tools: [{ name: 'noargs', description: 'd', inputSchema: { type: 'object', properties: {} } }],
        messages: [messages[0]!, messages[1]!, { role: 'tool', toolCallId: 'c1', name: 'search', content: 'denied', isError: true }],
      },
      'k',
    );
    const b = call.body as { tools: Array<{ functionDeclarations: unknown[] }>; contents: Array<{ parts: unknown[] }> };
    expect(b.tools[0]?.functionDeclarations[0]).toEqual({ name: 'noargs', description: 'd' });
    expect(b.contents[2]?.parts[0]).toEqual({ functionResponse: { name: 'search', response: { error: 'denied' } } });
  });

  it('maps tool names providers would reject, and maps them back', async () => {
    const map = nameMap([
      { name: 'cart.add', description: '', inputSchema: {} },
      { name: 'cart_add', description: '', inputSchema: {} },
      { name: 'ok-name', description: '', inputSchema: {} },
    ]);
    expect(map.out('ok-name')).toBe('ok-name');
    expect(map.out('cart_add')).toBe('cart_add');
    expect(map.out('cart.add')).not.toBe('cart_add');
    expect(map.back(map.out('cart.add'))).toBe('cart.add');

    const fetchMock = upstream({ choices: [{ message: { tool_calls: [{ id: 'z', function: { name: 'cart_add', arguments: '{}' } }] } }] });
    const { handle } = handler({ provider: 'openai' }, fetchMock);
    const res = await handle(post({ messages: [{ role: 'user', content: 'add' }], tools: [{ name: 'cart.add', description: 'Add.', inputSchema: { type: 'object' } }] }));
    const sent = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(sent.tools[0].function.name).toBe('cart_add');
    expect(await res.json()).toEqual({ type: 'tool', id: 'z', name: 'cart.add', arguments: {} });
  });

  it('each provider end to end through the handler', async () => {
    const cases = [
      { provider: 'anthropic' as const, reply: { content: [{ type: 'tool_use', id: 'a1', name: 'search', input: { q: 'm' } }] }, url: 'https://api.anthropic.com/v1/messages' },
      { provider: 'openai' as const, reply: { choices: [{ message: { tool_calls: [{ id: 'a1', function: { name: 'search', arguments: '{"q":"m"}' } }] } }] }, url: 'https://api.openai.com/v1/chat/completions' },
      { provider: 'gemini' as const, reply: { candidates: [{ content: { parts: [{ functionCall: { id: 'a1', name: 'search', args: { q: 'm' } } }] } }] }, url: 'https://generativelanguage.googleapis.com/v1beta/models/test-model:generateContent' },
    ];
    for (const c of cases) {
      const fetchMock = upstream(c.reply);
      const { handle } = handler({ provider: c.provider }, fetchMock);
      const res = await handle(post());
      expect(fetchMock.mock.calls[0]![0]).toBe(c.url);
      expect(await res.json()).toMatchObject({ type: 'tool', id: 'a1', name: 'search', arguments: { q: 'm' } });
    }
  });
});
