#!/usr/bin/env node
// Copies src/vendor/ to dist/vendor/. Node ES module resolution needs relative specifiers with file
// extensions; upstream omits extensions and imports web core through the '@web/core/' alias. The
// copies get '@web/core/' resolved to a relative path and '.js' appended — the only changes made
// to vendored code.
import { cpSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, relative } from 'path';

const ALIAS = { '@web/core/': 'dist/vendor/odoo-web-core/' };

cpSync('src/vendor', 'dist/vendor', { recursive: true, filter: f => !f.endsWith('.d.ts') });
for (const f of readdirSync('dist/vendor', { recursive: true }).map(String).filter(f => f.endsWith('.js'))) {
  const path = join('dist/vendor', f);
  const resolve = (spec) => {
    for (const [alias, target] of Object.entries(ALIAS)) {
      if (spec.startsWith(alias)) {
        const rel = relative(dirname(path), join(target, spec.slice(alias.length))).replaceAll('\\', '/');
        spec = rel.startsWith('.') ? rel : `./${rel}`;
      }
    }
    return spec.startsWith('.') && !spec.endsWith('.js') ? `${spec}.js` : spec;
  };
  writeFileSync(path, readFileSync(path, 'utf8')
    .replace(/(\bfrom\s+["'])([^"']+)(["'])/g, (_, a, spec, b) => `${a}${resolve(spec)}${b}`));
}
