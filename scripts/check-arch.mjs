#!/usr/bin/env node
// Version routing and vendored web-client code live behind src/odoo/ only (docs/architecture.md):
// no other source file may read the target version, define a since() table or import src/vendor/.
// The client owns the version itself.
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const ALLOWED = [/^src\/odoo\//, /^src\/odooClient\.ts$/];
const VERSIONED = /\.version\(\)|\bsince\(|\bunavailable\(|\.major\b|\.minor\b|\.saas\b|\.edition\b|\/vendor\//;

const files = readdirSync('src', { recursive: true })
  .map(f => join('src', String(f)).replaceAll('\\', '/'))
  .filter(f => f.endsWith('.ts') && !ALLOWED.some(re => re.test(f)));

const hits = files.flatMap(f =>
  readFileSync(f, 'utf8').split('\n')
    .map((line, i) => ({ f, n: i + 1, line }))
    .filter(({ line }) => VERSIONED.test(line)));

for (const { f, n, line } of hits) console.error(`${f}:${n}: ${line.trim()}`);
if (hits.length) {
  console.error('\nVersion-dependent or vendored code outside src/odoo/ — move it into an operation.');
  process.exit(1);
}
