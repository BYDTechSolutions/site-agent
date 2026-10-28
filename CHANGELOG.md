# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-10-28

### Changed

- Published from GitHub Actions with npm trusted publishing, so the package carries a provenance attestation. No code changes.

## [0.1.0] - 2026-10-28

### Added

- `createSiteAgent`: the loop over a page's declared WebMCP tools. One tool call per step, argument checks against each tool's `inputSchema`, `maxSteps` (default 6), a per-call timeout, abort at any point, events as an async iterator, and a JSON trace for every run.
- Confirmation rules: read-only tools run directly; every other call asks through `confirm`; `preApproved` names skip asking except for `consequentialHint` tools, every non-read-only call after untrusted output until `reset()`, and tools the browser returned without annotations. No `confirm` means those calls are denied.
- Output of `untrustedContentHint` tools is fenced as data in `<untrusted-data>` blocks, with the delimiter escaped inside the content.
- Model adapters: `chromeBuiltIn()` (Chrome's Prompt API with a JSON Schema response constraint, honest availability and a user-started download), `proxy({ url })`, `custom(fn)` and `firstAvailable(...)`. No adapter takes a provider API key in the browser.
- Tool source: the browser's `document.modelContext` when present; otherwise `installShim()` adds a local `registerTool` / `getTools` / `executeTool` / `toolchange` implementation, never replacing a native one.
- `replay(trace)`: re-runs recorded tool calls without a model, under the same confirmation rules, and reports differences from the recording.
- `<site-agent>` (`@bydtech/site-agent/element`): launcher, chat panel, confirmation card with Allow and Deny, on-device model status and download button, keyboard and screen-reader support, light and dark, CSS custom properties.
- `createProxyHandler` (`@bydtech/site-agent/server`): a fetch handler for Anthropic, OpenAI-compatible and Gemini tool calling with an origin allowlist, CORS, a per-IP in-memory rate limit, and body, message, tool and token caps. Runs in Cloudflare Workers, Deno, Bun and Node 20+.
- Examples: a demo shop (`npm run demo`), proxies for Node and Cloudflare Workers.
- Zero runtime dependencies; a size check keeps the browser bundle under 30 kB gzipped.

[Unreleased]: https://github.com/BYDTechSolutions/site-agent/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/BYDTechSolutions/site-agent/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/BYDTechSolutions/site-agent/tree/v0.1.0
