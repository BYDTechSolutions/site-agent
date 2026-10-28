import type { AgentMessage, ModelReply, ModelTool, ToolCall } from '../types.js';
import { PROVIDERS, UpstreamError, type Provider } from './providers.js';

export interface RateLimitOptions {
  /** Window length. Default 60 000 ms. */
  windowMs?: number;
  /** Requests per client IP per window. Default 20. */
  max?: number;
}

export interface ProxyHandlerOptions {
  provider: Provider;
  /** The provider's model ID. Required: there is no default, because model IDs change. */
  model: string;
  /** The provider API key. Read it from an environment variable or secret, never from the request. */
  apiKey: string;
  /** For OpenAI-compatible endpoints, or a provider's regional or gateway URL. */
  baseURL?: string;
  /** Exact origins allowed to call, such as `https://example.com`. Not authentication: see the README. */
  allowedOrigins: string[];
  /** Max output tokens per step. Default 1024. */
  maxTokens?: number;
  /** Max conversation messages per request. Default 40. */
  maxMessages?: number;
  /** Max tools per request. Default 32. */
  maxTools?: number;
  /** Max request body size. Default 65 536 bytes. */
  maxBodyBytes?: number;
  /** Per-IP limit, in memory, per instance. Default 20 requests a minute. `false` turns it off. */
  rateLimit?: RateLimitOptions | false;
  /** Instructions added on the server, before the ones the browser sends. */
  instructions?: string;
  /** Whether to use the instructions the browser sends. Default `true`. */
  allowClientInstructions?: boolean;
  /** Extra request headers to allow in CORS (besides `content-type`). */
  allowHeaders?: string[];
  /** Upstream request timeout. Default 30 000 ms. */
  timeoutMs?: number;
  /**
   * Finds the client IP for the rate limit. Default: the `cf-connecting-ip` header (set by
   * Cloudflare), else the platform's connection info (`context.ip`, Deno's `remoteAddr`, Bun's
   * `requestIP`), else one shared bucket. `X-Forwarded-For` is not read by default: clients can set it.
   */
  clientIp?: (request: Request, context: unknown) => string | undefined;
  /** A `fetch` to use for the provider call. Default: the global `fetch`. */
  fetch?: typeof fetch;
  /** Called with upstream and unexpected errors, for your logs. The client gets a generic message. */
  onError?: (error: unknown) => void;
}

export type ProxyHandler = (request: Request, context?: unknown) => Promise<Response>;

const NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** The default client IP lookup. Exported for tests and custom lookups. */
export function defaultClientIp(request: Request, context: unknown): string | undefined {
  const cf = request.headers.get('cf-connecting-ip');
  if (cf) return cf;
  if (typeof context === 'object' && context !== null) {
    const c = context as {
      ip?: unknown;
      remoteAddr?: { hostname?: unknown };
      requestIP?: (r: Request) => { address?: unknown } | null;
    };
    if (typeof c.ip === 'string') return c.ip;
    if (typeof c.remoteAddr?.hostname === 'string') return c.remoteAddr.hostname;
    if (typeof c.requestIP === 'function') {
      try {
        const address = c.requestIP(request)?.address;
        if (typeof address === 'string') return address;
      } catch {
        // not Bun
      }
    }
  }
  return undefined;
}

