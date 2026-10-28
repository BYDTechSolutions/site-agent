// A model proxy for Node 20+ with node:http. The API key stays in this process.
//
//   ANTHROPIC_API_KEY=... MODEL=<model id> node examples/proxy-node.mjs
//
// Then pick "Your proxy" in the demo shop (npm run demo).
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { createProxyHandler } from '@bydtech/site-agent/server';

const handler = createProxyHandler({
  provider: 'anthropic', // or 'openai' (with baseURL for compatible endpoints) or 'gemini'
  model: process.env.MODEL, // required: there is no default model
  apiKey: process.env.ANTHROPIC_API_KEY,
  allowedOrigins: ['http://localhost:5180'],
  maxTokens: 512,
  rateLimit: { windowMs: 60_000, max: 20 },
  // Use the socket address for the rate limit. Behind a proxy you trust, read its header instead.
  clientIp: (_request, context) => context.ip,
  onError: (error) => console.error(error),
});

createServer(async (req, res) => {
  if (req.url !== '/agent') return void res.writeHead(404).end();
  const request = new Request(`http://${req.headers.host}${req.url}`, {
    method: req.method,
    headers: Object.entries(req.headers).flatMap(([k, v]) => (v === undefined ? [] : [[k, String(v)]])),
    body: req.method === 'POST' ? Readable.toWeb(req) : undefined,
    duplex: 'half',
  });
  const response = await handler(request, { ip: req.socket.remoteAddress });
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(8787, '127.0.0.1', () => console.log('Model proxy: http://localhost:8787/agent'));
