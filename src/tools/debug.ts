/** Debug tools — only registered when server is started with --debug. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { OdooClient } from '../odooClient.js';
import { Cache } from '../cache.js';
import { xmlParser, FXPNode, iterNodes, ok } from '../utils.js';

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
        const result = await client.execute(model, 'get_views', [[[false, view_type]]]) as {
          views: Record<string, { arch: string }>;
        };
        const arch = result.views?.[view_type]?.arch ?? '';
        return ok({ model, view_type, arch });
      } catch (e) { return ok({ error: String(e) }); }
    },
  );

  server.registerTool(
    'inspect_action',
    {
      description:
        '[DEBUG] Dump all action sources for a model: ' +
        'server actions, reports, view buttons (type=object), view buttons (type=action).',
      inputSchema: { model: z.string() },
    },
    async ({ model }) => {
      try {
        const modelId = await client.getModelId(model);
        if (!modelId) return ok({ error: `Model '${model}' not found` });

        const serverActions = await client.execute('ir.actions.server', 'search_read',
          [[['binding_model_id', '=', modelId]]],
          { fields: ['id', 'name', 'binding_type', 'binding_view_types', 'state'] },
        );
        const reports = await client.execute('ir.actions.report', 'search_read',
          [[['binding_model_id', '=', modelId]]],
          { fields: ['id', 'name', 'binding_view_types', 'report_type', 'report_name'] },
        );

        const viewButtons: Record<string, unknown[]> = { object: [], action: [] };
        try {
          const arch = await client.getFormArch(model);
          const nodes = xmlParser.parse(arch) as FXPNode[];
          for (const node of iterNodes(nodes, 'button')) {
            const attrs = node[':@'] as Record<string, string> | undefined;
            if (!attrs) continue;
            const btnType = attrs['type'];
            if (btnType === 'object' || btnType === 'action') {
              viewButtons[btnType].push({ ...attrs });
            }
          }
        } catch (e) {
          viewButtons['parse_error'] = [String(e)];
        }

        return ok({ model, server_actions: serverActions, reports, view_buttons: viewButtons });
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
