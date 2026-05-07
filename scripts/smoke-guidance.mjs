#!/usr/bin/env node
/** End-to-end stdio smoke test for guidance tools against the local dist build. */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(HERE, '..', 'dist', 'index.js');

const proc = spawn('node', [ENTRY], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: { ...process.env, ODOO_URL: process.env.ODOO_URL || 'http://localhost', ODOO_DB: process.env.ODOO_DB || 'x', ODOO_USERNAME: process.env.ODOO_USERNAME || 'x', ODOO_PASSWORD: process.env.ODOO_PASSWORD || 'x' },
});

let buf = '';
const pending = new Map();
let nextId = 1;

proc.stdout.on('data', chunk => {
  buf += chunk.toString();
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id != null && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
      }
    } catch (e) { /* ignore non-JSON */ }
  }
});

function send(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout ${method}`)); } }, 5000);
  });
}

function unwrap(resp) {
  const text = resp.result?.content?.[0]?.text;
  return text ? JSON.parse(text) : resp;
}

function assert(cond, msg) {
  if (!cond) { console.error('❌ FAIL:', msg); process.exitCode = 1; }
  else console.log('✅', msg);
}

(async () => {
  try {
    await send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

    const tools = await send('tools/list', {});
    const names = (tools.result?.tools ?? []).map(t => t.name);
    assert(names.includes('list_skills'), 'list_skills registered');
    assert(names.includes('get_skill'), 'get_skill registered');
    assert(names.includes('find_skill'), 'find_skill registered');
    assert(names.includes('list_workflows'), 'list_workflows registered');
    assert(names.includes('get_workflow'), 'get_workflow registered');

    const ls = unwrap(await send('tools/call', { name: 'list_skills', arguments: {} }));
    assert(Array.isArray(ls) && ls.length === 2, `list_skills returns 2 entries (got ${ls.length})`);
    const html = ls.find(s => s.name === 'translate_html_field');
    assert(html && Array.isArray(html.used_in) && html.used_in.includes('translate_blog_post'),
      `translate_html_field.used_in includes translate_blog_post (got ${JSON.stringify(html?.used_in)})`);

    const gs = unwrap(await send('tools/call', { name: 'get_skill', arguments: { name: 'translate_html_field' } }));
    assert(gs.body && gs.body.length > 1000, `get_skill body present (len=${gs.body?.length})`);
    assert(gs.used_in?.includes('translate_blog_post'), 'get_skill includes used_in back-reference');

    const fs = unwrap(await send('tools/call', { name: 'find_skill', arguments: { model: 'blog.post', field_type: 'html_translate', operation: 'translate' } }));
    assert(Array.isArray(fs) && fs.length === 1 && fs[0].name === 'translate_html_field',
      `find_skill matches html_translate → translate_html_field (got ${fs.map(s=>s.name).join(',')})`);

    const fs2 = unwrap(await send('tools/call', { name: 'find_skill', arguments: { field_type: 'char', operation: 'translate' } }));
    assert(fs2.length === 1 && fs2[0].name === 'translate_char_field',
      `find_skill matches char → translate_char_field (got ${fs2.map(s=>s.name).join(',')})`);

    const fsNone = unwrap(await send('tools/call', { name: 'find_skill', arguments: { operation: 'delete' } }));
    assert(fsNone.length === 0, `find_skill returns empty for unknown operation (got ${fsNone.length})`);

    const lw = unwrap(await send('tools/call', { name: 'list_workflows', arguments: {} }));
    assert(lw.length === 1 && lw[0].name === 'translate_blog_post', `list_workflows returns translate_blog_post`);
    assert(lw[0].skills?.length === 2, `workflow declares 2 skills (got ${lw[0].skills?.length})`);

    const gw = unwrap(await send('tools/call', { name: 'get_workflow', arguments: { name: 'translate_blog_post', expand_skills: true } }));
    assert(gw.body?.length > 1000, `get_workflow body present (len=${gw.body?.length})`);
    assert(Array.isArray(gw.expanded_skills) && gw.expanded_skills.length === 2, `expanded_skills returns 2 entries`);
    assert(gw.expanded_skills.every(s => s.body && s.body.length > 500), `every expanded skill has full body`);

    const missing = unwrap(await send('tools/call', { name: 'get_skill', arguments: { name: 'nope' } }));
    assert(missing.error?.includes("'nope' not found"), `get_skill returns error for missing skill`);

    console.log(process.exitCode ? '\n❌ smoke test had failures' : '\n✅ all guidance tools smoke-tested OK');
  } catch (e) {
    console.error('❌ smoke test crashed:', e);
    process.exitCode = 1;
  } finally {
    proc.kill();
  }
})();
