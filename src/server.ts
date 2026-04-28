/** OdooSurface MCP server factory. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { OdooClient } from './odooClient.js';
import { Cache } from './cache.js';
import { register as registerDiscovery } from './tools/discovery.js';
import { register as registerPlanning } from './tools/planning.js';
import { register as registerSupporting } from './tools/supporting.js';
import { register as registerIntent } from './tools/intent.js';
import { register as registerDebug } from './tools/debug.js';
import { register as registerWebsite } from './tools/website.js';

export function createServer(debug = false): { server: McpServer; client: OdooClient } {
  const client = OdooClient.fromEnv();
  const cache = new Cache(300); // 5-minute TTL

  const server = new McpServer({
    name: 'odoo-surface',
    version: '0.3.0',
  });

  // Layer 1 — Discovery
  registerDiscovery(server, client, cache);
  // Layer 2 — Planning Bridge
  registerPlanning(server, client, cache);
  // Layer 3 — Supporting
  registerSupporting(server, client, cache);
  // Layer 4 — Primary Intent
  registerIntent(server, client, cache);
  // Layer 5 — Website
  registerWebsite(server, client, cache);

  if (debug) {
    registerDebug(server, client, cache);
  }

  return { server, client };
}
