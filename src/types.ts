/** A JSON Schema object, as WebMCP tools declare their input. Only a small subset is validated. */
export type JsonSchema = { [key: string]: unknown };

/**
 * WebMCP tool annotations. All default to `false`.
 * - `readOnlyHint`: the tool only reads state; the agent runs it without asking.
 * - `consequentialHint`: the action is significant or irreversible; the agent always asks.
 * - `untrustedContentHint`: the output holds user-generated or external data; the agent fences it as data.
 */
export interface ToolAnnotations {
  readOnlyHint?: boolean;
  consequentialHint?: boolean;
  untrustedContentHint?: boolean;
  debugging?: boolean;
}

/** What a tool's `execute` receives as its second argument. */
export interface ToolExecuteOptions {
  signal?: AbortSignal;
}

/** The descriptor a site passes to `document.modelContext.registerTool()`. */
export interface ToolDescriptor {
  name: string;
  title?: string;
  description: string;
  inputSchema?: JsonSchema;
  annotations?: ToolAnnotations;
  execute: (args: Record<string, unknown>, options: ToolExecuteOptions) => unknown;
}

/** Options for `registerTool()`. */
export interface RegisterToolOptions {
  /** Abort it to unregister the tool. */
  signal?: AbortSignal;
  /** Accepted for API compatibility; the local shim ignores it. */
  exposedTo?: string[];
}

/** A tool as `document.modelContext.getTools()` returns it. `annotations` may be missing in some browsers. */
export interface RegisteredTool {
  name: string;
  title?: string;
  description: string;
  inputSchema?: JsonSchema | string;
  annotations?: ToolAnnotations;
  origin?: string;
  window?: unknown;
}

/** The consumer side of WebMCP: what the agent needs from `document.modelContext`. */
export interface ModelContextLike {
  getTools(options?: unknown): Promise<RegisteredTool[]>;
  executeTool(tool: RegisteredTool, args: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<unknown>;
  addEventListener?(type: 'toolchange', listener: () => void): void;
  removeEventListener?(type: 'toolchange', listener: () => void): void;
}

/** The full shape of `document.modelContext`, producer and consumer side. */
export interface ModelContext extends ModelContextLike {
  registerTool(tool: ToolDescriptor, options?: RegisterToolOptions): void | Promise<void>;
}

/** A tool as the agent sees it, normalized from a `RegisteredTool`. */
export interface AgentTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: JsonSchema;
  annotations: Required<Pick<ToolAnnotations, 'readOnlyHint' | 'consequentialHint' | 'untrustedContentHint'>>;
  /**
   * `false` when the tool source returned no `annotations` field at all. The agent then cannot tell
   * read-only or consequential tools apart, so it asks before every call to that tool and ignores
   * `preApproved` for it.
   */
  annotationsKnown: boolean;
}

/** A tool as the model sees it: name, description and input schema. */
export interface ModelTool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

/** A tool call the model asked for. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** Opaque data from the model provider that must travel back with the call (for example a Gemini thought signature). */
  meta?: Record<string, unknown>;
}

/** The conversation, in a provider-neutral shape. */
export type AgentMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string }
  | { role: 'assistant'; toolCall: ToolCall }
  | { role: 'tool'; toolCallId: string; name: string; content: string; isError?: boolean };

/** What a model adapter receives for each step. */
export interface ModelRequest {
  /** The agent's system instructions, safety rules included. */
  instructions: string;
  messages: AgentMessage[];
  tools: ModelTool[];
  signal?: AbortSignal;
}

/** What a model adapter returns: one tool call, or a final answer. */
export type ModelReply =
  | { type: 'tool'; name: string; arguments: unknown; id?: string; meta?: Record<string, unknown> }
  | { type: 'answer'; text: string };

/** Chrome's availability states, plus `available` for adapters that are always ready. */
export type Availability = 'unavailable' | 'downloadable' | 'downloading' | 'available';

