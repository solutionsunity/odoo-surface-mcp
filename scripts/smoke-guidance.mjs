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
    assert(names.includes('get_skills'), 'get_skills registered (batch)');
    assert(names.includes('find_skill'), 'find_skill registered');
    assert(names.includes('list_workflows'), 'list_workflows registered');
    assert(names.includes('get_workflows'), 'get_workflows registered (batch)');

    // ── list_skills ──────────────────────────────────────────────────────────
    const ls = unwrap(await send('tools/call', { name: 'list_skills', arguments: {} }));
    assert(Array.isArray(ls) && ls.length === 5, `list_skills returns 5 entries (got ${ls.length})`);
    const html = ls.find(s => s.name === 'translate_html_field');
    assert(html && Array.isArray(html.used_in) && html.used_in.includes('translate_blog_post'),
      `translate_html_field.used_in includes translate_blog_post`);
    assert(html?.applies_to?.field_types?.includes('xml_translate'),
      `translate_html_field covers xml_translate`);
    assert(ls.find(s => s.name === 'upload_attachment'), 'upload_attachment skill present');
    assert(ls.find(s => s.name === 'inject_snippet'), 'inject_snippet skill present');
    assert(ls.find(s => s.name === 'edit_view_arch'), 'edit_view_arch skill present');

    // ── get_skills (batch) ───────────────────────────────────────────────────
    const gs = unwrap(await send('tools/call', { name: 'get_skills', arguments: { names: ['translate_html_field', 'translate_char_field'] } }));
    assert(Array.isArray(gs) && gs.length === 2, `get_skills returns 2 entries for 2 names`);
    assert(gs[0].body?.length > 1000, `get_skills[0] body present`);
    assert(gs[0].used_in?.includes('translate_blog_post'), 'get_skills[0] used_in correct');
    // partial success — one missing name
    const gsMixed = unwrap(await send('tools/call', { name: 'get_skills', arguments: { names: ['translate_char_field', 'nope'] } }));
    assert(gsMixed.length === 2, 'get_skills partial: returns 2 entries for 1 good + 1 bad');
    assert(gsMixed[0].body?.length > 0, 'get_skills partial: good entry has body');
    assert(gsMixed[1].error?.includes("'nope' not found"), 'get_skills partial: bad entry has error');

    // ── find_skill ───────────────────────────────────────────────────────────
    const fs = unwrap(await send('tools/call', { name: 'find_skill', arguments: { model: 'blog.post', field_type: 'html_translate', operation: 'translate' } }));
    assert(fs.length === 1 && fs[0].name === 'translate_html_field', `find_skill html_translate → translate_html_field`);
    const fs2 = unwrap(await send('tools/call', { name: 'find_skill', arguments: { field_type: 'xml_translate', operation: 'translate' } }));
    assert(fs2.length === 1 && fs2[0].name === 'translate_html_field', `find_skill xml_translate → translate_html_field`);
    const fs3 = unwrap(await send('tools/call', { name: 'find_skill', arguments: { field_type: 'char', operation: 'translate' } }));
    assert(fs3.length === 1 && fs3[0].name === 'translate_char_field', `find_skill char → translate_char_field`);
    const fsNone = unwrap(await send('tools/call', { name: 'find_skill', arguments: { operation: 'delete' } }));
    assert(fsNone.length === 0, `find_skill returns empty for unknown operation`);

    // ── list_workflows ───────────────────────────────────────────────────────
    const lw = unwrap(await send('tools/call', { name: 'list_workflows', arguments: {} }));
    assert(lw.length === 4, `list_workflows returns 4 entries (got ${lw.length})`);
    const wfNames = lw.map(w => w.name);
    assert(wfNames.includes('translate_blog_post'), 'translate_blog_post workflow present');
    assert(wfNames.includes('translate_website_page'), 'translate_website_page workflow present');
    assert(wfNames.includes('create_blog_post'), 'create_blog_post workflow present');
    assert(wfNames.includes('create_website_page'), 'create_website_page workflow present');

    // ── get_workflows (batch + expand) ───────────────────────────────────────
    const gw = unwrap(await send('tools/call', { name: 'get_workflows', arguments: { names: ['translate_blog_post', 'translate_website_page'], expand_skills: true } }));
    assert(Array.isArray(gw) && gw.length === 2, `get_workflows returns 2 entries`);
    assert(gw[0].body?.length > 1000, `get_workflows[0] body present`);
    assert(Array.isArray(gw[0].expanded_skills) && gw[0].expanded_skills.length === 2, `translate_blog_post has 2 expanded skills`);
    assert(gw[0].expanded_skills.every(s => s.body?.length > 500), `all expanded skills have body`);
    assert(gw[1].name === 'translate_website_page', 'get_workflows[1] is translate_website_page');
    // partial success
    const gwMissing = unwrap(await send('tools/call', { name: 'get_workflows', arguments: { names: ['translate_blog_post', 'nonexistent'] } }));
    assert(gwMissing[1].error?.includes("'nonexistent' not found"), 'get_workflows partial: bad entry has error');

    // ── GUIDANCE_HINT on mutating tools ──────────────────────────────────────
    const HINT_SUBSTR = 'find_skill / list_workflows';
    const mutating = ['create', 'update', 'archive', 'execute_action', 'set_page_arch', 'set_page_visibility', 'fetch_and_upload', 'translation_update'];
    for (const t of mutating) {
      const def = (tools.result?.tools ?? []).find(x => x.name === t);
      assert(def?.description?.includes(HINT_SUBSTR), `${t} description includes guidance hint`);
    }
    const nonMutating = ['get_models', 'get_fields', 'list_records', 'list_skills'];
    for (const t of nonMutating) {
      const def = (tools.result?.tools ?? []).find(x => x.name === t);
      assert(!def?.description?.includes(HINT_SUBSTR), `${t} description does NOT include hint (correct)`);
    }

    console.log(process.exitCode ? '\n❌ smoke test had failures' : '\n✅ all guidance tools smoke-tested OK');
  } catch (e) {
    console.error('❌ smoke test crashed:', e);
    process.exitCode = 1;
  } finally {
    proc.kill();
  }
})();
