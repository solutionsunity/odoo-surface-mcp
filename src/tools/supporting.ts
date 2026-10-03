/**
 * Layer 3 — Supporting tools: list_records, get_record (+ fields/context), search_records,
 * get_fields, get_defaults, get_filters, list_snippets, get_snippet,
 * list_attachments, fetch_and_upload, translation_get, translation_update, translation_audit.
 * Also exports shared helpers used by other layers.
 */
import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { OdooClient } from '../odooClient.js';
import { views } from '../odoo/views.js';
import { readBinary, writeAttachmentContent } from '../odoo/binary.js';
import { evalAction } from '../odoo/expr.js';
import { TermRow, fieldTranslations, updateFieldTranslations } from '../odoo/translations.js';
import { Cache } from '../cache.js';
import { xmlParser, FXPNode, iterNodes, ok, outputPath, GUIDANCE_HINT } from '../utils.js';

// ─── XML helpers ────────────────────────────────────────────────────────────

function parseArch(arch: string): FXPNode[] {
  return xmlParser.parse(arch) as FXPNode[];
}

// ─── Shared helpers ──────────────────────────────────────────────────────────

/**
 * A window action's domain and context as the web client evaluates them on opening it, with the
 * caller's context as additional context. The caller's context still takes precedence for reads.
 */
export async function actionDomainContext(
  client: OdooClient, cache: Cache, actionId: number | undefined | null, ctx: Record<string, unknown> = {},
): Promise<[unknown[], Record<string, unknown>]> {
  if (!actionId) return [[], {}];
  const key = `action_info:${actionId}`;
  let action = cache.get(key) as { domain: unknown; context: unknown } | undefined;
  if (!action) {
    const rows = await client.execute('ir.actions.act_window', 'read', [[actionId]], {
      fields: ['domain', 'context'],
    }) as Array<{ domain: unknown; context: unknown }>;
    if (!rows.length) throw new Error(`Window action ${actionId} not found.`);
    action = rows[0];
    cache.set(key, action);
  }
  const { domain, context } = await evalAction(client, action, ctx);
  return [domain, context];
}

export async function resolveContext(
  client: OdooClient, cache: Cache,
  actionId: number | undefined | null,
  ctx: Record<string, unknown> | undefined | null,
): Promise<Record<string, unknown>> {
  const [, actionCtx] = await actionDomainContext(client, cache, actionId, ctx ?? {});
  return { ...actionCtx, ...(ctx ?? {}) };
}

