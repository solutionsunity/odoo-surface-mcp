/**
 * Version routing. An operation is a table of implementations keyed by the series each starts
 * at; a key's segment runs until the next key. The target resolves to the greatest key ≤ its
 * version. Keys are '17.0' or 'saas~18.3', compared as (major, minor).
 */
import { OdooClient } from '../odooClient.js';

/** Supported floor. Every table starts here. */
export const FLOOR = '15.0';

type Impl<A extends unknown[], R> = (client: OdooClient, ...args: A) => Promise<R>;

const REASON = Symbol('unavailable');
interface Unavailable { [REASON]: string }

/** Segment where the operation does not exist on the target. */
export function unavailable(reason: string): Unavailable {
  return { [REASON]: reason };
}

type Series = [number, number];

function parse(series: string): Series {
  const m = /^(?:saas~)?(\d+)\.(\d+)$/.exec(series);
  if (!m) throw new Error(`Invalid series '${series}'`);
  return [Number(m[1]), Number(m[2])];
}

const atOrBelow = (a: Series, b: Series) => a[0] < b[0] || (a[0] === b[0] && a[1] <= b[1]);

export function since<A extends unknown[], R>(
  name: string,
  table: Record<string, Impl<A, R> | Unavailable>,
): Impl<A, R> {
  const segments = Object.entries(table)
    .map(([key, impl]) => ({ key, at: parse(key), impl }))
    .sort((a, b) => b.at[0] - a.at[0] || b.at[1] - a.at[1]);
  if (segments.at(-1)?.key !== FLOOR) throw new Error(`${name}: table must start at ${FLOOR}`);

  return async (client, ...args) => {
    const v = await client.version();
    const target = `${v.saas ? 'saas~' : ''}${v.major}.${v.minor}`;
    const segment = segments.find(s => atOrBelow(s.at, [v.major, v.minor]));
    if (!segment) throw new Error(`Odoo ${target} is below the supported floor ${FLOOR}`);
    const { impl } = segment;
    if (REASON in impl) throw new Error(`${name} is unavailable on Odoo ${target}: ${impl[REASON]}`);
    return impl(client, ...args);
  };
}
