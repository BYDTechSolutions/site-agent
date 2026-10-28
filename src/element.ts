/**
 * @bydtech/site-agent/element: importing this module defines `<site-agent>` (once) and installs
 * the local WebMCP shim when the browser has no `document.modelContext`.
 */
import { createSiteAgent, type AgentRun, type SiteAgent } from './agent.js';
import { chromeBuiltIn } from './models/chrome.js';
import { firstAvailable } from './models/first-available.js';
import { proxy } from './models/proxy.js';
import { installShim, type ToolsOption } from './tools.js';
import type { AgentEvent, ConfirmFn, ConfirmReason, ConfirmRequest, ModelAdapter, RunResult, Trace } from './types.js';

/** Options set from JavaScript; they win over attributes. */
export interface SiteAgentElementOptions {
  model?: ModelAdapter;
  /** Replace the built-in confirmation card. */
  confirm?: ConfirmFn;
  instructions?: string;
  preApproved?: string[];
  maxSteps?: number;
  toolTimeoutMs?: number;
  tools?: ToolsOption;
}

const REASONS: Record<ConfirmReason, string> = {
  'not-read-only': 'This action may change something on this site.',
  consequential: 'This action is marked as significant or hard to undo.',
  'after-untrusted': 'The assistant just read content written by others (such as reviews). Check this request is what you want.',
  'annotations-unknown': 'This browser did not say what kind of action this is, so the assistant asks every time.',
};

const STYLE = `
:host{--site-agent-accent:#0f766e;--site-agent-accent-fg:#fff;--site-agent-bg:#fff;--site-agent-fg:#1f2328;--site-agent-muted:#57606a;--site-agent-border:#d0d7de;--site-agent-surface:#f3f5f7;--site-agent-danger:#b42318;--site-agent-radius:12px;--site-agent-font:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;--site-agent-z:2147483000;position:fixed;right:16px;bottom:16px;z-index:var(--site-agent-z);font:15px/1.45 var(--site-agent-font);color:var(--site-agent-fg)}
@media (prefers-color-scheme:dark){:host{--site-agent-accent:#2dd4bf;--site-agent-accent-fg:#04201d;--site-agent-bg:#161b22;--site-agent-fg:#e6edf3;--site-agent-muted:#9da7b3;--site-agent-border:#30363d;--site-agent-surface:#0d1117;--site-agent-danger:#ff7b72}}
[hidden]{display:none!important}
*{box-sizing:border-box}
button{font:inherit;cursor:pointer;border-radius:999px;border:1px solid var(--site-agent-border);background:var(--site-agent-bg);color:var(--site-agent-fg);padding:6px 14px}
button:focus-visible,textarea:focus-visible,.confirm:focus-visible{outline:2px solid var(--site-agent-accent);outline-offset:2px}
button:disabled{opacity:.55;cursor:default}
.primary{background:var(--site-agent-accent);color:var(--site-agent-accent-fg);border-color:transparent}
.launcher{display:block;margin-left:auto;padding:10px 18px;box-shadow:0 4px 16px rgba(0,0,0,.18)}
.panel{display:flex;flex-direction:column;width:min(380px,calc(100vw - 32px));max-height:min(600px,calc(100vh - 96px));margin-bottom:12px;background:var(--site-agent-bg);border:1px solid var(--site-agent-border);border-radius:var(--site-agent-radius);box-shadow:0 12px 40px rgba(0,0,0,.25);overflow:hidden}
header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px 10px 16px;border-bottom:1px solid var(--site-agent-border)}
h2{font-size:15px;margin:0}
.close{padding:2px 10px}
.status{padding:10px 16px;background:var(--site-agent-surface);border-bottom:1px solid var(--site-agent-border);font-size:14px}
.status p{margin:0 0 8px}
.log{list-style:none;margin:0;padding:12px 16px;overflow-y:auto;flex:1;display:flex;flex-direction:column;gap:8px;min-height:120px}
.msg{white-space:pre-wrap;overflow-wrap:anywhere;padding:8px 12px;border-radius:var(--site-agent-radius);max-width:90%}
.user{align-self:flex-end;background:var(--site-agent-accent);color:var(--site-agent-accent-fg)}
.agent{align-self:flex-start;background:var(--site-agent-surface)}
.event{align-self:flex-start;color:var(--site-agent-muted);font-size:13px;padding:0 4px}
.error{align-self:flex-start;color:var(--site-agent-danger);font-size:14px;padding:0 4px}
.confirm{border:1px solid var(--site-agent-border);border-radius:var(--site-agent-radius);padding:12px;background:var(--site-agent-surface)}
.confirm h3{font-size:14px;margin:0 0 6px}
.confirm p{margin:0 0 6px}
.confirm .why,.confirm .empty{color:var(--site-agent-muted);font-size:13px}
.confirm dl{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;margin:6px 0 10px;font-size:14px}
.confirm dt{color:var(--site-agent-muted)}
.confirm dd{margin:0;overflow-wrap:anywhere}
.actions{display:flex;gap:8px}
form{display:flex;gap:8px;padding:10px 12px;border-top:1px solid var(--site-agent-border)}
textarea{flex:1;resize:none;font:inherit;color:inherit;background:var(--site-agent-bg);border:1px solid var(--site-agent-border);border-radius:10px;padding:8px 10px;min-height:40px;max-height:120px}
.note{margin:0;padding:0 16px 10px;color:var(--site-agent-muted);font-size:12px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
`;

