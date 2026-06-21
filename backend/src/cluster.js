/**
 * cluster.js — The cache cluster + consistent-hash router (the load balancer).
 *
 * The cluster owns N ShardNodes and a ConsistentHashRing. `route(key)` maps any
 * prefix (for /suggest, /cache/debug) or query (for trending) to the single
 * shard that owns it — exactly like a load balancer hashing a key and proxying
 * to the owning app node. Because routing is by consistent hashing, adding or
 * removing a shard only moves a slice of keys, not the whole cache.
 *
 * Every routing decision is logged (the assignment asks for logs showing
 * consistent-hashing behavior).
 */

import { ConsistentHashRing } from './consistentHash.js';
import { ShardNode } from './shard.js';
import { config } from './config.js';

export class CacheCluster {
  constructor({ shards = config.SHARDS, vnodes = config.VNODES, log = false } = {}) {
    this.ring = new ConsistentHashRing(shards, vnodes);
    this.shards = new Map(shards.map((id) => [id, new ShardNode(id)]));
    this.log = log;
    this.routeLog = []; // recent routing decisions, surfaced via /cache/debug
  }

  /** Which shard owns this key? (prefix for suggest, query for trending) */
  route(key) {
    const shardId = this.ring.getNode(key);
    const decision = { key, shard: shardId };
    if (this.log) console.log(`[ring] route("${key}") -> ${shardId}`);
    this.routeLog.push(decision);
    if (this.routeLog.length > 100) this.routeLog.shift();
    return this.shards.get(shardId);
  }

  /** Read suggestions for a prefix from its owning shard (undefined on miss). */
  suggest(prefix, rank) {
    return this.route(prefix).getSuggest(prefix, rank);
  }

  /** Push freshly-derived top-K (both orderings) to the prefix's owning shard. */
  pushCache(prefix, basicList, recencyList) {
    const shard = this.route(prefix);
    shard.putCache(prefix, 'basic', basicList);
    shard.putCache(prefix, 'recency', recencyList);
  }

  /** Trending is sharded by query; bump on the owning shard. */
  incrTrending(query, delta = 1) {
    this.route(query).incrTrending(query, delta);
  }

  /** Merge each shard's trending board (each query lives on exactly one shard). */
  mergeTrending(n = config.TRENDING_LIMIT) {
    const all = [];
    for (const shard of this.shards.values()) all.push(...shard.trendingEntries());
    return all
      .sort((a, b) => b.score - a.score)
      .slice(0, n)
      .map((e) => ({ query: e.query, score: Number(e.score.toFixed(3)) }));
  }

  decayTrending(factor) {
    for (const shard of this.shards.values()) shard.decayTrending(factor);
  }

  debug(prefix) {
    const shardId = this.ring.getNode(prefix);
    return { prefix, ownerShard: shardId, ...this.shards.get(shardId).debug(prefix) };
  }

  report() {
    let hits = 0;
    let misses = 0;
    const shards = [];
    for (const s of this.shards.values()) {
      hits += s.stats.hits;
      misses += s.stats.misses;
      shards.push({
        id: s.id,
        prefixesCached: s.basic.size,
        trendingQueries: s.trending.size,
        ...s.stats,
      });
    }
    const total = hits + misses;
    return {
      hits,
      misses,
      hitRate: total === 0 ? 0 : Number((hits / total).toFixed(4)),
      shards,
    };
  }

  /** Distribution of sample keys across shards — proves the ring spreads load. */
  distribution(sampleKeys) {
    return this.ring.distribution(sampleKeys);
  }
}
