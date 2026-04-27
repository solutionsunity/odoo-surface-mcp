"""Simple in-memory cache with optional TTL and hit/miss tracking."""
import time
from typing import Any


class Cache:
    def __init__(self, default_ttl: int = 300):
        """
        Args:
            default_ttl: seconds before an entry expires (0 = never)
        """
        self._store: dict[str, tuple[Any, float]] = {}  # key → (value, expires_at)
        self._hits = 0
        self._misses = 0
        self.default_ttl = default_ttl

    # ------------------------------------------------------------------
    # Core operations
    # ------------------------------------------------------------------

    def get(self, key: str) -> Any:
        """Return cached value or None if missing/expired."""
        entry = self._store.get(key)
        if entry is None:
            self._misses += 1
            return None
        value, expires_at = entry
        if expires_at and time.time() > expires_at:
            del self._store[key]
            self._misses += 1
            return None
        self._hits += 1
        return value

    def set(self, key: str, value: Any, ttl: int | None = None) -> None:
        """Store value under key. ttl=0 or ttl=None uses default_ttl."""
        effective_ttl = ttl if ttl is not None else self.default_ttl
        expires_at = (time.time() + effective_ttl) if effective_ttl else 0.0
        self._store[key] = (value, expires_at)

    def clear(self) -> int:
        """Remove all entries. Returns count cleared."""
        count = len(self._store)
        self._store.clear()
        self._hits = 0
        self._misses = 0
        return count

    # ------------------------------------------------------------------
    # Diagnostics
    # ------------------------------------------------------------------

    def stats(self) -> dict:
        now = time.time()
        live = sum(1 for _, (_, exp) in self._store.items() if not exp or exp > now)
        expired = len(self._store) - live
        return {
            "entries_live": live,
            "entries_expired": expired,
            "hits": self._hits,
            "misses": self._misses,
            "hit_rate": round(
                self._hits / (self._hits + self._misses), 3
            ) if (self._hits + self._misses) else 0.0,
        }

    def dump(self) -> list[dict]:
        """Return all live entries with key and expiry info (no values)."""
        now = time.time()
        rows = []
        for key, (_, exp) in self._store.items():
            if exp and exp <= now:
                continue
            rows.append({
                "key": key,
                "expires_in_s": round(exp - now, 1) if exp else None,
            })
        return sorted(rows, key=lambda r: r["key"])
