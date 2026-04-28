/**
 * Layer 2 — Planning Bridge: get_available_actions.
 *
 * Evaluates which buttons are actually visible for a specific record by
 * mirroring Odoo's invisible-expression evaluation logic.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { OdooClient } from '../odooClient.js';
import { Cache } from '../cache.js';
import { collectModelActions } from './discovery.js';
import { ok } from '../utils.js';

// Names that appear in invisible expressions but are NOT record fields.
const IGNORED = new Set([
  'True', 'False', 'None', 'self', 'uid', 'context', 'context_today',
  'allowed_company_ids', 'current_company_id', 'time', 'datetime',
  'relativedelta', 'current_date', 'today', 'now',
  'abs', 'len', 'bool', 'float', 'str', 'unicode', 'set', 'id',
]);

const ALIASES: Record<string, string> = { '1': 'True', '0': 'False' };

// ─── Expression helpers ───────────────────────────────────────────────────────

function fieldNamesFromExpr(expr: string): Set<string> {
  const names = new Set<string>();
  const rx = /\b([a-zA-Z_][a-zA-Z0-9_]*)\b/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(expr)) !== null) {
    if (!IGNORED.has(m[1])) names.add(m[1]);
  }
  return names;
}

function pyExprToJs(expr: string): string {
  return expr
    // "not in" must come before "not" replacement
    .replace(/\bnot\s+in\b/g, '__NOTIN__')
    // Python "in (a, b)" → JS "[a, b].includes(x)" – handled field-side below
    .replace(/\b([\w.]+)\s+in\s+\(([^)]+)\)/g, (_, field, items) => `[${items}].includes(${field})`)
    .replace(/\b([\w.]+)\s+__NOTIN__\s+\(([^)]+)\)/g, (_, field, items) => `![${items}].includes(${field})`)
    .replace(/\bnot\s+/g, '!')
    .replace(/\band\b/g, '&&')
    .replace(/\bor\b/g, '||')
    .replace(/\bTrue\b/g, 'true')
    .replace(/\bFalse\b/g, 'false')
    .replace(/\bNone\b/g, 'null')
    .replace(/\blen\(([^)]+)\)/g, '($1?.length ?? 0)');
}

function isInvisible(expr: string | null | undefined, ctx: Record<string, unknown>): boolean {
  if (!expr || expr === 'False') return false;
  if (expr === 'True') return true;
  try {
    const jsExpr = pyExprToJs(expr);
    // eslint-disable-next-line no-new-func
    const fn = new Function(...Object.keys(ctx), `return !!(${jsExpr})`);
    return Boolean(fn(...Object.values(ctx)));
  } catch { return false; }
}

function userInGroups(groupsAttr: string | null | undefined, userGroups: Set<string>): boolean {
  if (!groupsAttr) return true;
  if (!userGroups.size) return true; // conservative: show if group check unavailable
  const required = groupsAttr.split(',').map(g => g.trim()).filter(Boolean);
  return required.some(g => userGroups.has(g));
}

function normaliseRecord(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    // many2one → id (Odoo returns [id, display_name] or false)
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'number') {
      out[k] = v[0];
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ─── Register ────────────────────────────────────────────────────────────────

export function register(server: McpServer, client: OdooClient, _cache: Cache): void {

  server.registerTool(
    'get_available_actions',
    {
      description:
        'Return the buttons and actions that are actually visible for a specific record ' +
        'right now, based on its current field values. ' +
        'Mirrors what the Odoo web client shows when a user opens the form view. ' +
        'invisible expressions are evaluated deterministically via field extraction ' +
        'and a targeted read of only the fields each expression references. ' +
        'Returns {visible_buttons[], server_actions[], reports[], can_create, can_write, can_delete}.',
      inputSchema: {
        model: z.string(),
        record_id: z.number().int(),
        action_id: z.number().int().optional(),
      },
    },
    async ({ model, record_id, action_id: _actionId }) => {
      try {
        const actionMap = await collectModelActions(client, model);
        const buttons = (actionMap['view_buttons'] ?? []) as Array<Record<string, unknown>>;

        // Step 1: collect field names needed across all invisible expressions
        const neededFields = new Set<string>();
        const parsed: Array<[Record<string, unknown>, string | null]> = [];

        for (const btn of buttons) {
          const raw = btn['invisible'] as string | undefined;
          const expr = raw !== undefined ? (ALIASES[raw] ?? raw) : null;
          parsed.push([btn, expr]);
          if (expr && expr !== 'True' && expr !== 'False') {
            for (const f of fieldNamesFromExpr(expr)) neededFields.add(f);
          }
        }

        // Step 2: one targeted read — only referenced fields
        const evalCtx: Record<string, unknown> = {
          id: record_id,
          uid: await client.getUid(),
          current_date: new Date().toISOString().slice(0, 10),
          context: {},
        };

        if (neededFields.size) {
          try {
            const valid = await client.validFieldNames(model);
            for (const f of [...neededFields]) { if (!valid.has(f)) neededFields.delete(f); }
          } catch { /* keep as-is */ }

          if (neededFields.size) {
            const rows = await client.execute(model, 'read', [[record_id]], {
              fields: [...neededFields],
            }) as Array<Record<string, unknown>>;
            if (!rows.length) return ok({ error: `Record ${model}:${record_id} not found or not accessible.` });
            Object.assign(evalCtx, normaliseRecord(rows[0]));
          }
        }

        // Step 3: evaluate each invisible expression + groups
        const userGroups = await client.userGroupXmlids();
        const seenBtns = new Set<string>();
        const visibleButtons: unknown[] = [];

        for (const [btn, expr] of parsed) {
          if (isInvisible(expr, evalCtx)) continue;
          if (!userInGroups(btn['groups'] as string | undefined, userGroups)) continue;
          const name = btn['name'] as string;
          if (seenBtns.has(name)) continue;
          seenBtns.add(name);
          visibleButtons.push({ name, label: btn['label'], type: btn['type'] });
        }

        // Step 4 & 5: server actions and reports scoped to form
        const visibleServerActions = (actionMap['server_actions'] as Array<Record<string, unknown>> ?? [])
          .filter(sa => String(sa['view_types'] ?? '').includes('form'));
        const visibleReports = (actionMap['reports'] as Array<Record<string, unknown>> ?? [])
          .filter(r => String(r['view_types'] ?? '').includes('form'));

        return ok({
          record_id,
          can_create: actionMap['can_create'],
          can_write: actionMap['can_write'],
          can_delete: actionMap['can_delete'],
          visible_buttons: visibleButtons,
          server_actions: visibleServerActions,
          reports: visibleReports,
          eval_fields_read: [...neededFields].sort(),
        });
      } catch (e) { return ok({ error: String(e) }); }
    },
  );
}
