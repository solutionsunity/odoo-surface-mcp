/** Debug tools — only registered when server is started with --debug. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { OdooClient } from '../odooClient.js';
import { views } from '../odoo/views.js';
import { Cache } from '../cache.js';
import { collectModelActions } from './discovery.js';
import { xmlParser, FXPNode, viewNodes, ok } from '../utils.js';

export function register(server: McpServer, client: OdooClient, cache: Cache): void {

  // ── Health ──────────────────────────────────────────────────────────────────

  server.registerTool('ping',
    { description: '[DEBUG] Check MCP↔Odoo connectivity. Returns version and latency.' },
    async () => ok(await client.ping()),
  );

  server.registerTool('echo',
    { description: '[DEBUG] Reflect payload back. Tests MCP tool-call roundtrip.', inputSchema: { payload: z.string() } },
    async ({ payload }) => ok({ echo: payload }),
  );

  // ── Inspection ──────────────────────────────────────────────────────────────

  server.registerTool(
    'inspect_view',
    {
      description:
        '[DEBUG] Return the compiled arch XML for a model\'s view. ' +
        'view_type: form (default), list, kanban, search.',
      inputSchema: { model: z.string(), view_type: z.string().default('form') },
    },
    async ({ model, view_type }) => {
      try {
        const { arch } = await views(client, model, view_type);
        return ok({ model, view_type, arch });
      } catch (e) { return ok({ error: String(e) }); }
    },
  );

  server.registerTool(
    'inspect_action',
    {
      description:
        '[DEBUG] get_model_actions\' result plus the raw attributes of every form button ' +
        '(context, groups, class, … as the server sends them).',
      inputSchema: { model: z.string() },
    },
    async ({ model }) => {
      try {
        const { arch } = await views(client, model, 'form');
        const raw_buttons = [...viewNodes(xmlParser.parse(arch) as FXPNode[], 'button')].map(([node]) => node[':@'] ?? {});
        return ok({ model, ...await collectModelActions(client, model), raw_buttons });
      } catch (e) { return ok({ error: String(e) }); }
    },
  );

  server.registerTool(
    'inspect_fields',
    {
      description: '[DEBUG] Return all fields on a model — including technical fields not filtered by view visibility.',
      inputSchema: { model: z.string() },
    },
    async ({ model }) => {
      try {
        const fields = await client.execute(model, 'fields_get', [], {
          attributes: ['string', 'type', 'relation', 'required', 'readonly', 'store'],
        }) as Record<string, unknown>;
        return ok({ model, field_count: Object.keys(fields).length, fields });
      } catch (e) { return ok({ error: String(e) }); }
    },
  );

  // ── Cache ────────────────────────────────────────────────────────────────────

  server.registerTool('dump_cache',
    { description: '[DEBUG] Show cache stats and all live keys.' },
    async () => ok({ stats: cache.stats(), entries: cache.dump() }),
  );

  server.registerTool('clear_cache',
    { description: '[DEBUG] Clear all cache entries. Next call rebuilds from Odoo.' },
    async () => ok({ cleared: cache.clear(), message: 'Cache cleared.' }),
  );

  // ── Process ──────────────────────────────────────────────────────────────────

  server.registerTool(
    'restart_mcp',
    {
      description:
        '[DEBUG] Exit the MCP server process. The MCP client detects the disconnect and ' +
        'relaunches the server automatically (standard stdio MCP restart pattern).',
    },
    async () => {
      // Yield the response to the transport before exiting.
      setImmediate(() => process.exit(0));
      return ok({ status: 'restarting' });
    },
  );
}
