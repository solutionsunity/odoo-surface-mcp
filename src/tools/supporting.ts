/**
 * Layer 3 — Supporting tools: list_records, get_record (+ fields/context), search_records,
 * get_fields, get_defaults, get_filters, list_snippets, get_snippet,
 * list_attachments, fetch_and_upload, translation_get, translation_update.
 * Also exports shared helpers used by other layers.
 */
import { readFile } from 'fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { OdooClient } from '../odooClient.js';
import { Cache } from '../cache.js';
import { xmlParser, FXPNode, iterNodes, ok, GUIDANCE_HINT } from '../utils.js';

// ─── XML helpers ────────────────────────────────────────────────────────────

function parseArch(arch: string): FXPNode[] {
  return xmlParser.parse(arch) as FXPNode[];
}

// ─── Python-literal helpers ──────────────────────────────────────────────────

export function safeEvalList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!raw || raw === false) return [];
  try {
    const js = String(raw)
      .replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false').replace(/\bNone\b/g, 'null')
      .replace(/\(/g, '[').replace(/\)/g, ']');
    const val = JSON.parse(js);
    return Array.isArray(val) ? val : [];
  } catch { return []; }
}

export function safeEvalDict(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (!raw || raw === false) return {};
  try {
    const js = String(raw)
      .replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false').replace(/\bNone\b/g, 'null')
      .replace(/'/g, '"');
    const val = JSON.parse(js);
    return val && typeof val === 'object' && !Array.isArray(val) ? val as Record<string, unknown> : {};
  } catch { return {}; }
}

// ─── Shared helpers ──────────────────────────────────────────────────────────

export async function actionDomainContext(
  client: OdooClient, cache: Cache, actionId: number | undefined | null,
): Promise<[unknown[], Record<string, unknown>]> {
  if (!actionId) return [[], {}];
  const key = `action_info:${actionId}`;
  const cached = cache.get(key) as { domain: unknown[]; context: Record<string, unknown> } | undefined;
  if (cached) return [cached.domain, cached.context];
  try {
    const rows = await client.execute('ir.actions.act_window', 'read', [[actionId]], {
      fields: ['domain', 'context'],
    }) as Array<{ domain: unknown; context: unknown }>;
    if (!rows.length) return [[], {}];
    const act = rows[0];
    const domain = safeEvalList(act.domain);
    const context = safeEvalDict(act.context);
    cache.set(key, { domain, context });
    return [domain, context];
  } catch { return [[], {}]; }
}

export async function resolveContext(
  client: OdooClient, cache: Cache,
  actionId: number | undefined | null,
  ctx: Record<string, unknown> | undefined | null,
): Promise<Record<string, unknown>> {
  const [, actionCtx] = await actionDomainContext(client, cache, actionId);
  return { ...actionCtx, ...(ctx ?? {}) };
}

export async function viewFieldNames(
  client: OdooClient, cache: Cache, model: string, viewType: string,
): Promise<string[]> {
  const key = `view_fields:${model}:${viewType}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached as string[];

  const odooType = viewType === 'list' ? 'tree' : viewType;
  let arch = '';
  try {
    const result = await client.execute(model, 'get_views', [[[false, odooType]]]) as {
      views: Record<string, { arch?: string }>;
    };
    arch = result.views?.[odooType]?.arch ?? '';
  } catch { /* fall through */ }

  if (!arch) { cache.set(key, []); return []; }

  try {
    const nodes = parseArch(arch);
    const seen = new Set<string>();
    const names: string[] = [];
    for (const node of iterNodes(nodes, 'field')) {
      const attrs = node[':@'] as Record<string, string> | undefined;
      const name = attrs?.['name'];
      if (name && !seen.has(name)) { seen.add(name); names.push(name); }
    }
    try {
      const valid = await client.validFieldNames(model);
      const filtered = names.filter(n => valid.has(n));
      cache.set(key, filtered);
      return filtered;
    } catch {
      cache.set(key, names);
      return names;
    }
  } catch {
    cache.set(key, []);
    return [];
  }
}

const QWEB_DYNAMIC = new Set([
  't-foreach', 't-if', 't-else', 't-elif', 't-call', 't-set', 't-out', 't-esc',
]);

function stripQwebWrapper(arch: string): { html: string; hasDynamic: boolean } {
  let nodes: FXPNode[];
  try { nodes = parseArch(arch); } catch { return { html: arch, hasDynamic: false }; }

  let hasDynamic = false;
  for (const node of iterNodes(nodes)) {
    const attrs = node[':@'] as Record<string, string> | undefined;
    if (attrs && Object.keys(attrs).some(k => QWEB_DYNAMIC.has(k))) { hasDynamic = true; break; }
  }

  // If root is <t t-name="...">, return its serialised children
  const root = nodes[0];
  if (root && 't' in root) {
    // Re-serialise: fast-xml-parser can't round-trip easily; return arch minus wrapper tags
    const inner = arch.replace(/^<t[^>]*>/, '').replace(/<\/t>\s*$/, '').trim();
    return { html: inner, hasDynamic };
  }
  return { html: arch, hasDynamic };
}

// ─── Register ────────────────────────────────────────────────────────────────

export function register(server: McpServer, client: OdooClient, cache: Cache): void {

  server.registerTool(
    'list_records',
    {
      description:
        'Return a paginated list of records visible in the list view for a model. ' +
        'Pass action_id to scope results to the action\'s domain (e.g. only draft orders). ' +
        'Pass context to control read behaviour — e.g. {lang: "fr_FR"} returns translated field values, ' +
        '{active_test: false} includes archived records. ' +
        'Returns {total, offset, limit, records[]} with the columns from the list view.',
      inputSchema: {
        model: z.string(),
        action_id: z.number().int().optional(),
        limit: z.number().int().default(40),
        offset: z.number().int().default(0),
        order: z.string().optional(),
        context: z.record(z.unknown()).optional(),
      },
    },
    async ({ model, action_id, limit, offset, order, context }) => {
      try {
        const [domain, actionCtx] = await actionDomainContext(client, cache, action_id);
        const mergedCtx = { ...actionCtx, ...(context ?? {}) };
        let fields = await viewFieldNames(client, cache, model, 'list');
        if (!fields.length) fields = ['display_name'];
        const kwargs: Record<string, unknown> = { fields, limit, offset };
        if (order) kwargs['order'] = order;
        if (Object.keys(mergedCtx).length) kwargs['context'] = mergedCtx;
        const records = await client.execute(model, 'search_read', [domain], kwargs);
        const countKwargs: Record<string, unknown> = {};
        if (Object.keys(mergedCtx).length) countKwargs['context'] = mergedCtx;
        const total = await client.execute(model, 'search_count', [domain], countKwargs);
        return ok({ total, offset, limit, records });
      } catch (e) { return ok({ error: String(e) }); }
    },
  );

  server.registerTool(
    'get_record',
    {
      description:
        'Return form-view field values for a single record. ' +
        'Pass fields to fetch a specific subset instead of all form-view fields. ' +
        'Pass context to control read behaviour — e.g. {lang: "fr_FR"} returns field values ' +
        'in that language for all translate=True fields on the record.',
      inputSchema: {
        model: z.string(),
        record_id: z.number().int(),
        fields: z.array(z.string()).optional(),
        context: z.record(z.unknown()).optional(),
      },
    },
    async ({ model, record_id, fields: reqFields, context }) => {
      try {
        let fields = reqFields?.length ? reqFields : await viewFieldNames(client, cache, model, 'form');
        if (!fields.length) fields = ['display_name'];
        const kwargs: Record<string, unknown> = { fields };
        if (context && Object.keys(context).length) kwargs['context'] = context;
        const rows = await client.execute(model, 'read', [[record_id]], kwargs) as unknown[];
        if (!rows.length) return ok({ error: `Record ${model}:${record_id} not found or not accessible.` });
        return ok(rows[0]);
      } catch (e) { return ok({ error: String(e) }); }
    },
  );

  server.registerTool(
    'search_records',
    {
      description:
        'Search for records by name or domain. ' +
        'query: free-text name search (optional). ' +
        'domain: Odoo domain e.g. [["state","=","draft"]] (optional). ' +
        'action_id: scope search to the action\'s domain. ' +
        'Pass context for search-time behaviour — e.g. {active_test: false} finds archived records, ' +
        '{lang: "fr_FR"} matches and returns display_name in that language. ' +
        'Returns [{id, display_name}] up to limit.',
      inputSchema: {
        model: z.string(),
        query: z.string().optional(),
        domain: z.array(z.unknown()).optional(),
        action_id: z.number().int().optional(),
        limit: z.number().int().default(20),
        context: z.record(z.unknown()).optional(),
      },
    },
    async ({ model, query, domain, action_id, limit, context }) => {
      try {
        const [actionDomain, actionCtx] = await actionDomainContext(client, cache, action_id);
        const mergedCtx = { ...actionCtx, ...(context ?? {}) };
        const combined = [...actionDomain, ...(domain ?? [])];
        const ctxKwarg = Object.keys(mergedCtx).length ? { context: mergedCtx } : {};
        if (query) {
          const results = await client.execute(model, 'name_search', [query], {
            args: combined, limit, ...ctxKwarg,
          }) as Array<[number, string]>;
          return ok(results.map(r => ({ id: r[0], display_name: r[1] })));
        }
        return ok(await client.execute(model, 'search_read', [combined], {
          fields: ['id', 'display_name'], limit, ...ctxKwarg,
        }));
      } catch (e) { return ok([{ error: String(e) }]); }
    },
  );

  server.registerTool(
    'get_fields',
    {
      description:
        'Return metadata for all fields visible in a model\'s form or list view. ' +
        'view_type: "form" (default) or "list". ' +
        'Returns [{name, string, type, required, readonly, relation?, selection?}].',
      inputSchema: { model: z.string(), view_type: z.string().default('form') },
    },
    async ({ model, view_type }) => {
      const cKey = `get_fields:${model}:${view_type}`;
      const cached = cache.get(cKey);
      if (cached !== undefined) return ok(cached);
      try {
        const names = await viewFieldNames(client, cache, model, view_type);
        if (!names.length) return ok([]);
        const meta = await client.execute(model, 'fields_get', [], {
          attributes: ['string', 'type', 'required', 'readonly', 'relation', 'selection'],
        }) as Record<string, Record<string, unknown>>;
        const result = names.flatMap(name => {
          const f = meta[name];
          if (!f) return [];
          const entry: Record<string, unknown> = {
            name, string: f['string'] ?? name, type: f['type'],
            required: f['required'] ?? false, readonly: f['readonly'] ?? false,
          };
          if (f['relation']) entry['relation'] = f['relation'];
          if (f['selection']) entry['selection'] = f['selection'];
          return [entry];
        });
        cache.set(cKey, result);
        return ok(result);
      } catch (e) { return ok([{ error: String(e) }]); }
    },
  );

  server.registerTool(
    'get_defaults',
    {
      description:
        'Return the default field values Odoo would pre-fill when clicking New. ' +
        'Pass action_id to include the action\'s context (e.g. default_partner_id). ' +
        'Pass context dict directly for wizard models.',
      inputSchema: {
        model: z.string(),
        action_id: z.number().int().optional(),
        context: z.record(z.unknown()).optional(),
      },
    },
    async ({ model, action_id, context }) => {
      try {
        const merged = await resolveContext(client, cache, action_id, context);
        let fields = await viewFieldNames(client, cache, model, 'form');
        if (!fields.length) {
          const meta = await client.execute(model, 'fields_get', [], { attributes: ['string'] }) as Record<string, unknown>;
          fields = Object.keys(meta);
        }
        return ok(await client.execute(model, 'default_get', [fields], { context: merged }));
      } catch (e) { return ok({ error: String(e) }); }
    },
  );

  server.registerTool(
    'get_filters',
    {
      description:
        'Return saved filters and favourites available for a model\'s list view. ' +
        'These appear in the Filters and Favourites dropdown in the Odoo UI.',
      inputSchema: { model: z.string(), action_id: z.number().int().optional() },
    },
    async ({ model, action_id }) => {
      try {
        const domain: unknown[] = [['model_id', '=', model]];
        if (action_id) domain.push(['action_id', 'in', [action_id, false]]);
        return ok(await client.execute('ir.filters', 'search_read', [domain], {
          fields: ['id', 'name', 'domain', 'context', 'sort', 'is_default', 'action_id'],
        }));
      } catch (e) { return ok([{ error: String(e) }]); }
    },
  );

  server.registerTool(
    'list_snippets',
    {
      description:
        'List available website building-block snippets. ' +
        'Optional "search" filters by any substring of the key or name (case-insensitive). ' +
        'Returns {available_modules: [], snippets: [{key, name, module}]}. ' +
        'Use get_snippet(key) to fetch the ready-to-inject HTML.',
      inputSchema: { search: z.string().optional() },
    },
    async ({ search }) => {
      try {
        const rows = await client.execute('ir.ui.view', 'search_read',
          [[['type', '=', 'qweb'], ['key', 'like', '.s_']]],
          { fields: ['key', 'name'], order: 'key asc' },
        ) as Array<{ key: string; name: string }>;

        const needle = search?.toLowerCase();
        const modules = new Set<string>();
        const snippets: Array<{ key: string; name: string; module: string }> = [];

        for (const r of rows) {
          const key = r.key ?? '';
          const name = r.name ?? '';
          if (!key.includes('.s_')) continue;
          if (key.includes('_options') || key.includes('_default_image')) continue;
          const mod = key.includes('.') ? key.split('.')[0] : '';
          modules.add(mod);
          if (needle && !key.toLowerCase().includes(needle) && !name.toLowerCase().includes(needle)) continue;
          snippets.push({ key, name, module: mod });
        }
        return ok({ available_modules: [...modules].sort(), snippets });
      } catch (e) { return ok({ error: String(e) }); }
    },
  );

  server.registerTool(
    'get_snippet',
    {
      description:
        'Fetch the ready-to-inject HTML for a website building-block snippet. ' +
        'Pass the snippet key (e.g. "website.s_text_image"). ' +
        'Returns {key, name, html} or {error}.',
      inputSchema: { key: z.string() },
    },
    async ({ key }) => {
      try {
        const rows = await client.execute('ir.ui.view', 'search_read',
          [[['key', '=', key], ['type', '=', 'qweb']]],
          { fields: ['key', 'name', 'arch'] },
        ) as Array<{ key: string; name: string; arch: string }>;
        if (!rows.length) return ok({ error: `Snippet '${key}' not found.` });
        const row = rows[0];
        const { html, hasDynamic } = stripQwebWrapper(row.arch ?? '');
        const result: Record<string, unknown> = { key: row.key, name: row.name ?? '', html };
        if (hasDynamic) {
          result['warning'] = 'This snippet contains QWeb directives (t-if / t-foreach). ' +
            'The HTML may not render correctly as static injected content.';
        }
        return ok(result);
      } catch (e) { return ok({ error: String(e) }); }
    },
  );

  server.registerTool(
    'list_attachments',
    {
      description:
        'Search ir.attachment records for any model. Returns metadata only — never binary data. ' +
        'Use to find existing files before uploading duplicates. ' +
        'src is ready to use as an image/file URL.',
      inputSchema: {
        res_model: z.string().optional(),
        res_id: z.number().int().optional(),
        name: z.string().optional(),
        limit: z.number().int().default(40),
      },
    },
    async ({ res_model, res_id, name, limit }) => {
      try {
        const domain: unknown[] = [['type', '!=', 'url']];
        if (res_model) domain.push(['res_model', '=', res_model]);
        if (res_id !== undefined) domain.push(['res_id', '=', res_id]);
        if (name) domain.push(['name', 'ilike', name]);
        type AttachRow = { id: number; name: string; mimetype: string; res_model: string; res_id: number; public: boolean; url: string | false };
        const rows = await client.execute('ir.attachment', 'search_read',
          [domain],
          { fields: ['id', 'name', 'mimetype', 'res_model', 'res_id', 'public', 'url'], limit },
        ) as AttachRow[];
        return ok(rows.map(r => ({
          ...r,
          src: r.url || (r.mimetype?.startsWith('image/') ? `/web/image/${r.id}` : `/web/content/${r.id}`),
        })));
      } catch (e) { return ok({ error: String(e) }); }
    },
  );

  server.registerTool(
    'fetch_and_upload',
    {
      description:
        GUIDANCE_HINT +
        'Load a file from a URL or local absolute path and store it as an Odoo ir.attachment. ' +
        'The MCP server handles the transfer — no binary passes through the AI context. ' +
        'Returns {id, src} usable in any context (arch_db, chatter, record field).',
      inputSchema: {
        source: z.string(),
        name: z.string().optional(),
        is_image: z.boolean().default(true),
        public: z.boolean().default(true),
        res_model: z.string().default('ir.ui.view'),
        res_id: z.number().int().optional(),
      },
    },
    async ({ source, name, is_image, public: isPublic, res_model, res_id }) => {
      try {
        let buffer: Buffer;
        const isUrl = /^https?:\/\//i.test(source);
        if (isUrl) {
          const resp = await fetch(source);
          if (!resp.ok) return ok({ error: `Fetch failed: HTTP ${resp.status} ${resp.statusText}` });
          buffer = Buffer.from(await resp.arrayBuffer());
        } else {
          buffer = await readFile(source);
        }
        const data = buffer.toString('base64');
        const filename = name ?? source.split('/').pop()?.split('?')[0] ?? 'upload';
        const params: Record<string, unknown> = { name: filename, data, res_model, is_image };
        if (res_id !== undefined) params['res_id'] = res_id;
        const result = await client.httpCall('/web_editor/attachment/add_data', params) as Record<string, unknown>;
        const attachId = result?.['id'] as number | undefined;
        if (!attachId) return ok({ error: 'Upload failed: no attachment id returned', raw: result });
        if (isPublic) {
          await client.execute('ir.attachment', 'write', [[attachId], { public: true }]);
        }
        const src = is_image ? `/web/image/${attachId}` : `/web/content/${attachId}`;
        return ok({ id: attachId, src, name: result?.['name'] ?? filename });
      } catch (e) { return ok({ error: String(e) }); }
    },
  );

  // ─── Translation tools ───────────────────────────────────────────────────────

  server.registerTool(
    'translation_get',
    {
      description:
        'Read all language translations for a translatable field on a record. ' +
        'Works on any field with translate=True (char fields: returns one entry per language) ' +
        'or callable translate (html / arch_db: returns one entry per translatable term per language). ' +
        'langs: optional list of language codes to filter (e.g. ["fr_FR", "ar_001"]); ' +
        'omit to return all installed languages. ' +
        'Returns {translations: [{lang, source, value}], translation_type, translation_show_source} or {error}.',
      inputSchema: {
        model: z.string(),
        record_id: z.number().int(),
        field_name: z.string(),
        langs: z.array(z.string()).optional(),
      },
    },
    async ({ model, record_id, field_name, langs }) => {
      try {
        const kwargs: Record<string, unknown> = {};
        if (langs?.length) kwargs['langs'] = langs;
        const result = await client.execute(
          model, 'get_field_translations', [[record_id], field_name], kwargs,
        ) as [Array<{ lang: string; source: string; value: string }>, Record<string, unknown>];
        const [translations, meta] = result;
        return ok({ translations, ...meta });
      } catch (e) { return ok({ error: String(e) }); }
    },
  );

  server.registerTool(
    'translation_update',
    {
      description:
        GUIDANCE_HINT +
        'Write translations for a translatable field on a record. ' +
        'For char fields (translate=True): translations = {"fr_FR": "Bonjour", "ar_001": "مرحبا"}. ' +
        'For html / arch_db fields (callable translate): translations = {"fr_FR": {"English source term": "French translation"}}. ' +
        'The target language must be installed in Odoo (Settings → Languages). ' +
        'Returns {success: true} or {error}.',
      inputSchema: {
        model: z.string(),
        record_id: z.number().int(),
        field_name: z.string(),
        translations: z.record(z.unknown()),
      },
    },
    async ({ model, record_id, field_name, translations }) => {
      try {
        await client.execute(
          model, 'update_field_translations', [[record_id], field_name, translations],
        );
        return ok({ success: true });
      } catch (e) { return ok({ error: String(e) }); }
    },
  );
}
