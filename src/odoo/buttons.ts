import { OdooClient } from '../odooClient.js';
import { xmlParser, FXPNode, viewNodes } from '../utils.js';
import { since } from './since.js';
import { views } from './views.js';
import { Condition, recordEvalContext } from './expr.js';

const BUTTON_TYPES = new Set(['object', 'action']);

/** A form-view button the user can click: a method (object) or an action id (action). */
export interface Button {
  name: string;
  label: string;
  type: string;
  invisible: Condition;
}

function buttons(arch: string, invisible: (attrs: Record<string, string>) => Condition): Button[] {
  const out: Button[] = [];
  for (const node of viewNodes(xmlParser.parse(arch) as FXPNode[], 'button')) {
    const attrs = node[':@'] as Record<string, string> | undefined;
    if (!attrs || !BUTTON_TYPES.has(attrs['type'])) continue;
    out.push({ name: attrs['name'], label: attrs['string'] ?? attrs['name'], type: attrs['type'], invisible: invisible(attrs) });
  }
  return out;
}

/** The form view's object/action buttons with their invisible condition. */
export const formButtons = since<[string], Button[]>('formButtons', {
  // invisible, attrs and states fold into a JSON `modifiers` attribute holding a domain
  // (15.0/odoo/addons/base/models/ir_ui_view.py:82, 16.0/odoo/addons/base/models/ir_ui_view.py:82).
  '15.0': async (c, model) => buttons((await views(c, model, 'form')).arch,
    attrs => JSON.parse(attrs['modifiers'] || '{}').invisible ?? false),
  // invisible stays on the node as a Python expression.
  '17.0': async (c, model) => buttons((await views(c, model, 'form')).arch, attrs => attrs['invisible'] ?? false),
});

/** A record's evaluation context as its form view loads it (binary fields as sizes). */
export async function formRecordContext(c: OdooClient, model: string, id: number): Promise<Record<string, unknown>> {
  const { fields } = await views(c, model, 'form');
  const rows = await c.execute(model, 'read', [[id]], {
    fields: Object.keys(fields), context: { bin_size: true },
  }) as Array<Record<string, unknown>>;
  if (!rows.length) throw new Error(`Record ${model}:${id} not found or not accessible.`);
  return recordEvalContext(c, fields, rows[0]);
}
