/**
 * shard.js — One logical cache node. (In production this is a real Redis box.)
 *
 * Each shard holds, for the prefixes it OWNS (decided by consistent hashing in
 * cluster.js):
 *   basic[prefix]   -> derived top-K suggestions by all-time count   (a Redis `q:`  ZSET)
 *   recency[prefix] -> derived top-K by blended recency score (§7)    (a Redis `qr:` ZSET)
 *   trending        -> a query -> score board, decayed periodically   (a Redis `trending` ZSET)
 *
 * Entries carry a TTL so stale data can't live forever even if the updater
 * misses a refresh. putCache() atomically replaces an entry — the in-memory
 * analogue of a Redis Lua DEL+ZADD ("each shard has exactly one writer").
 */

import { config } from './config.js';

export class ShardNode {
  constructor(id, ttlMs = config.CACHE_TTL_MS) {
    this.id = id;
    this.ttlMs = ttlMs;
    this.basic = new Map(); // prefix -> { value, expiresAt }
    this.recency = new Map(); // prefix -> { value, expiresAt }
    this.trending = new Map(); // query -> score
    this.stats = { hits: 0, misses: 0, writes: 0 };
  }

  _store(rank) {
    return rank === 'recency' ? this.recency : this.basic;
  }

  /** Atomic replace of a prefix's derived top-K (pushed by the cache-updater). */
  putCache(prefix, rank, list) {
    this._store(rank).set(prefix, { value: list, expiresAt: Date.now() + this.ttlMs });
    this.stats.writes++;
  }

  /** Read cached suggestions for a prefix. Returns undefined on miss/expiry. */
  getSuggest(prefix, rank) {
    const entry = this._store(rank).get(prefix);
    if (!entry) {
      this.stats.misses++;
      return undefined;
    }
    if (Date.now() > entry.expiresAt) {
      this._store(rank).delete(prefix); // lazy expiry
      this.stats.misses++;
      return undefined;
    }
    this.stats.hits++;
    return entry.value;
  }

  // ---- Trending (this shard owns the queries hashed to it) -----------------
  incrTrending(query, delta = 1) {
    this.trending.set(query, (this.trending.get(query) || 0) + delta);
  }

  decayTrending(factor) {
    for (const [q, s] of this.trending) {
      const next = s * factor;
      if (next < 0.5) this.trending.delete(q);
      else this.trending.set(q, next);
    }
  }

  trendingEntries() {
    return [...this.trending.entries()].map(([query, score]) => ({ query, score }));
  }

  /** Debug view for GET /cache/debug. */
  debug(prefix) {
    const b = this.basic.get(prefix);
    const r = this.recency.get(prefix);
    const fresh = (e) => e && Date.now() <= e.expiresAt;
    return {
      shard: this.id,
      basic: { status: fresh(b) ? 'HIT' : 'MISS', cached: fresh(b) ? b.value.length : 0 },
      recency: { status: fresh(r) ? 'HIT' : 'MISS', cached: fresh(r) ? r.value.length : 0 },
      prefixesCached: this.basic.size,
    };
  }
}
