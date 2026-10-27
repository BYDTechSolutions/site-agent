import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', element: 'src/element.ts', server: 'src/server.ts' },
  format: ['esm'],
  // Runs in browsers (core, element) and in Workers, Deno, Bun and Node 20+ (server).
  target: 'es2022',
  platform: 'neutral',
  dts: true,
  clean: true,
  sourcemap: false,
  splitting: true,
  minify: true,
});
