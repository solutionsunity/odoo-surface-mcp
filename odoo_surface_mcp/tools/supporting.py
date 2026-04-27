"""Layer 3 — Supporting tools: list_records, get_record, search_records,
get_fields, get_defaults, get_filters."""
import ast
import xml.etree.ElementTree as ET
from typing import Any, Optional

from mcp.server.fastmcp import FastMCP

from odoo_surface_mcp.cache import Cache
from odoo_surface_mcp.odoo_client import OdooClient


def register(mcp: FastMCP, client: OdooClient, cache: Cache) -> None:

    @mcp.tool(description=(
        "Return a paginated list of records visible in the list view for a model. "
        "Pass action_id to scope results to the action's domain (e.g. only draft orders). "
        "Returns {total, offset, limit, records[]} with the columns from the list view."
    ))
    def list_records(
        model: str,
        action_id: Optional[int] = None,
        limit: int = 40,
        offset: int = 0,
        order: Optional[str] = None,
    ) -> dict:
        try:
            domain, context = _action_domain_context(client, cache, action_id)
            fields = _view_field_names(client, cache, model, "list")
            if not fields:
                fields = ["display_name"]
            kwargs: dict[str, Any] = {
                "fields": fields, "limit": limit, "offset": offset,
            }
            if order:
                kwargs["order"] = order
            if context:
                kwargs["context"] = context
            # search_read is used intentionally over web_search_read:
            # web_search_read's specification-dict API is Odoo 17+ only;
            # search_read exists unchanged since Odoo 8.
            records = client.execute(model, "search_read", domain, **kwargs)
            total = client.execute(model, "search_count", domain)
            return {"total": total, "offset": offset, "limit": limit, "records": records}
        except Exception as exc:
            return {"error": str(exc)}

    @mcp.tool(description=(
        "Return all form-view field values for a single record. "
        "Only fields the user can see in the form view are returned."
    ))
    def get_record(model: str, record_id: int) -> dict:
        try:
            fields = _view_field_names(client, cache, model, "form")
            if not fields:
                fields = ["display_name"]
            # read is used intentionally over web_read:
            # web_read (specification-dict API) is Odoo 17+ only;
            # read exists unchanged since Odoo 8.
            rows = client.execute(model, "read", [record_id], fields=fields)
            if not rows:
                return {"error": f"Record {model}:{record_id} not found or not accessible."}
            return rows[0]
        except Exception as exc:
            return {"error": str(exc)}

    @mcp.tool(description=(
        "Search for records by name or domain. "
        "query: free-text name search (optional). "
        "domain: Odoo domain e.g. [[\"state\",\"=\",\"draft\"]] (optional). "
        "action_id: scope search to the action's domain. "
        "Returns [{id, display_name}] up to limit."
    ))
    def search_records(
        model: str,
        query: Optional[str] = None,
        domain: Optional[list] = None,
        action_id: Optional[int] = None,
        limit: int = 20,
    ) -> list[dict]:
        try:
            action_domain, context = _action_domain_context(client, cache, action_id)
            combined = list(action_domain) + list(domain or [])
            if query:
                results = client.execute(
                    model, "name_search", query,
                    args=combined, limit=limit,
                )
                return [{"id": r[0], "display_name": r[1]} for r in results]
            else:
                return client.execute(
                    model, "search_read", combined,
                    fields=["id", "display_name"], limit=limit,
                )
        except Exception as exc:
            return [{"error": str(exc)}]

    @mcp.tool(description=(
        "Return metadata for all fields visible in a model's form or list view. "
        "view_type: 'form' (default) or 'list'. "
        "Returns [{name, string, type, required, readonly, relation?, selection?}]."
    ))
    def get_fields(model: str, view_type: str = "form") -> list[dict]:
        cache_key = f"get_fields:{model}:{view_type}"
        cached = cache.get(cache_key)
        if cached is not None:
            return cached
        try:
            names = _view_field_names(client, cache, model, view_type)
            if not names:
                return []
            meta = client.execute(
                model, "fields_get",
                attributes=["string", "type", "required", "readonly", "relation", "selection"],
            )
            result = []
            for name in names:
                f = meta.get(name)
                if not f:
                    continue
                entry: dict[str, Any] = {
                    "name": name,
                    "string": f.get("string", name),
                    "type": f.get("type"),
                    "required": f.get("required", False),
                    "readonly": f.get("readonly", False),
                }
                if f.get("relation"):
                    entry["relation"] = f["relation"]
                if f.get("selection"):
                    entry["selection"] = f["selection"]
                result.append(entry)
            cache.set(cache_key, result)
            return result
        except Exception as exc:
            return [{"error": str(exc)}]

    @mcp.tool(description=(
        "Return the default field values Odoo would pre-fill when clicking New. "
        "Pass action_id to include the action's context (e.g. default_partner_id). "
        "Pass context dict directly for wizard models whose context comes from an "
        "execute_action response (e.g. active_model, active_ids for payment wizards)."
    ))
    def get_defaults(
        model: str,
        action_id: Optional[int] = None,
        context: Optional[dict] = None,
    ) -> dict:
        try:
            merged = _resolve_context(client, cache, action_id, context)
            fields = _view_field_names(client, cache, model, "form")
            if not fields:
                # Transient/wizard models often have no cached view — fall back to fields_get
                meta = client.execute(model, "fields_get", attributes=["string"])
                fields = list(meta.keys())
            return client.execute(model, "default_get", fields, context=merged)
        except Exception as exc:
            return {"error": str(exc)}

    @mcp.tool(description=(
        "Return saved filters and favourites available for a model's list view. "
        "These appear in the Filters and Favourites dropdown in the Odoo UI."
    ))
    def get_filters(model: str, action_id: Optional[int] = None) -> list[dict]:
        try:
            domain: list = [["model_id", "=", model]]
            if action_id:
                domain.append(["action_id", "in", [action_id, False]])
            return client.execute(
                "ir.filters", "search_read", domain,
                fields=["id", "name", "domain", "context", "sort", "is_default", "action_id"],
            )
        except Exception as exc:
            return [{"error": str(exc)}]

    @mcp.tool(description=(
        "List available website building-block snippets. "
        "Snippets are reusable HTML sections that the Odoo website editor recognises as "
        "draggable, configurable blocks — using them preserves all editor controls. "
        "Works with any Odoo version and any installed module (including custom ones): "
        "all snippet views in the live database are discovered dynamically. "
        "Optional 'search' filters by any substring of the key or name (case-insensitive). "
        "Response includes 'available_modules' listing every module that has snippets. "
        "Returns {available_modules: [], snippets: [{key, name, module}]}. "
        "Use get_snippet(key) to fetch the ready-to-inject HTML for a specific snippet."
    ))
    def list_snippets(search: Optional[str] = None) -> dict:
        try:
            domain: list = [["type", "=", "qweb"], ["key", "like", ".s_"]]
            rows = client.execute(
                "ir.ui.view", "search_read",
                domain,
                fields=["key", "name"],
                order="key asc",
            )
            snippets = []
            modules: set[str] = set()
            needle = search.lower() if search else None
            for r in rows:
                key = r.get("key", "")
                name = r.get("name", "")
                # The domain uses SQL LIKE where _ is a wildcard, so enforce
                # the literal ".s_" substring here to exclude false positives
                # like portal.signup, website.sitemap_xml, etc.
                if ".s_" not in key:
                    continue
                # Skip editor option panels and image placeholder assets
                if "_options" in key or "_default_image" in key:
                    continue
                parts = key.split(".", 1)
                mod = parts[0] if len(parts) == 2 else ""
                modules.add(mod)
                if needle and needle not in key.lower() and needle not in name.lower():
                    continue
                snippets.append({"key": key, "name": name, "module": mod})
            return {"available_modules": sorted(modules), "snippets": snippets}
        except Exception as exc:
            return {"error": str(exc)}

    @mcp.tool(description=(
        "Fetch the ready-to-inject HTML for a website building-block snippet. "
        "Pass the snippet key (e.g. 'website.s_text_image'). "
        "The returned html is the bare <section>...</section> element with the correct "
        "data-snippet and CSS classes — paste it directly into blog.post content or "
        "ir.ui.view arch so the Odoo editor can still configure the block. "
        "Returns {key, name, html} or {error}. Snippets with live QWeb directives "
        "(t-foreach / t-if) also include a 'warning' key."
    ))
    def get_snippet(key: str) -> dict:
        try:
            rows = client.execute(
                "ir.ui.view", "search_read",
                [["key", "=", key], ["type", "=", "qweb"]],
                fields=["key", "name", "arch"],
            )
            if not rows:
                return {"error": f"Snippet '{key}' not found."}
            row = rows[0]
            html, has_dynamic = _strip_qweb_wrapper(row.get("arch", ""))
            result: dict = {"key": row["key"], "name": row.get("name", ""), "html": html}
            if has_dynamic:
                result["warning"] = (
                    "This snippet contains QWeb directives (t-if / t-foreach). "
                    "The HTML may not render correctly as static injected content."
                )
            return result
        except Exception as exc:
            return {"error": str(exc)}


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

