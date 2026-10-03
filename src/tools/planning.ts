/**
 * Layer 2 — Planning Bridge: get_available_actions.
 *
 * Evaluates which buttons are actually visible for a specific record, as the web client does.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { OdooClient } from '../odooClient.js';
import { Cache } from '../cache.js';
import { collectModelActions } from './discovery.js';
import { ok } from '../utils.js';
import { formRecordContext } from '../odoo/buttons.js';
import { holds } from '../odoo/expr.js';

// ─── Register ────────────────────────────────────────────────────────────────

export function register(server: McpServer, client: OdooClient, _cache: Cache): void {

  server.registerTool(
    'get_available_actions',
    {
      description:
        'Return the buttons and actions that are actually visible for a specific record ' +
        'right now, based on its current field values. ' +
        'Mirrors what the Odoo web client shows when a user opens the form view: ' +
        'invisible conditions are evaluated with the web client\'s own evaluator against the record. ' +
        'Returns {visible_buttons[], server_actions[], reports[], can_create, can_write, can_delete}.',
      inputSchema: {
        model: z.string(),
        record_id: z.number().int(),
        action_id: z.number().int().optional(),
      },
    },
    async ({ model, record_id, action_id: _actionId }) => {
      try {
        const actions = await collectModelActions(client, model);

        // Group restrictions need no check: the server drops buttons outside the user's groups
        // (15.0/odoo/addons/base/models/ir_ui_view.py:1007, 16.0/odoo/addons/base/models/ir_ui_view.py:1059).
        const evalCtx = await formRecordContext(client, model, record_id);
        const seenBtns = new Set<string>();
        const visibleButtons: unknown[] = [];
        for (const btn of actions.view_buttons) {
          if (holds(btn.invisible, evalCtx) || seenBtns.has(btn.name)) continue;
          seenBtns.add(btn.name);
          visibleButtons.push({ name: btn.name, label: btn.label, type: btn.type });
        }

        // Server actions and reports bound to the form view.
        const onForm = (a: { view_types: string }) => (a.view_types || '').includes('form');

        return ok({
          record_id,
          can_create: actions.can_create,
          can_write: actions.can_write,
          can_delete: actions.can_delete,
          visible_buttons: visibleButtons,
          server_actions: actions.server_actions.filter(onForm),
          reports: actions.reports.filter(onForm),
        });
      } catch (e) { return ok({ error: String(e) }); }
    },
  );
}
