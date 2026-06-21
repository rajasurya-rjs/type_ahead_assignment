/**
 * sourceOfTruth.js — The durable, authoritative store. (In production: Postgres.)
 *
 * Holds the equivalent of two tables:
 *   query_counts(query, count, recent_count)  -> Trie (count) + recent Map (recent_count)
 *   dirty_prefixes(prefix)                     -> this.dirty Set (the cache work queue)
 *
 * WHY SEPARATE FROM THE CACHE?
 * The cache (shards) is a *derived* view that can be rebuilt at any time. The
 * source of truth is what we protect with durability (the WAL). Writes go here;
 * the cache-updater reads from here to recompute each prefix's top-K. This is
 * the standard "Postgres is truth, Redis is a derived cache" split.
 *
 * count       : permanent all-time popularity (never decayed).
 * recent_count: a decaying recent-activity signal used by enhanced ranking (§7).
 */

import { Trie } from './trie.js';
import { config } from './config.js';

export class SourceOfTruth {
  constructor() {
    this.trie = new Trie(); // candidate generation + all-time counts
    this.recent = new Map(); // query -> recent_count
    this.dirty = new Set(); // prefixes whose cached top-K needs recompute
    this.stats = { upserts: 0, decayTicks: 0 };
  }

  get size() {
    return this.trie.size;
  }

  /**
   * Bulk load the dataset in one fast pass (no dirtying — the cache is warmed
   * separately). `entries` is an array of [query, count].
   */
  loadBulk(entries) {
    this.trie.bulkInsert(entries);
  }

  /** Every prefix of a query, capped, so we know which cache entries to refresh. */
  _prefixesOf(query) {
    const out = [];
    const max = Math.min(query.length, config.MAX_PREFIX_LEN);
    for (let i = 1; i <= max; i++) out.push(query.slice(0, i));
    return out;
  }

  /**
   * Apply a batch of aggregated deltas (called by the batch writer on flush).
   * Bumps count + recent_count and marks every affected prefix dirty.
   * @param {Map<string, number>} deltas  query -> count delta
   */
  applyBatch(deltas) {
    for (const [query, delta] of deltas) {
      this.trie.increment(query, delta); // permanent count
      this.recent.set(query, (this.recent.get(query) || 0) + delta); // recent signal
      this.stats.upserts++;
      for (const p of this._prefixesOf(query)) this.dirty.add(p);
    }
  }

  /**
   * Decay the recent-activity signal so short-lived spikes fade (§7 q3).
   * Re-marks affected prefixes dirty so the *served* recency cache fades too.
   */
  decayRecent(factor = config.RECENCY_DECAY_FACTOR) {
    for (const [query, rc] of this.recent) {
      const next = Math.floor(rc * factor);
      if (next <= 0) {
        this.recent.delete(query);
      } else {
        this.recent.set(query, next);
      }
      // Mark prefixes dirty either way so the order updates (or the boost drops off).
      for (const p of this._prefixesOf(query)) this.dirty.add(p);
    }
    this.stats.decayTicks++;
  }

  /** Pull up to `n` dirty prefixes for the updater to process (claim + remove). */
  drainDirty(n) {
    const out = [];
    for (const p of this.dirty) {
      out.push(p);
      if (out.length >= n) break;
    }
    for (const p of out) this.dirty.delete(p);
    return out;
  }

  /** Derived top-K for a prefix ordered by all-time count (the `q:` cache). */
  topKByCount(prefix, k = config.CACHE_K) {
    return this.trie.suggest(prefix).slice(0, k); // trie.suggest already count-sorted
  }

  /**
   * Derived top-K ordered by the blended recency score (the `qr:` cache, §7):
   *   score = HIST*log2(1+count) + RECENCY*log2(1+recent_count)
   * Candidates come from the same prefix subtree; we just re-rank them.
   */
  topKByRecency(prefix, k = config.CACHE_K) {
    const candidates = this.trie.suggest(prefix); // up to CACHE_K by count
    return candidates
      .map((c) => {
        const rc = this.recent.get(c.query) || 0;
        const score =
          config.HIST_WEIGHT * Math.log2(1 + c.count) +
          config.RECENCY_WEIGHT * Math.log2(1 + rc);
        return { query: c.query, count: c.count, recentCount: rc, score: Number(score.toFixed(4)) };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  getCount(query) {
    return this.trie.getCount(query);
  }
  getRecent(query) {
    return this.recent.get(query.toLowerCase()) || 0;
  }
}
