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

## Authentication

### Option A — `.env` file (keep credentials out of MCP config)

Instead of putting credentials in your MCP client JSON, create a `.env` file in the directory where you run the MCP:

```ini
ODOO_URL=http://localhost:8069
ODOO_DB=your_database
ODOO_USER=admin
ODOO_PASSWORD=your_password
```

Remove the `env` block from the MCP client config — the `.env` file is loaded automatically.

### Option B — API Key (recommended, no password stored)

Since Odoo 14+, users can generate personal API keys that act as a password replacement.
Each user generates their own key from their own account — there is no admin-side menu for this.

1. Log in as the user the MCP will authenticate as
2. Click the **user avatar** (top-right) → **Preferences**
3. Go to the **Account Security** tab
4. Under **API Keys** → click **New API Key**
5. Enter your password when prompted, give the key a name, copy the generated key
6. Use it as `ODOO_PASSWORD` — the actual account password is never stored

```ini
ODOO_URL=http://localhost:8069
ODOO_DB=your_database
ODOO_USER=admin
ODOO_PASSWORD=your_api_key_here
```

API keys can be revoked individually from the same screen without changing the account password.

## Advanced Configuration

### Multiple Odoo instances

Technical users commonly work with more than one Odoo instance (local dev, staging, production).
Each instance gets its own named entry in the MCP config — they run as independent processes with
fully isolated credentials. The AI client exposes them as separate tool namespaces.

```json
{
  "mcpServers": {
    "odoo-local": {
      "command": "npx",
      "args": ["-y", "@suco/odoo-surface-mcp@latest"],
      "env": {
        "ODOO_URL": "http://localhost:8069",
        "ODOO_DB": "dev",
        "ODOO_USER": "admin",
        "ODOO_PASSWORD": "dev_api_key"
      }
    },
    "odoo-production": {
      "command": "npx",
      "args": ["-y", "@suco/odoo-surface-mcp@latest"],
      "env": {
        "ODOO_URL": "https://mycompany.odoo.com",
        "ODOO_DB": "prod",
        "ODOO_USER": "admin",
        "ODOO_PASSWORD": "prod_api_key"
      }
    }
  }
}
```

> **Note:** The `.env` file approach (Option A) does not work for multi-instance setups — both
> processes share the same working directory and would load the same file. Use the `env` block
> per entry instead.

## Debug mode

Registers additional tools: `ping`, `echo`, `inspect_view`, `inspect_action`, `inspect_fields`, `dump_cache`, `clear_cache`, `restart_mcp`.

```json
"args": ["-y", "@suco/odoo-surface-mcp@latest", "--debug"]
```

## Tools

| Layer | Tools |
|---|---|
| Guidance | `list_skills`, `get_skills`, `find_skill`, `list_workflows`, `get_workflows` |
| Discovery | `get_models`, `get_model_actions`, `get_model_interface` |
| Planning | `get_available_actions` |
| Supporting | `list_records`, `get_record`, `search_records`, `get_fields`, `get_defaults`, `get_filters`, `list_snippets`, `get_snippet`, `list_attachments`, `fetch_and_upload`, `translation_get`, `translation_update` |
| Intent | `create`, `update`, `execute_action`, `archive`, `post_message`, `schedule_activity`, `set_page_arch`, `set_page_visibility` |

## Architecture

### Core Contract

The agent may only do what the authenticated user can do in their browser. Scope is bounded by the
user's menus, views, and ACL — nothing more. Tool verbs express functional intent (publish, confirm)
rather than raw ORM operations. Discovery is lazy: the agent resolves only what the current prompt
requires.

### Layered Tool Surface

| Layer | Role | When invoked |
|---|---|---|
| **0 — Guidance** | Canonical recipes (skills, workflows) the agent consults before any multi-step operation. Pure documentation, no side effects. | Before planning |
| **1 — Discovery** | Establishes the bounded universe of models and reachable relations for the current user. | At intent resolution |
| **2 — Planning Bridge** | Answers "what is live on this specific record right now" — record-state-aware actions. | Once a record is identified |
| **3 — Supporting** | Read-only data fetchers used silently to fill gaps in the agent's plan. | Throughout planning |
| **4 — Intent** | Mutating actions that fulfill the user's request — bounded by the user's UI permissions. | Final execution |

### Planning Loop

```
User prompt
  ├── Discovery       — what models/relations does this user have?
  ├── (optional)      — locate the specific record
  ├── Planning Bridge — what is live on that record right now?
  ├── Guidance        — consult skills/workflows for multi-step recipes
  └── Intent          — execute the mutation(s)
```

Skills and workflows are authored in `skills/` and `workflows/` as markdown with YAML
frontmatter; they are exposed as Layer 0 tools at runtime.
