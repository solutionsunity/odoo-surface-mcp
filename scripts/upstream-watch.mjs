#!/usr/bin/env node
// Upstream watch for vendored code. Reads src/vendor/*/UPSTREAM.json; for every vendored path and
// watched branch, compares the latest upstream commit touching it with the reviewed one, and
// checks whether the next stable series branch exists. Any finding opens one issue labelled
// with the vendor's label, unless one is already open.
//
//   GITHUB_TOKEN=… GITHUB_REPOSITORY=owner/repo node scripts/upstream-watch.mjs [--dry-run]
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

const API = 'https://api.github.com';
const DRY = process.argv.includes('--dry-run');
const { GITHUB_TOKEN, GITHUB_REPOSITORY } = process.env;

async function gh(path, init = {}) {
  const headers = { Accept: 'application/vnd.github+json', ...(GITHUB_TOKEN && { Authorization: `Bearer ${GITHUB_TOKEN}` }) };
  const res = await fetch(`${API}${path}`, { ...init, headers: { ...headers, ...init.headers } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path}: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

const latest = async (repo, branch, path) =>
  (await gh(`/repos/${repo}/commits?sha=${encodeURIComponent(branch)}&path=${encodeURIComponent(path)}&per_page=1`))?.[0]?.sha;

let failed = false;
for (const dir of readdirSync('src/vendor')) {
  const file = join('src/vendor', dir, 'UPSTREAM.json');
  if (!existsSync(file)) continue;
  const up = JSON.parse(readFileSync(file, 'utf8'));
  const label = `upstream-${dir.replace(/^odoo-/, '')}`;
  const findings = [];

  for (const [path, branches] of Object.entries(up.reviewed)) {
    for (const [branch, reviewed] of Object.entries(branches)) {
      const sha = await latest(up.repository, branch, `${up.root}/${path}`);
      if (!sha) findings.push(`- \`${path}\` on \`${branch}\`: branch or path not found upstream`);
      else if (sha !== reviewed) {
        findings.push(`- \`${path}\` on \`${branch}\`: ${reviewed.slice(0, 8)} → ${sha.slice(0, 8)} — https://github.com/${up.repository}/compare/${reviewed}...${sha}`);
      }
    }
  }

  const series = Object.values(up.reviewed).flatMap(Object.keys).filter(b => /^\d+\.0$/.test(b)).map(Number);
  const next = `${Math.max(...series) + 1}.0`;
  if (await gh(`/repos/${up.repository}/branches/${next}`)) {
    findings.push(`- new series \`${next}\` exists upstream — not watched yet`);
  }

  if (!findings.length) { console.log(`${dir}: up to date`); continue; }

  const title = `Upstream ${dir} changed`;
  const body = [
    `\`${up.repository}\` \`${up.root}\` moved beyond the reviewed state in \`${file}\`:`, '',
    ...findings, '',
    `Vendored copy: \`${up.vendored.branch}\` @ ${up.vendored.commit.slice(0, 8)}. Review the changes; update the copy if`,
    'behaviour changed, then record the reviewed commits (and any new series) in UPSTREAM.json.',
  ].join('\n');

  if (DRY) { console.log(`${dir}: would open "${title}" [${label}]\n${body}`); continue; }
  if (!GITHUB_REPOSITORY) { console.error('GITHUB_REPOSITORY not set'); failed = true; continue; }
  const open = await gh(`/repos/${GITHUB_REPOSITORY}/issues?labels=${label}&state=open&per_page=1`);
  if (open?.length) { console.log(`${dir}: changes found; #${open[0].number} already open`); continue; }
  const issue = await gh(`/repos/${GITHUB_REPOSITORY}/issues`, {
    method: 'POST', body: JSON.stringify({ title, body, labels: [label] }),
  });
  console.log(`${dir}: opened #${issue.number}`);
}
process.exit(failed ? 1 : 0);
