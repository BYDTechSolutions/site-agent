import { anySignal, raceAbort } from './errors.js';
import { resultToText, type NormalizedResult } from './text.js';
import type { ToolSource } from './tools.js';
import type { AgentTool } from './types.js';

/**
 * Runs one tool with a timeout. A tool that throws or times out becomes an error result for the
 * model; only aborting the run itself rejects.
 */
export async function executeTool(
  source: ToolSource,
  tool: AgentTool,
  args: Record<string, unknown>,
  options: { signal: AbortSignal; timeoutMs: number; maxResultChars: number },
): Promise<NormalizedResult> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), options.timeoutMs);
  const callSignal = anySignal([options.signal, timeout.signal]);
  try {
    const raw = await raceAbort(source.execute(tool, args, callSignal), callSignal);
    return resultToText(raw, options.maxResultChars);
  } catch (error) {
    if (options.signal.aborted) throw error;
    if (timeout.signal.aborted) {
      return { text: `Error: the tool did not finish within ${options.timeoutMs} ms.`, isError: true, navigated: false };
    }
    const text = error instanceof Error ? error.message : String(error);
    return { text: `Error: the tool failed: ${text.slice(0, 500)}`, isError: true, navigated: false };
  } finally {
    clearTimeout(timer);
  }
}
