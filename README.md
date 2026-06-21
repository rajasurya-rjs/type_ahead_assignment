# Search Typeahead System

A search-suggestion service like the autocomplete in search engines and
e-commerce sites. It suggests popular queries as you type, records searches,
updates popularity, and serves suggestions from a **distributed cache
(consistent hashing)** for low latency.

The design follows a real distributed architecture — **a durable source of
truth, a derived sharded cache kept in sync by a cache-updater, write-behind
batching, and recency-aware ranking** — implemented in a single Node process so
it runs with one command and every part is easy to explain.

```
Frontend (React, debounced)
        │  GET /suggest        POST /search
        ▼                          │
┌──────────────────────────────────────────────────────────────────────┐
│  Express API (src/server.js)                                           │
│                                                                        │
│   /suggest ──► CacheCluster.route(prefix) ──► Shard.get ─HIT─► return  │
│                  (consistent-hash ring)        │                       │
│                                              MISS► SourceOfTruth derive │
│                                                  └─► warm shard ──┘     │
│                                                                        │
│   /search ──► BatchWriter (in-memory buffer)                           │
│                  │ flush (size OR interval)                            │
│                  ▼                                                     │
│            SourceOfTruth: count++, recent_count++, mark prefixes dirty │
│                  │                                                     │
│   CacheUpdater poll(dirty) ─► recompute top-K ─► push to owning Shard  │
└──────────────────────────────────────────────────────────────────────┘
```

> **Why this stack?** At real scale a typeahead like this is built from a durable
> store (Postgres), several distributed caches (Redis shards), a consistent-hash
> load balancer, and a cache-updater — each a separate service behind Docker. This
> project implements **that same architecture and every feature** as in-process
> modules (no Docker, one command to run), so it is both easy to run locally and
> easy to defend line-by-line. Each module maps 1:1 to a real service, so swapping
> in real Redis/Postgres is a driver change, not a redesign. See the table below.

## Architecture mapping

| Concept | At production scale | In this project | File |
| --- | --- | --- | --- |
| Durable source of truth | Postgres `query_counts`, `dirty_prefixes` | `SourceOfTruth` (Trie + recent map + dirty set + WAL) | `backend/src/sourceOfTruth.js` |
| Distributed cache | 3 Redis shards (`q:`/`qr:` ZSETs) | 3 `ShardNode`s with TTL top-K maps | `backend/src/shard.js` |
| Consistent hashing / LB | Hash-ring load balancer | `CacheCluster` ring routing | `backend/src/cluster.js`, `consistentHash.js` |
| Cache sync | cache-updater service | `CacheUpdater` background loop | `backend/src/cacheUpdater.js` |
| Write-behind batching | In-memory buffer → batch UPSERT | `BatchWriter` | `backend/src/batchWriter.js` |
| Durability | Postgres WAL | Append-only `data/wal.log` replayed on boot | `backend/src/datastore.js` |
| Prefix search | SQL top-K per prefix | Trie with cached top-K per node | `backend/src/trie.js` |

## Quick start

Two terminals. **Node 18+** required (uses global `fetch`).

```bash
# 1) Backend
cd backend
npm install
npm run generate        # writes data/queries.csv (~125k queries) — see "Dataset"
npm start               # http://localhost:4000

# 2) Frontend (new terminal)
cd frontend
npm install
npm run dev             # http://localhost:5173  (proxies /api -> backend)
```

Open **http://localhost:5173**, start typing, toggle **Basic ↔ Recency-aware**,
submit searches, and watch the **Trending** board.

### Scripts

```bash
# backend/
npm test                # consistent-hash determinism + balance + stability
npm run bench           # latency p50/p95/p99, cache hit rate, write reduction
npm run demo:recency    # §7: basic vs recency ranking, before/after a burst
```

## Dataset

`backend/data/queries.csv` — `query,count` rows. `npm run generate` synthesizes
**~125,000 unique queries** (brands × products × modifiers) with **Zipf-distributed
counts** (a few head queries dominate, a long tail is rare — the shape real search
traffic has), which is what makes "sort by count" meaningful. It exceeds the §3
100k-row minimum.

