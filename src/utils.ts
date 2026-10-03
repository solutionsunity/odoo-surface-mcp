/** Shared utilities used across tool modules. */

// ─── Guidance hint ────────────────────────────────────────────────────────────
/** Prepend to mutating tool descriptions so agents check skills/workflows first. */
export const GUIDANCE_HINT = '💡 Before multi-step work, check find_skill / list_workflows for canonical recipes. ';
import { XMLParser } from 'fast-xml-parser';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, isAbsolute } from 'path';
import { z } from 'zod';

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

/** Input of read tools whose results can be large. */
export const outputPath = z.string().optional().describe(
  'Absolute path on the MCP server host. When given, the full JSON result is written there and the ' +
  'tool returns only {output_path, total, count} — for results too large for context or meant for scripts.');

/**
 * Wrap any value as a valid MCP tool text-content response. With outputPath, the value is written
 * to that file instead and the response is {output_path, total, count}: count is the number of
 * rows (an array, or its `records`), total the value's own `total` when it has one, else count.
 */
export function ok(data: unknown, outputPath?: string) {
  if (outputPath) {
    if (!isAbsolute(outputPath)) return ok({ error: `output_path must be absolute: ${outputPath}` });
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, JSON.stringify(data));
    const rows = Array.isArray(data) ? data : (data as { records?: unknown[] }).records;
    const count = rows?.length ?? 0;
    const total = (data as { total?: unknown }).total;
    data = { output_path: outputPath, total: typeof total === 'number' ? total : count, count };
  }
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}
