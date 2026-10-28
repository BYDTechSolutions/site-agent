// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createModelContext, createSiteAgent, hasNativeModelContext, installShim, isShim } from '../src/index.js';
import { answer, call, scripted } from './helpers.js';

const doc = document as unknown as { modelContext?: unknown };

afterEach(() => {
  delete doc.modelContext;
});

const tool = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  description: `The ${name} tool.`,
  inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
  execute: vi.fn((args: Record<string, unknown>) => `ran ${name} with ${JSON.stringify(args)}`),
  ...extra,
});

describe('the local shim', () => {
  it('registers, lists alphabetically, executes and unregisters by signal, firing toolchange', async () => {
    const context = createModelContext();
    const changes = vi.fn();
    context.addEventListener('toolchange', changes);
    const controller = new AbortController();
    context.registerTool(tool('zeta'), { signal: controller.signal });
    context.registerTool(tool('alpha', { annotations: { readOnlyHint: true } }));
    expect(changes).toHaveBeenCalledTimes(2);

    const tools = await context.getTools();
    expect(tools.map((t) => t.name)).toEqual(['alpha', 'zeta']);
    expect(tools[0]).toMatchObject({ description: 'The alpha tool.', annotations: { readOnlyHint: true }, origin: location.origin });

    expect(await context.executeTool(tools[1]!, { q: 'x' })).toBe('ran zeta with {"q":"x"}');
    expect(await context.executeTool(tools[1]!, '{"q":"y"}' as never)).toBe('ran zeta with {"q":"y"}');

    controller.abort();
    expect(changes).toHaveBeenCalledTimes(3);
    expect((await context.getTools()).map((t) => t.name)).toEqual(['alpha']);
    await expect(context.executeTool(tools[1]!, {})).rejects.toThrow('no tool named "zeta"');
  });

  it('validates descriptors and refuses duplicates', () => {
    const context = createModelContext();
    expect(() => context.registerTool({ ...tool('a'), name: '' })).toThrow(TypeError);
    expect(() => context.registerTool({ ...tool('a'), description: '' })).toThrow(TypeError);
    expect(() => context.registerTool({ ...tool('a'), execute: undefined } as never)).toThrow(TypeError);
    context.registerTool(tool('a'));
    expect(() => context.registerTool(tool('a'))).toThrow('already registered');
  });

  it('ignores a registration whose signal is already aborted and passes the call signal to execute', async () => {
    const context = createModelContext();
    const controller = new AbortController();
    controller.abort();
    context.registerTool(tool('gone'), { signal: controller.signal });
    expect(await context.getTools()).toEqual([]);

    const seen: unknown[] = [];
    context.registerTool({ ...tool('s'), execute: (_a: unknown, o: { signal?: AbortSignal }) => seen.push(o.signal) });
    const call = new AbortController();
    await context.executeTool({ name: 's', description: '' }, {}, { signal: call.signal });
    expect(seen[0]).toBe(call.signal);
    call.abort();
    await expect(context.executeTool({ name: 's', description: '' }, {}, { signal: call.signal })).rejects.toThrow('stopped');
  });

  it('a re-registered tool is not removed by the old signal', async () => {
    const context = createModelContext();
    const first = new AbortController();
    context.registerTool(tool('t'), { signal: first.signal });
    first.abort();
    context.registerTool(tool('t'));
    first.abort();
    expect((await context.getTools()).map((t) => t.name)).toEqual(['t']);
  });
});

describe('installShim', () => {
  it('installs on document when absent and returns the same object next time', () => {
    expect(hasNativeModelContext()).toBe(false);
    const shim = installShim();
    expect(doc.modelContext).toBe(shim);
    expect(isShim(shim)).toBe(true);
    expect(installShim()).toBe(shim);
    expect(hasNativeModelContext()).toBe(false);
  });

  it('never overrides a native modelContext', () => {
    const native = { registerTool: vi.fn(), getTools: vi.fn(async () => []), executeTool: vi.fn() };
    doc.modelContext = native;
    expect(installShim()).toBe(native);
    expect(doc.modelContext).toBe(native);
    expect(hasNativeModelContext()).toBe(true);
  });

  it('the agent uses the native consumer API when present', async () => {
    const native = {
      getTools: vi.fn(async () => [{ name: 'n', description: 'Native.', inputSchema: '{"type":"object"}', annotations: { readOnlyHint: true } }]),
      executeTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'native result' }] })),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    doc.modelContext = native;
    const { model, requests } = scripted([call('n', { a: 1 }), answer('ok')]);
    const agent = createSiteAgent({ model });
    await agent.run('x').done;
    expect(native.executeTool).toHaveBeenCalledWith(expect.objectContaining({ name: 'n' }), { a: 1 }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(requests[0]?.tools[0]?.inputSchema).toEqual({ type: 'object' });
    expect(requests[1]?.messages.at(-1)).toMatchObject({ content: 'native result' });
    const off = agent.onToolsChange(() => {});
    expect(native.addEventListener).toHaveBeenCalledWith('toolchange', expect.any(Function));
    off();
    expect(native.removeEventListener).toHaveBeenCalled();
  });

  it('reports a producer-only modelContext honestly', async () => {
    doc.modelContext = { registerTool: vi.fn() };
    const { model } = scripted([answer('x')]);
    const result = await createSiteAgent({ model }).run('x').done;
    expect(result.error?.code).toBe('no-tools');
  });

  it('the agent installs the shim when nothing is there and sees tools registered on it', async () => {
    const { model, requests } = scripted([answer('ok')]);
    const agent = createSiteAgent({ model });
    installShim().registerTool(tool('late'));
    await agent.run('x').done;
    expect(requests[0]?.tools.map((t) => t.name)).toEqual(['late']);
  });
});
