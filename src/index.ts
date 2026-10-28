/**
 * @bydtech/site-agent: an in-page agent that calls only the WebMCP tools a site declared.
 *
 * - `createSiteAgent` runs the loop; `replay` re-runs a trace without the model.
 * - Models: `chromeBuiltIn`, `proxy`, `custom`, `firstAvailable`.
 * - Tools: `document.modelContext` when the browser has it; `installShim` otherwise.
 *
 * The `<site-agent>` element lives in `@bydtech/site-agent/element`, the server helper in
 * `@bydtech/site-agent/server`.
 */
export { createSiteAgent, parseArguments, DEFAULT_MAX_STEPS, DEFAULT_TOOL_TIMEOUT_MS } from './agent.js';
export type { SiteAgent, SiteAgentOptions, AgentRun } from './agent.js';
export { replay } from './replay.js';
export type { ReplayOptions, ReplayResult, ReplayStep } from './replay.js';
export { chromeBuiltIn, replySchema, simpleReplySchema, renderPrompt } from './models/chrome.js';
export type { ChromeBuiltInOptions } from './models/chrome.js';
export { proxy, PROXY_PROTOCOL_VERSION } from './models/proxy.js';
export type { ProxyOptions } from './models/proxy.js';
export { custom } from './models/custom.js';
export { firstAvailable } from './models/first-available.js';
export { installShim, createModelContext, hasNativeModelContext, isShim, toAgentTool } from './tools.js';
export type { ToolsOption } from './tools.js';
export { verdictFor } from './policy.js';
export type { Verdict } from './policy.js';
export { validateArgs } from './schema.js';
export { fenceUntrusted, resultToText, describeArguments, humanizeKey, UNTRUSTED_TAG } from './text.js';
export { BASE_INSTRUCTIONS, buildInstructions } from './prompt.js';
export { SiteAgentError } from './errors.js';
export type * from './types.js';
