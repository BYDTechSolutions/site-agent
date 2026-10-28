import { SiteAgentError, anySignal, isAbortError, raceAbort, throwIfAborted } from './errors.js';
import { executeTool } from './exec.js';
import { decide, type PolicyState } from './policy.js';
import { buildInstructions } from './prompt.js';
import { validateArgs } from './schema.js';
import { DEFAULT_MAX_RESULT_CHARS, fenceUntrusted } from './text.js';
import { resolveContext, toolSource, type ToolSource, type ToolsOption } from './tools.js';
import type {
  AgentEvent,
  AgentMessage,
  AgentTool,
  ConfirmFn,
  Decision,
  ModelAdapter,
  ModelReply,
  RunResult,
  RunStatus,
  SiteAgentErrorCode,
  ToolCall,
  Trace,
} from './types.js';

export interface SiteAgentOptions {
  /** The model: `chromeBuiltIn()`, `proxy({ url })`, `custom(fn)` or `firstAvailable(...)`. */
  model: ModelAdapter;
  /** Where tools come from. Default: `document.modelContext` (native, or the local shim installed if absent). */
  tools?: ToolsOption;
  /** Asks the visitor. Without it, every call that needs asking is denied. */
  confirm?: ConfirmFn;
  /** Tool names that run without asking. Ignored for `consequentialHint` tools, after untrusted output, and for tools without annotations. */
  preApproved?: readonly string[];
  /** Model turns per visitor message. Default 6. */
  maxSteps?: number;
  /** Per tool call. Default 30 000 ms. Time spent waiting for the visitor to confirm does not count. */
  toolTimeoutMs?: number;
  /** Extra instructions from the site, appended after the built-in rules. */
  instructions?: string;
  /** Tool results are cut to this many characters before they reach the model. Default 4000. */
  maxResultChars?: number;
}

/** One run: iterate it for events, or await `done` for the result. */
export interface AgentRun extends AsyncIterable<AgentEvent> {
  readonly done: Promise<RunResult>;
  /** Stops the run. Pending confirmation, model call and tool call are abandoned. */
  abort(): void;
}

export interface SiteAgent {
  /** Sends a visitor message. One run at a time; a second call while one is running throws `busy`. */
  run(message: string, options?: { signal?: AbortSignal }): AgentRun;
  /** Clears the conversation and the untrusted-output state. */
  reset(): void;
  /** The tools the agent can see right now. */
  tools(): Promise<AgentTool[]>;
  /** Calls `listener` when the page's tools change. Returns an unsubscribe function. */
  onToolsChange(listener: () => void): () => void;
  readonly messages: readonly AgentMessage[];
  readonly running: boolean;
  readonly model: ModelAdapter;
}

export const DEFAULT_MAX_STEPS = 6;
export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

/** Parses tool arguments that arrive as a JSON string; anything else passes through. */
export function parseArguments(raw: unknown): { value?: Record<string, unknown>; error?: string } {
  let value = raw;
  if (value === undefined || value === null || value === '') return { value: {} };
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return { error: 'arguments are not valid JSON' };
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { error: 'arguments must be an object' };
  }
  return { value: value as Record<string, unknown> };
}

function isReply(value: unknown): value is ModelReply {
  if (typeof value !== 'object' || value === null) return false;
  const reply = value as { type?: unknown; text?: unknown; name?: unknown };
  if (reply.type === 'answer') return typeof reply.text === 'string';
  if (reply.type === 'tool') return typeof reply.name === 'string' && reply.name.length > 0;
  return false;
}

class EventLog implements AsyncIterable<AgentEvent> {
  private events: AgentEvent[] = [];
  private closed = false;
  private wake: Array<() => void> = [];

  push(event: AgentEvent): void {
    this.events.push(event);
    if (event.type === 'done') this.closed = true;
    for (const w of this.wake.splice(0)) w();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    let i = 0;
    for (;;) {
      while (i < this.events.length) yield this.events[i++] as AgentEvent;
      if (this.closed) return;
      await new Promise<void>((resolve) => this.wake.push(resolve));
    }
  }
}