const TEMPLATE = `
<section class="panel" part="panel" role="dialog" aria-labelledby="sa-title" hidden>
  <header><h2 id="sa-title"></h2><button type="button" class="close" aria-label="Close the assistant">×</button></header>
  <div class="status" hidden></div>
  <ol class="log" aria-live="polite" aria-relevant="additions"></ol>
  <form>
    <label class="sr" for="sa-input">Message</label>
    <textarea id="sa-input" rows="1"></textarea>
    <button type="submit" class="primary send">Send</button>
    <button type="button" class="stop" hidden>Stop</button>
  </form>
  <p class="note">It can only use the actions this site provides, and asks before changing anything.</p>
</section>
<button type="button" class="launcher primary" part="launcher" aria-expanded="false"></button>
`;

const Base: typeof HTMLElement = typeof HTMLElement === 'undefined' ? (class {} as unknown as typeof HTMLElement) : HTMLElement;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function list(value: string | null): string[] {
  return (value ?? '').split(/[\s,]+/).filter(Boolean);
}

/**
 * `<site-agent>`: a launcher button and a chat panel over the page's WebMCP tools.
 *
 * Attributes: `proxy-url`, `models` (`"chrome proxy"`, `"proxy"`, `"chrome"`), `pre-approved`,
 * `max-steps`, `label`, `placeholder`, `heading`, `instructions`, `open`.
 * Property: `options` (see `SiteAgentElementOptions`). Methods: `show()`, `hide()`, `ask(text)`,
 * `reset()`. Events: `site-agent-event` (each `AgentEvent`) and `site-agent-done` (the `RunResult`).
 */
export class SiteAgentElement extends Base {
  static observedAttributes = ['proxy-url', 'models', 'pre-approved', 'max-steps', 'label', 'placeholder', 'heading', 'instructions', 'open'];

