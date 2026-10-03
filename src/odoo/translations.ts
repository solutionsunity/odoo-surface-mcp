import { OdooClient } from '../odooClient.js';
import { since } from './since.js';

/** One translation: the en_US source (whole value, or one term of an html/xml field) and its value in lang. */
export interface TermRow {
  lang: string;
  source: string;
  value: string;
}

export interface FieldTranslations {
  rows: TermRow[];
  meta: { translation_type?: string; translation_show_source?: boolean };
}

/** Per language: a value (translate=True; false voids it) or a {source term: translation} map (html/xml). */
export type Translations = Record<string, unknown>;

// ─── 15.0: translations live in ir.translation ───────────────────────────────

/**
 * What 15.0's translate button opens: inserts the record's missing term rows and returns the
 * dialog's domain and context (15.0/odoo/addons/base/models/ir_translation.py:717).
 */
async function dialog(c: OdooClient, model: string, id: number, field: string) {
  const action = await c.execute('ir.translation', 'translate_fields', [model, id, field]) as {
    domain: unknown[];
    context: { search_default_name?: string; translation_type: string; translation_show_src: boolean };
  };
  return {
    domain: [...action.domain, ['name', '=', action.context.search_default_name ?? `${model},${field}`]],
    meta: { translation_type: action.context.translation_type, translation_show_source: action.context.translation_show_src },
  };
}

const installedLangs = async (c: OdooClient) =>
  (await c.execute('res.lang', 'search_read', [[]], { fields: ['code'] }) as Array<{ code: string }>).map(l => l.code);

async function readIn(c: OdooClient, model: string, id: number, field: string, lang: string): Promise<string> {
  const rows = await c.execute(model, 'read', [[id]], { fields: [field], context: { lang } }) as Array<Record<string, string>>;
  if (!rows.length) throw new Error(`Record ${model}:${id} not found.`);
  return rows[0][field];
}

async function translatable(c: OdooClient, model: string, field: string): Promise<boolean> {
  const meta = await c.execute(model, 'fields_get', [[field]], { attributes: ['translate'] }) as Record<string, { translate?: boolean }>;
  if (!meta[field]) throw new Error(`Field '${field}' not found on ${model}.`);
  return Boolean(meta[field].translate);
}

// ─── Operations ──────────────────────────────────────────────────────────────

/**
 * A field's translations in 16.0's get_field_translations shape: for translate=True one row per
 * language (value falls back to the source); for html/xml one row per term and language (value ''
 * when untranslated).
 */
export const fieldTranslations = since<[string, number, string, string[] | undefined], FieldTranslations>('fieldTranslations', {
  '15.0': async (c, model, id, field, langs) => {
    if (!await translatable(c, model, field)) return { rows: [], meta: {} };
    const { domain, meta } = await dialog(c, model, id, field);
    const codes = langs?.length ? langs : await installedLangs(c);
    if (!meta.translation_show_source) {
      const source = await readIn(c, model, id, field, 'en_US');
      const rows: TermRow[] = [];
      for (const lang of codes) rows.push({ lang, source, value: await readIn(c, model, id, field, lang) });
      return { rows, meta };
    }
    const terms = await c.execute('ir.translation', 'search_read', [[...domain, ['lang', 'in', codes]]], {
      fields: ['src', 'value', 'lang'], order: 'id',
    }) as Array<{ src: string; value: string; lang: string }>;
    const byTerm = new Map<string, Map<string, string>>();
    for (const t of terms) {
      if (!byTerm.has(t.src)) byTerm.set(t.src, new Map());
      if (t.value && t.value !== t.src) byTerm.get(t.src)!.set(t.lang, t.value);
    }
    const rows = [...byTerm].flatMap(([source, values]) =>
      codes.map(lang => ({ lang, source, value: values.get(lang) ?? '' })));
    return { rows, meta };
  },
  '16.0': async (c, model, id, field, langs) => {
    const [rows, meta] = await c.execute(model, 'get_field_translations', [[id], field],
      langs?.length ? { langs } : {}) as [TermRow[], FieldTranslations['meta']];
    return { rows: rows ?? [], meta: meta ?? {} };
  },
});

/** Write a field's translations with 16.0's update_field_translations contract. */
export const updateFieldTranslations = since<[string, number, string, Translations], void>('updateFieldTranslations', {
  // As the 15.0 translate dialog edits them: translate=True through the record in each language,
  // html/xml terms as ir.translation rows. Unknown source terms are ignored, as in 16.0.
  '15.0': async (c, model, id, field, translations) => {
    const installed = new Set(await installedLangs(c));
    const missing = Object.keys(translations).filter(l => !installed.has(l));
    if (missing.length) throw new Error(`The following languages are not activated: ${missing.join(', ')}`);
    if (!await translatable(c, model, field)) return;
    const { domain, meta } = await dialog(c, model, id, field);
    if (!meta.translation_show_source) {
      for (const [lang, value] of Object.entries(translations)) {
        if (typeof value === 'string') {
          await c.execute(model, 'write', [[id], { [field]: value }], { context: { lang } });
        } else if (lang !== 'en_US') {
          const ids = await c.execute('ir.translation', 'search', [[...domain, ['lang', '=', lang]]]) as number[];
          if (ids.length) await c.execute('ir.translation', 'unlink', [ids]);
        }
      }
      return;
    }
    if ('en_US' in translations) {
      throw new Error('Odoo 15.0 cannot rewrite source (en_US) terms of an html/xml field term by term; write the field itself.');
    }
    for (const [lang, terms] of Object.entries(translations)) {
      for (const [src, value] of Object.entries(terms as Record<string, string>)) {
        const ids = await c.execute('ir.translation', 'search',
          [[...domain, ['lang', '=', lang], ['src', '=', src]]]) as number[];
        if (ids.length) await c.execute('ir.translation', 'write', [ids, { value }]);
      }
    }
  },
  '16.0': async (c, model, id, field, translations) => {
    await c.execute(model, 'update_field_translations', [[id], field, translations]);
  },
});
