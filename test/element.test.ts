// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { custom, type ModelReply, type RunResult } from '../src/index.js';
import { shopTools, type ShopLog } from './helpers.js';
import '../src/element.js';
import type { SiteAgentElement } from '../src/element.js';

function mount(attrs: Record<string, string> = {}): SiteAgentElement {
  const node = document.createElement('site-agent');
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  document.body.append(node);
  return node;
}

const $ = <T extends Element>(node: SiteAgentElement, selector: string) => node.shadowRoot!.querySelector(selector) as T;
const $$ = (node: SiteAgentElement, selector: string) => Array.from(node.shadowRoot!.querySelectorAll(selector));

function scriptedModel(replies: ModelReply[]) {
  return custom(async () => replies.shift() ?? { type: 'answer', text: 'end' }, { name: 'test' });
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe('<site-agent>', () => {
  it('is defined once, and importing again does not throw', async () => {
    const first = customElements.get('site-agent');
    expect(first).toBeDefined();
    await import('../src/element.js');
    expect(customElements.get('site-agent')).toBe(first);
  });

  it('installs the local shim when the browser has no modelContext', () => {
    expect(typeof (document as unknown as { modelContext: { registerTool: unknown } }).modelContext.registerTool).toBe('function');
  });

  it('renders a labeled launcher and a hidden panel that opens and closes from the keyboard', () => {
    const node = mount({ label: 'Ask the shop', placeholder: 'Try: find a mug' });
    const launcher = $<HTMLButtonElement>(node, '.launcher');
    const panel = $<HTMLElement>(node, '.panel');
    expect(launcher.textContent).toBe('Ask the shop');
    expect(launcher.getAttribute('aria-controls')).toBe(panel.id);
    expect(panel.hidden).toBe(true);
    expect(panel.getAttribute('role')).toBe('dialog');
    expect($<HTMLTextAreaElement>(node, 'textarea').placeholder).toBe('Try: find a mug');
    expect($(node, '.log').getAttribute('aria-live')).toBe('polite');
    expect($(node, 'label[for="sa-input"]')).not.toBeNull();

    launcher.click();
    expect(panel.hidden).toBe(false);
    expect(launcher.getAttribute('aria-expanded')).toBe('true');
    expect(node.shadowRoot!.activeElement).toBe($(node, 'textarea'));

    $(node, 'textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true }));
    expect(panel.hidden).toBe(true);
    expect(launcher.getAttribute('aria-expanded')).toBe('false');
    expect(node.shadowRoot!.activeElement).toBe(launcher);
  });

  it('renders model text as text, never as HTML', async () => {
    const node = mount();
    node.options = { model: scriptedModel([{ type: 'answer', text: '<img src=x onerror="alert(1)"> <b>hi</b>' }]), tools: [] };
    await node.ask('<script>alert(2)</script>');
    expect($$(node, 'img')).toHaveLength(0);
    expect($$(node, 'script')).toHaveLength(0);
    expect($$(node, 'b')).toHaveLength(0);
    const texts = $$(node, '.msg').map((m) => m.textContent);
    expect(texts).toEqual(['<script>alert(2)</script>', '<img src=x onerror="alert(1)"> <b>hi</b>']);
  });

  it('shows a confirmation card with name, description and arguments; Allow runs the tool', async () => {
    const log: ShopLog = { calls: [] };
    const node = mount();
    node.options = {
      model: scriptedModel([{ type: 'tool', name: 'add_to_cart', arguments: { productId: 'm1', quantity: 2 } }, { type: 'answer', text: 'Added.' }]),
      tools: shopTools(log),
    };
    const done = node.ask('add two mugs');
    await vi.waitFor(() => expect($(node, '.confirm')).not.toBeNull());
    const card = $<HTMLElement>(node, '.confirm');
    expect(card.querySelector('h3')?.textContent).toBe('Allow this action?');
    expect(card.textContent).toContain('add_to_cart');
    expect(card.textContent).toContain('Add a product to the cart.');
    expect(Array.from(card.querySelectorAll('dt')).map((d) => d.textContent)).toEqual(['Product', 'Quantity']);
    expect(Array.from(card.querySelectorAll('dd')).map((d) => d.textContent)).toEqual(['m1', '2']);
    expect(node.shadowRoot!.activeElement).toBe(card);
    const [allow, deny] = Array.from(card.querySelectorAll('button'));
    expect(allow?.getAttribute('aria-label')).toBe('Allow add_to_cart');
    expect(deny?.getAttribute('aria-label')).toBe('Deny add_to_cart');
    allow!.click();
    const result = (await done) as RunResult;
    expect(result.answer).toBe('Added.');
    expect(log.calls.map((c) => c.name)).toEqual(['add_to_cart']);
    expect(allow!.disabled).toBe(true);
    expect(card.textContent).toContain('Allowed.');
  });

  it('Deny does not run the tool', async () => {
    const log: ShopLog = { calls: [] };
    const node = mount();
    node.options = { model: scriptedModel([{ type: 'tool', name: 'checkout', arguments: {} }, { type: 'answer', text: 'Not ordered.' }]), tools: shopTools(log) };
    const done = node.ask('buy');
    await vi.waitFor(() => expect($(node, '.confirm')).not.toBeNull());
    expect($(node, '.confirm .why')?.textContent).toContain('significant or hard to undo');
    ($$(node, '.confirm button')[1] as HTMLButtonElement).click();
    await done;
    expect(log.calls).toEqual([]);
    expect($(node, '.confirm').textContent).toContain('Denied.');
  });

  it('closing the panel denies a pending confirmation', async () => {
    const log: ShopLog = { calls: [] };
    const node = mount();
    node.options = { model: scriptedModel([{ type: 'tool', name: 'checkout', arguments: {} }]), tools: shopTools(log) };
    const done = node.ask('buy');
    await vi.waitFor(() => expect($(node, '.confirm')).not.toBeNull());
    node.hide();
    await done;
    expect(log.calls).toEqual([]);
  });

  it('dispatches events and keeps the last trace', async () => {
    const node = mount();
    node.options = { model: scriptedModel([{ type: 'answer', text: 'hi' }]), tools: [] };
    const types: string[] = [];
    node.addEventListener('site-agent-event', (e) => types.push((e as CustomEvent).detail.type));
    const finished = new Promise<RunResult>((resolve) => node.addEventListener('site-agent-done', (e) => resolve((e as CustomEvent).detail)));
    await node.ask('hello');
    expect((await finished).status).toBe('answered');
    expect(types).toEqual(['thinking', 'answer', 'done']);
    expect(node.lastTrace?.steps[0]).toEqual({ type: 'user', text: 'hello' });
  });

  it('builds the model from attributes', () => {
    expect(mount().agent.model.name).toBe('chrome-built-in');
    expect(mount({ 'proxy-url': '/api/agent' }).agent.model.name).toBe('first-available(chrome-built-in,proxy)');
    expect(mount({ 'proxy-url': '/api/agent', models: 'proxy' }).agent.model.name).toBe('proxy');
  });

  it('a custom confirm replaces the card', async () => {
    const log: ShopLog = { calls: [] };
    const node = mount();
    const confirm = vi.fn(async () => true);
    node.options = { model: scriptedModel([{ type: 'tool', name: 'add_to_cart', arguments: { productId: 'm1', quantity: 1 } }]), tools: shopTools(log), confirm };
    await node.ask('add');
    expect(confirm).toHaveBeenCalledOnce();
    expect($(node, '.confirm')).toBeNull();
    expect(log.calls).toHaveLength(1);
  });

  it('says plainly when no model is available', async () => {
    const node = mount();
    node.show();
    await vi.waitFor(() => expect($<HTMLElement>(node, '.status').hidden).toBe(false));
    expect($(node, '.status').textContent).toContain('No AI model is available in this browser');
    expect($<HTMLTextAreaElement>(node, 'textarea').disabled).toBe(true);
  });

  it('offers the on-device model download when it is downloadable', async () => {
    const prepare = vi.fn(async ({ onProgress }: { onProgress?: (f: number) => void } = {}) => onProgress?.(0.25));
    const model = { ...custom(async () => ({ type: 'answer' as const, text: '' }), { name: 'chrome-built-in', availability: async () => 'downloadable' as const }), prepare };
    const node = mount();
    node.options = { model, tools: [] };
    node.show();
    await vi.waitFor(() => expect($(node, '.status button')).not.toBeNull());
    expect($(node, '.status').textContent).toContain('one-time model download');
    ($(node, '.status button') as HTMLButtonElement).click();
    expect(prepare).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect($(node, '.status').textContent).toContain('ready'));
  });
});

describe('<site-agent> options during a run', () => {
  it('applies new options after the current run ends', async () => {
    const node = mount();
    let release!: () => void;
    const first = custom(() => new Promise((resolve) => (release = () => resolve({ type: 'answer', text: 'first' }))), { name: 'first' });
    node.options = { model: first, tools: [] };
    const done = node.ask('one');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    node.configure({ model: scriptedModel([{ type: 'answer', text: 'second' }]) });
    expect(node.agent.model.name).toBe('first');
    release();
    await done;
    expect(node.agent.model.name).toBe('test');
    expect((await node.ask('two'))?.answer).toBe('second');
  });
});
