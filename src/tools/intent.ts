/** Layer 4 — Primary Intent tools: create, update, execute_action, archive,
 * post_message, schedule_activity. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { OdooClient } from '../odooClient.js';
import { Cache } from '../cache.js';
import { resolveContext, viewFieldNames, safeEvalDict } from './supporting.js';
import { collectModelActions } from './discovery.js';
import { ok } from '../utils.js';

function isOdooCommand(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0
    && Array.isArray(value[0]) && value[0].length > 0
    && typeof value[0][0] === 'number';
}

function activeCtx(recordId: number, model: string): Record<string, unknown> {
  return { active_id: recordId, active_ids: [recordId], active_model: model };
}

function normalise(result: unknown): Record<string, unknown> {
  if (result === true || result === false || result === null || result === undefined) return { success: true };
  if (result && typeof result === 'object' && !Array.isArray(result)) return result as Record<string, unknown>;
  if (typeof result === 'number' || typeof result === 'string') return { result };
  return { result: String(result) };
}

async function actionCheck(client: OdooClient, model: string, recordId: number): Promise<Record<string, unknown>> {
  const PROBE = ['state', 'display_name', 'name', 'active'];
  try {
    const valid = await client.validFieldNames(model);
    const fields = PROBE.filter(f => valid.has(f));
    const rows = await client.execute(model, 'read', [[recordId]], { fields: fields.length ? fields : ['display_name'] }) as unknown[];
    if (rows.length) return { success: true, record_after: rows[0] };
  } catch { /* fall through */ }
  return { success: true };
}

