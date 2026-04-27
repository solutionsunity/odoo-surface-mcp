"""Layer 1 — Discovery tools: get_models, get_model_actions."""
import xml.etree.ElementTree as ET
from typing import Optional

from mcp.server.fastmcp import FastMCP

from odoo_surface_mcp.cache import Cache
from odoo_surface_mcp.odoo_client import OdooClient

_BUTTON_TYPES = {"object", "action"}
_RELATIONAL_TYPES = {"many2one", "many2many", "one2many"}


def register(mcp: FastMCP, client: OdooClient, cache: Cache) -> None:

    @mcp.tool(description=(
        "List primary models the user can navigate to via menus "
        "(get_models()), or list relational models reachable from a base "
        "model via its form-view fields (get_models(base='sale.order'))."
    ))
    def get_models(base: Optional[str] = None) -> list[dict]:
        if base:
            return _related_models(client, cache, base)
        return _primary_models(client, cache)

    @mcp.tool(description=(
        "Return all actions available on a model: server actions (Action menu), "
        "report actions (Print menu), and form-view buttons (type=object/action). "
        "Also returns CRUD access flags for the current user."
    ))
    def get_model_actions(model: str, action_id: Optional[int] = None) -> dict:
        cache_key = f"model_actions:{model}:{action_id}"
        cached = cache.get(cache_key)
        if cached:
            return cached

        result = _collect_model_actions(client, model)
        cache.set(cache_key, result)
        return result


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------

def _primary_models(client: OdooClient, cache: Cache) -> list[dict]:
    cached = cache.get("primary_models")
    if cached:
        return cached

    menus = client.execute(
        "ir.ui.menu", "search_read",
        [["action", "like", "ir.actions.act_window,"]],
        fields=["name", "complete_name", "action"],
    )

    act_ids = []
    menu_by_act: dict[int, dict] = {}
    for m in menus:
        action_ref = m.get("action") or ""
        if "," not in action_ref:
            continue
        act_id = int(action_ref.split(",", 1)[1])
        act_ids.append(act_id)
        menu_by_act.setdefault(act_id, m)  # keep first menu per action

    if not act_ids:
        return []

    actions = client.execute(
        "ir.actions.act_window", "search_read",
        [["id", "in", act_ids], ["res_model", "!=", False]],
        fields=["id", "name", "res_model", "view_mode"],
    )

    seen_models: set[str] = set()
    result = []
    for act in actions:
        model = act["res_model"]
        if model in seen_models:
            continue
        seen_models.add(model)
        menu = menu_by_act.get(act["id"], {})
        result.append({
            "model": model,
            "name": menu.get("name") or act["name"],
            "menu_path": menu.get("complete_name") or menu.get("name") or act["name"],
            "action_id": act["id"],
            "view_modes": act["view_mode"],
        })

    result.sort(key=lambda r: r["model"])
    cache.set("primary_models", result)
    return result


def _related_models(client: OdooClient, cache: Cache, base: str) -> list[dict]:
    cache_key = f"related_models:{base}"
    cached = cache.get(cache_key)
    if cached:
        return cached

    fields_meta = client.get_form_fields(base)
    result = []
    for fname, fmeta in fields_meta.items():
        if fmeta.get("type") not in _RELATIONAL_TYPES:
            continue
        relation = fmeta.get("relation")
        if not relation:
            continue
        result.append({
            "model": relation,
            "field": fname,
            "field_type": fmeta["type"],
            "label": fmeta.get("string", fname),
        })

    result.sort(key=lambda r: r["field"])
    cache.set(cache_key, result)
    return result


def _collect_model_actions(client: OdooClient, model: str) -> dict:
    """Collect all action sources for a model — mirrors the four places Odoo exposes actions.

    Odoo surfaces functional intents through four distinct mechanisms, each stored differently:

    1. Server actions (Action ▾ menu)
       Stored in ir.actions.server with binding_model_id and binding_type='action'.
       binding_view_types controls where they appear: 'form', 'list', or 'list,form'.

    2. Report actions (Print ▾ menu)
       Stored in ir.actions.report with binding_model_id.
       Same binding_view_types pattern as server actions.

    3. View buttons type="object" — the richest source of functional intents.
       NOT stored in ir.actions — they live in ir.ui.view.arch_db as XML attributes.
       They call Python methods directly (confirm, validate, cancel, publish, lock, ...).
       Visibility is controlled by the `invisible` attribute evaluated against the record.
       get_available_actions (Layer 2) evaluates these per-record using AST parsing.

    4. View buttons type="action" — less common.
       Also in arch_db. The button name is a numeric ir.actions.* id; calling it opens
       a related form or wizard rather than running a method directly.
    """
    # --- CRUD access ---
    access = {
        "can_create": client.check_access(model, "create"),
        "can_write":  client.check_access(model, "write"),
        "can_delete": client.check_access(model, "unlink"),
    }

    # --- ir.model id ---
    model_id = client.get_model_id(model)
    if not model_id:
        return {**access, "error": f"Model '{model}' not found in ir.model"}

    # --- Source 1: Server actions (Action ▾ menu) ---
    server_actions = client.execute(
        "ir.actions.server", "search_read",
        [["binding_model_id", "=", model_id], ["binding_type", "=", "action"]],
        fields=["id", "name", "binding_view_types", "state"],
    )

    # --- Source 2: Report actions (Print ▾ menu) ---
    reports = client.execute(
        "ir.actions.report", "search_read",
        [["binding_model_id", "=", model_id]],
        fields=["id", "name", "binding_view_types", "report_type"],
    )

    # --- Sources 3 & 4: View buttons (type=object / type=action) from form arch ---
    view_buttons = []
    try:
        arch = client.get_form_arch(model)
        root = ET.fromstring(arch)
        for btn in root.iter("button"):
            btn_type = btn.get("type", "")
            if btn_type not in _BUTTON_TYPES:
                continue
            view_buttons.append({
                "name": btn.get("name"),
                "label": btn.get("string") or btn.get("name"),
                "type": btn_type,
                "invisible": btn.get("invisible"),
                "groups": btn.get("groups"),
            })
    except Exception as exc:
        view_buttons = [{"error": str(exc)}]

    return {
        **access,
        "server_actions": [
            {"id": a["id"], "name": a["name"], "view_types": a["binding_view_types"]}
            for a in server_actions
        ],
        "reports": [
            {"id": r["id"], "name": r["name"], "view_types": r["binding_view_types"],
             "report_type": r["report_type"]}
            for r in reports
        ],
        "view_buttons": view_buttons,
    }
