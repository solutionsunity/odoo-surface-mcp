/** Simple in-memory cache with TTL and hit/miss tracking. */

export interface CacheStats {
  entries_live: number;
  entries_expired: number;
  hits: number;
  misses: number;
  hit_rate: number;
}

export interface CacheDumpEntry {
  key: string;
  expires_in_s: number | null;
}

interface Entry {
  value: unknown;
  expiresAt: number; // ms epoch; 0 = never
}

export class Cache {
  private store = new Map<string, Entry>();
  private hits = 0;
  private misses = 0;

  constructor(public readonly defaultTtl: number = 300) {}

  get(key: string): unknown {
    const entry = this.store.get(key);
    if (!entry) { this.misses++; return undefined; }
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      this.misses++;
      return undefined;
    }
    this.hits++;
    return entry.value;
  }

  set(key: string, value: unknown, ttl?: number): void {
    const effective = ttl ?? this.defaultTtl;
    const expiresAt = effective ? Date.now() + effective * 1000 : 0;
    this.store.set(key, { value, expiresAt });
  }

  clear(): number {
    const count = this.store.size;
    this.store.clear();
    this.hits = 0;
    this.misses = 0;
    return count;
  }

  stats(): CacheStats {
    const now = Date.now();
    let live = 0;
    let expired = 0;
    for (const { expiresAt } of this.store.values()) {
      if (!expiresAt || expiresAt > now) live++;
      else expired++;
    }
    const total = this.hits + this.misses;
    return {
      entries_live: live,
      entries_expired: expired,
      hits: this.hits,
      misses: this.misses,
      hit_rate: total ? Math.round((this.hits / total) * 1000) / 1000 : 0,
    };
  }

  dump(): CacheDumpEntry[] {
    const now = Date.now();
    const rows: CacheDumpEntry[] = [];
    for (const [key, { expiresAt }] of this.store.entries()) {
      if (expiresAt && expiresAt <= now) continue;
      rows.push({
        key,
        expires_in_s: expiresAt ? Math.round((expiresAt - now) / 100) / 10 : null,
      });
    }
    return rows.sort((a, b) => a.key.localeCompare(b.key));
  }
}
