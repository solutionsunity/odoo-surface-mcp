// Local declarations (not upstream) for the context.js entry points this repository uses.
export function makeContext(
  contexts: Array<string | false | Record<string, unknown>>,
  initialEvaluationContext?: Record<string, unknown>,
): Record<string, unknown>;
