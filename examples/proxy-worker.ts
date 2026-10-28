// A model proxy as a Cloudflare Worker. Store the key as a secret:
//   npx wrangler secret put OPENAI_API_KEY
// and set MODEL and ALLOWED_ORIGIN as variables in wrangler.toml.
import { createProxyHandler, type ProxyHandler } from '@bydtech/site-agent/server';

interface Env {
  OPENAI_API_KEY: string;
  MODEL: string;
  ALLOWED_ORIGIN: string;
}

// One handler per isolate, so the in-memory rate limit lives as long as the isolate does.
let handler: ProxyHandler | undefined;

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    handler ??= createProxyHandler({
      provider: 'openai',
      model: env.MODEL,
      apiKey: env.OPENAI_API_KEY,
      allowedOrigins: [env.ALLOWED_ORIGIN],
      maxTokens: 512,
      // Cloudflare sets cf-connecting-ip, which the default client IP lookup reads.
    });
    return handler(request);
  },
};
