/** Layer 1 — Discovery tools: get_models, get_model_actions. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { OdooClient } from '../odooClient.js';
import { views } from '../odoo/views.js';
import { hasAccess } from '../odoo/access.js';
import { Button, formButtons } from '../odoo/buttons.js';
import { Cache } from '../cache.js';
import { ok } from '../utils.js';

const RELATIONAL_TYPES = new Set(['many2one', 'many2many', 'one2many']);

// ─── Internals ────────────────────────────────────────────────────────────────

async function primaryModels(client: OdooClient, cache: Cache): Promise<unknown[]> {
  const cached = cache.get('primary_models');
  if (cached) return cached as unknown[];

  const menus = await client.execute('ir.ui.menu', 'search_read',
    [[['action', 'like', 'ir.actions.act_window,']]],
    { fields: ['name', 'complete_name', 'action'] },
  ) as Array<{ name: string; complete_name: string; action: string }>;

  const actIds: number[] = [];
  const menuByAct = new Map<number, typeof menus[0]>();
  for (const m of menus) {
    const ref = m.action ?? '';
    if (!ref.includes(',')) continue;
    const id = parseInt(ref.split(',')[1], 10);
    actIds.push(id);
    if (!menuByAct.has(id)) menuByAct.set(id, m);
  }
  if (!actIds.length) return [];

  const actions = await client.execute('ir.actions.act_window', 'search_read',
    [[['id', 'in', actIds], ['res_model', '!=', false]]],
    { fields: ['id', 'name', 'res_model', 'view_mode'] },
  ) as Array<{ id: number; name: string; res_model: string; view_mode: string }>;

  const seen = new Set<string>();
  const result: unknown[] = [];
  for (const act of actions) {
    if (seen.has(act.res_model)) continue;
    seen.add(act.res_model);
    const menu = menuByAct.get(act.id);
    result.push({
      model: act.res_model,
      name: menu?.name ?? act.name,
      menu_path: menu?.complete_name ?? menu?.name ?? act.name,
      action_id: act.id,
      view_modes: act.view_mode,
    });
  }
  (result as Array<{ model: string }>).sort((a, b) => a.model.localeCompare(b.model));
  cache.set('primary_models', result);
  return result;
}

async function relatedModels(client: OdooClient, cache: Cache, base: string): Promise<unknown[]> {
  const key = `related_models:${base}`;
  const cached = cache.get(key);
  if (cached) return cached as unknown[];

  const { fields: meta } = await views(client, base, 'form');
  const result: unknown[] = [];
  for (const [fname, fmeta] of Object.entries(meta)) {
    if (!RELATIONAL_TYPES.has(String(fmeta['type']))) continue;
    const relation = fmeta['relation'];
    if (!relation) continue;
    result.push({
      model: relation,
      field: fname,
      field_type: fmeta['type'],
      label: fmeta['string'] ?? fname,
    });
  }
  (result as Array<{ field: string }>).sort((a, b) => a.field.localeCompare(b.field));
  cache.set(key, result);
  return result;
}

export interface ModelActions {
  can_create: boolean;
  can_write: boolean;
  can_delete: boolean;
  server_actions: Array<{ id: number; name: string; view_types: string }>;
  reports: Array<{ id: number; name: string; view_types: string; report_type: string }>;
  view_buttons: Button[];
}

export async function collectModelActions(client: OdooClient, model: string): Promise<ModelActions> {
  const modelId = await client.getModelId(model);
  if (!modelId) throw new Error(`Model '${model}' not found in ir.model`);

  const access = {
    can_create: await hasAccess(client, model, 'create'),
    can_write: await hasAccess(client, model, 'write'),
    can_delete: await hasAccess(client, model, 'unlink'),
  };

  const serverActions = await client.execute('ir.actions.server', 'search_read',
    [[['binding_model_id', '=', modelId], ['binding_type', '=', 'action']]],
    { fields: ['id', 'name', 'binding_view_types', 'state'] },
  ) as Array<{ id: number; name: string; binding_view_types: string }>;

  const reports = await client.execute('ir.actions.report', 'search_read',
    [[['binding_model_id', '=', modelId]]],
    { fields: ['id', 'name', 'binding_view_types', 'report_type'] },
  ) as Array<{ id: number; name: string; binding_view_types: string; report_type: string }>;

  return {
    ...access,
    server_actions: serverActions.map(a => ({ id: a.id, name: a.name, view_types: a.binding_view_types })),
    reports: reports.map(r => ({ id: r.id, name: r.name, view_types: r.binding_view_types, report_type: r.report_type })),
    view_buttons: await formButtons(client, model),
  };
}

// ─── Register ────────────────────────────────────────────────────────────────

export function register(server: McpServer, client: OdooClient, cache: Cache): void {

  server.registerTool(
    'get_models',
    {
      description:
        'List primary models the user can navigate to via menus (get_models()), ' +
        'or list relational models reachable from a base model via its form-view fields ' +
        '(get_models({ base: "sale.order" })).',
      inputSchema: { base: z.string().optional() },
    },
    async ({ base }) => {
      try {
        return ok(base ? await relatedModels(client, cache, base) : await primaryModels(client, cache));
      } catch (e) { return ok({ error: String(e) }); }
    },
  );

  server.registerTool(
    'get_model_actions',
    {
      description:
        'Return all actions available on a model: server actions (Action menu), ' +
        'report actions (Print menu), and form-view buttons (type=object/action) with their ' +
        'invisible condition (Python expression, or a domain on Odoo 15/16). ' +
        'Also returns CRUD access flags for the current user.',
      inputSchema: {
        model: z.string(),
        action_id: z.number().int().optional(),
      },
    },
    async ({ model, action_id }) => {
      const key = `model_actions:${model}:${action_id ?? ''}`;
      const cached = cache.get(key);
      if (cached) return ok(cached);
      try {
        const result = await collectModelActions(client, model);
        cache.set(key, result);
        return ok(result);
      } catch (e) { return ok({ error: String(e) }); }
    },
  );

  server.registerTool(
    'get_model_interface',
    {
      description:
        'Single-call planning helper: returns form-view field metadata AND all model actions ' +
        '(server actions, reports, view buttons) AND CRUD access flags. ' +
        'Use this before creating or editing records to understand the full model interface ' +
        'without separate get_fields + get_model_actions round trips.',
      inputSchema: { model: z.string() },
    },
    async ({ model }) => {
      const key = `model_interface:${model}`;
      const cached = cache.get(key);
      if (cached) return ok(cached);
      try {
        const [fields, actions] = await Promise.all([
          views(client, model, 'form').then(v => v.fields),
          collectModelActions(client, model),
        ]);
        const result = { fields, ...actions };
        cache.set(key, result);
        return ok(result);
      } catch (e) { return ok({ error: String(e) }); }
    },
  );
}
