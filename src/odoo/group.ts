import { since } from './since.js';

/**
 * One group, in formatted_read_group's shape: each groupby spec → its value (many2one as
 * [id, name], date granularity as [range start, label]), '__count', each 'field:agg' → its value.
 */
export type Group = Record<string, unknown>;

type Range = { from: string } | false;

export const readGroup = since<[string, unknown[], string[], string[], Record<string, unknown>], Group[]>('readGroup', {
  // read_group(domain, fields, groupby, lazy=False): aggregates keyed by field name, a date group's
  // value is its label with the range start in __range (15.0/odoo/models.py:2412, 18.0/odoo/models.py:2819).
  '15.0': async (c, model, domain, groupby, aggregates, context) => {
    const rows = await c.execute(model, 'read_group', [domain, aggregates, groupby], { lazy: false, context }) as Group[];
    return rows.map(row => {
      const ranges = (row['__range'] ?? {}) as Record<string, Range>;
      const group: Group = {};
      for (const spec of groupby) {
        const range = ranges[spec] ?? ranges[spec.split(':')[0]];
        group[spec] = range ? [range.from, row[spec]] : row[spec];
      }
      group['__count'] = row['__count'];
      for (const spec of aggregates) group[spec] = row[spec.split(':')[0]];
      return group;
    });
  },
  // read_group is deprecated from 19.0 (19.0/odoo/orm/models.py:2754) and returns tuples on 20.0;
  // formatted_read_group is the web client's (19.0/addons/web/models/models.py:802).
  '19.0': async (c, model, domain, groupby, aggregates, context) => {
    const rows = await c.execute(model, 'formatted_read_group', [domain, groupby, ['__count', ...aggregates]], { context }) as Group[];
    return rows.map(row => Object.fromEntries([...groupby, '__count', ...aggregates].map(k => [k, row[k]])));
  },
});
