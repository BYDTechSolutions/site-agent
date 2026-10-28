// Fails when the browser side (dist/index.js + dist/element.js and every chunk they import)
// is larger than the budget, gzipped. Run after `npm run build`.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { gzipSync } from 'node:zlib';

const BUDGET = 30 * 1024;
const root = new URL('../dist/', import.meta.url).pathname;
const entries = ['index.js', 'element.js'].map((f) => join(root, f));

for (const entry of entries) {
  if (!existsSync(entry)) {
    console.error(`Missing ${relative(process.cwd(), entry)}. Run npm run build first.`);
    process.exit(1);
  }
}

const seen = new Set();
const queue = [...entries];
while (queue.length) {
  const file = queue.pop();
  if (seen.has(file)) continue;
  seen.add(file);
  const code = readFileSync(file, 'utf8');
  for (const match of code.matchAll(/(?:from|import)\s*["'](\.\/[^"']+)["']/g)) {
    queue.push(join(dirname(file), match[1]));
  }
}

let total = 0;
const rows = [...seen].sort().map((file) => {
  const size = gzipSync(readFileSync(file), { level: 9 }).length;
  total += size;
  return `  ${relative(root, file).padEnd(28)} ${(size / 1024).toFixed(2).padStart(6)} kB`;
});
console.log('Browser bundle, gzipped:');
console.log(rows.join('\n'));
console.log(`  ${'total'.padEnd(28)} ${(total / 1024).toFixed(2).padStart(6)} kB (budget ${BUDGET / 1024} kB)`);
if (total > BUDGET) {
  console.error('Over budget.');
  process.exit(1);
}