def _resolve_context(
    client: OdooClient,
    cache: Cache,
    action_id: Optional[int],
    context: Optional[dict],
) -> dict:
    """Return a merged context dict from an optional action_id and/or a raw context.

    Callers that receive a context dict from an execute_action response (e.g.
    wizard flows) pass it via `context`.  Callers that open a standard list-view
    action pass its id via `action_id`.  Both can be combined; `context` wins
    on key conflicts so the caller's explicit values always take precedence.
    """
    _, action_ctx = _action_domain_context(client, cache, action_id)
    return {**action_ctx, **(context or {})}


def _action_domain_context(
    client: OdooClient, cache: Cache, action_id: Optional[int],
) -> tuple[list, dict]:
    """Return (domain, context) for an act_window action. Empty if action_id is None."""
    if not action_id:
        return [], {}
    cache_key = f"action_info:{action_id}"
    cached = cache.get(cache_key)
    if cached:
        return cached["domain"], cached["context"]
    try:
        rows = client.execute(
            "ir.actions.act_window", "read",
            [action_id], fields=["domain", "context"],
        )
        if not rows:
            return [], {}
        act = rows[0]
        domain = _safe_eval_list(act.get("domain") or "[]")
        context = _safe_eval_dict(act.get("context") or "{}")
        cache.set(cache_key, {"domain": domain, "context": context})
        return domain, context
    except Exception:
        return [], {}