export function register(server: McpServer, client: OdooClient, cache: Cache): void {

  server.registerTool(
    'create',
    {
      description:
        'Create a new record. values: dict of field/value pairs (form-view fields only). ' +
        'Defaults are merged with provided values automatically. ' +
        'Pass action_id to include the action\'s context (e.g. default_partner_id). ' +
        'Pass context dict directly for wizard models. ' +
        'Returns {id, display_name} or {error}.',
      inputSchema: {
        model: z.string(),
        values: z.record(z.unknown()),
        action_id: z.number().int().optional(),
        context: z.record(z.unknown()).optional(),
      },
    },
    async ({ model, values, action_id, context }) => {
      try {
        const mergedCtx = await resolveContext(client, cache, action_id, context);
        const newId = await client.execute(model, 'create', [values], { context: mergedCtx }) as number;
        const rows = await client.execute(model, 'read', [[newId]], { fields: ['id', 'display_name'] }) as unknown[];
        return ok(rows[0] ?? { id: newId });
      } catch (e) { return ok({ error: String(e) }); }
    },
  );

  server.registerTool(
    'update',
    {
      description:
        'Update fields on an existing record. values: {field: value, ...}. ' +
        'Writes both form-view fields and model fields not exposed in the form view. ' +
        'One2many / many2many fields accept Odoo Command tuples directly: ' +
        '[[0,0,{vals}]] create+link, [[1,id,{vals}]] update line, [[2,id]] delete line, [[6,0,[ids]]] replace set. ' +
        'Returns {success, updated_fields, non_form_fields} or {error}.',
      inputSchema: {
        model: z.string(),
        record_id: z.number().int(),
        values: z.record(z.unknown()),
      },
    },
    async ({ model, record_id, values }) => {
      try {
        const formFields = new Set(await viewFieldNames(client, cache, model, 'form'));
        const meta = await client.execute(model, 'fields_get', [], { attributes: ['readonly'] }) as Record<string, { readonly?: boolean }>;
        const writable: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(values)) {
          if (k in meta && (isOdooCommand(v) || !meta[k]?.readonly)) {
            writable[k] = v;
          }
        }
        if (!Object.keys(writable).length) return ok({ error: 'No writable fields found in the provided values.' });
        await client.execute(model, 'write', [[record_id], writable]);
        const nonFormWritten = Object.keys(writable).filter(k => !formFields.has(k));
        const result: Record<string, unknown> = { success: true, updated_fields: Object.keys(writable) };
        if (nonFormWritten.length) result['non_form_fields'] = nonFormWritten;
        return ok(result);
      } catch (e) { return ok({ error: String(e) }); }
    },
  );

  server.registerTool(
    'execute_action',
    {
      description:
        'Execute a button or server action on a record. ' +
        'action: button name (method) or label as shown in get_model_actions — ' +
        'e.g. "action_confirm", "Confirm", "Privacy Lookup". ' +
        'View buttons (type=object) call the method directly; server actions use ir.actions.server.run. ' +
        'Returns the Odoo action result, {success: true}, or {error}.',
      inputSchema: {
        model: z.string(),
        record_id: z.number().int(),
        action: z.string(),
      },
    },
    async ({ model, record_id, action }) => {
      try {
        const actionMap = await collectModelActions(client, model);

        // 1. View buttons
        for (const btn of (actionMap['view_buttons'] as Array<Record<string, unknown>> ?? [])) {
          if (btn['name'] !== action && btn['label'] !== action) continue;

          if (btn['type'] === 'action') {
            const actionId = parseInt(String(btn['name']), 10);
            const meta = await client.execute('ir.actions.actions', 'read', [[actionId]], {
              fields: ['type', 'name'],
            }) as Array<{ type: string; name: string }>;
            if (!meta.length) return ok({ error: `Action id ${actionId} not found.` });
            const actionType = meta[0].type ?? 'ir.actions.act_window';
            const full = await client.execute(actionType, 'read', [[actionId]]) as Array<Record<string, unknown>>;
            if (!full.length) return ok({ error: `Could not load action ${actionId}.` });
            const actionDef = { ...full[0] };
            const ctx = safeEvalDict(actionDef['context']);
            Object.assign(ctx, activeCtx(record_id, model));
            actionDef['context'] = ctx;
            return ok(actionDef);
          }

          // type=object → call_button
          const result = await client.httpCall('/web/dataset/call_button', {
            model, method: btn['name'], args: [[record_id]], kwargs: {},
          });
          if (result === false || result === null || result === undefined) {
            return ok(await actionCheck(client, model, record_id));
          }
          return ok(normalise(result));
        }

        // 2. Server actions
        for (const sa of (actionMap['server_actions'] as Array<Record<string, unknown>> ?? [])) {
          if (String(sa['id']) !== action && sa['name'] !== action) continue;
          const result = await client.execute('ir.actions.server', 'run', [[sa['id']]], {
            context: activeCtx(record_id, model),
          });
          if (result === true || result === false || result === null || result === undefined) {
            return ok(await actionCheck(client, model, record_id));
          }
          return ok(normalise(result));
        }

        return ok({
          error: `Action '${action}' not found on '${model}'. Use get_model_actions() to list available actions.`,
        });
      } catch (e) { return ok({ error: String(e) }); }
    },
  );

  server.registerTool(
    'archive',
    {
      description:
        'Archive (deactivate) a record by setting active=False. ' +
        'Only works on models that have an active field (most standard models do). ' +
        'Returns {success: true} or {error}.',
      inputSchema: { model: z.string(), record_id: z.number().int() },
    },
    async ({ model, record_id }) => {
      try {
        const meta = await client.execute(model, 'fields_get', [], { attributes: ['type'] }) as Record<string, unknown>;
        if (!('active' in meta)) return ok({ error: `Model '${model}' has no active field and cannot be archived.` });
        await client.execute(model, 'write', [[record_id], { active: false }]);
        return ok({ success: true, record_id, active: false });
      } catch (e) { return ok({ error: String(e) }); }
    },
  );

  server.registerTool(
    'post_message',
    {
      description:
        'Post a message or internal note on a record (requires mail.thread). ' +
        'message_type: "comment" (sent to followers) or "note" (internal log note, not emailed). ' +
        'Returns {message_id} or {error}.',
      inputSchema: {
        model: z.string(),
        record_id: z.number().int(),
        body: z.string(),
        message_type: z.enum(['comment', 'note']).default('comment'),
      },
    },
    async ({ model, record_id, body, message_type }) => {
      try {
        const msgId = await client.execute(model, 'message_post', [[record_id]], {
          body,
          message_type: 'comment',
          subtype_xmlid: message_type === 'note' ? 'mail.mt_note' : 'mail.mt_comment',
        });
        return ok({ message_id: msgId });
      } catch (e) { return ok({ error: String(e) }); }
    },
  );

  server.registerTool(
    'schedule_activity',
    {
      description:
        'Schedule an activity on a record. ' +
        'activity_type: name of the activity type (e.g. "To-Do", "Email", "Phone Call"). ' +
        'deadline: ISO date string YYYY-MM-DD. ' +
        'summary: short title. note: longer description (optional). ' +
        'assigned_user_id: who to assign (default: current user). ' +
        'Returns {activity_id, activity_type, deadline} or {error}.',
      inputSchema: {
        model: z.string(),
        record_id: z.number().int(),
        activity_type: z.string(),
        deadline: z.string(),
        summary: z.string(),
        note: z.string().optional(),
        assigned_user_id: z.number().int().optional(),
      },
    },
    async ({ model, record_id, activity_type, deadline, summary, note, assigned_user_id }) => {
      try {
        const types = await client.execute('mail.activity.type', 'search_read',
          [[['name', 'ilike', activity_type]]],
          { fields: ['id', 'name'], limit: 1 },
        ) as Array<{ id: number; name: string }>;
        if (!types.length) return ok({ error: `Activity type '${activity_type}' not found.` });

        const modelId = await client.getModelId(model);
        if (!modelId) return ok({ error: `Model '${model}' not found in ir.model.` });

        const vals: Record<string, unknown> = {
          activity_type_id: types[0].id,
          date_deadline: deadline,
          summary,
          res_id: record_id,
          res_model_id: modelId,
        };
        if (note) vals['note'] = note;
        if (assigned_user_id) vals['user_id'] = assigned_user_id;

        const activityId = await client.execute('mail.activity', 'create', [vals]);
        return ok({ activity_id: activityId, activity_type: types[0].name, deadline });
      } catch (e) { return ok({ error: String(e) }); }
    },
  );
}
