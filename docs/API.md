# API Reference

Base URL: `http://localhost:4000` (the frontend reaches it via the Vite proxy at `/api`).

---

## GET /suggest

Returns up to 10 suggestions whose text **starts with** the prefix.

**Query params**

| Param | Required | Default | Notes |
| --- | --- | --- | --- |
| `q` | yes | — | the typed prefix; case-insensitive; empty → empty list (handled gracefully) |
| `rank` | no | `basic` | `basic` = all-time count; `recency` = blended recency score (§7) |
| `enhanced` | no | — | alias: `enhanced=1` is the same as `rank=recency` |

**Example**

```bash
curl "http://localhost:4000/suggest?q=app&rank=basic"
```

```json
{
  "prefix": "app",
  "rank": "basic",
  "source": "cache",
  "latencyMs": 0.04,
  "suggestions": [
    { "query": "apple console waterproof", "count": 43856 },
    { "query": "apple desk for gaming", "count": 21559 }
  ]
}
```

- `source`: `cache` (HIT on the owning shard) or `db` (MISS → derived from the
  source of truth and the shard warmed).
- In `rank=recency`, each suggestion also includes `recentCount` and `score`.

---

## POST /search

Dummy search endpoint. Records the query (buffered, batched) and returns a fixed
message. The count update is applied on the next flush and made visible by the
cache-updater.

```bash
curl -X POST http://localhost:4000/search \
  -H 'Content-Type: application/json' \
  -d '{"query":"iphone 15"}'
```

```json
{ "message": "Searched", "query": "iphone 15" }
```

Empty/missing `query` → `400 { "error": "query is required" }`.

---

## GET /trending

Merged, time-decayed trending board across all shards.

```bash
curl "http://localhost:4000/trending?n=5"
```

```json
{ "trending": [ { "query": "iphone 15", "score": 12.4 } ] }
```

---

## GET /cache/debug

Shows which cache shard owns a prefix and whether it is currently cached, per
ranking. Backs the §5 "debug cache routing" requirement.

```bash
curl "http://localhost:4000/cache/debug?prefix=app"
```

```json
{
  "prefix": "app",
  "ownerShard": "shard-2",
  "shard": "shard-2",
  "basic":   { "status": "HIT", "cached": 30 },
  "recency": { "status": "HIT", "cached": 30 },
  "prefixesCached": 39
}
```

---

## GET /metrics

Performance + internal counters (powers the perf report and the UI footer).

```json
{
  "datasetSize": 125479,
  "suggestLatency": { "p50Ms": 0.02, "p95Ms": 0.03, "p99Ms": 0.06, "avgMs": 0.03 },
  "cache": { "hits": 4995, "misses": 5, "hitRate": 0.999, "shards": [ ... ] },
  "batchWriter": { "searchesRecorded": 1000, "sourceWrites": 20, "writeReductionFactor": "50.0x" },
  "cacheUpdater": { "ticks": 120, "prefixesRefreshed": 340, "dirtyPending": 0 },
  "sourceOfTruth": { "upserts": 20, "decayTicks": 0 }
}
```

---

## GET /ring/distribution

Hashes N synthetic keys and reports how many land on each shard — evidence that
consistent hashing spreads load evenly. Also returns the last few routing
decisions.

```bash
curl "http://localhost:4000/ring/distribution?n=30000"
```

```json
{
  "sampled": 30000,
  "perShard": { "shard-0": 8886, "shard-1": 10292, "shard-2": 10822 },
  "recentRoutes": [ { "key": "ap", "shard": "shard-2" } ]
}
```

---

## GET /health

```json
{ "ok": true }
```
