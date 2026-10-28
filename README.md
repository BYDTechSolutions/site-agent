# @bydtech/site-agent

Add one tag, `<site-agent>`, and visitors can ask your site to do things in plain words: "find the plan with SSO", "add two of these to my cart". The agent can call only the [WebMCP](https://github.com/webmachinelearning/webmcp) tools your page declared, asks the visitor before anything that changes data, never holds a model provider's API key, and records every run so you can replay it without the model.

[![npm version](https://img.shields.io/npm/v/@bydtech/site-agent.svg)](https://www.npmjs.com/package/@bydtech/site-agent)
[![CI](https://github.com/BYDTechSolutions/site-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/BYDTechSolutions/site-agent/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## Why

In-page agents usually drive the page itself: they read the DOM, click whatever looks right, and sometimes ship with an API key in the client. That makes them unpredictable and easy to abuse. This package takes the strict route:

- **Declared tools only.** The agent sees the tools your page registered with WebMCP and nothing else. It never reads or clicks arbitrary elements, never evaluates code, and has no DOM fallback.
- **Confirmation by default.** Every call to a tool that is not marked read-only asks the visitor first. Tools marked `consequentialHint` always ask, and no option turns that off.
- **No key in the browser.** The models are Chrome's built-in model (on the visitor's machine, no key at all), your own endpoint through `proxy()`, or a function you write. There is no adapter that takes a provider key in the browser.
- **Replayable.** Every run produces a JSON trace. `replay(trace)` runs the same tool calls again without the model, under the same confirmation rules, so a good run can become a test.

Zero runtime dependencies, framework-free (one custom element), about 17 kB gzipped for the core and the element. No telemetry: the only network requests are to the proxy URL you configure.

## Install

```sh
npm install @bydtech/site-agent
```

Or load it from a CDN with no build step (see below). Node.js 20 or later for the server helper.

## Quick start

Register a tool and add the element. In browsers without WebMCP, importing the element installs a small local shim, so `document.modelContext.registerTool` works everywhere.

```html
<site-agent label="Ask this site"></site-agent>

<script type="module">
  import { installShim } from 'https://cdn.jsdelivr.net/npm/@bydtech/site-agent@0.1.1/dist/index.js';
  import 'https://cdn.jsdelivr.net/npm/@bydtech/site-agent@0.1.1/dist/element.js';

  // The browser's own document.modelContext when it has one, the local shim otherwise.
  const modelContext = installShim();

  modelContext.registerTool({
    name: 'find_plan',
    description: 'Find pricing plans that include a feature.',
    inputSchema: {
      type: 'object',
      properties: { feature: { type: 'string', description: 'For example "SSO"' } },
      required: ['feature'],
    },
    annotations: { readOnlyHint: true },
    execute: ({ feature }) => `Plans with ${feature}: Business, Enterprise.`,
  });
</script>
```

With no attributes, the element uses Chrome's built-in model, which only some desktop Chrome installs have (see [Models](#models)). To serve every visitor, add a proxy and point the element at it:

```html
<site-agent proxy-url="/api/agent" pre-approved="add_to_cart"></site-agent>
```

The same with npm and a bundler:

```js
import { installShim } from '@bydtech/site-agent';
import '@bydtech/site-agent/element';

installShim().registerTool({ /* ... */ });
```

And the endpoint behind `/api/agent`, for example as a Cloudflare Worker:

```ts
import { createProxyHandler } from '@bydtech/site-agent/server';

let handler;
export default {
  fetch(request, env) {
    handler ??= createProxyHandler({
      provider: 'anthropic', // or 'openai', 'gemini'
      model: env.MODEL, // required; no default, because model IDs change
      apiKey: env.ANTHROPIC_API_KEY, // a secret, never sent to the browser
      allowedOrigins: ['https://example.com'],
    });
    return handler(request);
  },
};
```

To try every path locally: `npm run demo` builds the package and serves [`examples/demo-shop.html`](examples/demo-shop.html) at http://localhost:5180/. It declares a read-only search, an add-to-cart tool, a `checkout` marked `consequentialHint`, a reviews tool marked `untrustedContentHint` (one review tries a prompt injection), and a declarative form tool. A "demo rules" option (keyword matching, not AI) lets you click through the confirmation flow in any browser.

## The safety rules

These are enforced in code and covered by tests.

1. **Declared tools only.** The agent lists tools with `getTools()` and runs them with `executeTool()`. A call to a name that is not in the list, or with arguments that fail the tool's `inputSchema` check, is not run; the error goes back to the model and counts as a step.
2. **Read-only tools run without asking.** A tool with `annotations.readOnlyHint: true` runs directly.
3. **Everything else asks.** Any other call waits for `confirm(request)`. Only a strict `true` allows it. A denied call is not run, and the model is told it was denied.
4. **No `confirm`, no action.** Without a `confirm` function, every call that needs asking is denied. Nothing is ever allowed by default.
5. **`preApproved` names skip asking,** with three exceptions that always ask:
   - tools marked `consequentialHint` (this cannot be disabled);
   - every non-read-only call after a tool marked `untrustedContentHint` returned, for the rest of the conversation (that content stays in the model's context; `reset()` starts over);
   - tools for which the browser returned no `annotations` at all, since the agent cannot tell what they do.
6. **Untrusted output is data.** Results of `untrustedContentHint` tools reach the model inside `<untrusted-data tool="...">…</untrusted-data>`, with any copy of that tag inside the content escaped, and the system instructions say such blocks are data, never instructions. This lowers the risk of prompt injection; it does not remove it, which is why rule 5 asks before every call that changes something once such output is in the conversation.
7. **Bounded.** One tool call at a time, `maxSteps` model turns per message (default 6), a per-call timeout (default 30 s), results cut to 4000 characters, and an abort that stops the model call, the pending confirmation and the running tool.

Declarative form tools (`<form toolname>`) keep the browser's own rule on top of these: the browser fills the form and the visitor still clicks Submit, unless the form has `toolautosubmit`.

## Models

| Adapter | Where the model runs | Key |
|---|---|---|
| `chromeBuiltIn(options?)` | On the visitor's machine, through Chrome's [Prompt API](https://developer.chrome.com/docs/ai/prompt-api) (`LanguageModel`) | None |
| `proxy({ url, headers?, credentials?, fetch? })` | Wherever your endpoint sends it | On your server |
| `custom(fn, { name?, availability? })` | Anywhere you like | Your choice; keep provider keys on a server |
| `firstAvailable(...models)` | The first model that is `available` for each step | — |

`<site-agent proxy-url="...">` uses `firstAvailable(chromeBuiltIn(), proxy({ url }))`: Chrome's model when it is ready on that machine, your endpoint otherwise.

**Chrome's built-in model, plainly:** desktop Chrome only (Windows 10 or 11, macOS 13+, Linux, or ChromeOS on Chromebook Plus; not Android or iOS), at least 22 GB free disk, and a GPU with more than 4 GB of VRAM or 16 GB of RAM with 4 or more CPU cores. The model is downloaded once per browser, which needs an unmetered connection and must start from a user gesture: the element shows a "Download the on-device model" button when Chrome reports `downloadable`, and never downloads by itself. Check Chrome's Prompt API page for the current status on web pages and any origin trial your site needs. The adapter asks the model to pick a tool through structured output (`responseConstraint` with a JSON Schema whose branches are "answer" or one call per tool), not native tool use, which Chrome has not documented. Small on-device models are suited to routing a request to the right tool, not to multi-step planning.

**WebMCP:** native `document.modelContext` is a Chrome origin trial from Chrome 149, and can be tried locally behind `chrome://flags/#enable-webmcp-testing`. Everywhere else the local shim stands in (see [How it works](#how-it-works-and-its-limits)).

## Server helper

`createProxyHandler(options)` from `@bydtech/site-agent/server` returns a standard fetch handler, `(request, context?) => Promise<Response>`. It speaks one small JSON protocol with `proxy()`:

```text
POST  { version: 1, instructions, messages, tools }
200   { type: "tool", name, arguments, id?, meta? }  or  { type: "answer", text }
```

and translates it to Anthropic's Messages API, OpenAI's Chat Completions (or any compatible endpoint through `baseURL`), or Gemini's `generateContent`, with plain `fetch` and no SDK. It asks for one tool call per step (`disable_parallel_tool_use` on Anthropic, `parallel_tool_calls: false` on OpenAI; Gemini has no such switch, so only its first call is used).

| Option | Default | |
|---|---|---|
| `provider` | required | `'anthropic'`, `'openai'` or `'gemini'` |
| `model` | required | The provider's model ID. No default: model IDs change. |
| `apiKey` | required | Read it from an environment variable or secret. |
| `allowedOrigins` | required | Exact origins (`https://example.com`), no `*`, no paths. |
| `baseURL` | provider's | For OpenAI-compatible servers, gateways or regional endpoints. |
| `maxTokens` | `1024` | Output tokens per step. |
| `maxMessages` | `40` | Messages per request. |
| `maxTools` | `32` | Tools per request. |
| `maxBodyBytes` | `65536` | Request body cap, checked on the header and on the bytes read. |
| `rateLimit` | `{ windowMs: 60000, max: 20 }` | Per client IP, sliding window, in memory. `false` turns it off. |
| `instructions` | — | Added on the server before the browser's instructions. |
| `allowClientInstructions` | `true` | `false` ignores the instructions the browser sends. |
| `allowHeaders` | — | Extra CORS request headers to allow. |
| `timeoutMs` | `30000` | Upstream timeout (504 after it). |
| `clientIp` | see below | `(request, context) => string \| undefined` |
| `fetch` | global | For tests or a custom agent. |
| `onError` | — | Receives upstream and unexpected errors for your logs. Clients only get a generic message and the upstream status code. |

The default client IP is the `cf-connecting-ip` header (set by Cloudflare), else the platform's connection info passed as the second argument (`{ ip }`, Deno's `remoteAddr`, Bun's `requestIP`), else one shared bucket. `X-Forwarded-For` is not read by default because clients can set it; behind a proxy you trust, pass `clientIp` to read its header. Tool names that providers reject (they allow letters, digits, `_` and `-`) are mapped for the provider and mapped back in the reply.

**What it protects, honestly:** the origin allowlist and CORS stop other websites from using your endpoint from their visitors' browsers. They are not authentication: any script outside a browser can send any `Origin` header. The rate limit, caps and token limit bound cost and abuse; they do not make the endpoint private. The rate limit lives in the memory of one instance (one Worker isolate, one Node process), so several instances each keep their own count. If you need more, put the handler behind your own authentication or a platform rate limiter.

Node 20+ with `node:http` (full file: [`examples/proxy-node.mjs`](examples/proxy-node.mjs)):

```js
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { createProxyHandler } from '@bydtech/site-agent/server';

const handler = createProxyHandler({
  provider: 'openai',
  model: process.env.MODEL,
  apiKey: process.env.OPENAI_API_KEY,
  allowedOrigins: ['https://example.com'],
});

createServer(async (req, res) => {
  const request = new Request(`http://${req.headers.host}${req.url}`, {
    method: req.method,
    headers: Object.entries(req.headers).flatMap(([k, v]) => (v === undefined ? [] : [[k, String(v)]])),
    body: req.method === 'POST' ? Readable.toWeb(req) : undefined,
    duplex: 'half',
  });
  const response = await handler(request, { ip: req.socket.remoteAddress });
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(8787);
```

Deno: `Deno.serve(handler)`. Bun: `Bun.serve({ fetch: handler })`. Cloudflare Workers: [`examples/proxy-worker.ts`](examples/proxy-worker.ts).

## API reference

### `createSiteAgent(options)`

```js
import { createSiteAgent, proxy } from '@bydtech/site-agent';

const agent = createSiteAgent({
  model: proxy({ url: '/api/agent' }),
  confirm: async ({ tool, lines, reason }) => window.confirm(`${tool.name}?\n${lines.map((l) => `${l.label}: ${l.value}`).join('\n')}`),
});

const run = agent.run('add two mugs to my cart');
for await (const event of run) console.log(event.type, event);
const { status, answer, trace } = await run.done;
```

| Option | Default | |
|---|---|---|
| `model` | required | A model adapter. |
| `tools` | `document.modelContext` | Any object with `getTools()` and `executeTool()`, or an array of tool descriptors (handy in tests and Node). Without it, the native `document.modelContext` is used, or the shim is installed. |
| `confirm` | none (deny) | `(request, { signal }) => boolean \| Promise<boolean>`. |
| `preApproved` | `[]` | Tool names that skip asking, within the rules above. |
| `maxSteps` | `6` | Model turns per message, 1 to 50. |
| `toolTimeoutMs` | `30000` | Per tool call. Time waiting for the visitor does not count. |
| `instructions` | — | Your instructions, appended after the built-in rules (which they cannot remove). |
| `maxResultChars` | `4000` | Tool results are cut to this length before they reach the model. |

The agent returns `{ run, reset, tools, onToolsChange, messages, running, model }`:

- `run(message, { signal? })` returns an `AgentRun`: async-iterate it for events, await `run.done` for the `RunResult` (`{ status: 'answered' | 'max-steps' | 'aborted' | 'error', answer?, error?, trace }`), call `run.abort()` to stop. Events are buffered, so iterating late still sees all of them. One run at a time; a second call while one runs throws a `SiteAgentError` with code `busy`.
- The conversation carries over between runs; `reset()` clears it and the untrusted-output state.
- `tools()` lists what the agent can see; `onToolsChange(fn)` follows the `toolchange` event.

**Events,** in order: `thinking` (`step`, `model`), `tool-call` (`call`), `confirm-request` (`request`, only when the visitor is asked), `confirm-result` (`call`, `decision: { allowed, by: 'read-only' | 'pre-approved' | 'visitor' | 'no-confirm', reason? }`, for every call), `tool-result` (`call`, `text`, `untrusted`, `isError`, `navigated`), `answer` (`text`), `error` (`code`, `message`), `done` (`result`).

**The confirm request** holds the `call` (`id`, `name`, `arguments`), the `tool` (`name`, `title`, `description`, `inputSchema`, `annotations`), the `reason` (`'not-read-only' | 'consequential' | 'after-untrusted' | 'annotations-unknown'`) and `lines`: the arguments in plain words, `[{ key, label, value }]`, labeled from each property's `title` in the schema or from the key (`productId` becomes "Product id").

**Tool results** are turned into text for the model: MCP-style `{ content: [{ type: 'text', text }] }` is joined (other content types become "[image omitted]" and similar, `isError: true` marks an error), strings pass through, other values are JSON-encoded, and `null` (what `executeTool` returns when the call navigates) becomes a note that the page navigated. A tool that throws or times out becomes an error result for the model, not a failed run.

**Error codes** (`SiteAgentError.code`, and `RunResult.error.code`): `aborted`, `busy`, `max-steps`, `model-unavailable`, `model-download-required`, `model-error`, `bad-reply`, `no-tools`.

### Models

`chromeBuiltIn({ languages = ['en'], maxHistory = 12, maxPromptChars = 6000 })`, `proxy({ url, headers, credentials = 'same-origin', fetch })`, `custom(fn, { name, availability })`, `firstAvailable(...models)`. A model adapter is `{ name, respond(request), availability?(), prepare?({ onProgress, signal }) }`; `respond` receives `{ instructions, messages, tools, signal }` and returns `{ type: 'tool', name, arguments, id?, meta? }` or `{ type: 'answer', text }`. Never put a provider key in `proxy`'s `headers`: every visitor could read it.

### Tools

- `installShim()`: returns `document.modelContext`, installing the local shim first only if the page has none. It never replaces the browser's own object.
- `createModelContext()`: a standalone shim, not installed anywhere (for tests, workers or Node).
- `hasNativeModelContext()`, `isShim(object)`.
- The shim implements `registerTool(descriptor, { signal })` (abort the signal to unregister), `getTools()` (alphabetical), `executeTool(tool, args, { signal })` and the `toolchange` event. It accepts `exposedTo` and ignores it.

### `replay(trace, options?)`

```js
import { replay } from '@bydtech/site-agent';

const result = await replay(savedTrace, { confirm: () => true });
// result.steps: [{ call, status: 'ran' | 'denied' | 'missing-tool' | 'invalid-arguments', text, recorded, matches }]
// result.differences: how many steps differ from the recording
```

It re-runs each recorded tool call in order against the current tools, with no model. The confirmation rules apply as in a live run (starting from a clean untrusted-output state); without `confirm`, calls that need asking are denied. Options: `tools`, `confirm`, `preApproved`, `toolTimeoutMs`, `maxResultChars`, `signal`, `onConfirmRequest`.

A trace is plain JSON: `{ version: 1, startedAt, endedAt, model, status, steps }`, where steps are `user`, `model` (the adapter that answered and its reply), `tool-call` (with the tool's hints), `invalid-call`, `decision`, `tool-result`, `answer` and `error`. Traces stay in memory; save them only if you choose to (`<site-agent>` exposes `lastTrace` and the `site-agent-done` event).

### `<site-agent>`

Importing `@bydtech/site-agent/element` defines the element once (a second import is harmless) and installs the shim if needed.

| Attribute | Default | |
|---|---|---|
| `proxy-url` | — | Your endpoint. |
| `models` | `"chrome proxy"` with `proxy-url`, else `"chrome"` | Which models to chain, in order. |
| `pre-approved` | — | Tool names, separated by spaces or commas. |
| `max-steps` | `6` | |
| `label` | "Ask this site" | Launcher text and panel heading. |
| `heading` | the label | Panel heading. |
| `placeholder` | "What can I do for you?" | |
| `instructions` | — | Short instructions for the model. |
| `open` | — | Opens the panel on load. |

From JavaScript: `element.options = { model, confirm, instructions, preApproved, maxSteps, toolTimeoutMs, tools }` (wins over attributes). Changing options or the model attributes starts a fresh conversation; during a run, the change waits until the run ends, `configure(partial)`, `show()`, `hide()`, `ask(text)`, `reset()`, `agent`, `lastTrace`. Events: `site-agent-event` (`detail` is each agent event) and `site-agent-done` (`detail` is the `RunResult`); both bubble out of the shadow root.

The confirmation card shows the tool's title or name, its description, each argument as a labeled line, why it asks, and Allow / Deny buttons. Escape closes the panel; closing it denies a pending confirmation. New messages are announced through `aria-live`, focus moves to the input on open, to the card when one appears, and back to the launcher on close. All model and tool text is set with `textContent`, never as HTML. Light and dark follow `prefers-color-scheme`. Theme it with CSS custom properties on the element:

```css
site-agent {
  --site-agent-accent: #0f766e;
  --site-agent-accent-fg: #fff;
  --site-agent-bg: #fff;
  --site-agent-fg: #1f2328;
  --site-agent-muted: #57606a;
  --site-agent-border: #d0d7de;
  --site-agent-surface: #f3f5f7;
  --site-agent-danger: #b42318;
  --site-agent-radius: 12px;
  --site-agent-font: system-ui, sans-serif;
  --site-agent-z: 2147483000;
}
```

The launcher and the panel are exposed as `::part(launcher)` and `::part(panel)`. No fonts, images or other requests are loaded.

## How it works, and its limits

- **WebMCP is a draft and may change.** It has already renamed things (`navigator.modelContext` became `document.modelContext`; JSON-string arguments are deprecated from Chrome 155). All browser calls go through one small tool-source module. Arguments are always passed as objects.
- **Annotations may be missing.** Chrome's documentation lists `annotations` on the tools `getTools()` returns; the spec explainer does not. When a tool comes back without them, the agent asks before every call to it (rule 5).
- **The shim is local.** In browsers without WebMCP, tools registered on the shim are visible only to code on that page: browser agents and other outside agents cannot see them. The shim does not implement declarative `<form toolname>` tools.
- **Declarative form tools** appear only where the browser has WebMCP. How `executeTool` reports a form the visitor has not yet submitted is up to the browser; the agent passes on whatever comes back.
- **Small models route; they do not plan.** Chrome's on-device model is a reasonable fit for picking one tool and its arguments, not for long chains of steps. Tool-choice accuracy has not been measured for any model; this README makes no accuracy claims.
- **Argument checks are small on purpose:** `type`, `required`, `properties`, `additionalProperties: false`, `enum`, `const` and `items`, recursively. Your tool should still validate its own input.
- **Untrusted fencing reduces prompt-injection risk; it does not remove it.** Asking before every call that changes something, once such output is in the conversation, is the backstop.
- **No DOM fallback, by design.** If a task has no declared tool, the agent says so instead of trying to click its way through the page.
- **The server's protections limit cost and abuse.** They do not authenticate anyone (see [Server helper](#server-helper)).
- **Gemini thought signatures:** the server passes a function call's `thoughtSignature` back to the browser in `meta` and returns it with the next request, as Gemini's newer models expect. This mapping is tested against recorded shapes, not against the live API.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security reports: [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)

---

Maintained by [BYD Tech](https://bydtech.in), a software studio that builds MVPs, AI agents, and web & mobile apps.
