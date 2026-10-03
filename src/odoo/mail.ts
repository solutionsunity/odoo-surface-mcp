import { OdooClient } from '../odooClient.js';
import { since } from './since.js';

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&#34;', "'": '&#39;' };

const post = (c: OdooClient, model: string, id: number, body: string, subtypeXmlid: string) =>
  c.execute(model, 'message_post', [[id]], { body, message_type: 'comment', subtype_xmlid: subtypeXmlid });

/** Post a plain-text message on a record; returns the mail.message id. */
export const postMessage = since<[string, number, string, string], number>('postMessage', {
  // A string body is stored as HTML; escape it as 17.0+ does server-side.
  '15.0': async (c, model, id, body, subtype) =>
    await post(c, model, id, body.replace(/[&<>"']/g, ch => ESCAPES[ch]), subtype) as number,
  // A string body is escaped server-side (17.0/addons/mail/models/mail_thread.py:2224).
  '17.0': async (c, model, id, body, subtype) => await post(c, model, id, body, subtype) as number,
  // No @api.returns: the recordset comes back as ids (19.0/odoo/service/model.py:104).
  '19.0': async (c, model, id, body, subtype) => (await post(c, model, id, body, subtype) as number[])[0],
});
