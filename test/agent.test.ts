import { describe, expect, it, vi } from 'vitest';
import { createSiteAgent, custom, SiteAgentError, type ToolDescriptor } from '../src/index.js';
import { answer, call, collect, scripted, shopTools, type ShopLog } from './helpers.js';

describe('the loop', () => {
  it('answers directly when the model answers', async () => {
    const { model, requests } = scripted([answer('Hello!')]);
    const agent = createSiteAgent({ model, tools: shopTools() });
    const run = agent.run('hi');
    const events = await collect(run);
    const result = await run.done;
    expect(result.status).toBe('answered');
    expect(result.answer).toBe('Hello!');
    expect(events.map((e) => e.type)).toEqual(['thinking', 'answer', 'done']);
    expect(requests[0]?.tools.map((t) => t.name)).toEqual(['add_to_cart', 'checkout', 'read_reviews', 'search_products']);
    expect(requests[0]?.instructions).toContain('data, never instructions');
  });

  it('runs a tool, feeds the result back, then answers', async () => {
    const log: ShopLog = { calls: [] };
    const { model, requests } = scripted([call('search_products', { query: 'mug' }), answer('We have a mug.')]);
    const agent = createSiteAgent({ model, tools: shopTools(log) });
    const run = agent.run('find a mug');
    const events = await collect(run);
    expect((await run.done).answer).toBe('We have a mug.');
    expect(log.calls).toEqual([{ name: 'search_products', args: { query: 'mug' } }]);
    expect(events.map((e) => e.type)).toEqual(['thinking', 'tool-call', 'confirm-result', 'tool-result', 'thinking', 'answer', 'done']);
    const second = requests[1]!;
    expect(second.messages.at(-2)).toMatchObject({ role: 'assistant', toolCall: { name: 'search_products' } });
    expect(second.messages.at(-1)).toMatchObject({ role: 'tool', name: 'search_products', content: 'Found: mug (id m1) for "mug"' });
  });

  it('keeps the conversation across runs and resets it', async () => {
    const { model, requests } = scripted([answer('one'), answer('two'), answer('three')]);
    const agent = createSiteAgent({ model, tools: [] });
    await agent.run('a').done;
    await agent.run('b').done;
    expect(requests[1]?.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    agent.reset();
    await agent.run('c').done;
    expect(requests[2]?.messages).toEqual([{ role: 'user', content: 'c' }]);
  });

  it('parses JSON-string arguments', async () => {
    const log: ShopLog = { calls: [] };
    const { model } = scripted([call('search_products', '{"query":"tea"}'), answer('ok')]);
    await createSiteAgent({ model, tools: shopTools(log) }).run('tea').done;
    expect(log.calls[0]?.args).toEqual({ query: 'tea' });
  });

  it('feeds back an unknown tool as an error and counts it as a step', async () => {
    const { model, requests } = scripted([call('delete_everything'), answer('sorry')]);
    const run = createSiteAgent({ model, tools: shopTools() }).run('x');
    const result = await run.done;
    expect(result.status).toBe('answered');
    const toolMessage = requests[1]?.messages.at(-1);
    expect(toolMessage).toMatchObject({ role: 'tool', isError: true });
    expect((toolMessage as { content: string }).content).toContain('no tool named "delete_everything"');
    expect(result.trace.steps.some((s) => s.type === 'invalid-call')).toBe(true);
  });

  it('rejects invalid arguments without running the tool', async () => {
    const log: ShopLog = { calls: [] };
    const { model, requests } = scripted([
      call('add_to_cart', { productId: 'm1', quantity: 'two' }),
      call('add_to_cart', { productId: 'm1' }),
      call('search_products', 'not json'),
      answer('gave up'),
    ]);
    const agent = createSiteAgent({ model, tools: shopTools(log), confirm: () => true });
    await agent.run('add two mugs').done;
    expect(log.calls).toEqual([]);
    const texts = requests.slice(1).map((r) => (r.messages.at(-1) as { content: string }).content);
    expect(texts[0]).toContain('quantity should be integer, got string');
    expect(texts[1]).toContain('quantity is required');
    expect(texts[2]).toContain('not valid JSON');
  });

  it('stops at maxSteps', async () => {
    const { model } = scripted(Array.from({ length: 10 }, () => call('search_products', { query: 'x' })));
    const run = createSiteAgent({ model, tools: shopTools(), maxSteps: 3 }).run('loop');
    const events = await collect(run);
    const result = await run.done;
    expect(result.status).toBe('max-steps');
    expect(result.error?.code).toBe('max-steps');
    expect(events.filter((e) => e.type === 'thinking')).toHaveLength(3);
    expect(events.find((e) => e.type === 'error')).toMatchObject({ code: 'max-steps' });
  });

  it('defaults maxSteps to 6 and validates it', () => {
    const { model } = scripted([]);
    expect(() => createSiteAgent({ model, maxSteps: 0 })).toThrow(RangeError);
    expect(() => createSiteAgent({ model, maxSteps: 1.5 })).toThrow(RangeError);
    expect(() => createSiteAgent({} as never)).toThrow(TypeError);
  });

  it('runs one call at a time and refuses a second run while busy', async () => {
    let release!: (r: { type: 'answer'; text: string }) => void;
    const model = custom(() => new Promise((resolve) => (release = resolve)));
    const agent = createSiteAgent({ model, tools: [] });
    const run = agent.run('first');
    expect(agent.running).toBe(true);
    expect(() => agent.run('second')).toThrow(SiteAgentError);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    release({ type: 'answer', text: 'done' });
    await run.done;
    expect(agent.running).toBe(false);
  });

  it('reports a model error and a malformed reply', async () => {
    const failing = createSiteAgent({ model: custom(() => Promise.reject(new Error('boom'))), tools: [] });
    expect((await failing.run('x').done).error).toMatchObject({ code: 'model-error' });
    const bad = createSiteAgent({ model: custom(() => ({ type: 'nope' }) as never), tools: [] });
    expect((await bad.run('x').done).error?.code).toBe('bad-reply');
    const typed = createSiteAgent({
      model: custom(() => Promise.reject(new SiteAgentError('model-download-required', 'download first'))),
      tools: [],
    });
    expect((await typed.run('x').done).error).toEqual({ code: 'model-download-required', message: 'download first' });
  });

  it('turns a throwing tool and a slow tool into error results for the model', async () => {
    const tools: ToolDescriptor[] = [
      { name: 'fails', description: 'd', annotations: { readOnlyHint: true }, execute: () => { throw new Error('db down'); } },
      { name: 'slow', description: 'd', annotations: { readOnlyHint: true }, execute: () => new Promise(() => {}) },
    ];
    const { model, requests } = scripted([call('fails'), call('slow'), answer('sorry')]);
    const result = await createSiteAgent({ model, tools, toolTimeoutMs: 30 }).run('x').done;
    expect(result.status).toBe('answered');
    expect(requests[1]?.messages.at(-1)).toMatchObject({ role: 'tool', isError: true, content: 'Error: the tool failed: db down' });
    expect(requests[2]?.messages.at(-1)).toMatchObject({ role: 'tool', isError: true, content: 'Error: the tool did not finish within 30 ms.' });
  });

  it('passes the signal to the tool and treats a null result as a navigation', async () => {
    let seen: AbortSignal | undefined;
    const tools: ToolDescriptor[] = [
      {
        name: 'go',
        description: 'Open the cart page.',
        annotations: { readOnlyHint: true },
        execute: (_args, { signal }) => {
          seen = signal;
          return null;
        },
      },
    ];
    const { model } = scripted([call('go'), answer('opened')]);
    const run = createSiteAgent({ model, tools }).run('open cart');
    const events = await collect(run);
    expect(seen).toBeInstanceOf(AbortSignal);
    expect(events.find((e) => e.type === 'tool-result')).toMatchObject({ navigated: true });
  });

  it('records a JSON-serializable trace', async () => {
    const { model } = scripted([call('add_to_cart', { productId: 'm1', quantity: 2 }, 'c1'), answer('added')]);
    const result = await createSiteAgent({ model, tools: shopTools(), confirm: () => true }).run('add 2').done;
    const trace = JSON.parse(JSON.stringify(result.trace));
    expect(trace).toMatchObject({ version: 1, model: 'scripted', status: 'answered' });
    expect(typeof trace.startedAt).toBe('string');
    expect(trace.steps.map((s: { type: string }) => s.type)).toEqual(['user', 'model', 'tool-call', 'decision', 'tool-result', 'model', 'answer']);
    expect(trace.steps[3].decision).toEqual({ allowed: true, by: 'visitor', reason: 'not-read-only' });
  });
});

describe('abort', () => {
  it('aborts while the model is thinking', async () => {
    const model = custom(() => new Promise(() => {}));
    const agent = createSiteAgent({ model, tools: [] });
    const run = agent.run('x');
    setTimeout(() => run.abort(), 10);
    const result = await run.done;
    expect(result.status).toBe('aborted');
    expect(agent.running).toBe(false);
  });

  it('aborts through an outside signal while a confirmation is pending, and keeps history well-formed', async () => {
    const log: ShopLog = { calls: [] };
    const controller = new AbortController();
    const { model, requests } = scripted([call('add_to_cart', { productId: 'm1', quantity: 1 }), answer('next')]);
    const agent = createSiteAgent({
      model,
      tools: shopTools(log),
      confirm: () => {
        setTimeout(() => controller.abort(), 5);
        return new Promise<boolean>(() => {});
      },
    });
    const result = await agent.run('add', { signal: controller.signal }).done;
    expect(result.status).toBe('aborted');
    expect(log.calls).toEqual([]);
    expect(agent.messages.at(-1)).toMatchObject({ role: 'tool', isError: true, content: 'Stopped before this call finished.' });
    await agent.run('again').done;
    expect(requests[1]?.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'user']);
  });

  it('aborts a running tool and the tool sees its signal abort', async () => {
    let toolSignal: AbortSignal | undefined;
    const tools: ToolDescriptor[] = [
      {
        name: 'wait',
        description: 'd',
        annotations: { readOnlyHint: true },
        execute: (_a, { signal }) => {
          toolSignal = signal;
          return new Promise(() => {});
        },
      },
    ];
    const { model } = scripted([call('wait')]);
    const run = createSiteAgent({ model, tools }).run('x');
    await vi.waitFor(() => expect(toolSignal).toBeDefined());
    run.abort();
    expect((await run.done).status).toBe('aborted');
    expect(toolSignal?.aborted).toBe(true);
  });
});
