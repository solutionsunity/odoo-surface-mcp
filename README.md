# OdooSurface MCP

[![PyPI version](https://img.shields.io/pypi/v/suco-odoo-surface-mcp)](https://pypi.org/project/suco-odoo-surface-mcp/)
[![Python](https://img.shields.io/pypi/pyversions/suco-odoo-surface-mcp)](https://pypi.org/project/suco-odoo-surface-mcp/)
[![Odoo](https://img.shields.io/badge/Odoo-16%2B-blueviolet)](https://www.odoo.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Downloads](https://img.shields.io/pypi/dm/suco-odoo-surface-mcp)](https://pypistats.org/packages/suco-odoo-surface-mcp)

User-equivalent Odoo access for AI agents — what the authenticated user can do in their browser, nothing more.

## Prerequisites

A running Odoo instance (16.0+, CE or EE) and an MCP-compatible client (e.g. Claude Desktop).

### Install `uv`

`uv` is the Python runner used to launch the server — no manual Python or pip setup needed.

**macOS**
```bash
brew install uv
```

Then make `uvx` visible to MCP clients (non-login shells):
```bash
sudo ln -s $(which uvx) /usr/local/bin/uvx
```

**Windows**
```powershell
winget install --id=astral-sh.uv
```

**Linux**
```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

Then make `uvx` visible to MCP clients (non-login shells):
```bash
sudo ln -s $(which uvx) /usr/local/bin/uvx
```

## Configure your MCP client

Add this to your MCP client config (e.g. Claude Desktop `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "odoo-surface": {
      "command": "uvx",
      "args": ["suco-odoo-surface-mcp@latest"],
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

Restart your MCP client after saving. `uvx` downloads and runs the package automatically — no further install steps.

## Debug mode

Registers additional tools: `ping`, `echo`, `inspect_view`, `inspect_action`, `inspect_fields`, `query_db`, `dump_cache`, `clear_cache`, `restart_mcp`.

```json
"args": ["suco-odoo-surface-mcp@latest", "--debug"]
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
