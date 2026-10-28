// A tiny static server for the demo: serves only examples/ and dist/ on localhost.
// npm run demo  →  http://localhost:5180/
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.env.PORT ?? 5180);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };

createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
  if (path === '/') {
    res.writeHead(302, { location: '/examples/demo-shop.html' }).end();
    return;
  }
  const file = normalize(join(root, path));
  const allowed = [join(root, 'examples') + sep, join(root, 'dist') + sep].some((dir) => file.startsWith(dir));
  if (!allowed) {
    res.writeHead(404).end('Not found');
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' }).end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`Demo shop: http://localhost:${port}/`);
});
