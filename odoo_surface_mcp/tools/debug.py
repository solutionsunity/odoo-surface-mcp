"""Debug tools — only registered when server is started with --debug."""
import os
import sys
import xml.etree.ElementTree as ET
from typing import Optional

from mcp.server.fastmcp import FastMCP

from odoo_surface_mcp.cache import Cache
from odoo_surface_mcp.odoo_client import OdooClient


def register(mcp: FastMCP, client: OdooClient, cache: Cache) -> None:

    # ------------------------------------------------------------------
    # Health
    # ------------------------------------------------------------------

    @mcp.tool(description="[DEBUG] Check MCP↔Odoo connectivity. Returns version and latency.")
    def ping() -> dict:
        return client.ping()

    @mcp.tool(description="[DEBUG] Reflect payload back. Tests MCP tool-call roundtrip.")
    def echo(payload: str) -> dict:
        return {"echo": payload}

    # ------------------------------------------------------------------
    # Inspection
    # ------------------------------------------------------------------

    @mcp.tool(description=(
        "[DEBUG] Return the compiled arch XML for a model's view. "
        "view_type: form (default), list, kanban, search."
    ))
    def inspect_view(model: str, view_type: str = "form") -> dict:
        try:
            result = client.execute(model, "get_views", [[False, view_type]])
            arch = result["views"][view_type]["arch"]
            # Pretty-print for readability
            root = ET.fromstring(arch)
            pretty = ET.tostring(root, encoding="unicode")
            return {"model": model, "view_type": view_type, "arch": pretty}
        except Exception as exc:
            return {"error": str(exc)}

    @mcp.tool(description=(
        "[DEBUG] Dump all action sources for a model: "
        "server actions, reports, view buttons (type=object), view buttons (type=action)."
    ))
    def inspect_action(model: str) -> dict:
        try:
            model_id = client.get_model_id(model)
            if not model_id:
                return {"error": f"Model '{model}' not found"}

            server_actions = client.execute(
                "ir.actions.server", "search_read",
                [["binding_model_id", "=", model_id]],
                fields=["id", "name", "binding_type", "binding_view_types", "state"],
            )
            reports = client.execute(
                "ir.actions.report", "search_read",
                [["binding_model_id", "=", model_id]],
                fields=["id", "name", "binding_view_types", "report_type", "report_name"],
            )

            view_buttons = {"object": [], "action": []}
            try:
                arch = client.get_form_arch(model)
                root = ET.fromstring(arch)
                for btn in root.iter("button"):
                    btn_type = btn.get("type", "")
                    if btn_type in view_buttons:
                        view_buttons[btn_type].append(dict(btn.attrib))
            except Exception as exc:
                view_buttons["parse_error"] = str(exc)

            return {
                "model": model,
                "server_actions": server_actions,
                "reports": reports,
                "view_buttons": view_buttons,
            }
        except Exception as exc:
            return {"error": str(exc)}

    @mcp.tool(description=(
        "[DEBUG] Return all fields on a model — including technical fields "
        "not filtered by view visibility."
    ))
    def inspect_fields(model: str) -> dict:
        try:
            fields = client.execute(
                model, "fields_get",
                attributes=["string", "type", "relation", "required", "readonly", "store"],
            )
            return {"model": model, "field_count": len(fields), "fields": fields}
        except Exception as exc:
            return {"error": str(exc)}

    # ------------------------------------------------------------------
    # Raw DB query (SELECT only)
    # ------------------------------------------------------------------

    @mcp.tool(description=(
        "[DEBUG] Run a read-only SQL query against the Odoo DB via RPC. "
        "Only SELECT statements are allowed. Works with any remote Odoo instance."
    ))
    def query_db(sql: str) -> dict:
        import re as _re

        # Strip single-line (--) and block (/* */) comments, then normalise whitespace
        cleaned = _re.sub(r"--[^\n]*", " ", sql)
        cleaned = _re.sub(r"/\*.*?\*/", " ", cleaned, flags=_re.DOTALL)
        cleaned = cleaned.strip()

        without_trailing = cleaned.rstrip(";").strip()
        if ";" in without_trailing:
            return {"error": "Only a single SELECT statement is allowed. No semicolons permitted."}

        if not without_trailing.upper().startswith("SELECT"):
            return {"error": "Only SELECT queries are allowed."}

        # Raw psql is intentionally removed — it only works on localhost.
        # The proper alternative for remote DB inspection is to use the
        # search_records / list_records MCP tools instead.
        return {
            "error": (
                "query_db is not available for remote Odoo instances. "
                "Raw SQL requires direct PostgreSQL access which is not possible via JSON-RPC. "
                "Use list_records / search_records tools instead, "
                "or connect directly to the remote DB using an external SQL client."
            )
        }

    # ------------------------------------------------------------------
    # Cache
    # ------------------------------------------------------------------

    @mcp.tool(description="[DEBUG] Show cache stats and all live keys.")
    def dump_cache() -> dict:
        return {"stats": cache.stats(), "entries": cache.dump()}

    @mcp.tool(description="[DEBUG] Clear all cache entries. Next call rebuilds from Odoo.")
    def clear_cache() -> dict:
        count = cache.clear()
        return {"cleared": count, "message": "Cache cleared."}

    # ------------------------------------------------------------------
    # Process
    # ------------------------------------------------------------------

    @mcp.tool(description=(
        "[DEBUG] Restart the MCP server process in-place. "
        "The client will reconnect automatically. --debug flag is preserved."
    ))
    def restart_mcp() -> dict:
        # Return before replacing — best-effort; client handles reconnect
        os.execv(sys.executable, [sys.executable] + sys.argv)
        return {"status": "restarting"}  # unreachable, but satisfies return type