**Use a real dataset instead:** drop any CSV with a `query,count` header at
`backend/data/queries.csv` and restart — no code changes. Good open sources:
AOL search log, Wikipedia page titles + pageviews, or the Kaggle "English word
frequency" set (aggregate to get counts).

## Features ↔ rubric

| Rubric (marks) | Where |
| --- | --- |
| **Basic (60)** — ingestion, UI, `/suggest`, `/search`, count updates, distributed cache w/ consistent hashing | `generateDataset.js`, `frontend/`, `server.js`, `trie.js`, `cluster.js`, `consistentHash.js` |
| **Trending (20)** — recency-aware ranking + windowing/decay | `sourceOfTruth.topKByRecency`, `cacheUpdater` decay, `/trending`; demo `npm run demo:recency` |
| **Batch writes (20)** — buffering, aggregation, write reduction, failure trade-offs | `batchWriter.js`; numbers in [PERFORMANCE.md](./PERFORMANCE.md) |

## API

Summary (full reference + examples → [docs/API.md](./docs/API.md)):

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/suggest?q=<prefix>&rank=basic\|recency` | up to 10 prefix matches, sorted by count (basic) or blended recency score (§7) |
| POST | `/search` `{ "query": "..." }` | dummy `{ "message": "Searched" }`; buffers a count update |
| GET | `/trending?n=10` | merged, decayed trending board across shards |
| GET | `/cache/debug?prefix=<p>` | which shard owns the prefix + HIT/MISS per rank |
| GET | `/metrics` | latency p95, cache hit rate, batch write reduction |
| GET | `/ring/distribution?n=10000` | key spread across shards (consistent-hash evidence) |

## Performance (measured)

| Metric | Value |
| --- | --- |
| `/suggest` p95 (server-side) | **~0.03  ms** |
| `/suggest` p95 (client, incl. HTTP) | ~1.1 ms |
| Cache hit rate | **99.9%** |
| Write reduction (batching) | **~50×** (1000 searches → 20 writes) |
| Adding a 4th shard re-maps | **~25%** of keys (naive `hash%N` ≈ 75%) |

Reproduce: `npm start` then `npm run bench`. Full methodology → [PERFORMANCE.md](./PERFORMANCE.md).

## Design notes & trade-offs

- **Cache vs source of truth.** The shards are a *derived* view; the
  `SourceOfTruth` is what we protect with the WAL. Writes go to the source and
  mark prefixes dirty; the updater rebuilds caches from the source. This is why a
  search for a query on one shard becomes visible under a prefix owned by a
  *different* shard — the updater pushes to the prefix's owner.
- **Eventual consistency.** A search is visible in suggestions after the next
  flush + updater cycle (sub-second by default). We trade a little freshness for
  fast O(1) reads.
- **Recency without permanent over-ranking (§7).** `recent_count` is decayed by
  the updater, so a spike fades back to the query's true all-time rank; `count`
  is never decayed, so long-term popularity persists. See
  [docs/API.md](./docs/API.md) and `npm run demo:recency`.
- **Batch durability.** A crash loses only the un-flushed buffer (bounded by
  `BATCH_SIZE`/`FLUSH_INTERVAL_MS`); flushes append to the WAL and we flush on
  `SIGINT`/`SIGTERM`. Acceptable because counts are approximate popularity
  signals. Details in `batchWriter.js`.

## Repo layout

```
backend/
  src/  trie · consistentHash · sourceOfTruth · shard · cluster
        cacheUpdater · batchWriter · datastore · metrics · config · server
  scripts/  generateDataset · benchmark · demoRecency
  test/  hashRing.test.js
  data/  queries.csv (generated) · wal.log (runtime)
frontend/
  src/  App.jsx · api.js · styles.css · main.jsx
docs/  API.md
PERFORMANCE.md
```
