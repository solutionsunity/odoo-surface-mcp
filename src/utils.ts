/** Shared utilities used across tool modules. */
import { XMLParser } from 'fast-xml-parser';

// ─── XML ─────────────────────────────────────────────────────────────────────

export const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  preserveOrder: true,
  isArray: () => true,
});

export type FXPNode = Record<string, unknown>;

/**
 * Recursively yield all nodes from a fast-xml-parser preserveOrder tree.
 * If `tag` is given, only yield nodes whose element tag matches.
 * Each yielded node is the full { tagName: [...children], ':@': {...attrs} } object.
 */
export function* iterNodes(nodes: FXPNode[], tag?: string): Generator<FXPNode> {
  for (const node of nodes) {
    for (const [key, children] of Object.entries(node)) {
      if (key === ':@') continue;
      if (!tag || key === tag) yield node;
      if (Array.isArray(children)) yield* iterNodes(children as FXPNode[], tag);
    }
  }
}

// ─── MCP response helper ─────────────────────────────────────────────────────

/** Wrap any value as a valid MCP tool text-content response. */
export function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}
