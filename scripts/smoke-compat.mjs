#!/usr/bin/env node
/**
 * Live compatibility smoke: drives the built server over stdio against every target in an env
 * file and checks each tool call's result shape. Read-only — no tool here writes.
 *
 *   node scripts/smoke-compat.mjs <env-file>
 *
 * The env file holds one block per target, prefixed by series: O15_ODOO_URL, O15_ODOO_DB,
 * O15_ODOO_USERNAME, O15_ODOO_PASSWORD, O17_…; the prefix's number is the expected major.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ENTRY = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const envFile = process.argv[2];
if (!envFile) { console.error('usage: smoke-compat.mjs <env-file>'); process.exit(2); }

const targets = {};
for (const line of readFileSync(envFile, 'utf8').split('\n')) {
  const m = /^O(\d+)_(ODOO_\w+)=(.*)$/.exec(line.trim());
  if (m && m[3]) (targets[m[1]] ??= {})[m[2]] = m[3];
}

const nonEmpty = v => Array.isArray(v) ? v.length > 0 : v && typeof v === 'object' && Object.keys(v).length > 0;
const noError = v => !JSON.stringify(v).includes('"error"');

// [tool, args, check(result, major) → true | reason]
const CASES = [
  ['ping', {}, (r, major) => r.version?.major === major || `major ${r.version?.major}`],
  ['inspect_view', { model: 'res.partner', view_type: 'list' }, r => r.arch?.includes('<field') || 'no arch'],
  ['inspect_view', { model: 'res.partner', view_type: 'form' }, r => r.arch?.includes('<field') || 'no arch'],
  ['get_fields', { model: 'res.partner', view_type: 'list' }, r => (nonEmpty(r) && noError(r)) || 'empty'],
  ['get_fields', { model: 'res.partner', view_type: 'form' }, r => (nonEmpty(r) && noError(r)) || 'empty'],
  ['list_records', { model: 'res.partner', limit: 2 }, r => Object.keys(r.records?.[0] ?? {}).length > 2 || 'display_name only'],
  ['get_record', { model: 'res.partner', record_id: 1 }, r => Object.keys(r).length > 2 || 'display_name only'],
  ['get_defaults', { model: 'res.partner' }, r => noError(r) || 'error'],
  ['get_models', { base: 'res.partner' }, r => (nonEmpty(r) && noError(r)) || 'empty'],
  ['get_model_actions', { model: 'res.partner' }, r => (noError(r.view_buttons) && r.can_write === true) || 'view_buttons error or no write access'],
  ['get_model_interface', { model: 'res.partner' }, r => (nonEmpty(r.fields) && !('fields' in r.fields)) || 'fields empty or nested'],
  ['get_available_actions', { model: 'res.partner', record_id: 1 }, r => Array.isArray(r.visible_buttons) || 'no visible_buttons'],
  ['search_records', { model: 'res.partner', query: 'a', limit: 3 }, r => (nonEmpty(r) && noError(r)) || 'empty'],
  ['read_group', { model: 'ir.module.module', groupby: ['state'], aggregates: ['sequence:sum'] },
    r => (nonEmpty(r) && Object.keys(r[0]).join() === 'state,__count,sequence:sum') || 'shape'],
  ['get_filters', { model: 'res.partner' }, r => (Array.isArray(r) && noError(r)) || 'error'],
  ['list_attachments', {}, r => noError(r) || 'error'],
  ['list_pages', {}, r => (nonEmpty(r) && noError(r)) || 'empty'],
  ['list_snippets', {}, r => (nonEmpty(r) && noError(r)) || 'empty'],
  ['get_snippet', { key: 'website.s_text_image' }, r => r.html?.includes('<') || 'no html'],
  ['download_binary', { model: 'res.company', record_id: 1, field: 'logo', dest_path: '/tmp/smoke-compat-logo.png' },
    r => r.size_bytes > 0 || 'no bytes'],
];

function server(env) {
  const proc = spawn('node', [ENTRY, '--debug'], { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, ...env } });
  const pending = new Map();
  let buf = '', nextId = 1;
  proc.stdout.on('data', chunk => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      try { const msg = JSON.parse(line); pending.get(msg.id)?.(msg); pending.delete(msg.id); } catch { /* not JSON-RPC */ }
    }
  });
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => pending.delete(id) && reject(new Error(`timeout ${method}`)), 30000);
  });
  return { proc, send };
}

let failed = 0;
for (const [series, env] of Object.entries(targets)) {
  const major = Number(series);
  const { proc, send } = server(env);
  await send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke-compat', version: '0' } });
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  console.log(`\n── ${series} (${env.ODOO_URL})`);
  for (const [tool, args, check] of CASES) {
    let verdict;
    try {
      const resp = await send('tools/call', { name: tool, arguments: args });
      const text = resp.result?.content?.[0]?.text ?? '';
      let result;
      try { result = JSON.parse(text); } catch { result = { error: text }; }
      verdict = result?.error && !Array.isArray(result) ? String(result.error).slice(0, 120) : check(result, major);
    } catch (e) { verdict = String(e); }
    const pass = verdict === true;
    if (!pass) failed++;
    console.log(`${pass ? '✅' : '❌'} ${tool} ${JSON.stringify(args)}${pass ? '' : ` — ${verdict}`}`);
  }
  proc.kill();
}
process.exit(failed ? 1 : 0);