/** A sliding-window counter per key, kept in memory. */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private readonly windowMs: number,
    private readonly max: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns 0 when the request may go ahead, else the milliseconds until it may. */
  take(key: string): number {
    const now = this.now();
    const since = now - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > since);
    if (list.length >= this.max) {
      this.hits.set(key, list);
      return Math.max(1, (list[0] as number) + this.windowMs - now);
    }
    list.push(now);
    this.hits.set(key, list);
    if (this.hits.size > 10_000) this.prune(since);
    return 0;
  }

  private prune(since: number): void {
    for (const [key, list] of this.hits) {
      if (!list.some((t) => t > since)) this.hits.delete(key);
    }
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function readBody(request: Request, maxBytes: number): Promise<string> {
  const declared = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) throw new HttpError(413, 'Request body too large.');
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new HttpError(413, 'Request body too large.');
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Checks the browser's request body. Throws `HttpError(400)` with a short reason. */
export function parseProxyRequest(
  raw: unknown,
  limits: { maxMessages: number; maxTools: number },
): { instructions: string; messages: AgentMessage[]; tools: ModelTool[] } {
  if (!isObject(raw)) throw new HttpError(400, 'Expected a JSON object.');
  const { instructions = '', messages, tools = [] } = raw;
  if (!isString(instructions)) throw new HttpError(400, 'instructions must be a string.');
  if (!Array.isArray(messages) || messages.length === 0) throw new HttpError(400, 'messages must be a non-empty array.');
  if (messages.length > limits.maxMessages) throw new HttpError(400, `Too many messages (max ${limits.maxMessages}).`);
  if (!Array.isArray(tools)) throw new HttpError(400, 'tools must be an array.');
  if (tools.length > limits.maxTools) throw new HttpError(400, `Too many tools (max ${limits.maxTools}).`);

  const cleanTools: ModelTool[] = tools.map((t, i) => {
    if (!isObject(t) || !isString(t.name) || t.name === '' || !isString(t.description ?? '')) {
      throw new HttpError(400, `tools[${i}] needs a name and a description.`);
    }
    return { name: t.name, description: (t.description as string | undefined) ?? '', inputSchema: isObject(t.inputSchema) ? t.inputSchema : { type: 'object' } };
  });

  const cleanMessages: AgentMessage[] = messages.map((m, i) => {
    const bad = () => new HttpError(400, `messages[${i}] has an unknown shape.`);
    if (!isObject(m)) throw bad();
    if (m.role === 'user' && isString(m.content)) return { role: 'user', content: m.content };
    if (m.role === 'assistant' && isString(m.content)) return { role: 'assistant', content: m.content };
    if (m.role === 'assistant' && isObject(m.toolCall)) {
      const c = m.toolCall;
      if (!isString(c.id) || !isString(c.name) || !isObject(c.arguments)) throw bad();
      const call: ToolCall = { id: c.id, name: c.name, arguments: c.arguments, ...(isObject(c.meta) ? { meta: c.meta } : {}) };
      return { role: 'assistant', toolCall: call };
    }
    if (m.role === 'tool' && isString(m.toolCallId) && isString(m.name) && isString(m.content)) {
      return { role: 'tool', toolCallId: m.toolCallId, name: m.name, content: m.content, ...(m.isError === true ? { isError: true } : {}) };
    }
    throw bad();
  });
  return { instructions, messages: cleanMessages, tools: cleanTools };
}

/**
 * Provider tool names allow only letters, digits, `_` and `-` (up to 64). WebMCP names may hold
 * more, so names are mapped for the provider and mapped back in the reply.
 */
export function nameMap(tools: ModelTool[]): { out: (name: string) => string; back: (name: string) => string } {
  const toProvider = new Map<string, string>();
  const fromProvider = new Map<string, string>();
  for (const tool of tools) {
    let safe = NAME.test(tool.name) ? tool.name : tool.name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60) || 'tool';
    let n = 2;
    while (fromProvider.has(safe) && fromProvider.get(safe) !== tool.name) safe = `${safe.slice(0, 60)}_${n++}`;
    toProvider.set(tool.name, safe);
    fromProvider.set(safe, tool.name);
  }
  return {
    out: (name) => toProvider.get(name) ?? (NAME.test(name) ? name : name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)),
    back: (name) => fromProvider.get(name) ?? name,
  };
}

/**
 * A standard fetch handler, `(request) => Promise<Response>`, that forwards the agent's steps to a
 * model provider with your key. Use it as a Cloudflare Worker's `fetch`, with `Deno.serve`,
 * `Bun.serve`, or in Node 20+ through a small `node:http` adapter (see the README).
 */
