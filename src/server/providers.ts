import type { AgentMessage, JsonSchema, ModelReply, ModelTool } from '../types.js';

/** What the handler passes to a provider mapping. Names are already provider-safe. */
export interface ProviderRequest {
  instructions: string;
  messages: AgentMessage[];
  tools: ModelTool[];
  model: string;
  maxTokens: number;
}

export interface HttpCall {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

export class UpstreamError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'UpstreamError';
  }
}

type Role = 'user' | 'assistant';

/** Merges consecutive messages of the same role, as Anthropic and Gemini expect alternating turns. */
function mergeTurns<T extends { role: string; parts: unknown[] }>(turns: T[]): T[] {
  const merged: T[] = [];
  for (const turn of turns) {
    const last = merged[merged.length - 1];
    if (last && last.role === turn.role) last.parts.push(...turn.parts);
    else merged.push({ ...turn, parts: [...turn.parts] });
  }
  return merged;
}

// ---------------------------------------------------------------- Anthropic (Messages API)

export function toAnthropic(req: ProviderRequest, apiKey: string, baseURL = 'https://api.anthropic.com'): HttpCall {
  const turns = mergeTurns(
    req.messages.map((m): { role: Role; parts: unknown[] } => {
      if (m.role === 'user') return { role: 'user', parts: [{ type: 'text', text: m.content }] };
      if (m.role === 'tool') {
        return {
          role: 'user',
          parts: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content, ...(m.isError ? { is_error: true } : {}) }],
        };
      }
      if ('toolCall' in m) {
        return { role: 'assistant', parts: [{ type: 'tool_use', id: m.toolCall.id, name: m.toolCall.name, input: m.toolCall.arguments }] };
      }
      return { role: 'assistant', parts: [{ type: 'text', text: m.content }] };
    }),
  );
  while (turns[0] && turns[0].role !== 'user') turns.shift();
  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: req.maxTokens,
    system: req.instructions,
    messages: turns.map((t) => ({ role: t.role, content: t.parts })),
  };
  if (req.tools.length) {
    body.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: objectSchema(t.inputSchema) }));
    body.tool_choice = { type: 'auto', disable_parallel_tool_use: true };
  }
  return {
    url: `${trimSlash(baseURL)}/v1/messages`,
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body,
  };
}

export function fromAnthropic(json: unknown): ModelReply {
  const content = (json as { content?: unknown })?.content;
  const blocks = Array.isArray(content) ? (content as Array<Record<string, unknown>>) : [];
  const call = blocks.find((b) => b?.type === 'tool_use');
  if (call && typeof call.name === 'string') {
    return { type: 'tool', name: call.name, arguments: call.input ?? {}, ...(typeof call.id === 'string' ? { id: call.id } : {}) };
  }
  const text = blocks
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('');
  return { type: 'answer', text };
}

// ---------------------------------------------------------------- OpenAI (Chat Completions)

export function toOpenAI(req: ProviderRequest, apiKey: string, baseURL = 'https://api.openai.com/v1'): HttpCall {
  const messages: unknown[] = [{ role: 'system', content: req.instructions }];
  for (const m of req.messages) {
    if (m.role === 'user') messages.push({ role: 'user', content: m.content });
    else if (m.role === 'tool') messages.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
    else if ('toolCall' in m) {
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [{ id: m.toolCall.id, type: 'function', function: { name: m.toolCall.name, arguments: JSON.stringify(m.toolCall.arguments) } }],
      });
    } else messages.push({ role: 'assistant', content: m.content });
  }
  const body: Record<string, unknown> = { model: req.model, messages, max_completion_tokens: req.maxTokens };
  if (req.tools.length) {
    body.tools = req.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: objectSchema(t.inputSchema) },
    }));
    body.tool_choice = 'auto';
    body.parallel_tool_calls = false;
  }
  return {
    url: `${trimSlash(baseURL)}/chat/completions`,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body,
  };
}

export function fromOpenAI(json: unknown): ModelReply {
  const message = (json as { choices?: Array<{ message?: Record<string, unknown> }> })?.choices?.[0]?.message;
  const calls = message?.tool_calls;
  const call = Array.isArray(calls) ? (calls[0] as { id?: unknown; function?: { name?: unknown; arguments?: unknown } }) : undefined;
  if (call && typeof call.function?.name === 'string') {
    let args: unknown = call.function.arguments ?? '{}';
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args || '{}');
      } catch {
        // Passed on as a string: the agent reports invalid JSON back to the model.
      }
    }
    return { type: 'tool', name: call.function.name, arguments: args, ...(typeof call.id === 'string' ? { id: call.id } : {}) };
  }
  const content = message?.content;
  return { type: 'answer', text: typeof content === 'string' ? content : '' };
}

// ---------------------------------------------------------------- Gemini (generateContent)

const GEMINI_SCHEMA_KEYS = new Set([
  'type', 'format', 'title', 'description', 'nullable', 'enum', 'properties', 'required', 'items',
  'minItems', 'maxItems', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'anyOf', 'default',
]);

