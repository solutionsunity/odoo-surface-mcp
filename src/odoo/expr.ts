/**
 * Expression evaluation as the web client does it, through its own vendored code (py_js,
 * context.js, domain.js). Odoo stores action domains/contexts and view conditions as Python
 * expressions or domains; the browser evaluates them, never the server.
 */
import { OdooClient } from '../odooClient.js';
import { evaluateBooleanExpr, evaluateExpr } from '../vendor/odoo-web-core/py_js/py.js';
import { makeContext } from '../vendor/odoo-web-core/context.js';
import { Domain } from '../vendor/odoo-web-core/domain.js';

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
 * A record's evaluation context for view conditions, from a classic read of its view fields
 * (20.0/addons/web/static/src/model/relational_model/record.js, _computeDataContext;
 * utils.js, getBasicEvalContext).
 */
export async function recordEvalContext(client: OdooClient, fields: Fields, values: Ctx): Promise<Ctx> {
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