def _safe_eval_list(raw: Any) -> list:
    if isinstance(raw, list):
        return raw
    try:
        val = ast.literal_eval(str(raw))
        return val if isinstance(val, list) else []
    except Exception:
        return []


def _safe_eval_dict(raw: Any) -> dict:
    if isinstance(raw, dict):
        return raw
    try:
        val = ast.literal_eval(str(raw))
        return val if isinstance(val, dict) else {}
    except Exception:
        return {}


def _view_field_names(
    client: OdooClient, cache: Cache, model: str, view_type: str,
) -> list[str]:
    """Parse view arch and return unique field names in declaration order."""
    cache_key = f"view_fields:{model}:{view_type}"
    cached = cache.get(cache_key)
    if cached is not None:
        return cached

    odoo_type = "tree" if view_type == "list" else view_type
    arch = ""
    try:
        result = client.execute(model, "get_views", [[False, odoo_type]])
        arch = result.get("views", {}).get(odoo_type, {}).get("arch", "")
    except Exception:
        pass

    try:
        root = ET.fromstring(arch) if arch else None
        if root is None:
            cache.set(cache_key, [])
            return []
        seen: set[str] = set()
        names: list[str] = []
        for el in root.iter("field"):
            name = el.get("name")
            if name and name not in seen:
                seen.add(name)
                names.append(name)

        # Filter out fields from nested subviews (e.g. o2m inline trees)
        # that do not actually exist on the parent model.
        try:
            names = [n for n in names if n in client.valid_field_names(model)]
        except Exception:
            pass  # keep names as-is if valid_field_names fails

        cache.set(cache_key, names)
        return names
    except Exception:
        cache.set(cache_key, [])
        return []


_QWEB_DYNAMIC_ATTRS = frozenset({
    "t-foreach", "t-if", "t-else", "t-elif",
    "t-call", "t-set", "t-out", "t-esc",
})


def _strip_qweb_wrapper(arch: str) -> tuple[str, bool]:
    """Strip the QWeb ``<t t-name="...">`` wrapper from a snippet arch.

    Returns ``(inner_html, has_dynamic)`` where ``inner_html`` is the bare
    section element(s) ready to inject into a content field, and
    ``has_dynamic`` is True when QWeb directives that require server-side
    rendering were detected (the content will still be returned but a warning
    should accompany it).
    """
    try:
        root = ET.fromstring(arch)
    except ET.ParseError:
        return arch, False

    has_dynamic = any(
        attr in _QWEB_DYNAMIC_ATTRS
        for node in root.iter()
        for attr in node.attrib
    )

    if root.tag == "t":
        # Collect the serialised children (the real <section> elements)
        parts: list[str] = []
        if root.text and root.text.strip():
            parts.append(root.text)
        for child in root:
            parts.append(ET.tostring(child, encoding="unicode"))
            if child.tail and child.tail.strip():
                parts.append(child.tail)
        inner = "".join(parts).strip()
    else:
        inner = ET.tostring(root, encoding="unicode").strip()

    return inner, has_dynamic