/** Keeps the OpenAPI-style subset Gemini's `parameters` accepts; `const` becomes a one-value `enum`. */
export function geminiSchema(schema: unknown, depth = 0): JsonSchema {
  if (typeof schema !== 'object' || schema === null || depth > 20) return {};
  const input = schema as Record<string, unknown>;
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(input)) {
    if (!GEMINI_SCHEMA_KEYS.has(key)) continue;
    if (key === 'type' && Array.isArray(value)) {
      const types = value.filter((t) => t !== 'null');
      if (types[0] !== undefined) out.type = types[0];
      if (types.length < value.length) out.nullable = true;
    } else if (key === 'properties' && typeof value === 'object' && value !== null) {
      out.properties = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, geminiSchema(v, depth + 1)]));
    } else if (key === 'items') {
      out.items = geminiSchema(value, depth + 1);
    } else if (key === 'anyOf' && Array.isArray(value)) {
      out.anyOf = value.map((v) => geminiSchema(v, depth + 1));
    } else {
      out[key] = value;
    }
  }
  if ('const' in input && out.enum === undefined) out.enum = [input.const];
  return out;
}

export function toGemini(req: ProviderRequest, apiKey: string, baseURL = 'https://generativelanguage.googleapis.com/v1beta'): HttpCall {
  // Gemini's own call ids (when it sends them) travel in `meta.callId` and go back on both sides.
  const geminiIds = new Map<string, string>();
  for (const m of req.messages) {
    if (m.role === 'assistant' && 'toolCall' in m && typeof m.toolCall.meta?.callId === 'string') {
      geminiIds.set(m.toolCall.id, m.toolCall.meta.callId);
    }
  }
  const contents = mergeTurns(
    req.messages.map((m): { role: 'user' | 'model'; parts: unknown[] } => {
      if (m.role === 'user') return { role: 'user', parts: [{ text: m.content }] };
      if (m.role === 'tool') {
        const id = geminiIds.get(m.toolCallId);
        return {
          role: 'user',
          parts: [
            {
              functionResponse: {
                ...(id ? { id } : {}),
                name: m.name,
                response: m.isError ? { error: m.content } : { result: m.content },
              },
            },
          ],
        };
      }
      if ('toolCall' in m) {
        const signature = m.toolCall.meta?.thoughtSignature;
        const id = geminiIds.get(m.toolCall.id);
        return {
          role: 'model',
          parts: [
            {
              functionCall: { ...(id ? { id } : {}), name: m.toolCall.name, args: m.toolCall.arguments },
              ...(typeof signature === 'string' ? { thoughtSignature: signature } : {}),
            },
          ],
        };
      }
      return { role: 'model', parts: [{ text: m.content }] };
    }),
  );
  while (contents[0] && contents[0].role !== 'user') contents.shift();
  const body: Record<string, unknown> = {
    systemInstruction: { parts: [{ text: req.instructions }] },
    contents,
    generationConfig: { maxOutputTokens: req.maxTokens },
  };
  if (req.tools.length) {
    body.tools = [
      {
        functionDeclarations: req.tools.map((t) => {
          const parameters = geminiSchema(objectSchema(t.inputSchema));
          const empty = !parameters.properties || Object.keys(parameters.properties as object).length === 0;
          return { name: t.name, description: t.description, ...(empty ? {} : { parameters }) };
        }),
      },
    ];
    body.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
  }
  return {
    url: `${trimSlash(baseURL)}/models/${encodeURIComponent(req.model)}:generateContent`,
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body,
  };
}

export function fromGemini(json: unknown): ModelReply {
  const parts = (json as { candidates?: Array<{ content?: { parts?: unknown } }> })?.candidates?.[0]?.content?.parts;
  const list = Array.isArray(parts) ? (parts as Array<Record<string, unknown>>) : [];
  const part = list.find((p) => typeof p?.functionCall === 'object' && p.functionCall !== null);
  if (part) {
    const call = part.functionCall as { name?: unknown; args?: unknown; id?: unknown };
    if (typeof call.name === 'string') {
      return {
        type: 'tool',
        name: call.name,
        arguments: call.args ?? {},
        ...(typeof call.id === 'string' ? { id: call.id } : {}),
        meta: {
          ...(typeof call.id === 'string' ? { callId: call.id } : {}),
          ...(typeof part.thoughtSignature === 'string' ? { thoughtSignature: part.thoughtSignature } : {}),
        },
      };
    }
  }
  const text = list
    .filter((p) => typeof p?.text === 'string' && p.thought !== true)
    .map((p) => p.text as string)
    .join('');
  return { type: 'answer', text };
}

// ---------------------------------------------------------------- helpers

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function objectSchema(schema: JsonSchema): JsonSchema {
  const { $schema: _ignored, ...rest } = schema as { $schema?: unknown };
  return { ...rest, type: 'object', properties: (rest as { properties?: unknown }).properties ?? {} };
}

export type Provider = 'anthropic' | 'openai' | 'gemini';

export const PROVIDERS: Record<Provider, { build: typeof toAnthropic; parse: (json: unknown) => ModelReply }> = {
  anthropic: { build: toAnthropic, parse: fromAnthropic },
  openai: { build: toOpenAI, parse: fromOpenAI },
  gemini: { build: toGemini, parse: fromGemini },
};
