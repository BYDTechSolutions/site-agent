import type { ModelAdapter, ModelReply, ModelRequest } from '../types.js';

/**
 * Bring any model: `fn` receives the instructions, the conversation, the tools and the abort
 * signal, and returns one tool call or an answer. Keep provider API keys on a server.
 */
export function custom(
  fn: (request: ModelRequest) => Promise<ModelReply> | ModelReply,
  options: { name?: string; availability?: ModelAdapter['availability'] } = {},
): ModelAdapter {
  if (typeof fn !== 'function') throw new TypeError('custom: expected a function.');
  return {
    name: options.name ?? 'custom',
    respond: async (request) => fn(request),
    ...(options.availability ? { availability: options.availability } : {}),
  };
}
