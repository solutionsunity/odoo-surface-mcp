import { OdooClient } from '../odooClient.js';
import { since } from './since.js';

type Fields = Record<string, Record<string, unknown>>;

/** A model's default view of one type: compiled arch and metadata of the model's fields in it. */
export interface View {
  arch: string;
  fields: Fields;
}

interface GetViews {
  views: Record<string, { arch: string }>;
  models: Record<string, unknown>;
}

// View type 'list' on every series: 15.0–17.0 map it to 'tree' and key the result by the
// requested type (15.0/odoo/models.py:1641, 16.0/odoo/addons/base/models/ir_ui_view.py:2522).
const getViews = (c: OdooClient, model: string, type: string) =>
  c.execute(model, 'get_views', [[[false, type]]]) as Promise<GetViews>;

export const views = since<[string, string], View>('views', {
  // load_views → fields_views[type] = { arch, fields } (15.0/odoo/models.py:1626).
  // x2many metadata nests its sub-views under 'views'; dropped.
  '15.0': async (c, model, type) => {
    const r = await c.execute(model, 'load_views', [[[false, type]]]) as {
      fields_views: Record<string, { arch: string; fields: Fields }>;
    };
    const { arch, fields } = r.fields_views[type];
    return {
      arch,
      fields: Object.fromEntries(Object.entries(fields).map(([n, { views: _, ...meta }]) => [n, meta])),
    };
  },
  // get_views → models[model] is the field map (16.0/odoo/addons/base/models/ir_ui_view.py:2536).
  '16.0': async (c, model, type) => {
    const r = await getViews(c, model, type);
    return { arch: r.views[type].arch, fields: (r.models[model] ?? {}) as Fields };
  },
  // models[model] is { fields } (18.0/odoo/addons/base/models/ir_ui_view.py:2631).
  '18.0': async (c, model, type) => {
    const r = await getViews(c, model, type);
    return { arch: r.views[type].arch, fields: (r.models[model] as { fields?: Fields } | undefined)?.fields ?? {} };
  },
});
