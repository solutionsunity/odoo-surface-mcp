# OdooSurface MCP

[![npm version](https://img.shields.io/npm/v/@suco/odoo-surface-mcp)](https://www.npmjs.com/package/@suco/odoo-surface-mcp)
[![Node](https://img.shields.io/node/v/@suco/odoo-surface-mcp)](https://www.npmjs.com/package/@suco/odoo-surface-mcp)
[![Odoo](https://img.shields.io/badge/Odoo-17%2B-blueviolet)](https://www.odoo.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Downloads](https://img.shields.io/npm/dm/@suco/odoo-surface-mcp)](https://www.npmjs.com/package/@suco/odoo-surface-mcp)

User-equivalent Odoo access for AI agents — what the authenticated user can do in their browser, nothing more.

## Prerequisites

- Node.js 18+ (ships with `npx` — no extra install needed)
- A running Odoo instance (17.0+, CE or EE)
- An MCP-compatible client (VS Code, Claude Desktop, Claude Code, Cursor, …)

## Configure your MCP client

Add this to your MCP client config (e.g. Claude Desktop `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "odoo-surface": {
      "command": "npx",
      "args": ["-y", "@suco/odoo-surface-mcp@latest"],
      "env": {
        "ODOO_URL": "http://localhost:8069",
        "ODOO_DB": "your_database",
        "ODOO_USER": "admin",
        "ODOO_PASSWORD": "admin"
      }
    }
  }
}
```

Restart your MCP client after saving. `npx` downloads and runs the package automatically — no further install steps.

## Debug mode

Registers additional tools: `ping`, `echo`, `inspect_view`, `inspect_action`, `inspect_fields`, `dump_cache`, `clear_cache`, `restart_mcp`.

```json
"args": ["-y", "@suco/odoo-surface-mcp@latest", "--debug"]
```

## Tools

| Layer | Tools |
|---|---|
| Discovery | `get_models`, `get_model_actions` |
| Planning | `get_available_actions` |
| Supporting | `list_records`, `get_record`, `search_records`, `get_fields`, `get_defaults`, `get_filters`, `list_snippets`, `get_snippet` |
| Intent | `create`, `update`, `execute_action`, `archive`, `post_message`, `schedule_activity` |

## Architecture

See [SURFACE.md](SURFACE.md) for the design contract, layer rationale, and planning loop.
