#!/usr/bin/env node
// Version routing lives in src/odoo/ only (docs/architecture.md): no other source file may
// read the target version or define a since() table. The client owns the version itself.
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const ALLOWED = [/^src\/odoo\//, /^src\/odooClient\.ts$/];
const VERSIONED = /\.version\(\)|\bsince\(|\bunavailable\(|\.major\b|\.minor\b|\.saas\b|\.edition\b/;

const files = readdirSync('src', { recursive: true })
  .map(f => join('src', String(f)).replaceAll('\\', '/'))
  .filter(f => f.endsWith('.ts') && !ALLOWED.some(re => re.test(f)));

const hits = files.flatMap(f =>
  readFileSync(f, 'utf8').split('\n')
    .map((line, i) => ({ f, n: i + 1, line }))
    .filter(({ line }) => VERSIONED.test(line)));

for (const { f, n, line } of hits) console.error(`${f}:${n}: ${line.trim()}`);
if (hits.length) {
  console.error('\nVersion-dependent code outside src/odoo/ — move it into an operation.');
  process.exit(1);
}
