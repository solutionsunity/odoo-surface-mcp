/**
 * Expression evaluation as the web client does it, through its own vendored code (py_js,
 * context.js, domain.js). Odoo stores action domains/contexts and view conditions as Python
 * expressions or domains; the browser evaluates them, never the server.
 */
import { OdooClient } from '../odooClient.js';
import { evaluateBooleanExpr, evaluateExpr } from '../vendor/odoo-web-core/py_js/py.js';
import { makeContext } from '../vendor/odoo-web-core/context.js';
import { Domain } from '../vendor/odoo-web-core/domain.js';
import { since } from './since.js';

type Ctx = Record<string, unknown>;

/** A view condition: a Python expression (17.0+), a domain (15.0/16.0 modifiers) or a constant. */
export type Condition = string | unknown[] | boolean;

type Fields = Record<string, Record<string, unknown>>;

/**
 * An action's domain and context with the caller's additional context, as the action service
 * prepares them: context = makeContext([additional, action.context], user context); the domain
 * is evaluated with user context + that context
 * (20.0/addons/web/static/src/webclient/actions/action_plugin.js, _preprocessAction).
 */
export async function evalAction(
  client: OdooClient,
  action: { domain?: unknown; context?: unknown },
  additional: Ctx = {},
): Promise<{ domain: unknown[]; context: Ctx }> {
  const user = await client.userContext();
  const context = makeContext([additional, (action.context || {}) as string | Ctx], user);
  const domain = typeof action.domain === 'string'
    ? evaluateExpr(action.domain, { ...user, ...context }) as unknown[]
    : (action.domain || []) as unknown[];
  return { domain, context };
}

/**
 * The record's active_* keys in its view evaluation context: there through 17.x
 * (15.0/addons/web/static/src/legacy/js/views/basic/basic_model.js:3741,
 * 17.0/addons/web/static/src/model/relational_model/utils.js:318 "deprecated, will be removed in v18"),
 * gone from 18.0 (18.0/addons/web/static/src/model/relational_model/utils.js:328).
 */
const activeKeys = since<[string, unknown], Ctx>('activeKeys', {
  '15.0': async (_c, model, id) => ({ active_id: id || false, active_ids: id ? [id] : [], active_model: model }),
  '18.0': async () => ({}),
});

/**
 * A record's evaluation context for view expressions, from a classic read of its view fields
 * (20.0/addons/web/static/src/model/relational_model/record.js, _computeDataContext;
 * utils.js, getBasicEvalContext).
 */
export async function recordEvalContext(client: OdooClient, model: string, fields: Fields, values: Ctx): Promise<Ctx> {
  const context = await client.userContext();
  const data: Ctx = {};
  for (const [name, value] of Object.entries(values)) {
    const type = fields[name]?.type;
    if (type === 'properties') continue;
    if (type === 'char' || type === 'text' || type === 'html') data[name] = value || '';
    else if (type === 'many2one') data[name] = Array.isArray(value) ? value[0] : value;
    else data[name] = value;
  }
  return {
    context,
    uid: context.uid,
    allowed_company_ids: context.allowed_company_ids,
    current_company_id: (context.allowed_company_ids as number[] | undefined)?.[0],
    ...await activeKeys(client, model, values.id ?? false),
    ...data,
    id: values.id ?? false,
  };
}

/**
 * Whether a view condition holds for an evaluation context: expressions as the 17.0+ record does
 * (evaluateBooleanExpr), domains as 15.0/16.0 do (16.0/addons/web/static/src/views/utils.js:135).
 */
export function holds(condition: Condition, context: Ctx): boolean {
  if (typeof condition === 'boolean') return condition;
  return Array.isArray(condition) ? new Domain(condition).contains(context) : evaluateBooleanExpr(condition, context);
}

/** A button's context attribute evaluated against its record, as the form does it (20.0/addons/web/static/src/views/view_button/view_button_hook.js:106). */
export function buttonContext(context: string | undefined, record: Ctx): Ctx {
  return context ? evaluateExpr(context, record) as Ctx : {};
}

/** The condition that holds when any of `conditions` does: domains or-ed (15.0/16.0), expressions or-ed (17.0+). */
export function anyOf(conditions: Condition[]): Condition {
  const live = conditions.filter(c => c !== false);
  if (live.includes(true)) return true;
  if (live.length < 2) return live[0] ?? false;
  return live.every(Array.isArray)
    ? Domain.or(live as unknown[][]).toList({})
    : live.map(c => `(${c})`).join(' or ');
}
