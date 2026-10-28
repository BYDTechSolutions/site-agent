import { describe, expect, it } from 'vitest';
import { createSiteAgent, replay, type ConfirmRequest, type ToolDescriptor, type Trace } from '../src/index.js';
import { answer, call, scripted, shopTools, type ShopLog } from './helpers.js';

async function recordedTrace(): Promise<Trace> {
  const { model } = scripted([
    call('search_products', { query: 'mug' }),
    call('add_to_cart', { productId: 'm1', quantity: 2 }),
    call('add_to_cart', { productId: 'm1' }),
    call('checkout'),
    answer('Ordered.'),
  ]);
  const result = await createSiteAgent({ model, tools: shopTools(), confirm: () => true }).run('buy two mugs').done;
  return JSON.parse(JSON.stringify(result.trace)) as Trace;
}

describe('replay', () => {
  it('re-runs the recorded calls in order without a model and reports matches', async () => {
    const trace = await recordedTrace();
    const log: ShopLog = { calls: [] };
    const asked: string[] = [];
    const result = await replay(trace, { tools: shopTools(log), confirm: (r) => (asked.push(r.call.name), true) });
    expect(log.calls.map((c) => c.name)).toEqual(['search_products', 'add_to_cart', 'checkout']);
    expect(result.steps.map((s) => s.status)).toEqual(['ran', 'ran', 'ran']);
    expect(result.steps.every((s) => s.matches)).toBe(true);
    expect(result.differences).toBe(0);
    expect(asked).toEqual(['add_to_cart', 'checkout']);
  });

  it('still honors the confirmation rules', async () => {
    const trace = await recordedTrace();
    const log: ShopLog = { calls: [] };
    const reasons: string[] = [];
    const result = await replay(trace, {
      tools: shopTools(log),
      preApproved: ['add_to_cart', 'checkout'],
      confirm: (r: ConfirmRequest) => {
        reasons.push(`${r.call.name}:${r.reason}`);
        return false;
      },
    });
    expect(reasons).toEqual(['checkout:consequential']);
    expect(log.calls.map((c) => c.name)).toEqual(['search_products', 'add_to_cart']);
    expect(result.steps.at(-1)).toMatchObject({ status: 'denied', decision: { allowed: false, by: 'visitor' } });
    expect(result.differences).toBe(1);
  });

  it('denies calls that need asking when there is no confirm', async () => {
    const trace = await recordedTrace();
    const result = await replay(trace, { tools: shopTools() });
    expect(result.steps.map((s) => s.status)).toEqual(['ran', 'denied', 'denied']);
  });

  it('reports changed results, missing tools and arguments that no longer fit', async () => {
    const trace = await recordedTrace();
    const changed = shopTools(undefined, {
      search_products: { execute: () => 'Nothing found.' },
      add_to_cart: { inputSchema: { type: 'object', properties: { sku: { type: 'string' } }, required: ['sku'] } },
    }).filter((t) => t.name !== 'checkout');
    const result = await replay(trace, { tools: changed, confirm: () => true });
    expect(result.steps.map((s) => s.status)).toEqual(['ran', 'invalid-arguments', 'missing-tool']);
    expect(result.steps[0]).toMatchObject({ matches: false, text: 'Nothing found.', recorded: { text: 'Found: mug (id m1) for "mug"' } });
    expect(result.steps[1]?.problems).toEqual(['sku is required']);
    expect(result.differences).toBe(3);
  });

  it('can be aborted', async () => {
    const trace = await recordedTrace();
    const controller = new AbortController();
    const tools: ToolDescriptor[] = shopTools(undefined, {
      search_products: {
        execute: () => {
          controller.abort();
          return new Promise(() => {});
        },
      },
    });
    const result = await replay(trace, { tools, signal: controller.signal });
    expect(result.aborted).toBe(true);
    expect(result.steps).toEqual([]);
  });

  it('rejects something that is not a trace', async () => {
    await expect(replay({} as Trace)).rejects.toThrow(TypeError);
  });
});
