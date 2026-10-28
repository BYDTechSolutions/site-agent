import { SiteAgentError, abortError } from './errors.js';
import { normalizeSchema } from './schema.js';
import type {
  AgentTool,
  ModelContext,
  ModelContextLike,
  RegisteredTool,
  RegisterToolOptions,
  ToolDescriptor,
} from './types.js';

const SHIM = Symbol.for('@bydtech/site-agent/shim');

type DocumentWithContext = { modelContext?: unknown };

function currentDocument(): DocumentWithContext | undefined {
  return typeof document === 'undefined' ? undefined : (document as unknown as DocumentWithContext);
}

/** True when the object is this package's local shim rather than the browser's own `modelContext`. */
export function isShim(context: unknown): boolean {
  return typeof context === 'object' && context !== null && (context as Record<symbol, unknown>)[SHIM] === true;
}

/** True when the browser itself provides `document.modelContext` with the consumer API (`getTools` and `executeTool`). */
export function hasNativeModelContext(): boolean {
  const context = currentDocument()?.modelContext;
  return isConsumer(context) && !isShim(context);
}

function isConsumer(value: unknown): value is ModelContextLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ModelContextLike).getTools === 'function' &&
    typeof (value as ModelContextLike).executeTool === 'function'
  );
}

interface Entry {
  descriptor: ToolDescriptor;
  registered: RegisteredTool;
}

/**
 * Creates a local, in-memory `modelContext`: `registerTool` (unregister by aborting the signal),
 * `getTools`, `executeTool` and the `toolchange` event. It is not installed anywhere; see
 * `installShim()`. Tools registered here are visible only to code on this page, not to browser or
 * outside agents, and declarative `<form toolname>` tools are not implemented.
 */
export function createModelContext(): ModelContext & EventTarget {
  const target = new EventTarget();
  const tools = new Map<string, Entry>();
  const changed = () => target.dispatchEvent(new Event('toolchange'));
  const origin = typeof location === 'undefined' ? undefined : location.origin;

  const context = Object.assign(target, {
    registerTool(descriptor: ToolDescriptor, options: RegisterToolOptions = {}): void {
      if (!descriptor || typeof descriptor.name !== 'string' || descriptor.name.trim() === '') {
        throw new TypeError('registerTool: a tool needs a non-empty name.');
      }
      if (typeof descriptor.description !== 'string' || descriptor.description.trim() === '') {
        throw new TypeError(`registerTool: tool "${descriptor.name}" needs a description.`);
      }
      if (typeof descriptor.execute !== 'function') {
        throw new TypeError(`registerTool: tool "${descriptor.name}" needs an execute function.`);
      }
      if (tools.has(descriptor.name)) {
        throw new Error(`registerTool: a tool named "${descriptor.name}" is already registered.`);
      }
      if (options.signal?.aborted) return;
      const registered: RegisteredTool = {
        name: descriptor.name,
        ...(descriptor.title ? { title: descriptor.title } : {}),
        description: descriptor.description,
        inputSchema: normalizeSchema(descriptor.inputSchema),
        annotations: { ...descriptor.annotations },
        ...(origin ? { origin } : {}),
        ...(typeof window === 'undefined' ? {} : { window }),
      };
      const entry: Entry = { descriptor, registered };
      tools.set(descriptor.name, entry);
      options.signal?.addEventListener(
        'abort',
        () => {
          if (tools.get(descriptor.name) === entry) {
            tools.delete(descriptor.name);
            changed();
          }
        },
        { once: true },
      );
      changed();
    },

    async getTools(): Promise<RegisteredTool[]> {
      return [...tools.values()]
        .map((entry) => ({ ...entry.registered }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    },

    async executeTool(
      tool: RegisteredTool | string,
      args: Record<string, unknown> | string = {},
      options: { signal?: AbortSignal } = {},
    ): Promise<unknown> {
      const name = typeof tool === 'string' ? tool : tool?.name;
      const entry = name === undefined ? undefined : tools.get(name);
      if (!entry) throw new Error(`executeTool: no tool named "${String(name)}" is registered.`);
      if (options.signal?.aborted) throw abortError();
      const input = typeof args === 'string' ? (JSON.parse(args) as Record<string, unknown>) : args;
      return await entry.descriptor.execute(input ?? {}, { ...(options.signal ? { signal: options.signal } : {}) });
    },
  });
  Object.defineProperty(context, SHIM, { value: true });
  return context as ModelContext & EventTarget;
}

/**
 * Makes `document.modelContext` available so site code can call `registerTool` in every browser.
 * If the browser already has one, it is returned untouched; the shim never replaces it. Without a
 * `document` (Node, workers), it returns a fresh local context without installing it.
 */
export function installShim(): ModelContext {
  const doc = currentDocument();
  if (doc && typeof doc.modelContext === 'object' && doc.modelContext !== null) {
    return doc.modelContext as ModelContext;
  }
  const shim = createModelContext();
  if (doc) {
    Object.defineProperty(doc, 'modelContext', { value: shim, configurable: true, enumerable: true, writable: false });
  }
  return shim;
}

/** Where the agent gets its tools: anything with `getTools` and `executeTool`, or a list of descriptors. */
export type ToolsOption = ModelContextLike | ToolDescriptor[];

/** The agent's view of a tool source. */
export interface ToolSource {
  list(): Promise<AgentTool[]>;
  execute(tool: AgentTool, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
  /** Calls `listener` on `toolchange`; returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

/**
 * Resolves the tool source: the given one, else `document.modelContext` (native or shim), else
 * the shim, installed on `document` when there is one.
 */
export function resolveContext(option?: ToolsOption): ModelContextLike {
  if (Array.isArray(option)) {
    const context = createModelContext();
    for (const tool of option) context.registerTool(tool);
    return context;
  }
  if (option) return option;
  const existing = currentDocument()?.modelContext;
  if (isConsumer(existing)) return existing;
  if (existing !== undefined && existing !== null) {
    throw new SiteAgentError(
      'no-tools',
      'This browser has document.modelContext without getTools()/executeTool(), so an in-page agent cannot list or call its tools.',
    );
  }
  return installShim();
}

export function toAgentTool(tool: RegisteredTool): AgentTool {
  const annotations = tool.annotations;
  const known = typeof annotations === 'object' && annotations !== null;
  return {
    name: tool.name,
    ...(tool.title ? { title: tool.title } : {}),
    description: typeof tool.description === 'string' ? tool.description : '',
    inputSchema: normalizeSchema(tool.inputSchema),
    annotations: {
      readOnlyHint: known && annotations.readOnlyHint === true,
      consequentialHint: known && annotations.consequentialHint === true,
      untrustedContentHint: known && annotations.untrustedContentHint === true,
    },
    annotationsKnown: known,
  };
}

export function toolSource(context: ModelContextLike): ToolSource {
  const raw = new Map<string, RegisteredTool>();
  return {
    async list() {
      const tools = await context.getTools();
      raw.clear();
      for (const tool of tools) raw.set(tool.name, tool);
      return tools.map(toAgentTool);
    },
    async execute(tool, args, signal) {
      let registered = raw.get(tool.name);
      if (!registered) {
        registered = (await context.getTools()).find((t) => t.name === tool.name);
        if (!registered) throw new SiteAgentError('unknown-tool', `The tool "${tool.name}" is no longer registered.`);
      }
      return context.executeTool(registered, args, { signal });
    },
    subscribe(listener) {
      if (typeof context.addEventListener !== 'function') return () => {};
      context.addEventListener('toolchange', listener);
      return () => context.removeEventListener?.('toolchange', listener);
    },
  };
}
