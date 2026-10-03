#!/usr/bin/env node
// package.json holds the version. `npm version` runs this to stamp server.json in the same commit;
// `--check` (CI, on a tag) fails unless the tag, package.json and server.json agree.
import { readFileSync, writeFileSync } from 'fs';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const server = JSON.parse(readFileSync('server.json', 'utf8'));

if (process.argv.includes('--check')) {
  const tag = process.env.GITHUB_REF_NAME;
  const found = { tag, 'server.json version': server.version, 'server.json packages[0].version': server.packages[0].version };
  const wrong = Object.entries(found).filter(([k, v]) => v !== (k === 'tag' ? `v${version}` : version));
  if (wrong.length) {
    console.error(`package.json is ${version}; mismatched: ${wrong.map(([k, v]) => `${k}=${v}`).join(', ')}`);
    process.exit(1);
  }
} else {
  server.version = server.packages[0].version = version;
  writeFileSync('server.json', JSON.stringify(server, null, 2) + '\n');
}
