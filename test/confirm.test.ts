import { describe, expect, it, vi } from 'vitest';
import { createSiteAgent, toAgentTool, verdictFor, type ConfirmRequest, type ModelContextLike } from '../src/index.js';
import { answer, call, scripted, shopTools, type ShopLog } from './helpers.js';

const cartCall = call('add_to_cart', { productId: 'm1', quantity: 2 });

async function runWith(
  replies: Parameters<typeof scripted>[0],
  options: { confirm?: (r: ConfirmRequest) => boolean | Promise<boolean>; preApproved?: string[] } = {},
) {
  const log: ShopLog = { calls: [] };
  const asked: ConfirmRequest[] = [];
  const { model, requests } = scripted(replies);
  const agent = createSiteAgent({
    model,
    tools: shopTools(log),
    ...(options.preApproved ? { preApproved: options.preApproved } : {}),
    ...(options.confirm
      ? {
          confirm: (r: ConfirmRequest) => {
            asked.push(r);
            return options.confirm!(r);
          },
        }
      : {}),
  });
  const result = await agent.run('go').done;
  return { log, asked, requests, result, agent };
}

describe('confirmation rules', () => {
  it('runs readOnlyHint tools without asking', async () => {
    const confirm = vi.fn(() => false);
    const { log, asked, result } = await runWith([call('search_products', { query: 'mug' }), answer('ok')], { confirm });
    expect(asked).toHaveLength(0);
    expect(log.calls.map((c) => c.name)).toEqual(['search_products']);
    expect(result.trace.steps.find((s) => s.type === 'decision')).toMatchObject({ decision: { allowed: true, by: 'read-only' } });
  });

  it('asks before any tool that is not read-only, with the arguments in plain words', async () => {
    const { log, asked } = await runWith([cartCall, answer('ok')], { confirm: () => true });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ reason: 'not-read-only', tool: { name: 'add_to_cart', description: 'Add a product to the cart.' } });
    expect(asked[0]?.lines).toEqual([
      { key: 'productId', label: 'Product', value: 'm1' },
      { key: 'quantity', label: 'Quantity', value: '2' },
    ]);
    expect(log.calls.map((c) => c.name)).toEqual(['add_to_cart']);
  });

  it('reports a denied call to the model as denied and does not run it', async () => {
    const { log, requests, result } = await runWith([cartCall, answer('not added')], { confirm: () => false });
    expect(log.calls).toEqual([]);
    const fed = requests[1]?.messages.at(-1);
    expect(fed).toMatchObject({ role: 'tool', isError: true });
    expect((fed as { content: string }).content).toContain('the visitor denied this call');
    expect(result.trace.steps.find((s) => s.type === 'decision')).toMatchObject({ decision: { allowed: false, by: 'visitor' } });
  });

  it('only a strict true allows a call', async () => {
    const { log } = await runWith([cartCall, answer('x')], { confirm: () => 'yes' as unknown as boolean });
    expect(log.calls).toEqual([]);
  });

  it('denies non-read-only calls when no confirm is provided (never auto-allows)', async () => {
    const { log, requests, result } = await runWith([cartCall, call('search_products', { query: 'q' }), answer('x')]);
    expect(log.calls.map((c) => c.name)).toEqual(['search_products']);
    expect((requests[1]?.messages.at(-1) as { content: string }).content).toContain('no way to ask');
    expect(result.trace.steps.find((s) => s.type === 'decision')).toMatchObject({ decision: { allowed: false, by: 'no-confirm' } });
  });

  it('skips asking for pre-approved names', async () => {
    const confirm = vi.fn(() => false);
    const { log, asked, result } = await runWith([cartCall, answer('ok')], { confirm, preApproved: ['add_to_cart'] });
    expect(asked).toHaveLength(0);
    expect(log.calls.map((c) => c.name)).toEqual(['add_to_cart']);
    expect(result.trace.steps.find((s) => s.type === 'decision')).toMatchObject({ decision: { allowed: true, by: 'pre-approved' } });
  });

  it('always asks for consequentialHint tools, even when pre-approved', async () => {
    const { asked, log } = await runWith([call('checkout'), answer('ok')], { confirm: () => true, preApproved: ['checkout'] });
    expect(asked.map((a) => a.reason)).toEqual(['consequential']);
    expect(log.calls.map((c) => c.name)).toEqual(['checkout']);
  });

  it('a pre-approved consequential tool without confirm is denied', async () => {
    const { log } = await runWith([call('checkout'), answer('ok')], { preApproved: ['checkout'] });
    expect(log.calls).toEqual([]);
  });

  it('consequentialHint wins over readOnlyHint', () => {
    const tool = toAgentTool({ name: 't', description: 'd', annotations: { readOnlyHint: true, consequentialHint: true } });
    expect(verdictFor(tool, new Set(['t']), { tainted: false })).toEqual({ ask: true, reason: 'consequential' });
  });

  it('after untrusted output, every non-read-only call asks even if pre-approved, also after an allow', async () => {
    const { asked, log } = await runWith(
      [call('read_reviews', { productId: 'm1' }), call('search_products', { query: 'q' }), cartCall, cartCall, answer('ok')],
      { confirm: () => true, preApproved: ['add_to_cart'] },
    );
    // reviews (read-only, untrusted) → search (read-only, no ask) → cart asks → cart asks again: the reviews are still in context
    expect(asked.map((a) => a.reason)).toEqual(['after-untrusted', 'after-untrusted']);
    expect(log.calls.map((c) => c.name)).toEqual(['read_reviews', 'search_products', 'add_to_cart', 'add_to_cart']);
  });

  it('a denied call after untrusted output keeps the next call asking', async () => {
    const answers = [false, true];
    const { asked } = await runWith([call('read_reviews', { productId: 'm1' }), cartCall, cartCall, answer('ok')], {
      confirm: () => answers.shift() ?? false,
      preApproved: ['add_to_cart'],
    });
    expect(asked.map((a) => a.reason)).toEqual(['after-untrusted', 'after-untrusted']);
  });

  it('the untrusted state carries over to the next run and reset() clears it', async () => {
    const { model } = scripted([call('read_reviews', { productId: 'm1' }), answer('read'), cartCall, answer('ok'), cartCall, answer('ok')]);
    const asked: string[] = [];
    const agent = createSiteAgent({
      model,
      tools: shopTools(),
      preApproved: ['add_to_cart'],
      confirm: (r) => {
        asked.push(r.reason);
        return false;
      },
    });
    await agent.run('reviews').done;
    await agent.run('add').done;
    expect(asked).toEqual(['after-untrusted']);
    agent.reset();
    await agent.run('add').done;
    expect(asked).toEqual(['after-untrusted']);
  });

  it('asks every time for tools whose annotations the browser did not provide, ignoring pre-approval', async () => {
    const executed: string[] = [];
    const context: ModelContextLike = {
      getTools: async () => [{ name: 'lookup', description: 'Look something up.', inputSchema: { type: 'object', properties: {} } }],
      executeTool: async (tool) => {
        executed.push(tool.name);
        return 'ok';
      },
    };
    const asked: string[] = [];
    const { model } = scripted([call('lookup'), answer('done')]);
    const agent = createSiteAgent({ model, tools: context, preApproved: ['lookup'], confirm: (r) => (asked.push(r.reason), true) });
    await agent.run('x').done;
    expect(asked).toEqual(['annotations-unknown']);
    expect(executed).toEqual(['lookup']);
  });

  it('emits confirm-request before confirm-result', async () => {
    const { model } = scripted([cartCall, answer('ok')]);
    const run = createSiteAgent({ model, tools: shopTools(), confirm: () => true }).run('x');
    const types: string[] = [];
    for await (const e of run) types.push(e.type);
    expect(types).toEqual(['thinking', 'tool-call', 'confirm-request', 'confirm-result', 'tool-result', 'thinking', 'answer', 'done']);
  });
});
