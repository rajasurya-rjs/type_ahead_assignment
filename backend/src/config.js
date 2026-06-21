/**
 * config.js — All tunable knobs in one place (env-overridable).
 *
 * Centralizes the system's config: batch sizes, cache depth, shard count,
 * recency-blend weights and decay factors. Keeping them here makes the
 * latency/throughput/freshness trade-offs explicit and easy to defend.
 */

const num = (v, d) => (v === undefined ? d : Number(v));

export const config = {
  PORT: num(process.env.PORT, 4000),

  // Cache cluster
  SHARDS: ['shard-0', 'shard-1', 'shard-2'], // 3 logical Redis-like cache nodes
  VNODES: num(process.env.VNODES, 150), // virtual nodes per shard on the ring
  CACHE_TTL_MS: num(process.env.CACHE_TTL_MS, 60_000), // per-entry expiry
  CACHE_K: num(process.env.CACHE_K, 30), // depth of each derived top-K (>= SUGGEST_LIMIT)
  SUGGEST_LIMIT: num(process.env.SUGGEST_LIMIT, 10),
  TRENDING_LIMIT: num(process.env.TRENDING_LIMIT, 10),

  // Batch writer
  BATCH_SIZE: num(process.env.BATCH_SIZE, 100), // flush when buffer hits this many distinct queries
  FLUSH_INTERVAL_MS: num(process.env.FLUSH_INTERVAL_MS, 2000), // safety-net flush for low traffic

  // Cache updater
  UPDATER_INTERVAL_MS: num(process.env.UPDATER_INTERVAL_MS, 500), // poll cadence for dirty prefixes
  UPDATER_BATCH: num(process.env.UPDATER_BATCH, 500), // dirty prefixes processed per tick

  // Recency-aware ranking (§7): score = HIST*log2(1+count) + RECENCY*log2(1+recent_count)
  HIST_WEIGHT: num(process.env.HIST_WEIGHT, 1),
  RECENCY_WEIGHT: num(process.env.RECENCY_WEIGHT, 3),
  RECENCY_DECAY_FACTOR: num(process.env.RECENCY_DECAY_FACTOR, 0.5), // recent_count *= this each tick
  RECENCY_DECAY_INTERVAL_MS: num(process.env.RECENCY_DECAY_INTERVAL_MS, 30_000),

  // Trending board decay
  TRENDING_DECAY_FACTOR: num(process.env.TRENDING_DECAY_FACTOR, 0.9),
  TRENDING_DECAY_INTERVAL_MS: num(process.env.TRENDING_DECAY_INTERVAL_MS, 60_000),

  MAX_PREFIX_LEN: num(process.env.MAX_PREFIX_LEN, 32), // cap prefix fan-out per query
};
