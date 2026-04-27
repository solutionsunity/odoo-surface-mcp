"""Layer 4 — Primary Intent tools: create, update, execute_action, archive,
post_message, schedule_activity."""
from typing import Any, Optional

from mcp.server.fastmcp import FastMCP

from odoo_surface_mcp.cache import Cache
from odoo_surface_mcp.odoo_client import OdooClient
from odoo_surface_mcp.tools.supporting import (
    _action_domain_context,
    _resolve_context,
    _safe_eval_dict,
    _view_field_names,
)


def register(mcp: FastMCP, client: OdooClient, cache: Cache) -> None:

    @mcp.tool(description=(
        "Create a new record. values: dict of field/value pairs (form-view fields only). "
        "Defaults are merged with provided values automatically. "
        "Pass action_id to include the action's context (e.g. default_partner_id). "
        "Pass context dict directly for wizard models whose context comes from an "
        "execute_action response (e.g. active_model, active_ids for payment wizards). "
        "Returns {id, display_name} or {error}."
    ))
    def create(
        model: str,
        values: dict,
        action_id: Optional[int] = None,
        context: Optional[dict] = None,
    ) -> dict:
        try:
            merged_ctx = _resolve_context(client, cache, action_id, context)
            new_id = client.execute(model, "create", values, context=merged_ctx)
            rows = client.execute(model, "read", [new_id], fields=["id", "display_name"])
            return rows[0] if rows else {"id": new_id}
        except Exception as exc:
            return {"error": str(exc)}

    @mcp.tool(description=(
        "Update fields on an existing record. values: {field: value, ...}. "
        "Writes both form-view fields and model fields not exposed in the form view "
        "(e.g. html content fields rendered by the website builder). "
        "Model-level readonly fields are silently skipped; the server enforces access rights. "
        "One2many / many2many fields accept Odoo Command tuples directly: "
        "  [[0,0,{vals}]]  — create and link a new line, "
        "  [[1,id,{vals}]] — update existing line by id, "
        "  [[2,id]]        — delete line by id, "
        "  [[6,0,[ids]]]   — replace the full set. "
        "Returns {success, updated_fields, non_form_fields} or {error}."
    ))
    def update(model: str, record_id: int, values: dict) -> dict:
        try:
            form_fields = _view_field_names(client, cache, model, "form")
            meta = client.execute(model, "fields_get", attributes=["readonly"])
            writable = {
                k: v for k, v in values.items()
                if k in meta and (
                    _is_odoo_command(v)
                    or not meta.get(k, {}).get("readonly", False)
                )
            }
            if not writable:
                return {"error": "No writable fields found in the provided values."}
            client.execute(model, "write", [record_id], writable)
            # Report form vs non-form writes so the caller knows which fields
            # are rendered outside the standard backend form view.
            form_written = [k for k in writable if k in form_fields]
            non_form_written = [k for k in writable if k not in form_fields]
            result: dict = {"success": True, "updated_fields": list(writable.keys())}
            if non_form_written:
                result["non_form_fields"] = non_form_written
            return result
        except Exception as exc:
            return {"error": str(exc)}

    @mcp.tool(description=(
        "Execute a button or server action on a record. "
        "action: button name (method) or label as shown in get_model_actions — "
        "e.g. 'action_confirm', 'Confirm', 'Privacy Lookup'. "
        "View buttons (type=object) call the method directly; server actions use ir.actions.server.run. "
        "Returns the Odoo action result, {success: true}, or {error}."
    ))
    def execute_action(model: str, record_id: int, action: str) -> dict:
        try:
            from odoo_surface_mcp.tools.discovery import _collect_model_actions
            action_map = _collect_model_actions(client, model)

            # 1. View buttons
            for btn in action_map.get("view_buttons", []):
                if btn.get("name") != action and btn.get("label") != action:
                    continue

                if btn.get("type") == "action":
                    # type="action" buttons carry a numeric ir.actions.* id as name.
                    # Load the action definition and inject active-record context —
                    # the agent (or a follow-up create+execute) handles the wizard.
                    action_id = int(btn["name"])
                    meta = client.execute(
                        "ir.actions.actions", "read", [action_id],
                        fields=["type", "name"],
                    )
                    if not meta:
                        return {"error": f"Action id {action_id} not found."}
                    action_type = meta[0].get("type", "ir.actions.act_window")
                    full = client.execute(action_type, "read", [action_id])
                    if not full:
                        return {"error": f"Could not load action {action_id}."}
                    action_def = dict(full[0])
                    ctx = _safe_eval_dict(action_def.get("context") or {})
                    ctx.update(_active_ctx(record_id, model))
                    action_def["context"] = ctx
                    return action_def

                # type="object" — use /web/dataset/call_button (browser equivalent).
                # The endpoint calls clean_action() on action-dict results and returns
                # False for everything else (True / None / non-action return values).
                result = client.http_call("/web/dataset/call_button", {
                    "model": model,
                    "method": btn["name"],
                    "args": [[record_id]],
                    "kwargs": {},
                })

                # False / None → button ran with no redirect; re-read the record.
                if result is False or result is None:
                    return _action_check(client, model, record_id)

                # Returned a clean action dict (e.g. opens a wizard) — pass through.
                return _normalise(result)

            # 2. Server actions — run via ir.actions.server with active context
            for sa in action_map.get("server_actions", []):
                if str(sa.get("id")) == action or sa.get("name") == action:
                    result = client.execute(
                        "ir.actions.server", "run", [sa["id"]],
                        context=_active_ctx(record_id, model),
                    )

                    if result is True or result is False or result is None:
                        return _action_check(client, model, record_id)

                    return _normalise(result)

            return {"error": (
                f"Action '{action}' not found on '{model}'. "
                "Use get_model_actions() to list available actions."
            )}
        except Exception as exc:
            return {"error": str(exc)}

    @mcp.tool(description=(
        "Archive (deactivate) a record by setting active=False. "
        "Only works on models that have an active field (most standard models do). "
        "Returns {success: true} or {error}."
    ))
    def archive(model: str, record_id: int) -> dict:
        try:
            meta = client.execute(model, "fields_get", attributes=["type"])
            if "active" not in meta:
                return {"error": f"Model '{model}' has no active field and cannot be archived."}
            client.execute(model, "write", [record_id], {"active": False})
            return {"success": True, "record_id": record_id, "active": False}
        except Exception as exc:
            return {"error": str(exc)}

    @mcp.tool(description=(
        "Post a message or internal note on a record (requires mail.thread). "
        "message_type: 'comment' (sent to followers, visible in chatter) "
        "or 'note' (internal log note, not emailed). "
        "Returns {message_id} or {error}."
    ))
    def post_message(
        model: str,
        record_id: int,
        body: str,
        message_type: str = "comment",
    ) -> dict:
        try:
            if message_type not in ("comment", "note"):
                return {"error": "message_type must be 'comment' (sent to followers) or 'note' (internal only)."}
            # In Odoo 17, message_post always uses message_type='comment'.
            # The comment vs internal-note distinction is made via subtype_xmlid:
            #   mail.mt_comment → visible message sent to followers
            #   mail.mt_note    → internal log note, not emailed
            msg_id = client.execute(
                model, "message_post", [record_id],
                body=body,
                message_type="comment",
                subtype_xmlid="mail.mt_note" if message_type == "note" else "mail.mt_comment",
            )
            return {"message_id": msg_id}
        except Exception as exc:
            return {"error": str(exc)}

    @mcp.tool(description=(
        "Schedule an activity on a record. "
        "activity_type: name of the activity type (e.g. 'To-Do', 'Email', 'Phone Call'). "
        "deadline: ISO date string YYYY-MM-DD. "
        "summary: short title. note: longer description (optional). "
        "assigned_user_id: who to assign (default: current user). "
        "Returns {activity_id, activity_type, deadline} or {error}."
    ))
    def schedule_activity(
        model: str,
        record_id: int,
        activity_type: str,
        deadline: str,
        summary: str,
        note: Optional[str] = None,
        assigned_user_id: Optional[int] = None,
    ) -> dict:
        try:
            types = client.execute(
                "mail.activity.type", "search_read",
                [["name", "ilike", activity_type]],
                fields=["id", "name"], limit=1,
            )
            if not types:
                return {"error": f"Activity type '{activity_type}' not found."}
            type_id = types[0]["id"]
            model_id = client.get_model_id(model)
            if not model_id:
                return {"error": f"Model '{model}' not found in ir.model."}
            vals: dict[str, Any] = {
                "activity_type_id": type_id,
                "date_deadline": deadline,
                "summary": summary,
                "res_id": record_id,
                "res_model_id": model_id,
            }
            if note:
                vals["note"] = note
            if assigned_user_id:
                vals["user_id"] = assigned_user_id
            activity_id = client.execute("mail.activity", "create", vals)
            return {"activity_id": activity_id, "activity_type": types[0]["name"], "deadline": deadline}
        except Exception as exc:
            return {"error": str(exc)}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _is_odoo_command(value: Any) -> bool:
    """Return True if value is an Odoo Command list ([[int, ...], ...]).

    Odoo Commands are lists whose first element is itself a list/tuple whose
    first element is an integer command code (0–6).  Recognising them lets
    the update tool bypass the static readonly check and pass the value
    straight to write() — the server enforces the real access rules.
    """
    return (
        isinstance(value, list)
        and bool(value)
        and isinstance(value[0], (list, tuple))
        and bool(value[0])
        and isinstance(value[0][0], int)
    )


