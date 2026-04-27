"""OdooSurface MCP server factory."""
from contextlib import asynccontextmanager

from mcp.server.fastmcp import FastMCP

from odoo_surface_mcp.cache import Cache
from odoo_surface_mcp.odoo_client import OdooClient
from odoo_surface_mcp.tools import discovery
from odoo_surface_mcp.tools import planning
from odoo_surface_mcp.tools import supporting
from odoo_surface_mcp.tools import intent
from odoo_surface_mcp.tools import debug as debug_tools


def create_server(debug: bool = False) -> FastMCP:
    client = OdooClient.from_env()
    cache = Cache(default_ttl=300)  # 5-minute TTL; clear_cache() resets on demand

    @asynccontextmanager
    async def lifespan(_server: FastMCP):
        # startup: OdooClient authenticates lazily on first call — nothing to do here
        yield
        # shutdown: close the HTTP session cleanly (normal exit, SIGINT, or SIGHUP)
        client.close()

    mcp = FastMCP(
        "odoo-surface",
        instructions=(
            "OdooSurface MCP gives you user-equivalent access to Odoo. "
            "You may only do what the authenticated user can do in their browser. "
            "Start with get_models() to discover available models, then "
            "get_model_actions(model) to see what actions exist, then execute."
        ),
        lifespan=lifespan,
    )

    # Layer 1 — Discovery
    discovery.register(mcp, client, cache)

    # Layer 2 — Planning Bridge
    planning.register(mcp, client, cache)

    # Layer 3 — Supporting
    supporting.register(mcp, client, cache)

    # Layer 4 — Primary Intent
    intent.register(mcp, client, cache)

    if debug:
        debug_tools.register(mcp, client, cache)

    return mcp
