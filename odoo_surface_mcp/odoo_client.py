"""Odoo JSON-RPC client — session-based wrapper around /web/dataset/call_kw."""
import itertools
import os
import time
from typing import Any

import requests


class OdooClient:

    def __init__(self, url: str, db: str, username: str, password: str):
        self.url = url.rstrip("/")
        self.db = db
        self.username = username
        self.password = password
        self._uid: int | None = None
        self._id_iter = itertools.count(1)
        self._session = requests.Session()
        self._session.headers.update({"Content-Type": "application/json"})

    @classmethod
    def from_env(cls) -> "OdooClient":
        # Accept both ODOO_USERNAME and ODOO_USER for backwards compatibility.
        username = (
            os.getenv("ODOO_USERNAME")
            or os.getenv("ODOO_USER")
            or "admin"
        )
        return cls(
            url=os.getenv("ODOO_URL", "http://localhost:8069"),
            db=os.getenv("ODOO_DB", "odoo17"),
            username=username,
            password=os.getenv("ODOO_PASSWORD", "admin"),
        )

    def _rpc(self, route: str, params: dict) -> Any:
        """POST a JSON-RPC 2.0 envelope to *route* and return the result.

        The session cookie is managed automatically by requests.Session, so
        the Odoo server-side session (and request.website on frontend routes)
        persists across calls within the same OdooClient instance.

        Redirects are followed manually with POST preserved on every hop.
        requests' default behaviour downgrades POST→GET on 301/302, which
        drops the JSON body and causes Odoo to return "Access Denied".
        """
        payload = {
            "jsonrpc": "2.0",
            "method": "call",
            "id": next(self._id_iter),
            "params": params,
        }
        url = f"{self.url}{route}"
        for _ in range(5):
            resp = self._session.post(url, json=payload, timeout=30, allow_redirects=False)
            if not resp.is_redirect:
                break
            location = resp.headers.get("Location", "")
            if not location:
                break
            # Absolute redirect → update self.url so future calls skip the hop.
            if location.startswith(("http://", "https://")) and route in location:
                self.url = location[: location.rindex(route)]
            url = location if location.startswith("http") else f"{self.url}{location}"
        resp.raise_for_status()
        data = resp.json()
        if "error" in data:
            err = data["error"]
            msg = (
                err.get("data", {}).get("message")
                or err.get("message")
                or str(err)
            )
            raise Exception(msg)
        return data.get("result")

    @property
    def uid(self) -> int:
        if self._uid is None:
            result = self._rpc("/web/session/authenticate", {
                "db": self.db,
                "login": self.username,
                "password": self.password,
            })
            uid = (result or {}).get("uid")
            if not uid:
                raise ConnectionError(
                    f"Odoo authentication failed: {self.username}@{self.db}"
                )
            self._uid = uid
        return self._uid

    def execute(self, model: str, method: str, *args: Any, **kwargs: Any) -> Any:
        """Call model.method(*args, **kwargs) via /web/dataset/call_kw.

        Re-authenticates once if the server-side session has expired so
        long-running MCP processes survive Odoo's session TTL without a restart.
        """
        _ = self.uid  # ensure session cookie is established
        kw = {"model": model, "method": method, "args": list(args), "kwargs": kwargs}
        try:
            return self._rpc("/web/dataset/call_kw", kw)
        except Exception as exc:
            if _is_session_expired(exc):
                self._uid = None
                _ = self.uid
                return self._rpc("/web/dataset/call_kw", kw)
            raise

    def http_call(self, route: str, params: dict | None = None) -> Any:
        """Call any Odoo JSON route within the established session.

        Covers website-specific routes (e.g. /website/snippet/filters) and
        frontend routes where request.website is bound by the website
        middleware — neither of which are reachable via execute().

        Re-authenticates once on session expiry (same as execute).
        """
        _ = self.uid  # ensure session cookie is established
        p = params or {}
        try:
            return self._rpc(route, p)
        except Exception as exc:
            if _is_session_expired(exc):
                self._uid = None
                _ = self.uid
                return self._rpc(route, p)
            raise

    def ping(self) -> dict:
        """Check connectivity and return version info with latency."""
        t0 = time.time()
        info = self._rpc("/web/webclient/version_info", {})
        rpc_ms = round((time.time() - t0) * 1000, 2)
        t1 = time.time()
        uid = self.uid
        auth_ms = round((time.time() - t1) * 1000, 2)
        return {
            "status": "ok",
            "server_version": (info or {}).get("server_version"),
            "db": self.db,
            "uid": uid,
            "rpc_latency_ms": rpc_ms,
            "auth_latency_ms": auth_ms,
        }

    def get_form_arch(self, model: str) -> str:
        """Return the compiled form view arch XML string for a model."""
        result = self.execute(model, "get_views", [[False, "form"]])
        return result["views"]["form"]["arch"]

    def get_form_fields(self, model: str) -> dict:
        """Return the fields metadata dict for a model.

        Odoo 17 get_views puts field metadata under result["models"][model],
        not inside result["views"]["form"]["fields"]. Fall back to fields_get
        if the structure is unexpected.
        """
        try:
            result = self.execute(model, "get_views", [[False, "form"]])
            # Odoo 17: field metadata is in result["models"][model]
            models_meta = result.get("models", {})
            if model in models_meta:
                return models_meta[model]
            # Older structure fallback
            form_view = result.get("views", {}).get("form", {})
            if "fields" in form_view:
                return form_view["fields"]
        except Exception:
            pass
        # Reliable fallback: fields_get returns all fields with metadata
        return self.execute(
            model, "fields_get",
            attributes=["string", "type", "relation", "required", "readonly"],
        )

    def check_access(self, model: str, operation: str) -> bool:
        """Return True if the current user can perform operation on model."""
        try:
            return bool(
                self.execute(model, "check_access_rights", operation, False)
            )
        except Exception:
            return False

    def valid_field_names(self, model: str) -> set[str]:
        """Return all valid field names on a model.

        Used to filter field lists before read() so we never request fields
        that don't exist on the model (e.g. subview fields collected from
        nested inline trees, or renamed/removed computed fields).
        """
        meta = self.execute(model, "fields_get", attributes=["string"])
        return set(meta.keys())

    def close(self) -> None:
        """Close the underlying HTTP session.  Called by the server lifespan on shutdown."""
        self._session.close()

    def get_model_id(self, model: str) -> int | None:
        """Return the ir.model.id for a model technical name, or None."""
        ids = self.execute("ir.model", "search", [["model", "=", model]])
        return ids[0] if ids else None

    def user_group_xmlids(self) -> frozenset[str]:
        """Return the set of group XML IDs the current user belongs to.

        Group XML IDs look like 'account.group_account_manager' or 'base.group_user'.
        Result is cached on the client instance for the lifetime of the session.
        """
        if hasattr(self, "_group_xmlids"):
            return self._group_xmlids  # type: ignore[attr-defined]

        # 1. Fetch group numeric IDs for the current user
        rows = self.execute("res.users", "read", [self.uid], fields=["groups_id"])
        group_ids: list[int] = rows[0].get("groups_id", []) if rows else []

        # 2. Resolve numeric IDs → XML IDs via ir.model.data
        xmlids: set[str] = set()
        if group_ids:
            imd_rows = self.execute(
                "ir.model.data", "search_read",
                [["model", "=", "res.groups"], ["res_id", "in", group_ids]],
                fields=["module", "name"],
            )
            for row in imd_rows:
                xmlids.add(f"{row['module']}.{row['name']}")

        self._group_xmlids: frozenset[str] = frozenset(xmlids)
        return self._group_xmlids


# ---------------------------------------------------------------------------
# Module-level helpers
# ---------------------------------------------------------------------------

_SESSION_EXPIRED_PHRASES = (
    "session expired",
    "session_invalid",
    "not logged",
    "odoo.http.sessionexpired",
)


def _is_session_expired(exc: Exception) -> bool:
    """Return True when *exc* signals an Odoo server-side session expiry.

    Odoo surfaces session expiry as a JSON-RPC error with messages like
    "Session Expired" or "Access Denied" (when the session cookie is stale).
    We catch those and let the caller re-authenticate rather than propagating.
    """
    msg = str(exc).lower()
    return any(phrase in msg for phrase in _SESSION_EXPIRED_PHRASES)
