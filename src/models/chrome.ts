import { SiteAgentError, isAbortError, raceAbort } from '../errors.js';
import type { AgentMessage, Availability, JsonSchema, ModelAdapter, ModelReply, ModelRequest, ModelTool } from '../types.js';

/** The parts of Chrome's Prompt API this adapter uses. */
interface LanguageModelSession {
  prompt(input: string, options?: { responseConstraint?: JsonSchema; signal?: AbortSignal }): Promise<string>;
  clone?(options?: { signal?: AbortSignal }): Promise<LanguageModelSession>;
  destroy(): void;
}

interface LanguageModelStatic {
  availability(options?: Record<string, unknown>): Promise<string>;
  create(options?: Record<string, unknown>): Promise<LanguageModelSession>;
}

function languageModel(): LanguageModelStatic | undefined {
  const candidate = (globalThis as { LanguageModel?: unknown }).LanguageModel;
  if (
    typeof candidate === 'function' || (typeof candidate === 'object' && candidate !== null)
  ) {
    const lm = candidate as LanguageModelStatic;
    if (typeof lm.availability === 'function' && typeof lm.create === 'function') return lm;
  }
  return undefined;
}

export interface ChromeBuiltInOptions {
  /** Languages the visitor writes in and the model answers in. Default `['en']`. */
  languages?: string[];
  /** Conversation messages kept in each prompt, newest first. Default 12. */
  maxHistory?: number;
  /** Characters of conversation kept in each prompt. Default 6000. */
  maxPromptChars?: number;
}

/** The JSON Schema that makes the model return either an answer or exactly one call to a listed tool. */
export function replySchema(tools: ModelTool[]): JsonSchema {
  const answer = {
    type: 'object',
    properties: { type: { type: 'string', enum: ['answer'] }, text: { type: 'string' } },
    required: ['type', 'text'],
    additionalProperties: false,
  };
  const branches = tools.map((tool) => {
    const { $schema: _ignored, ...args } = tool.inputSchema as { $schema?: unknown };
    return {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['tool'] },
        name: { type: 'string', enum: [tool.name] },
        arguments: Object.keys(args).length ? args : { type: 'object' },
      },
      required: ['type', 'name', 'arguments'],
      additionalProperties: false,
    };
  });
  return { anyOf: [answer, ...branches] };
}

/** A flatter schema, used if the browser rejects the first one. */
export function simpleReplySchema(tools: ModelTool[]): JsonSchema {
  const properties: Record<string, unknown> = {
    type: { type: 'string', enum: tools.length ? ['answer', 'tool'] : ['answer'] },
    text: { type: 'string' },
  };
  if (tools.length) {
    properties.name = { type: 'string', enum: tools.map((t) => t.name) };
    properties.arguments = { type: 'object' };
  }
  return { type: 'object', properties, required: ['type'] };
}

function renderMessage(message: AgentMessage): string {
  if (message.role === 'user') return `Visitor: ${message.content}`;
  if (message.role === 'tool') return `Result of ${message.name}${message.isError ? ' (error)' : ''}: ${message.content}`;
  if ('toolCall' in message) return `You called ${message.toolCall.name} with ${JSON.stringify(message.toolCall.arguments)}`;
  return `You answered: ${message.content}`;
}

/** The text prompt for one step: the tools, the recent conversation, and the reply format. */
export function renderPrompt(request: ModelRequest, maxHistory = 12, maxChars = 6000): string {
  const tools = request.tools.length
    ? request.tools.map((t) => `- ${t.name}: ${t.description}\n  Arguments (JSON Schema): ${JSON.stringify(t.inputSchema)}`).join('\n')
    : '(none)';
  const lines: string[] = [];
  let used = 0;
  for (const message of request.messages.slice(-maxHistory).reverse()) {
    const line = renderMessage(message);
    if (used + line.length > maxChars && lines.length > 0) break;
    lines.unshift(line.length > maxChars ? `${line.slice(0, maxChars)} [cut]` : line);
    used += line.length;
  }
  return [
    'Tools you can call:',
    tools,
    '',
    'Conversation so far:',
    lines.join('\n'),
    '',
    'Reply with JSON only: {"type":"answer","text":"..."} to answer the visitor, or {"type":"tool","name":"<tool name>","arguments":{...}} to call one tool.',
  ].join('\n');
}

