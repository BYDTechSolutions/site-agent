# Contributing

Thanks for helping. Issues and pull requests are welcome at
[github.com/BYDTechSolutions/site-agent](https://github.com/BYDTechSolutions/site-agent).

## Setup

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run size
npm run demo   # http://localhost:5180/
```

Node.js 20 or later. Tests never call a model provider: `fetch` is mocked.

## Rules

- **Declared tools only.** The agent may act only through `getTools()` and
  `executeTool()`. No DOM reading or clicking, no `eval`, no navigation of its
  own. A DOM fallback is out of scope by design.
- **The confirmation rules are not negotiable.** They live in `src/policy.ts`
  and are listed in the README. `consequentialHint` always asks; no option may
  turn that off; a missing `confirm` denies. `test/confirm.test.ts` covers each
  rule: extend it with any change there.
- **No key in the browser.** Do not add a browser adapter that takes a model
  provider's API key.
- **Model text is text.** The element sets model and tool output with
  `textContent` only. `innerHTML` is used once, for the element's own static
  template.
- **All WebMCP calls go through `src/tools.ts`,** so a change in the draft API
  touches one file. Pass arguments as objects.
- **No telemetry,** no requests other than to the proxy URL the developer set.
- **State only what the code does today.** No accuracy or benchmark numbers in
  the docs unless they were measured, with the date and the model.
- Keep the browser bundle under the budget (`npm run size`, 30 kB gzipped).
- No runtime dependencies.
- Add a line to `CHANGELOG.md` under "Unreleased".
- American English in code, messages and docs.
