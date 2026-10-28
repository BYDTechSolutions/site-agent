# Security policy

## Reporting a vulnerability

Please email **sales.bydtech@gmail.com** with the details, instead of opening a
public issue. We will acknowledge the report and keep you posted on the fix.

## Scope

`site-agent` runs in the visitor's browser and calls only the WebMCP tools the
page declared. It asks the visitor before any call that is not marked
read-only, always asks for tools marked `consequentialHint`, fences output from
`untrustedContentHint` tools as data, renders model text as text, and sends
requests only to the proxy URL the developer configured. The server helper
forwards requests to one model provider with a key it never returns.

Especially welcome:

- any way to make the agent run a tool call that the rules say must be
  confirmed, without the visitor's Allow (including through `preApproved`,
  replay, malformed model replies or tool results);
- any way for tool output or model text to become HTML or script in the page;
- any way for content inside an untrusted-data block to close the block;
- any way to call a tool the page did not declare, or to reach the DOM;
- any way to get the server helper to leak its API key, call a host other than
  its provider, or skip its origin check, caps or rate limit.

Known and documented limits, not vulnerabilities: prompt injection through
untrusted content can still steer the model's words (the fresh confirmation is
the backstop); the origin allowlist is not authentication; the rate limit is
per instance and in memory; the shim's tools are local to the page.
