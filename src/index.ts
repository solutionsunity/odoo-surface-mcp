#!/usr/bin/env node
/**
 * OdooSurface MCP — entry point.
 *
 * Usage:
 *   node dist/index.js              # production / stdio (default)
 *   node dist/index.js --debug      # adds debug/inspection tools
 *
 * Stdout discipline:
 *   In stdio transport mode stdout IS the JSON-RPC channel.
 *   All diagnostic output MUST go to stderr — never console.log().
 */
import 'dotenv/config';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

function parseArgs(): { debug: boolean } {
  const args = process.argv.slice(2);
  return { debug: args.includes('--debug') };
}

async function main(): Promise<void> {
  const { debug } = parseArgs();

  if (debug) {
    process.stderr.write('[odoo-surface] debug mode ON — extra tools registered\n');
  }

  const { server, client } = createServer(debug);
  const transport = new StdioServerTransport();

  // Clean shutdown on SIGINT / SIGTERM
  const shutdown = async () => {
    client.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await server.connect(transport);
}

main().catch(err => {
  process.stderr.write(`[odoo-surface] fatal: ${err}\n`);
  process.exit(1);
});
