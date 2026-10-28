import { SiteAgentError } from '../errors.js';
import type { ModelAdapter, ModelReply } from '../types.js';

export interface ProxyOptions {
  /** Your endpoint, for example one built with `createProxyHandler` from `@bydtech/site-agent/server`. */
  url: string;
  /** Extra request headers. Never put a model provider's API key here: it would be visible to every visitor. */
  headers?: Record<string, string>;
  /** Fetch credentials mode. Default `same-origin`. */
  credentials?: RequestCredentials;
  /** A `fetch` to use instead of the global one. */
  fetch?: typeof fetch;
}

/**
 * The request body `proxy()` sends: `{ instructions, messages, tools }`. The endpoint answers with
 * `{ type: 'tool', name, arguments, id?, meta? }` or `{ type: 'answer', text }`.
 */
export const PROXY_PROTOCOL_VERSION = 1;

/** Posts each step to your own endpoint, so the model provider's API key stays on your server. */
export function proxy(options: ProxyOptions): ModelAdapter {
  if (!options || typeof options.url !== 'string' || options.url === '') {
    throw new TypeError('proxy: options.url is required.');
  }
  return {
    name: 'proxy',
    async respond({ instructions, messages, tools, signal }) {
      const doFetch = options.fetch ?? fetch;
      let response: Response;
      try {
        response = await doFetch(options.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...options.headers },
          credentials: options.credentials ?? 'same-origin',
          body: JSON.stringify({ version: PROXY_PROTOCOL_VERSION, instructions, messages, tools }),
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        throw new SiteAgentError('model-unavailable', `Could not reach the model endpoint: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!response.ok) {
        let detail = '';
        try {
          const body = (await response.json()) as { error?: unknown };
          if (typeof body?.error === 'string') detail = `: ${body.error}`;
        } catch {
          // not JSON
        }
        throw new SiteAgentError('model-error', `The model endpoint answered ${response.status}${detail}.`);
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new SiteAgentError('bad-reply', 'The model endpoint did not return JSON.');
      }
      return body as ModelReply;
    },
  };
}
