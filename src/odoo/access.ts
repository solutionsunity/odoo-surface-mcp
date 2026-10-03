import { since } from './since.js';

/** Whether the user may perform operation ('read' | 'create' | 'write' | 'unlink') on the model. */
export const hasAccess = since<[string, string], boolean>('hasAccess', {
  '15.0': async (c, model, operation) =>
    Boolean(await c.execute(model, 'check_access_rights', [operation, false])),
  // check_access_rights deprecated (18.0/odoo/models.py:4512), removed in 20.0; has_access on an
  // empty recordset checks model access (18.0/odoo/models.py:4459).
  '18.0': async (c, model, operation) =>
    Boolean(await c.execute(model, 'has_access', [[], operation])),
});
