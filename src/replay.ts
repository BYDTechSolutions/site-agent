import { isAbortError, throwIfAborted } from './errors.js';
import { executeTool } from './exec.js';
import { decide, type PolicyState } from './policy.js';
import { validateArgs } from './schema.js';
import { DEFAULT_MAX_RESULT_CHARS } from './text.js';
import { resolveContext, toolSource, type ToolsOption } from './tools.js';
import { DEFAULT_TOOL_TIMEOUT_MS } from './agent.js';
import type { ConfirmFn, ConfirmRequest, Decision, ToolCall, Trace } from './types.js';

export interface ReplayOptions {
  /** Where tools come from. Default: `document.modelContext`, as for the agent. */
  tools?: ToolsOption;
  /** Asks before calls that need it, under the same rules as a live run. Without it those calls are denied. */
  confirm?: ConfirmFn;
  preApproved?: readonly string[];
  toolTimeoutMs?: number;
  maxResultChars?: number;
  signal?: AbortSignal;
  /** Called before each confirmation, like the agent's `confirm-request` event. */
  onConfirmRequest?: (request: ConfirmRequest) => void;
}

export interface ReplayStep {
  call: ToolCall;
  status: 'ran' | 'denied' | 'missing-tool' | 'invalid-arguments';
  decision?: Decision;
  text?: string;
  isError?: boolean;
  navigated?: boolean;
  /** What the original run recorded for this call, if it ran then. */
  recorded?: { text: string; isError: boolean };
  /** `true` when the call ran both times with the same text and error flag. */
  matches?: boolean;
  /** Validation problems, for `invalid-arguments`. */
  problems?: string[];
}

export interface ReplayResult {
  steps: ReplayStep[];
  /** Steps whose outcome differs from the recording: a different result, or a call that did not run this time. */
  differences: number;
  aborted: boolean;
}

/**
 * Re-runs the tool calls of a trace in order against the current tools, without any model. The
 * confirmation rules apply exactly as in a live run (fresh untrusted-output state), and calls that
 * were invalid in the original run are skipped.
 */
export async function replay(trace: Trace, options: ReplayOptions = {}): Promise<ReplayResult> {
  if (!trace || trace.version !== 1 || !Array.isArray(trace.steps)) {
    throw new TypeError('replay: expected a trace with version 1.');
  }
  const signal = options.signal ?? new AbortController().signal;
  const source = toolSource(resolveContext(options.tools));
  const preApproved = new Set(options.preApproved ?? []);
  const state: PolicyState = { tainted: false };
  const steps: ReplayStep[] = [];
  let differences = 0;

  const recorded = new Map<string, { text: string; isError: boolean }>();
  for (const step of trace.steps) {
    if (step.type === 'tool-result') recorded.set(step.callId, { text: step.text, isError: step.isError });
  }
  const ranBefore = new Set<string>();
  for (const step of trace.steps) {
    if (step.type === 'decision' && step.decision.allowed) ranBefore.add(step.callId);
  }

  try {
    for (const step of trace.steps) {
      if (step.type !== 'tool-call') continue;
      throwIfAborted(signal);
      const call = step.call;
      const before = ranBefore.has(call.id) ? recorded.get(call.id) : undefined;
      const base: ReplayStep = { call, status: 'ran', ...(before ? { recorded: before } : {}) };
      const tool = (await source.list()).find((t) => t.name === call.name);
      if (!tool) {
        steps.push({ ...base, status: 'missing-tool' });
        differences++;
        continue;
      }
      const problems = validateArgs(tool.inputSchema, call.arguments);
      if (problems.length > 0) {
        steps.push({ ...base, status: 'invalid-arguments', problems });
        differences++;
        continue;
      }
      const decision = await decide(call, tool, {
        preApproved,
        state,
        ...(options.confirm ? { confirm: options.confirm } : {}),
        signal,
        ...(options.onConfirmRequest ? { onRequest: options.onConfirmRequest } : {}),
      });
      if (!decision.allowed) {
        steps.push({ ...base, status: 'denied', decision });
        if (before) differences++;
        continue;
      }
      const result = await executeTool(source, tool, call.arguments, {
        signal,
        timeoutMs: options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
        maxResultChars: options.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS,
      });
      if (tool.annotations.untrustedContentHint) state.tainted = true;
      const matches = before !== undefined && before.text === result.text && before.isError === result.isError;
      if (!matches) differences++;
      steps.push({ ...base, decision, text: result.text, isError: result.isError, navigated: result.navigated, matches });
    }
  } catch (error) {
    if (isAbortError(error) || signal.aborted) return { steps, differences, aborted: true };
    throw error;
  }
  return { steps, differences, aborted: false };
}