def _active_ctx(record_id: int, model: str) -> dict:
    """Standard active-record context injected when calling actions on a record."""
    return {
        "active_id": record_id,
        "active_ids": [record_id],
        "active_model": model,
    }


def _normalise(result: Any) -> dict:
    """Normalise Odoo method return values to a consistent dict.

    True / False / None all mean "action completed, stay on current form"
    in Odoo's return convention — no redirect action dict is produced.
    """
    if result is True or result is False or result is None:
        return {"success": True}
    if isinstance(result, dict):
        return result
    if isinstance(result, (int, str)):
        return {"result": result}
    return {"result": str(result)}


def _action_check(client: OdooClient, model: str, record_id: int) -> dict:
    """Re-read the record after a direct action (True/False/None return or None-marshal).

    Returns {success, record_after} so the caller has actual evidence of what
    changed in a single round-trip — the "action, check" pattern.
    Probes a small fixed set of common status fields filtered to those that
    actually exist on the model, so it is safe for both regular and transient
    wizard records.
    """
    _PROBE = ["state", "display_name", "name", "active"]
    try:
        valid = client.valid_field_names(model)
        fields = [f for f in _PROBE if f in valid] or ["display_name"]
        rows = client.execute(model, "read", [record_id], fields=fields)
        if rows:
            return {"success": True, "record_after": rows[0]}
    except Exception:
        pass
    return {"success": True}
