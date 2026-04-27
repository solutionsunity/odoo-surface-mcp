"""Odoo JSON-RPC client — session-based wrapper around /web/dataset/call_kw."""
import itertools
import os
import time
from typing import Any

import requests


class OdooClient:
    _id_iter = itertools.count(1)

    def __init__(self, url: str, db: str, username: str, password: str):
        self.url = url.rstrip("/")
        self.db = db
        self.username = username
        self.password = password
        self._uid: int | None = None
        self._session = requests.Session()
        self._session.headers.update({"Content-Type": "application/json"})

    @classmethod
    def from_env(cls) -> "OdooClient":
        return cls(
            url=os.getenv("ODOO_URL", "http://localhost:8069"),
            db=os.getenv("ODOO_DB", "odoo17"),
            username=os.getenv("ODOO_USER", "admin"),
            password=os.getenv("ODOO_PASSWORD", "admin"),
        )

    def _rpc(self, route: str, params: dict) -> Any:
        """POST a JSON-RPC 2.0 envelope to *route* and return the result.

        The session cookie is managed automatically by requests.Session, so
        the Odoo server-side session (and request.website on frontend routes)
        persists across calls within the same OdooClient instance.
        """
        payload = {
            "jsonrpc": "2.0",
            "method": "call",
            "id": next(self._id_iter),
            "params": params,
        }
        resp = self._session.post(
            f"{self.url}{route}", json=payload, timeout=30
        )
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
        """Call model.method(*args, **kwargs) via /web/dataset/call_kw."""
        _ = self.uid  # ensure session cookie is established
        return self._rpc("/web/dataset/call_kw", {
            "model": model,
            "method": method,
            "args": list(args),
            "kwargs": kwargs,
        })

    def http_call(self, route: str, params: dict | None = None) -> Any:
        """Call any Odoo JSON route within the established session.

        Covers website-specific routes (e.g. /website/snippet/filters) and
        frontend routes where request.website is bound by the website
        middleware — neither of which are reachable via execute().
        """
        _ = self.uid  # ensure session cookie is established
        return self._rpc(route, params or {})

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