  #options: SiteAgentElementOptions = {};
  #agent: SiteAgent | undefined;
  #run: AgentRun | undefined;
  #pending: { resolve: (allowed: boolean) => void; card: HTMLElement } | undefined;
  #root!: ShadowRoot;
  #ui!: {
    launcher: HTMLButtonElement;
    panel: HTMLElement;
    title: HTMLElement;
    close: HTMLButtonElement;
    status: HTMLElement;
    log: HTMLOListElement;
    form: HTMLFormElement;
    input: HTMLTextAreaElement;
    send: HTMLButtonElement;
    stop: HTMLButtonElement;
  };
  #checkedAvailability = false;
  #stale = false;
  /** The trace of the last finished run. */
  lastTrace: Trace | undefined;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    const style = el('style');
    style.textContent = STYLE;
    const holder = el('div');
    holder.innerHTML = TEMPLATE; // static markup only; nothing from the model or the page goes through innerHTML
    this.#root.append(style, ...Array.from(holder.childNodes));
    const q = <T extends Element>(selector: string) => this.#root.querySelector(selector) as T;
    this.#ui = {
      launcher: q('.launcher'),
      panel: q('.panel'),
      title: q('#sa-title'),
      close: q('.close'),
      status: q('.status'),
      log: q('.log'),
      form: q('form'),
      input: q('textarea'),
      send: q('.send'),
      stop: q('.stop'),
    };
    const id = `sa-panel-${Math.random().toString(36).slice(2, 8)}`;
    this.#ui.panel.id = id;
    this.#ui.launcher.setAttribute('aria-controls', id);
    this.#ui.launcher.addEventListener('click', () => (this.#ui.panel.hidden ? this.show() : this.hide()));
    this.#ui.close.addEventListener('click', () => this.hide());
    this.#ui.stop.addEventListener('click', () => this.#run?.abort());
    this.#ui.form.addEventListener('submit', (event) => {
      event.preventDefault();
      const text = this.#ui.input.value.trim();
      if (text) void this.ask(text);
    });
    this.#ui.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        this.#ui.form.requestSubmit();
      }
    });
    this.#root.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Escape' && !this.#ui.panel.hidden) {
        event.stopPropagation();
        this.hide();
      }
    });
    this.#renderText();
  }

  connectedCallback(): void {
    if (this.hasAttribute('open')) this.show();
  }

  disconnectedCallback(): void {
    this.#run?.abort();
    this.#settle(false);
  }

  attributeChangedCallback(name: string): void {
    if (name === 'label' || name === 'placeholder' || name === 'heading') this.#renderText();
    else if (name === 'open') {
      if (this.hasAttribute('open')) this.show();
    } else this.#invalidate();
  }

  /** Full options from JavaScript: a custom model, a confirm override, instructions, tools. */
  get options(): SiteAgentElementOptions {
    return { ...this.#options };
  }

  set options(value: SiteAgentElementOptions) {
    this.#options = { ...value };
    this.#invalidate();
  }

  /** Merges options into the current ones. */
  configure(value: SiteAgentElementOptions): void {
    this.options = { ...this.#options, ...value };
  }

  /** The agent behind the element, created on first use from the attributes and options. */
  get agent(): SiteAgent {
    if (!this.#agent) {
      const preApproved = this.#options.preApproved ?? list(this.getAttribute('pre-approved'));
      const maxSteps = this.#options.maxSteps ?? (Number(this.getAttribute('max-steps')) || undefined);
      const instructions = this.#options.instructions ?? this.getAttribute('instructions') ?? undefined;
      this.#agent = createSiteAgent({
        model: this.#options.model ?? this.#modelFromAttributes(),
        confirm: this.#options.confirm ?? ((request, { signal }) => this.#askVisitor(request, signal)),
        preApproved,
        ...(maxSteps ? { maxSteps } : {}),
        ...(instructions ? { instructions } : {}),
        ...(this.#options.toolTimeoutMs ? { toolTimeoutMs: this.#options.toolTimeoutMs } : {}),
        ...(this.#options.tools ? { tools: this.#options.tools } : {}),
      });
    }
    return this.#agent;
  }

  show(): void {
    this.#ui.panel.hidden = false;
    this.#ui.launcher.setAttribute('aria-expanded', 'true');
    this.#ui.input.focus();
    if (!this.#checkedAvailability) {
      this.#checkedAvailability = true;
      void this.#refreshAvailability();
    }
  }

  hide(): void {
    if (this.#ui.panel.hidden) return;
    this.#settle(false);
    this.#ui.panel.hidden = true;
    this.#ui.launcher.setAttribute('aria-expanded', 'false');
    this.#ui.launcher.focus();
  }

  /** Clears the conversation on screen and in the agent. */
  reset(): void {
    this.#run?.abort();
    this.#settle(false);
    this.#agent?.reset();
    this.#ui.log.replaceChildren();
  }

  /** Sends a message as if the visitor typed it. Resolves with the run's result. */
  async ask(text: string): Promise<RunResult | undefined> {
    if (this.#run) return undefined;
    if (this.#ui.panel.hidden) this.show();
    let agent: SiteAgent;
    try {
      agent = this.agent;
    } catch (error) {
      this.#append('error', error instanceof Error ? error.message : String(error));
      return undefined;
    }
    this.#ui.input.value = '';
    this.#append('user', text);
    this.#busy(true);
    const run = agent.run(text);
    this.#run = run;
    try {
      for await (const event of run) this.#onEvent(event);
      const result = await run.done;
      this.lastTrace = result.trace;
      this.dispatchEvent(new CustomEvent('site-agent-done', { detail: result, bubbles: true, composed: true }));
      return result;
    } finally {
      this.#run = undefined;
      this.#busy(false);
      if (this.#stale) {
        this.#stale = false;
        this.#invalidate();
      }
    }
  }

  #invalidate(): void {
    if (this.#run) {
      this.#stale = true; // applied when the current run ends
      return;
    }
    this.#agent = undefined;
    this.#checkedAvailability = false;
  }

  #modelFromAttributes(): ModelAdapter {
    const url = this.getAttribute('proxy-url');
    const names = list(this.getAttribute('models') ?? (url ? 'chrome proxy' : 'chrome'));
    const models: ModelAdapter[] = [];
    for (const name of names) {
      if (name === 'chrome') models.push(chromeBuiltIn());
      else if (name === 'proxy') {
        if (url) models.push(proxy({ url }));
        else console.warn('<site-agent>: models includes "proxy" but proxy-url is not set.');
      } else console.warn(`<site-agent>: unknown model "${name}" in models.`);
    }
    if (models.length === 0) models.push(chromeBuiltIn());
    return models.length === 1 ? (models[0] as ModelAdapter) : firstAvailable(...models);
  }

  #renderText(): void {
    this.#ui.launcher.textContent = this.getAttribute('label') ?? 'Ask this site';
    this.#ui.title.textContent = this.getAttribute('heading') ?? this.getAttribute('label') ?? 'Ask this site';
    this.#ui.input.placeholder = this.getAttribute('placeholder') ?? 'What can I do for you?';
  }

  #busy(on: boolean): void {
    this.#ui.send.disabled = on;
    this.#ui.stop.hidden = !on;
  }

  #append(kind: 'user' | 'agent' | 'event' | 'error', text: string): HTMLLIElement {
    const item = el('li', `msg ${kind}`, text);
    this.#ui.log.append(item);
    item.scrollIntoView?.({ block: 'end' });
    return item;
  }

  #onEvent(event: AgentEvent): void {
    this.dispatchEvent(new CustomEvent('site-agent-event', { detail: event, bubbles: true, composed: true }));
    switch (event.type) {
      case 'confirm-result':
        // Shown after the decision: confirmation cards are added while the run waits, before this event is read.
        if (event.decision.allowed) this.#append('event', `Using ${event.call.name}…`);
        else if (event.decision.by === 'no-confirm') {
          this.#append('event', `${event.call.name} needs your permission, and this page cannot ask, so it was not run.`);
        }
        break;
      case 'answer':
        this.#append('agent', event.text || '(no answer)');
        break;
      case 'error':
        if (event.code === 'aborted') this.#append('event', 'Stopped.');
        else if (event.code === 'model-download-required') {
          this.#append('error', event.message);
          void this.#refreshAvailability();
        } else this.#append('error', event.message);
        break;
      default:
        break;
    }
  }

  /** The built-in confirmation card. Resolves `true` only when the visitor clicks Allow. */
  #askVisitor(request: ConfirmRequest, signal: AbortSignal): Promise<boolean> {
    this.#settle(false);
    if (this.#ui.panel.hidden) this.show();
    const card = el('li', 'confirm');
    card.tabIndex = -1;
    card.setAttribute('role', 'group');
    const headingId = `sa-confirm-${request.call.id.replace(/[^A-Za-z0-9_-]/g, '')}`;
    card.setAttribute('aria-labelledby', headingId);
    const heading = el('h3', undefined, 'Allow this action?');
    heading.id = headingId;
    const name = el('p');
    name.append(el('strong', undefined, request.tool.title || request.tool.name));
    const description = el('p', undefined, request.tool.description);
    const why = el('p', 'why', REASONS[request.reason]);
    card.append(heading, name, description);
    if (request.lines.length) {
      const dl = el('dl');
      for (const line of request.lines) dl.append(el('dt', undefined, line.label), el('dd', undefined, line.value));
      card.append(dl);
    } else {
      card.append(el('p', 'empty', 'No details to show.'));
    }
    const allow = el('button', 'primary', 'Allow');
    const deny = el('button', undefined, 'Deny');
    allow.type = deny.type = 'button';
    allow.setAttribute('aria-label', `Allow ${request.tool.title || request.tool.name}`);
    deny.setAttribute('aria-label', `Deny ${request.tool.title || request.tool.name}`);
    const actions = el('div', 'actions');
    actions.append(allow, deny);
    card.append(why, actions);
    this.#ui.log.append(card);
    card.scrollIntoView?.({ block: 'end' });
    card.focus();
    return new Promise<boolean>((resolve) => {
      this.#pending = { resolve, card };
      allow.addEventListener('click', () => this.#settle(true));
      deny.addEventListener('click', () => this.#settle(false));
      signal.addEventListener('abort', () => this.#settle(false), { once: true });
    });
  }

  #settle(allowed: boolean): void {
    const pending = this.#pending;
    if (!pending) return;
    this.#pending = undefined;
    for (const button of Array.from(pending.card.querySelectorAll('button'))) button.disabled = true;
    pending.card.append(el('p', 'why', allowed ? 'Allowed.' : 'Denied.'));
    pending.resolve(allowed);
    if (!this.#ui.panel.hidden) this.#ui.input.focus();
  }

  async #refreshAvailability(): Promise<void> {
    const status = this.#ui.status;
    let agent: SiteAgent;
    try {
      agent = this.agent;
    } catch {
      return;
    }
    const model = agent.model;
    const state = model.availability ? await model.availability() : 'available';
    // An optional on-device model in a chain whose other model already works.
    const chromeChild = model.models?.find((m) => m.name === 'chrome-built-in');
    const childState = chromeChild?.availability ? await chromeChild.availability() : undefined;
    status.replaceChildren();
    status.hidden = true;
    this.#ui.input.disabled = false;
    if (state === 'unavailable') {
      status.append(el('p', undefined, 'No AI model is available in this browser, so the assistant cannot answer here.'));
      status.hidden = false;
      this.#ui.input.disabled = true;
      return;
    }
    const target = state !== 'available' ? model : childState === 'downloadable' ? chromeChild : undefined;
    if (!target?.prepare) return;
    const optional = state === 'available';
    const which = state === 'available' ? childState : state;
    status.append(
      el(
        'p',
        undefined,
        which === 'downloading'
          ? 'The on-device model is downloading.'
          : optional
            ? 'Optional: this browser can run the assistant on your device after a one-time model download.'
            : 'The assistant runs on your device. It needs a one-time model download first.',
      ),
    );
    const button = el('button', 'primary', which === 'downloading' ? 'Show download progress' : 'Download the on-device model');
    button.type = 'button';
    button.addEventListener('click', () => {
      button.disabled = true;
      const progress = el('p', undefined, 'Starting the download…');
      progress.setAttribute('role', 'status');
      status.append(progress);
      target
        .prepare!({ onProgress: (f) => (progress.textContent = `Downloading… ${Math.round(Math.min(1, Math.max(0, f)) * 100)}%`) })
        .then(() => {
          progress.textContent = 'The on-device model is ready.';
          setTimeout(() => void this.#refreshAvailability(), 1500);
        })
        .catch((error: unknown) => {
          progress.textContent = `The download did not start: ${error instanceof Error ? error.message : String(error)}`;
          button.disabled = false;
        });
    });
    status.append(button);
    status.hidden = false;
  }
}

if (typeof document !== 'undefined') installShim();
if (typeof customElements !== 'undefined' && !customElements.get('site-agent')) {
  customElements.define('site-agent', SiteAgentElement);
}

declare global {
  interface HTMLElementTagNameMap {
    'site-agent': SiteAgentElement;
  }
}
