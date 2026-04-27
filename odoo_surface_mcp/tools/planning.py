"""Layer 2 — Planning Bridge: get_available_actions.

Evaluates which buttons and actions are actually visible for a specific record
right now, by mirroring the logic Odoo's JS client uses when rendering a form view.

Reference: odoo/tools/view_validation.py  (get_expression_field_names)
           odoo/tests/form.py             (_get_modifier, _get_eval_context)
"""
import ast
from datetime import date
from typing import Optional

from mcp.server.fastmcp import FastMCP

from odoo_surface_mcp.cache import Cache
from odoo_surface_mcp.odoo_client import OdooClient

# Names that appear in invisible expressions but are NOT record fields.
# Mirrors odoo/tools/view_validation.py :: IGNORED_IN_EXPRESSION
_IGNORED = {
    'True', 'False', 'None', 'self', 'uid', 'context', 'context_today',
    'allowed_company_ids', 'current_company_id', 'time', 'datetime',
    'relativedelta', 'current_date', 'today', 'now',
    'abs', 'len', 'bool', 'float', 'str', 'unicode', 'set',
    'id',   # always injected into eval_ctx directly; not fetched via read()
}

# Aliases used in view XML: invisible="1" means invisible="True"
_ALIASES = {'1': 'True', '0': 'False'}


def register(mcp: FastMCP, client: OdooClient, cache: Cache) -> None:

    @mcp.tool(description=(
        "Return the buttons and actions that are actually visible for a specific record "
        "right now, based on its current field values. "
        "Mirrors what the Odoo web client shows when a user opens the form view. "
        "invisible expressions are evaluated deterministically via AST field extraction "
        "and a targeted read of only the fields each expression references. "
        "Returns {visible_buttons[], server_actions[], reports[], can_create, can_write, can_delete}."
    ))
    def get_available_actions(
        model: str,
        record_id: int,
        action_id: Optional[int] = None,
    ) -> dict:
        try:
            from odoo_surface_mcp.tools.discovery import _collect_model_actions
            action_map = _collect_model_actions(client, model)

            buttons = action_map.get("view_buttons", [])

            # --- Step 1: collect all field names needed across all invisible exprs ---
            needed_fields: set[str] = set()
            parsed: list[tuple[dict, str | None]] = []  # (button, normalised_expr)

            for btn in buttons:
                raw = btn.get("invisible")
                expr = _ALIASES.get(raw, raw) if raw else None
                parsed.append((btn, expr))
                if expr and expr not in ('True', 'False'):
                    needed_fields |= _field_names_from_expr(expr)

            # --- Step 2: one targeted read — only the fields that are referenced ---
            eval_ctx: dict = {
                'id': record_id,
                'uid': client.uid,
                'current_date': date.today().strftime('%Y-%m-%d'),
                'context': {},
            }

            if needed_fields:
                # Drop any names that don't exist on this model.
                # Invisible expressions sometimes reference computed fields
                # from related models or fields that were renamed/removed.
                try:
                    needed_fields = {f for f in needed_fields if f in client.valid_field_names(model)}
                except Exception:
                    pass  # keep as-is; _is_invisible will catch NameErrors

                rows = client.execute(
                    model, "read", [record_id],
                    fields=list(needed_fields),
                ) if needed_fields else [{"id": record_id}]
                if not rows:
                    return {"error": f"Record {model}:{record_id} not found or not accessible."}
                eval_ctx.update(_normalise_record(rows[0]))

            # --- Step 3: evaluate each invisible expression + groups check ---
            # Deduplicate by name — the same button can appear in multiple
            # places in the form XML (header + inline section).
            user_groups = client.user_group_xmlids()
            seen_btn: set[str] = set()
            visible_buttons = []
            for btn, expr in parsed:
                if _is_invisible(expr, eval_ctx):
                    continue
                if not _user_in_groups(btn.get("groups"), user_groups):
                    continue
                btn_name = btn.get("name")
                if btn_name in seen_btn:
                    continue
                seen_btn.add(btn_name)
                visible_buttons.append({
                    "name": btn_name,
                    "label": btn.get("label"),
                    "type": btn.get("type"),
                })

            # --- Step 4: server actions — filter to form context ---
            visible_server_actions = [
                sa for sa in action_map.get("server_actions", [])
                if "form" in (sa.get("view_types") or "")
            ]

            # --- Step 5: reports — filter to form context ---
            visible_reports = [
                r for r in action_map.get("reports", [])
                if "form" in (r.get("view_types") or "")
            ]

            return {
                "record_id": record_id,
                "can_create": action_map.get("can_create"),
                "can_write": action_map.get("can_write"),
                "can_delete": action_map.get("can_delete"),
                "visible_buttons": visible_buttons,
                "server_actions": visible_server_actions,
                "reports": visible_reports,
                "eval_fields_read": sorted(needed_fields),  # transparency: what was fetched
            }

        except Exception as exc:
            return {"error": str(exc)}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _field_names_from_expr(expr: str) -> set[str]:
    """Parse an invisible expression and return the record field names it references.

    Uses the same AST-based approach as Odoo's get_expression_field_names.
    Only ast.Name nodes that are not in _IGNORED are considered field names.
    Attribute access (parent.field) is ignored — we only handle flat record fields.
    """
    try:
        tree = ast.parse(expr.strip(), mode='eval')
        names: set[str] = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Name) and node.id not in _IGNORED:
                names.add(node.id)
        return names
    except SyntaxError:
        return set()


def _normalise_record(record: dict) -> dict:
    """Coerce record values so invisible expressions evaluate correctly.

    Many2one fields come back as [id, display_name] or False (both XML-RPC
    and JSON-RPC use this format).  Expressions reference them by field name
    and compare to an id or False.  We coerce [id, name] → id.
    """
    out: dict = {}
    for k, v in record.items():
        if isinstance(v, list) and len(v) == 2 and isinstance(v[0], int):
            out[k] = v[0]   # many2one → id
        else:
            out[k] = v
    return out


def _is_invisible(expr: str | None, ctx: dict) -> bool:
    """Evaluate an invisible expression. Returns True if the element should be hidden."""
    if expr is None or expr == 'False':
        return False
    if expr == 'True':
        return True
    try:
        return bool(eval(expr, {"__builtins__": {}}, ctx))  # noqa: S307
    except Exception:
        # If we can't evaluate (e.g. references a field not on the record),
        # err on the side of showing the button.
        return False


def _user_in_groups(groups_attr: str | None, user_groups: frozenset[str]) -> bool:
    """Return True if the button should be visible given the user's group membership.

    The `groups` attribute is a comma-separated list of XML IDs, e.g.:
        "account.group_account_manager,base.group_system"

    A button with no `groups` attribute is always visible (returns True).
    A button with `groups` is visible only if the user belongs to at least one
    of the listed groups — same logic as Odoo's JS client.

    If the user_groups set is empty (e.g. the fetch failed), we err on the side
    of showing the button so we don't hide legitimate buttons.
    """
    if not groups_attr:
        return True
    if not user_groups:
        # Could not determine group membership — show the button conservatively.
        return True
    required = {g.strip() for g in groups_attr.split(",") if g.strip()}
    return bool(required & user_groups)