export function createProxyHandler(options: ProxyHandlerOptions): ProxyHandler {
  const provider = PROVIDERS[options?.provider];
  if (!provider) throw new TypeError('createProxyHandler: provider must be "anthropic", "openai" or "gemini".');
  if (!isString(options.model) || options.model.trim() === '') throw new TypeError('createProxyHandler: model is required.');
  if (!isString(options.apiKey) || options.apiKey.trim() === '') throw new TypeError('createProxyHandler: apiKey is required.');
  if (!Array.isArray(options.allowedOrigins) || options.allowedOrigins.length === 0) {
    throw new TypeError('createProxyHandler: allowedOrigins must list at least one origin, such as "https://example.com".');
  }
  for (const origin of options.allowedOrigins) {
    if (origin === '*' || !/^https?:\/\/[^/\s]+$/.test(origin)) {
      throw new TypeError(`createProxyHandler: "${origin}" is not an exact origin (scheme://host[:port], no path, no "*").`);
    }
  }
  const allowed = new Set(options.allowedOrigins);
  const maxTokens = options.maxTokens ?? 1024;
  const maxMessages = options.maxMessages ?? 40;
  const maxTools = options.maxTools ?? 32;
  const maxBodyBytes = options.maxBodyBytes ?? 65_536;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const limiter =
    options.rateLimit === false ? undefined : new RateLimiter(options.rateLimit?.windowMs ?? 60_000, options.rateLimit?.max ?? 20);
  const clientIp = options.clientIp ?? defaultClientIp;
  const allowHeaders = ['content-type', ...(options.allowHeaders ?? []).map((h) => h.toLowerCase())].join(', ');

  const json = (status: number, body: unknown, origin?: string, extra: Record<string, string> = {}) => {
    const headers: Record<string, string> = {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      vary: 'Origin',
      ...extra,
    };
    if (origin) headers['access-control-allow-origin'] = origin;
    return new Response(JSON.stringify(body), { status, headers });
  };

  return async function handler(request: Request, context?: unknown): Promise<Response> {
    const origin = request.headers.get('origin') ?? '';
    if (!allowed.has(origin)) return json(403, { error: 'Origin not allowed.' });

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': origin,
          'access-control-allow-methods': 'POST, OPTIONS',
          'access-control-allow-headers': allowHeaders,
          'access-control-max-age': '600',
          vary: 'Origin',
        },
      });
    }
    if (request.method !== 'POST') return json(405, { error: 'Use POST.' }, origin, { allow: 'POST, OPTIONS' });
    if (!(request.headers.get('content-type') ?? '').toLowerCase().includes('application/json')) {
      return json(415, { error: 'Send application/json.' }, origin);
    }

    if (limiter) {
      const wait = limiter.take(clientIp(request, context) ?? 'unknown');
      if (wait > 0) {
        return json(429, { error: 'Too many requests. Try again shortly.' }, origin, { 'retry-after': String(Math.ceil(wait / 1000)) });
      }
    }

    let parsed: ReturnType<typeof parseProxyRequest>;
    try {
      const text = await readBody(request, maxBodyBytes);
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        throw new HttpError(400, 'Invalid JSON.');
      }
      parsed = parseProxyRequest(raw, { maxMessages, maxTools });
    } catch (error) {
      if (error instanceof HttpError) return json(error.status, { error: error.message }, origin);
      options.onError?.(error);
      return json(400, { error: 'Could not read the request.' }, origin);
    }

    const names = nameMap(parsed.tools);
    const instructions = [options.instructions?.trim(), options.allowClientInstructions === false ? '' : parsed.instructions.trim()]
      .filter(Boolean)
      .join('\n\n');
    const call = provider.build(
      {
        instructions,
        model: options.model,
        maxTokens,
        tools: parsed.tools.map((t) => ({ ...t, name: names.out(t.name) })),
        messages: parsed.messages.map((m) =>
          m.role === 'tool'
            ? { ...m, name: names.out(m.name) }
            : m.role === 'assistant' && 'toolCall' in m
              ? { ...m, toolCall: { ...m.toolCall, name: names.out(m.toolCall.name) } }
              : m,
        ),
      },
      options.apiKey,
      options.baseURL,
    );

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await (options.fetch ?? fetch)(call.url, {
        method: 'POST',
        headers: call.headers,
        body: JSON.stringify(call.body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new UpstreamError(response.status, `${options.provider} answered ${response.status}: ${detail.slice(0, 500)}`);
      }
      const reply: ModelReply = provider.parse(await response.json());
      const body = reply.type === 'tool' ? { ...reply, name: names.back(reply.name) } : reply;
      return json(200, body, origin);
    } catch (error) {
      options.onError?.(error);
      if (controller.signal.aborted) return json(504, { error: 'The model provider did not answer in time.' }, origin);
      if (error instanceof UpstreamError) return json(502, { error: `The model provider answered ${error.status}.` }, origin);
      return json(502, { error: 'The model provider could not be reached.' }, origin);
    } finally {
      clearTimeout(timer);
    }
  };
}
