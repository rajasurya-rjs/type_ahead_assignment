/**
 * cacheUpdater.js — Keeps the shard caches in sync with the source of truth.
 * (In production this is a separate service; here it's a background loop.)
 *
 * THE PROBLEM IT SOLVES (cross-shard consistency):
 * A search for query "q" routes to hash(q)'s shard, but /suggest?q="p" is read
 * from hash("p")'s shard — a *different* shard. If the app node wrote the cache
 * directly, the search would never become visible on the prefix's shard. The fix
 * is the standard one: writes go to the SOURCE OF TRUTH and mark prefixes dirty;
 * this updater recomputes each dirty prefix's top-K from the source and pushes it
 * to whichever shard owns that prefix. So a live search becomes visible in
 * suggestions on the correct shard, every time.
 *
 * It also drives DECAY: it periodically decays recent_count (recency signal) and
 * the trending board, so short-lived spikes fade back to their true rank (§7 q3).
 */

import { config } from './config.js';

export class CacheUpdater {
  constructor({ source, cluster }) {
    this.source = source;
    this.cluster = cluster;
    this.timers = [];
    this.stats = { ticks: 0, prefixesRefreshed: 0, decayRuns: 0 };
  }

  /** Process one batch of dirty prefixes: recompute top-K and push to owners. */
  tick() {
    const prefixes = this.source.drainDirty(config.UPDATER_BATCH);
    for (const prefix of prefixes) {
      const basic = this.source.topKByCount(prefix); // q:<prefix>
      const recency = this.source.topKByRecency(prefix); // qr:<prefix>
      this.cluster.pushCache(prefix, basic, recency); // -> owning shard
      this.stats.prefixesRefreshed++;
    }
    this.stats.ticks++;
    return prefixes.length;
  }

  start() {
    // 1) Poll the dirty queue and refresh caches.
    const t1 = setInterval(() => this.tick(), config.UPDATER_INTERVAL_MS);
    // 2) Decay recent_count so recency boosts fade (re-dirties affected prefixes).
    const t2 = setInterval(() => {
      this.source.decayRecent();
      this.stats.decayRuns++;
    }, config.RECENCY_DECAY_INTERVAL_MS);
    // 3) Decay the trending board.
    const t3 = setInterval(
      () => this.cluster.decayTrending(config.TRENDING_DECAY_FACTOR),
      config.TRENDING_DECAY_INTERVAL_MS
    );
    for (const t of [t1, t2, t3]) t.unref?.();
    this.timers = [t1, t2, t3];
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
  }

  report() {
    return { ...this.stats, dirtyPending: this.source.dirty.size };
  }
}
