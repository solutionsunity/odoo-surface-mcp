// Local declarations (not upstream) for the domain.js entry points this repository uses.
export class Domain {
  constructor(descr?: string | unknown[] | Domain);
  contains(record: Record<string, unknown>): boolean;
}
