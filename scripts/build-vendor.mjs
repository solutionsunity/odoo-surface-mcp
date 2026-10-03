#!/usr/bin/env node
// Copies src/vendor/ to dist/vendor/. Node ESM resolution needs file extensions on relative imports,
// which upstream omits; the copies get '.js' appended to them — the only change made to vendored code.
import { cpSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

cpSync('src/vendor', 'dist/vendor', { recursive: true, filter: f => !f.endsWith('.d.ts') });
for (const f of readdirSync('dist/vendor', { recursive: true }).map(String).filter(f => f.endsWith('.js'))) {
  const path = join('dist/vendor', f);
  writeFileSync(path, readFileSync(path, 'utf8')
    .replace(/(\bfrom\s+["'])(\.{1,2}\/[^"']+?)(["'])/g, (m, a, spec, b) => spec.endsWith('.js') ? m : `${a}${spec}.js${b}`));
}
