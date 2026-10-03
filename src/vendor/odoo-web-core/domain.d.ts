// Local declarations (not upstream) for the domain.js entry points this repository uses.
export class Domain {
  constructor(descr?: string | unknown[] | Domain);
  static or(domains: Array<string | unknown[] | Domain>): Domain;
  contains(record: Record<string, unknown>): boolean;
  toList(context: Record<string, unknown>): unknown[];
}
