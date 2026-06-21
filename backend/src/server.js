/**
 * server.js — Wires the components together and exposes the HTTP API.
 *
 * Architecture (a production-style design, in one easy-to-run process):
 *
 *   POST /search ──> BatchWriter (buffer) ──flush──> SourceOfTruth (count++, recent++, mark dirty)
 *                                                          │
 *                              CacheUpdater polls dirty ───┘──> recompute top-K ──> owning Shard
 *                                                                                      ▲
 *   GET /suggest ──> CacheCluster.route(prefix) ──> Shard.getSuggest ──hit──> return  │
 *                                              └────────────────────miss──> SourceOfTruth (derive)
 *                                                                            └─> warm the shard ┘
 *
 * Components:
 *   SourceOfTruth  = durable store (Postgres in production) — sourceOfTruth.js
 *   CacheCluster   = 3 shards + consistent-hash LB       — cluster.js / shard.js
 *   CacheUpdater   = dirty-prefix sync + decay           — cacheUpdater.js
 *   BatchWriter    = write-behind buffer                 — batchWriter.js
 */

import express from 'express';
import cors from 'cors';

import { config } from './config.js';
import { SourceOfTruth } from './sourceOfTruth.js';
import { CacheCluster } from './cluster.js';
import { CacheUpdater } from './cacheUpdater.js';
import { BatchWriter } from './batchWriter.js';
import { LatencyMeter } from './metrics.js';
import { loadDataset, replayWal, appendWal } from './datastore.js';

// ---- Build the system ------------------------------------------------------
const source = new SourceOfTruth();
const cluster = new CacheCluster({ log: process.env.RING_LOG === '1' });
const updater = new CacheUpdater({ source, cluster });
const latency = new LatencyMeter();
const batch = new BatchWriter({
  source,
  cluster,
  onApplied: (query, delta) => appendWal(query, delta),
});

console.log('Loading dataset into source of truth...');
const loaded = loadDataset(source);
const replayed = replayWal(source);
console.log(`Loaded ${loaded.toLocaleString()} queries (+${replayed} WAL deltas replayed).`);

// Warm the cache for short prefixes (1–2 chars) so common typing hits instantly.
// (A full system could pre-derive every prefix; we pre-warm the hot head and let
//  the updater/lazy-fill handle the long tail — same idea, faster startup.)
warmShortPrefixes();
updater.start();
batch.start();

function warmShortPrefixes() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789 '.split('');
  let warmed = 0;
  for (const a of alphabet) {
    if (source.topKByCount(a).length) {
      cluster.pushCache(a, source.topKByCount(a), source.topKByRecency(a));
      warmed++;
    }
    for (const b of alphabet) {
      const p = a + b;
      const top = source.topKByCount(p);
      if (top.length) {
        cluster.pushCache(p, top, source.topKByRecency(p));
        warmed++;
      }
    }
  }
  console.log(`Warmed ${warmed} short-prefix cache entries across ${config.SHARDS.length} shards.`);
}

// ---- HTTP ------------------------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json());

/**
 * GET /suggest?q=<prefix>&rank=<basic|recency>
 * Up to 10 prefix-matching suggestions.
 *   rank=basic   (default) -> all-time count        (the 60% version)
 *   rank=recency           -> blended recency score (the enhanced 20% version, §7)
 * Served from the owning shard; on a miss we fall back to the source of truth
 * and warm the shard (source:"db" vs "cache").
 */
app.get('/suggest', (req, res) => {
  const start = process.hrtime.bigint();
  const prefix = (req.query.q ?? '').toString().trim().toLowerCase();
  // Accept rank=recency OR the alias enhanced=1 for the enhanced ranking.
  const rank =
    req.query.rank === 'recency' || req.query.enhanced === '1' || req.query.enhanced === 'true'
      ? 'recency'
      : 'basic';

  if (!prefix) {
    return res.json({ prefix: '', rank, source: 'none', suggestions: [] });
  }

  let suggestions = cluster.suggest(prefix, rank);
  let src = 'cache';
  if (suggestions === undefined) {
    // Cache miss: derive from the source of truth and warm both caches on the shard.
    src = 'db';
    const basic = source.topKByCount(prefix);
    const recency = source.topKByRecency(prefix);
    cluster.pushCache(prefix, basic, recency);
    suggestions = rank === 'recency' ? recency : basic;
  }

  const out = suggestions.slice(0, config.SUGGEST_LIMIT);
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  latency.record(ms);
  res.json({ prefix, rank, source: src, latencyMs: Number(ms.toFixed(3)), suggestions: out });
});

/**
 * POST /search { "query": "iphone 15" }
 * Dummy search. Buffers the count update (batch write) and returns "Searched".
 */
app.post('/search', (req, res) => {
  const query = (req.body?.query ?? '').toString().trim();
  if (!query) return res.status(400).json({ error: 'query is required' });
  batch.record(query); // write-behind: buffered, not synchronous
  res.json({ message: 'Searched', query });
});

/** GET /trending?n=10 — merged, decayed trending board across all shards. */
app.get('/trending', (req, res) => {
  const n = Math.min(Number(req.query.n) || config.TRENDING_LIMIT, 50);
  res.json({ trending: cluster.mergeTrending(n) });
});

/** GET /cache/debug?prefix=<p> — which shard owns the prefix, hit/miss per rank. */
app.get('/cache/debug', (req, res) => {
  const prefix = (req.query.prefix ?? '').toString().trim().toLowerCase();
  if (!prefix) return res.status(400).json({ error: 'prefix is required' });
  res.json(cluster.debug(prefix));
});

/** GET /metrics — latency p95, cache hit rate, batch write reduction, etc. */
app.get('/metrics', (_req, res) => {
  res.json({
    datasetSize: source.size,
    suggestLatency: latency.report(),
    cache: cluster.report(),
    batchWriter: batch.report(),
    cacheUpdater: updater.report(),
    sourceOfTruth: source.stats,
  });
});

/**
 * GET /ring/distribution — proves consistent hashing spreads load evenly.
 * Hashes N synthetic keys and reports how many land on each shard.
 */
app.get('/ring/distribution', (req, res) => {
  const n = Math.min(Number(req.query.n) || 10000, 100000);
  const keys = Array.from({ length: n }, (_, i) => `key-${i}`);
  res.json({ sampled: n, perShard: cluster.distribution(keys), recentRoutes: cluster.routeLog.slice(-10) });
});

app.get('/health', (_req, res) => res.json({ ok: true }));

const server = app.listen(config.PORT, () => {
  console.log(`Typeahead backend on http://localhost:${config.PORT}`);
  console.log(`Shards: ${config.SHARDS.join(', ')} | batchSize=${config.BATCH_SIZE} | ttl=${config.CACHE_TTL_MS}ms`);
});

function shutdown() {
  console.log('\nShutting down: flushing batch buffer...');
  batch.stop();
  updater.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export { app };