/** Creates an agent over the page's declared tools. See the README for the confirmation rules. */
export function createSiteAgent(options: SiteAgentOptions): SiteAgent {
  if (!options || !options.model || typeof options.model.respond !== 'function') {
    throw new TypeError('createSiteAgent: options.model must be a model adapter, such as proxy({ url }).');
  }
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 50) {
    throw new RangeError('createSiteAgent: maxSteps must be an integer from 1 to 50.');
  }
  const toolTimeoutMs = options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  const maxResultChars = options.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS;
  const preApproved = new Set(options.preApproved ?? []);
  const instructions = buildInstructions(options.instructions);
  const model = options.model;
  let source: ToolSource | undefined;
  const getSource = () => (source ??= toolSource(resolveContext(options.tools)));

  let history: AgentMessage[] = [];
  const state: PolicyState = { tainted: false };
  let running = false;
  let callCounter = 0;

  async function execute(message: string, signal: AbortSignal, emit: (e: AgentEvent) => void, trace: Trace): Promise<RunResult> {
    let pending: ToolCall | undefined;
    const finish = (status: RunStatus, extra: Partial<RunResult> = {}): RunResult => {
      trace.status = status;
      trace.endedAt = new Date().toISOString();
      return { status, trace, ...extra };
    };
    const fail = (code: SiteAgentErrorCode, text: string): RunResult => {
      trace.steps.push({ type: 'error', code, message: text });
      emit({ type: 'error', code, message: text });
      return finish(code === 'aborted' ? 'aborted' : code === 'max-steps' ? 'max-steps' : 'error', { error: { code, message: text } });
    };
    const addToolMessage = (call: ToolCall, content: string, isError: boolean) => {
      history.push({ role: 'tool', toolCallId: call.id, name: call.name, content, ...(isError ? { isError } : {}) });
      if (pending === call) pending = undefined;
    };

    trace.steps.push({ type: 'user', text: message });
    history.push({ role: 'user', content: message });

    try {
      const tools = getSource();
      for (let step = 1; step <= maxSteps; step++) {
        throwIfAborted(signal);
        const available = await raceAbort(tools.list(), signal);
        emit({ type: 'thinking', step, model: model.name });

        let reply: unknown;
        try {
          reply = await raceAbort(
            model.respond({
              instructions,
              messages: history.slice(),
              tools: available.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
              signal,
            }),
            signal,
          );
        } catch (error) {
          if (isAbortError(error) || signal.aborted) throw error;
          if (error instanceof SiteAgentError) return fail(error.code, error.message);
          return fail('model-error', `The model failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (!isReply(reply)) return fail('bad-reply', 'The model returned something that is neither a tool call nor an answer.');
        trace.steps.push({ type: 'model', step, model: model.lastUsed ?? model.name, reply });

        if (reply.type === 'answer') {
          history.push({ role: 'assistant', content: reply.text });
          trace.steps.push({ type: 'answer', text: reply.text });
          emit({ type: 'answer', text: reply.text });
          return finish('answered', { answer: reply.text });
        }

        const id = typeof reply.id === 'string' && reply.id ? reply.id : `call_${++callCounter}`;
        const parsed = parseArguments(reply.arguments);
        const call: ToolCall = {
          id,
          name: reply.name,
          arguments: parsed.value ?? {},
          ...(reply.meta && typeof reply.meta === 'object' ? { meta: reply.meta } : {}),
        };
        const tool = available.find((t) => t.name === reply.name);
        const problems = !tool
          ? [`there is no tool named "${reply.name}"; available tools: ${available.map((t) => t.name).join(', ') || 'none'}`]
          : parsed.error
            ? [parsed.error]
            : validateArgs(tool.inputSchema, parsed.value);
        history.push({ role: 'assistant', toolCall: call });
        pending = call;
        if (!tool || problems.length > 0) {
          const text = `Error: the call was not run because ${problems.join('; ')}.`;
          trace.steps.push({ type: 'invalid-call', name: reply.name, arguments: reply.arguments ?? null, error: text });
          addToolMessage(call, text, true);
          continue;
        }

        trace.steps.push({
          type: 'tool-call',
          call,
          untrusted: tool.annotations.untrustedContentHint,
          readOnly: tool.annotations.readOnlyHint,
          consequential: tool.annotations.consequentialHint,
        });
        emit({ type: 'tool-call', step, call });

        const decision: Decision = await decide(call, tool, {
          preApproved,
          state,
          ...(options.confirm ? { confirm: options.confirm } : {}),
          signal,
          onRequest: (request) => emit({ type: 'confirm-request', request }),
        });
        trace.steps.push({ type: 'decision', callId: call.id, name: call.name, decision });
        emit({ type: 'confirm-result', call, decision });

        if (!decision.allowed) {
          const text =
            decision.by === 'no-confirm'
              ? 'Not run: this call needs the visitor to allow it, and this site has no way to ask. Tell the visitor it was not done.'
              : 'Not run: the visitor denied this call. Do not retry it; tell the visitor it was not done.';
          trace.steps.push({ type: 'tool-result', callId: call.id, name: call.name, text, isError: true, navigated: false, untrusted: false });
          addToolMessage(call, text, true);
          emit({ type: 'tool-result', call, text, untrusted: false, isError: true, navigated: false });
          continue;
        }

        const result = await executeTool(tools, tool, call.arguments, { signal, timeoutMs: toolTimeoutMs, maxResultChars });
        const untrusted = tool.annotations.untrustedContentHint;
        if (untrusted) state.tainted = true;
        const forModel = untrusted ? fenceUntrusted(tool.name, result.text) : result.text;
        trace.steps.push({
          type: 'tool-result',
          callId: call.id,
          name: call.name,
          text: result.text,
          isError: result.isError,
          navigated: result.navigated,
          untrusted,
        });
        addToolMessage(call, forModel, result.isError);
        emit({ type: 'tool-result', call, text: result.text, untrusted, isError: result.isError, navigated: result.navigated });
      }
      return fail('max-steps', `Stopped after ${maxSteps} steps without an answer.`);
    } catch (error) {
      if (isAbortError(error) || signal.aborted) return fail('aborted', 'The run was stopped.');
      if (error instanceof SiteAgentError) return fail(error.code, error.message);
      return fail('model-error', error instanceof Error ? error.message : String(error));
    } finally {
      // Keep the conversation well-formed for providers that require a result for every tool call.
      if (pending) addToolMessage(pending, 'Stopped before this call finished.', true);
    }
  }

  return {
    run(message, runOptions = {}) {
      if (typeof message !== 'string' || message.trim() === '') throw new TypeError('run: message must be a non-empty string.');
      if (running) throw new SiteAgentError('busy', 'The agent is already working on a message.');
      running = true;
      const controller = new AbortController();
      const signal = anySignal([controller.signal, runOptions.signal]);
      const log = new EventLog();
      const trace: Trace = { version: 1, startedAt: new Date().toISOString(), model: model.name, steps: [] };
      const done = execute(message, signal, (e) => log.push(e), trace).then((result) => {
        running = false;
        log.push({ type: 'done', result });
        return result;
      });
      return {
        done,
        abort: () => controller.abort(),
        [Symbol.asyncIterator]: () => log[Symbol.asyncIterator](),
      };
    },
    reset() {
      history = [];
      state.tainted = false;
    },
    tools: () => getSource().list(),
    onToolsChange: (listener) => getSource().subscribe(listener),
    get messages() {
      return history.slice();
    },
    get running() {
      return running;
    },
    model,
  };
}
