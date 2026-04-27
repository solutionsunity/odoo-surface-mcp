"""OdooSurface MCP — entry point.

Usage:
    python main.py                  # production mode
    python main.py --debug          # adds debug/inspection tools

Signal handling:
    SIGINT  — handled by asyncio (KeyboardInterrupt); lifespan teardown runs.
    SIGTERM — converted to SIGINT so asyncio teardown also runs cleanly.
    SIGHUP  — not relevant for stdio; ignored by default.

Stdout discipline:
    In stdio transport mode stdout IS the JSON-RPC channel.
    All diagnostic output MUST go to sys.stderr — never print() to stdout.
"""
import argparse
import os
import signal
import sys

from dotenv import load_dotenv

# env vars set by the MCP client take priority; .env is a local-dev fallback only
load_dotenv()

from odoo_surface_mcp.server import create_server  # noqa: E402 (import after dotenv)


def _sigterm_handler(sig, frame) -> None:  # noqa: ANN001
    """Convert SIGTERM → SIGINT so asyncio runs lifespan teardown before exit."""
    signal.raise_signal(signal.SIGINT)


def main() -> None:
    # Register SIGTERM handler before the event loop starts so process managers
    # (systemd, Docker) get a clean shutdown with lifespan teardown.
    signal.signal(signal.SIGTERM, _sigterm_handler)

    parser = argparse.ArgumentParser(
        description="OdooSurface MCP Server — user-equivalent Odoo access for AI agents."
    )
    parser.add_argument(
        "--debug",
        action="store_true",
        help="Register debug/inspection tools (inspect_view, query_db, restart_mcp, …)",
    )
    parser.add_argument(
        "--transport",
        choices=["stdio", "streamable-http"],
        default="stdio",
        help="MCP transport (default: stdio for Claude Desktop / local clients)",
    )
    args = parser.parse_args()

    if args.debug:
        # IMPORTANT: stderr only — stdout is the JSON-RPC channel in stdio transport
        print("[odoo-surface] debug mode ON — extra tools registered", file=sys.stderr, flush=True)

    server = create_server(debug=args.debug)
    server.run(transport=args.transport)


if __name__ == "__main__":
    main()