/** A model the agent can use. Build one with `chromeBuiltIn()`, `proxy()`, `custom()` or `firstAvailable()`. */
export interface ModelAdapter {
  /** A short name recorded in traces, such as `chrome-built-in` or `proxy`. */
  readonly name: string;
  respond(request: ModelRequest): Promise<ModelReply>;
  /** Whether the model can answer now. Adapters without it count as `available`. */
  availability?(): Promise<Availability>;
  /** Downloads or warms up the model. For Chrome's model this must run inside a user gesture. */
  prepare?(options?: { onProgress?: (fraction: number) => void; signal?: AbortSignal }): Promise<void>;
  /** Child adapters, for `firstAvailable()`. */
  readonly models?: readonly ModelAdapter[];
  /** For `firstAvailable()`: the name of the child that answered last. Traces record it. */
  readonly lastUsed?: string;
}

/** Why the agent asks the visitor before a call. */
export type ConfirmReason =
  /** The tool is not marked read-only. */
  | 'not-read-only'
  /** The tool is marked `consequentialHint`; this can never be skipped. */
  | 'consequential'
  /** A tool marked `untrustedContentHint` returned data earlier in the conversation. */
  | 'after-untrusted'
  /** The browser gave no annotations for the tool, so the agent cannot tell what it does. */
  | 'annotations-unknown';

/** One argument, labeled for people. */
export interface ArgumentLine {
  key: string;
  label: string;
  value: string;
}

/** What `confirm` receives. */
export interface ConfirmRequest {
  call: ToolCall;
  tool: AgentTool;
  reason: ConfirmReason;
  /** The arguments in plain words, one line each, labeled from the schema's `title` or the key. */
  lines: ArgumentLine[];
}

/** Asks the visitor. Resolve `true` to allow the call, `false` to deny it. */
export type ConfirmFn = (request: ConfirmRequest, options: { signal: AbortSignal }) => Promise<boolean> | boolean;

/** How a decision about a tool call was reached. */
export type DecisionBy = 'read-only' | 'pre-approved' | 'visitor' | 'no-confirm';

export interface Decision {
  allowed: boolean;
  by: DecisionBy;
  reason?: ConfirmReason;
}

/** Events a run emits, in order. */
export type AgentEvent =
  | { type: 'thinking'; step: number; model: string }
  | { type: 'tool-call'; step: number; call: ToolCall }
  | { type: 'confirm-request'; request: ConfirmRequest }
  | { type: 'confirm-result'; call: ToolCall; decision: Decision }
  | { type: 'tool-result'; call: ToolCall; text: string; untrusted: boolean; isError: boolean; navigated: boolean }
  | { type: 'answer'; text: string }
  | { type: 'error'; code: SiteAgentErrorCode; message: string }
  | { type: 'done'; result: RunResult };

export type SiteAgentErrorCode =
  | 'aborted'
  | 'busy'
  | 'max-steps'
  | 'model-unavailable'
  | 'model-download-required'
  | 'model-error'
  | 'bad-reply'
  | 'no-tools'
  | 'tool-error'
  | 'invalid-arguments'
  | 'unknown-tool'
  | 'timeout';

/** One entry in a trace. */
export type TraceStep =
  | { type: 'user'; text: string }
  | { type: 'model'; step: number; model: string; reply: ModelReply }
  | { type: 'tool-call'; call: ToolCall; untrusted: boolean; readOnly: boolean; consequential: boolean }
  | { type: 'invalid-call'; name: string; arguments: unknown; error: string }
  | { type: 'decision'; callId: string; name: string; decision: Decision }
  | { type: 'tool-result'; callId: string; name: string; text: string; isError: boolean; navigated: boolean; untrusted: boolean }
  | { type: 'answer'; text: string }
  | { type: 'error'; code: SiteAgentErrorCode; message: string };

export type RunStatus = 'answered' | 'max-steps' | 'aborted' | 'error';

/** A JSON-serializable record of one run. */
export interface Trace {
  version: 1;
  startedAt: string;
  endedAt?: string;
  /** The adapter's name, such as `first-available(chrome-built-in,proxy)`. */
  model: string;
  status?: RunStatus;
  steps: TraceStep[];
}

export interface RunResult {
  status: RunStatus;
  /** The final answer, when `status` is `answered`. */
  answer?: string;
  error?: { code: SiteAgentErrorCode; message: string };
  trace: Trace;
}