/** Reads the model's JSON reply. Exported for tests. */
export function parseReply(output: string): ModelReply {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw new SiteAgentError('bad-reply', "The on-device model's reply was not valid JSON.");
  }
  const reply = value as { type?: unknown; text?: unknown; name?: unknown; arguments?: unknown };
  if (reply?.type === 'tool' && typeof reply.name === 'string' && reply.name) {
    return { type: 'tool', name: reply.name, arguments: reply.arguments ?? {} };
  }
  if (typeof reply?.text === 'string') return { type: 'answer', text: reply.text };
  throw new SiteAgentError('bad-reply', "The on-device model's reply was neither an answer nor a tool call.");
}

/**
 * Chrome's built-in model through the Prompt API (`LanguageModel`). No key and no server: it runs on
 * the visitor's machine. Desktop Chrome only, with the hardware Chrome requires. The first use
 * downloads the model, which needs a user gesture: call `prepare()` from a click handler.
 *
 * Tool choice uses structured output (`responseConstraint`), not native tool use.
 */
export function chromeBuiltIn(options: ChromeBuiltInOptions = {}): ModelAdapter {
  const languages = options.languages ?? ['en'];
  const io = {
    expectedInputs: [{ type: 'text', languages }],
    expectedOutputs: [{ type: 'text', languages }],
  };
  let base: { instructions: string; session: Promise<LanguageModelSession> } | undefined;
  let simple = false;

  async function availability(): Promise<Availability> {
    const lm = languageModel();
    if (!lm) return 'unavailable';
    try {
      const state = await lm.availability(io);
      return state === 'available' || state === 'downloadable' || state === 'downloading' ? state : 'unavailable';
    } catch {
      return 'unavailable';
    }
  }

  function baseSession(lm: LanguageModelStatic, instructions: string): Promise<LanguageModelSession> {
    if (base?.instructions !== instructions) {
      base?.session.then((s) => s.destroy()).catch(() => {});
      const session = lm.create({ ...io, initialPrompts: [{ role: 'system', content: instructions }] });
      base = { instructions, session };
      session.catch(() => {
        if (base?.session === session) base = undefined;
      });
    }
    return base.session;
  }

  return {
    name: 'chrome-built-in',
    availability,

    async prepare({ onProgress, signal } = {}) {
      const lm = languageModel();
      if (!lm) throw new SiteAgentError('model-unavailable', "This browser does not have Chrome's built-in model.");
      const session = await lm.create({
        ...io,
        ...(signal ? { signal } : {}),
        monitor(m: EventTarget) {
          m.addEventListener('downloadprogress', (e) => onProgress?.(Number((e as unknown as { loaded?: number }).loaded ?? 0)));
        },
      });
      session.destroy();
    },

    async respond(request) {
      const lm = languageModel();
      const state = await availability();
      if (!lm || state === 'unavailable') {
        throw new SiteAgentError('model-unavailable', "Chrome's built-in model is not available in this browser.");
      }
      if (state !== 'available') {
        throw new SiteAgentError(
          'model-download-required',
          state === 'downloading'
            ? 'The on-device model is still downloading.'
            : 'The on-device model needs a one-time download, started by the visitor.',
        );
      }
      const parent = await baseSession(lm, request.instructions);
      const session = parent.clone
        ? await parent.clone(request.signal ? { signal: request.signal } : {})
        : await lm.create({ ...io, initialPrompts: [{ role: 'system', content: request.instructions }], ...(request.signal ? { signal: request.signal } : {}) });
      try {
        const prompt = renderPrompt(request, options.maxHistory, options.maxPromptChars);
        const ask = (schema: JsonSchema) =>
          raceAbort(session.prompt(prompt, { responseConstraint: schema, ...(request.signal ? { signal: request.signal } : {}) }), request.signal);
        let output: string;
        if (simple) {
          output = await ask(simpleReplySchema(request.tools));
        } else {
          try {
            output = await ask(replySchema(request.tools));
          } catch (error) {
            if (isAbortError(error) || request.signal?.aborted) throw error;
            // Some versions may not accept anyOf schemas; fall back to a flat one from now on.
            simple = true;
            output = await ask(simpleReplySchema(request.tools));
          }
        }
        return parseReply(output);
      } finally {
        session.destroy();
      }
    },
  };
}
