import { OdooClient } from '../odooClient.js';
import { since } from './since.js';

async function readField(c: OdooClient, model: string, id: number, field: string): Promise<unknown> {
  const rows = await c.execute(model, 'read', [[id]], { fields: [field] }) as Array<Record<string, unknown>>;
  if (!rows.length) throw new Error(`Record ${model}:${id} not found.`);
  return rows[0][field];
}

/** Where an attachment is served: its own url, else images through /web/image, other files through /web/content. */
export function attachmentSrc(a: { id: number; mimetype?: string | false; url?: string | false }): string {
  return a.url || (a.mimetype && a.mimetype.startsWith('image/') ? `/web/image/${a.id}` : `/web/content/${a.id}`);
}

/** Base64 content of a binary field, or false when empty. */
export const readBinary = since<[string, number, string], string | false>('readBinary', {
  // read returns the base64 string.
  '15.0': async (c, model, id, field) => (await readField(c, model, id, field) as string | false) || false,
  // read returns { filename?, content, size } (20.0/odoo/orm/fields_binary.py:134).
  '20.0': async (c, model, id, field) => {
    const value = await readField(c, model, id, field) as { content?: string } | false;
    return (value && value.content) || false;
  },
});

/** Replace an attachment's content (base64) in place, with any other values written alongside. */
export const writeAttachmentContent = since<[number, string, Record<string, unknown>], void>('writeAttachmentContent', {
  '15.0': async (c, id, content, vals) => {
    await c.execute('ir.attachment', 'write', [[id], { ...vals, datas: content }]);
  },
  // datas removed; raw decodes a base64 string on write
  // (20.0/odoo/addons/base/models/ir_attachment.py:616, 20.0/odoo/orm/fields_binary.py:89).
  '20.0': async (c, id, content, vals) => {
    await c.execute('ir.attachment', 'write', [[id], { ...vals, raw: content }]);
  },
});
