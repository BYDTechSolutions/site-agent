import { raceAbort } from './errors.js';
import { describeArguments } from './text.js';
import type { AgentTool, ConfirmFn, ConfirmReason, ConfirmRequest, Decision, ToolCall } from './types.js';

/** Confirmation state that lives across the steps and runs of one conversation. */
export interface PolicyState {
  /** Set after a tool marked `untrustedContentHint` returns; cleared when the visitor allows a call. */
  tainted: boolean;
}

export type Verdict = { ask: false; by: 'read-only' | 'pre-approved' } | { ask: true; reason: ConfirmReason };

/**
 * The confirmation rules, in order:
 * 1. A tool without annotations from the browser always asks (pre-approval does not apply).
 * 2. `consequentialHint` always asks, even when read-only or pre-approved.
 * 3. `readOnlyHint` runs without asking.
 * 4. After untrusted output, the next non-read-only call asks, even when pre-approved.
 * 5. Pre-approved names run without asking.
 * 6. Everything else asks.
 */
export function verdictFor(tool: AgentTool, preApproved: ReadonlySet<string>, state: PolicyState): Verdict {
  if (!tool.annotationsKnown) return { ask: true, reason: 'annotations-unknown' };
  if (tool.annotations.consequentialHint) return { ask: true, reason: 'consequential' };
  if (tool.annotations.readOnlyHint) return { ask: false, by: 'read-only' };
  if (state.tainted) return { ask: true, reason: 'after-untrusted' };
  if (preApproved.has(tool.name)) return { ask: false, by: 'pre-approved' };
  return { ask: true, reason: 'not-read-only' };
}

export function confirmRequest(call: ToolCall, tool: AgentTool, reason: ConfirmReason): ConfirmRequest {
  return { call, tool, reason, lines: describeArguments(call.arguments, tool.inputSchema) };
}

/**
 * Applies the rules and, when needed, asks through `confirm`. Without `confirm`, every call that
 * needs asking is denied. Only a strict `true` from `confirm` allows the call.
 */
export async function decide(
  call: ToolCall,
  tool: AgentTool,
  options: {
    preApproved: ReadonlySet<string>;
    state: PolicyState;
    confirm?: ConfirmFn;
    signal: AbortSignal;
    onRequest?: (request: ConfirmRequest) => void;
  },
): Promise<Decision> {
  const verdict = verdictFor(tool, options.preApproved, options.state);
  if (!verdict.ask) return { allowed: true, by: verdict.by };
  if (!options.confirm) return { allowed: false, by: 'no-confirm', reason: verdict.reason };
  const request = confirmRequest(call, tool, verdict.reason);
  options.onRequest?.(request);
  const answer = await raceAbort(options.confirm(request, { signal: options.signal }), options.signal);
  const allowed = answer === true;
  if (allowed) options.state.tainted = false;
  return { allowed, by: 'visitor', reason: verdict.reason };
}