export async function viewFieldNames(
  client: OdooClient, cache: Cache, model: string, viewType: string,
): Promise<string[]> {
  const key = `view_fields:${model}:${viewType}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached as string[];

  // Arch order, restricted to the model's own fields (sub-view fields belong to other models).
  const { arch, fields } = await views(client, model, viewType);
  const names = new Set<string>();
  for (const node of iterNodes(parseArch(arch), 'field')) {
    const name = (node[':@'] as Record<string, string> | undefined)?.['name'];
    if (name && name in fields) names.add(name);
  }
  const result = [...names];
  cache.set(key, result);
  return result;
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

// ─── Translation helpers ──────────────────────────────────────────────────────

// Arabic / Arabic-supplement / presentation-form ranges. Used to detect a source
// term that is actually a translation (the "translation stored as source" defect).
const ARABIC_RE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
const LATIN_RE = /[A-Za-z]/;

function toArray<T>(v: T | T[]): T[] { return Array.isArray(v) ? v : [v]; }

/** Group flat translation rows by source term, preserving first-seen order. */
function groupTerms(rows: TermRow[]): { order: string[]; byTerm: Map<string, Map<string, string>> } {
  const byTerm = new Map<string, Map<string, string>>();
  const order: string[] = [];
  for (const r of rows) {
    if (!byTerm.has(r.source)) { byTerm.set(r.source, new Map()); order.push(r.source); }
    byTerm.get(r.source)!.set(r.lang, r.value ?? '');
  }
  return { order, byTerm };
}

// ─── Register ────────────────────────────────────────────────────────────────

export function register(server: McpServer, client: OdooClient, cache: Cache): void {

  server.registerTool(
    'list_records',
    {
      description:
        'Return a paginated list of records — as the list view or the Export dialog would show them. ' +
        'domain: Odoo domain, e.g. [["state","=","draft"]]; ANDed with the action\'s domain when action_id is given. ' +
        'fields: field names to return (any readable field; relational ones as [id, display_name]); ' +
        'default: the list view\'s columns. ' +
        'Pass context to control read behaviour — e.g. {lang: "fr_FR"} returns translated field values, ' +
        '{active_test: false} includes archived records. ' +
        'order: e.g. "date desc, id"; ordering by a many2one follows the related model\'s own order ' +
        '(e.g. order_id on sale.order = date_order desc, id desc), which can look like order being ignored. ' +
        'Returns {total, offset, limit, records[]}.',
      inputSchema: {
        model: z.string(),
        domain: z.array(z.unknown()).optional(),
        fields: z.array(z.string()).optional(),
        action_id: z.number().int().optional(),
        limit: z.number().int().default(40),
        offset: z.number().int().default(0),
        order: z.string().optional(),
        context: z.record(z.unknown()).optional(),
        output_path: outputPath,
      },
    },
    async ({ model, domain: userDomain, fields: reqFields, action_id, limit, offset, order, context, output_path }) => {
      try {
        const [actionDomain, actionCtx] = await actionDomainContext(client, cache, action_id, context ?? {});
        // Top-level terms of a domain are implicitly ANDed, so concatenation ANDs the two.
        const domain = [...actionDomain, ...(userDomain ?? [])];
        const mergedCtx = { ...actionCtx, ...(context ?? {}) };
        let fields = reqFields?.length ? reqFields : await viewFieldNames(client, cache, model, 'list');
        if (!fields.length) fields = ['display_name'];
        const kwargs: Record<string, unknown> = { fields, limit, offset };
        if (order) kwargs['order'] = order;
        if (Object.keys(mergedCtx).length) kwargs['context'] = mergedCtx;
        const records = await client.execute(model, 'search_read', [domain], kwargs);
        const countKwargs: Record<string, unknown> = {};
        if (Object.keys(mergedCtx).length) countKwargs['context'] = mergedCtx;
        const total = await client.execute(model, 'search_count', [domain], countKwargs);
        return ok({ total, offset, limit, records }, output_path);
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
        'Find records by name — "which record is called X" — with the model\'s own name matching ' +
        '(display name, plus per-model keys such as reference, email or code). ' +
        'domain / action_id narrow the search. For filtering by field values use list_records. ' +
        'Pass context for search-time behaviour — e.g. {active_test: false} finds archived records, ' +
        '{lang: "fr_FR"} matches and returns display_name in that language. ' +
        'Returns [{id, display_name}] up to limit.',
      inputSchema: {
        model: z.string(),
        query: z.string(),
        domain: z.array(z.unknown()).optional(),
        action_id: z.number().int().optional(),
        limit: z.number().int().default(20),
        context: z.record(z.unknown()).optional(),
        output_path: outputPath,
      },
    },
    async ({ model, query, domain, action_id, limit, context, output_path }) => {
      try {
        const [actionDomain, actionCtx] = await actionDomainContext(client, cache, action_id, context ?? {});
        const mergedCtx = { ...actionCtx, ...(context ?? {}) };
        const combined = [...actionDomain, ...(domain ?? [])];
        const ctxKwarg = Object.keys(mergedCtx).length ? { context: mergedCtx } : {};
        // Positional: the domain parameter is `args` up to 18.0, `domain` from 19.0.
        const results = await client.execute(model, 'name_search', [query, combined, 'ilike', limit], ctxKwarg) as Array<[number, string]>;
        return ok(results.map(r => ({ id: r[0], display_name: r[1] })), output_path);
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

  // Extension → MIME map used by fetch_and_upload to set mimetype on in-place replace.
  // Odoo's _compute_mimetype falls back to python-magic for plain-text files (CSS/JS/JSON),
  // which returns text/plain. Providing the MIME explicitly avoids that.
  const EXT_MIME: Record<string, string> = {
    css: 'text/css', js: 'application/javascript', mjs: 'application/javascript',
    json: 'application/json', html: 'text/html', htm: 'text/html',
    svg: 'image/svg+xml', ttf: 'font/ttf', woff: 'font/woff', woff2: 'font/woff2',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  };

  server.registerTool(
    'fetch_and_upload',
    {
      description:
        GUIDANCE_HINT +
        'Load a file from a URL or local absolute path and store it as an Odoo ir.attachment. ' +
        'The MCP server handles the transfer — no binary passes through the AI context. ' +
        'Pass attachment_id to replace an existing attachment in-place (same ID, no arch update needed). ' +
        'Omit attachment_id to create a new attachment. ' +
        'Returns {id, src} usable in any context (arch_db, chatter, record field).',
      inputSchema: {
        source: z.string(),
        name: z.string().optional(),
        is_image: z.boolean().default(true),
        public: z.boolean().default(true),
        res_model: z.string().default('ir.ui.view'),
        res_id: z.number().int().optional(),
        attachment_id: z.number().int().optional(),
      },
    },
    async ({ source, name, is_image, public: isPublic, res_model, res_id, attachment_id }) => {
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

        if (attachment_id !== undefined) {
          // ── Replace existing attachment in-place ──────────────────────────
          // Always include `name` so Odoo's _compute_mimetype can derive the
          // correct MIME from the extension (rather than falling back to
          // python-magic binary detection which returns text/plain for CSS/JS).
          const ext = filename.split('.').pop()?.toLowerCase() ?? '';
          const detectedMime = EXT_MIME[ext];
          const writeVals: Record<string, unknown> = { name: filename };
          if (detectedMime) writeVals['mimetype'] = detectedMime;
          if (isPublic) writeVals['public'] = true;
          await writeAttachmentContent(client, attachment_id, data, writeVals);
          const src = is_image ? `/web/image/${attachment_id}` : `/web/content/${attachment_id}`;
          return ok({ id: attachment_id, src, name: filename });
        }

        // ── Create new attachment ─────────────────────────────────────────
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

  // ─── Binary field transfer tools ────────────────────────────────────────────

  server.registerTool(
    'download_binary',
    {
      description:
        'Download a binary field value from an Odoo record to a local absolute path on the MCP server filesystem. ' +
        'The binary is decoded and written to disk — no base64 passes through the AI context. ' +
        'Use this as the source step in a cross-instance binary migration: ' +
        'call download_binary on source MCP, then upload_binary on target MCP using the same path. ' +
        'Returns {success, dest_path, size_bytes} or {error}.',
      inputSchema: {
        model: z.string(),
        record_id: z.number().int(),
        field: z.string(),
        dest_path: z.string(),
      },
    },
    async ({ model, record_id, field, dest_path }) => {
      try {
        const content = await readBinary(client, model, record_id, field);
        if (!content) return ok({ error: `Field '${field}' on ${model}:${record_id} is empty or not a binary.` });
        const buffer = Buffer.from(content, 'base64');
        await mkdir(dirname(dest_path), { recursive: true });
        await writeFile(dest_path, buffer);
        return ok({ success: true, dest_path, size_bytes: buffer.length });
      } catch (e) { return ok({ error: String(e) }); }
    },
  );

  server.registerTool(
    'upload_binary',
    {
      description:
        GUIDANCE_HINT +
        'Upload a local file into an Odoo record\'s binary field. ' +
        'Reads the file at source_path (absolute path on the MCP server filesystem), ' +
        'encodes it, and writes it to the specified field via the ORM — no base64 in AI context. ' +
        'Use this as the target step in a cross-instance binary migration: ' +
        'call download_binary on source MCP first, then upload_binary on target MCP using the same path. ' +
        'Returns {success, model, record_id, field, size_bytes} or {error}.',
      inputSchema: {
        model: z.string(),
        record_id: z.number().int(),
        field: z.string(),
        source_path: z.string(),
      },
    },
    async ({ model, record_id, field, source_path }) => {
      try {
        const buffer = await readFile(source_path);
        const data = buffer.toString('base64');
        await client.execute(model, 'write', [[record_id], { [field]: data }]);
        return ok({ success: true, model, record_id, field, size_bytes: buffer.length });
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
        'record_id and field_name each accept a single value OR an array (batch read in one call). ' +
        'langs: optional list of language codes to filter (e.g. ["fr_FR", "ar_001"]); ' +
        'omit to return all installed languages. ' +
        'Single record_id AND single field_name → {translations: [{lang, source, value}], translation_type, translation_show_source}. ' +
        'Any array argument → {results: [{record_id, field_name, translations, translation_type, translation_show_source} | {record_id, field_name, error}]}. ' +
        'Returns the above or {error}.',
      inputSchema: {
        model: z.string(),
        record_id: z.union([z.number().int(), z.array(z.number().int())]),
        field_name: z.union([z.string(), z.array(z.string())]),
        langs: z.array(z.string()).optional(),
      },
    },
    async ({ model, record_id, field_name, langs }) => {
      try {
        const ids = toArray(record_id);
        const fields = toArray(field_name);
        const single = !Array.isArray(record_id) && !Array.isArray(field_name);
        const results: Array<Record<string, unknown>> = [];
        for (const id of ids) {
          for (const f of fields) {
            try {
              const { rows, meta } = await fieldTranslations(client, model, id, f, langs);
              results.push({ record_id: id, field_name: f, translations: rows, ...meta });
            } catch (e) {
              results.push({ record_id: id, field_name: f, error: String(e) });
            }
          }
        }
        if (single) {
          const r = results[0];
          if (r['error']) return ok({ error: r['error'] });
          const { record_id: _i, field_name: _f, translations, ...meta } = r;
          return ok({ translations, ...meta });
        }
        return ok({ results });
      } catch (e) { return ok({ error: String(e) }); }
    },
  );

  server.registerTool(
    'translation_update',
    {
      description:
        GUIDANCE_HINT +
        'Write translations for translatable field(s). Two forms: ' +
        '(1) Single/same-map — pass record_id (a number or an array of ids), field_name and translations; ' +
        'the same translations map is applied to every id. ' +
        '(2) Batch — pass updates: [{record_id, field_name, translations}, ...] to write different content ' +
        'per record and per field in one call (e.g. name + html_content for many records). ' +
        'For char fields (translate=True): translations = {"fr_FR": "Bonjour", "ar_001": "مرحبا"}. ' +
        'For html / arch_db fields (callable translate): translations = {"fr_FR": {"English source term": "French translation"}}. ' +
        'The target language must be installed in Odoo (Settings → Languages). ' +
        'Single id (number) form returns {success: true}; id-array and batch forms return ' +
        '{results: [{record_id, field_name, success: true} | {record_id, field_name, error}]}. Returns the above or {error}.',
      inputSchema: {
        model: z.string(),
        record_id: z.union([z.number().int(), z.array(z.number().int())]).optional(),
        field_name: z.string().optional(),
        translations: z.record(z.unknown()).optional(),
        updates: z.array(z.object({
          record_id: z.number().int(),
          field_name: z.string(),
          translations: z.record(z.unknown()),
        })).optional(),
      },
    },
    async ({ model, record_id, field_name, translations, updates }) => {
      try {
        // Form (2): explicit batch of heterogeneous updates.
        if (updates?.length) {
          const results: Array<Record<string, unknown>> = [];
          for (const u of updates) {
            try {
              await updateFieldTranslations(client, model, u.record_id, u.field_name, u.translations);
              results.push({ record_id: u.record_id, field_name: u.field_name, success: true });
            } catch (e) {
              results.push({ record_id: u.record_id, field_name: u.field_name, error: String(e) });
            }
          }
          return ok({ results });
        }
        // Form (1): single record_id, field_name and translations (same map applied to all ids).
        if (record_id === undefined || !field_name || !translations) {
          return ok({ error: 'Provide either updates[] or (record_id, field_name, translations).' });
        }
        if (!Array.isArray(record_id)) {
          await updateFieldTranslations(client, model, record_id, field_name, translations);
          return ok({ success: true });
        }
        const results: Array<Record<string, unknown>> = [];
        for (const id of record_id) {
          try {
            await updateFieldTranslations(client, model, id, field_name, translations);
            results.push({ record_id: id, field_name, success: true });
          } catch (e) {
            results.push({ record_id: id, field_name, error: String(e) });
          }
        }
        return ok({ results });
      } catch (e) { return ok({ error: String(e) }); }
    },
  );

  server.registerTool(
    'translation_audit',
    {
      description:
        'Audit translation coverage and integrity for translatable field(s) across one or more records. ' +
        'For each record×field it reports total source terms and, per target language, how many are ' +
        'translated and which source terms are still missing. It also returns two integrity flags: ' +
        'suspect_source (when base_lang is English, source terms written in Arabic script — the signature ' +
        'of the "translation stored as source" defect that destroys the English body) and nonempty_base ' +
        '(terms whose base-language value is non-empty). Use it to verify a bilingual push in one call and ' +
        'to catch source corruption early. record_id and field_name each accept a single value or an array. ' +
        'base_lang defaults to "en_US"; target_langs defaults to every non-base language present. ' +
        'Long term lists are capped at max_list (default 50) with a *_truncated flag. ' +
        'Returns {passed, summary, results: [...]} or {error}.',
      inputSchema: {
        model: z.string(),
        record_id: z.union([z.number().int(), z.array(z.number().int())]),
        field_name: z.union([z.string(), z.array(z.string())]),
        base_lang: z.string().optional(),
        target_langs: z.array(z.string()).optional(),
        max_list: z.number().int().optional(),
      },
    },
    async ({ model, record_id, field_name, base_lang, target_langs, max_list }) => {
      try {
        const ids = toArray(record_id);
        const fields = toArray(field_name);
        const base = base_lang ?? 'en_US';
        const cap = max_list ?? 50;
        const baseIsEnglish = base.toLowerCase().startsWith('en');
        const langsFilter = target_langs?.length ? [base, ...target_langs] : undefined;
        const results: Array<Record<string, unknown>> = [];
        let totalMissing = 0, totalSuspect = 0, totalNonemptyBase = 0;
        for (const id of ids) {
          for (const f of fields) {
            try {
              const { rows, meta } = await fieldTranslations(client, model, id, f, langsFilter);
              const { order, byTerm } = groupTerms(rows);
              const presentLangs = new Set(rows.map(r => r.lang));
              const targets = target_langs?.length
                ? target_langs
                : [...presentLangs].filter(l => l !== base);

              const langReport: Record<string, unknown> = {};
              for (const tl of targets) {
                const missing: string[] = [];
                let translated = 0;
                for (const src of order) {
                  const v = byTerm.get(src)?.get(tl) ?? '';
                  if (v.trim()) translated++; else missing.push(src);
                }
                totalMissing += missing.length;
                langReport[tl] = {
                  translated,
                  missing_count: missing.length,
                  missing: missing.slice(0, cap),
                  ...(missing.length > cap ? { missing_truncated: true } : {}),
                };
              }

              const suspect: string[] = [];
              const nonemptyBase: string[] = [];
              for (const src of order) {
                if (baseIsEnglish && ARABIC_RE.test(src) && !LATIN_RE.test(src)) suspect.push(src);
                if ((byTerm.get(src)?.get(base) ?? '').trim()) nonemptyBase.push(src);
              }
              totalSuspect += suspect.length;
              totalNonemptyBase += nonemptyBase.length;

              results.push({
                record_id: id,
                field_name: f,
                translation_type: meta['translation_type'],
                translation_show_source: meta['translation_show_source'],
                total_terms: order.length,
                base_lang: base,
                langs: langReport,
                suspect_source: suspect.slice(0, cap),
                ...(suspect.length > cap ? { suspect_source_truncated: true } : {}),
                nonempty_base: nonemptyBase.slice(0, cap),
                ...(nonemptyBase.length > cap ? { nonempty_base_truncated: true } : {}),
              });
            } catch (e) {
              results.push({ record_id: id, field_name: f, error: String(e) });
            }
          }
        }
        const passed = totalMissing === 0 && totalSuspect === 0
          && results.every(r => !r['error']);
        return ok({
          passed,
          summary: {
            records: ids.length,
            fields: fields.length,
            checks: results.length,
            total_missing: totalMissing,
            total_suspect_source: totalSuspect,
            total_nonempty_base: totalNonemptyBase,
          },
          results,
        });
      } catch (e) { return ok({ error: String(e) }); }
    },
  );
}
