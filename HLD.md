# High-Level Design (HLD) — Search Typeahead

This is the systems-design view of the project: requirements → architecture →
each component → trade-offs → how it maps to real production infrastructure.
Read this to defend the *design*, not just the code.

---

## 1. Requirements

**Functional**
- As the user types a prefix, return the **top 10** queries that start with it,
  sorted by popularity.
- Submitting a search returns a dummy response and **increments** that query's
  popularity.
- Support **trending** (recency-aware) ranking.
- Handle empty / missing / mixed-case / no-match input gracefully.

**Non-functional (the part HLD really cares about)**
- **Low read latency** — suggestions fire on every keystroke, so reads must be
  single-digit ms. This is a **read-heavy** system (reads ≫ writes).
- **Scalable cache** — distribute across nodes; adding/removing a node shouldn't
  nuke the whole cache → **consistent hashing**.
- **Reduced write pressure** — don't hit the DB on every search → **batching**.
- **Freshness** — a search should eventually affect suggestions/trending.
- **Reliability** — counts survive a restart.

**The core tension:** reads must be instant, but writes constantly change the
data that reads depend on. The whole architecture is about resolving that
tension: **serve reads from a precomputed cache; absorb writes asynchronously;
reconcile the two in the background.**

---

## 2. Back-of-envelope (why the design is shaped this way)

- Typing one word = ~6 keystrokes = ~6 suggestion reads. One search = 1 write.
  So **reads outnumber writes ~10:1+**. → Optimize reads hard; make writes cheap
  and asynchronous.
- 125k queries, top-10 per prefix. A short prefix like `a` could have a huge
  subtree → never scan it on the read path. → **Precompute top-K** and cache it.
- Many users hammer the same hot prefixes (`a`, `ap`, `i`...). → A cache with
  high hit-rate on hot prefixes pays for itself.

These three facts justify: Trie + per-node top-K, a derived cache, and
write-behind batching.

---

## 3. High-level architecture

```
                 ┌────────────────────────────────────────────────────┐
   READ  ───────►│  Load balancer / router  (consistent-hash ring)     │
  /suggest       └───────────────┬────────────────────────────────────┘
                                 │ route(prefix)
                 ┌───────────────▼─────────────┐   miss   ┌─────────────────────┐
                 │  Cache shard (top-K, TTL)    │─────────►│  Source of truth     │
                 │  shard-0 / shard-1 / shard-2 │◄─────────│  (durable counts)    │
                 └──────────────────────────────┘  warm    │  query_counts        │
                                 ▲                          │  recent_count        │
            push fresh top-K     │                          │  dirty_prefixes ◄─┐  │
                 ┌───────────────┴─────────────┐            └──────────┬────────┼──┘
                 │  Cache updater (background)  │◄──────polls dirty─────┘        │
                 │  recompute top-K, decay      │                               │
                 └──────────────────────────────┘                              │
                                                                                │
   WRITE ──────► Batch writer (in-memory buffer) ──flush──► applyBatch ─────────┘
  /search        aggregate repeats, flush by size/time     (count++, recent++, mark dirty)
```

**Two independent paths:**

**Read path** (must be fast): `route(prefix)` → owning shard → return cached
top-K. On miss, derive once from the source, warm the shard, return.

**Write path** (must be cheap + not block reads): buffer → batch flush into the
source of truth → mark affected prefixes dirty → the updater rebuilds those cache
entries asynchronously.

The two paths only meet through the **source of truth** and the **dirty queue** —
they're decoupled. That decoupling is the central HLD idea.

---

## 4. Component deep-dive (the complete backend)

### 4.1 Trie — the index (`src/trie.js`)
- A tree keyed by character; the node at the end of a prefix path "owns" the
  subtree of all completions.
- **Each node caches its subtree's top-K** (sorted by count). So a suggestion is
  "walk to the node, read its list" — no scan, no sort at read time.
- Sorting cost is paid at **write** time (`_bubble` updates ancestor lists),
  which is fine because writes are batched and rare relative to reads.
- Complexity: lookup O(prefix length); space O(total characters).

### 4.2 Source of truth — durable store (`src/sourceOfTruth.js`)
- Equivalent of a database. Holds permanent `count` (in the Trie), a decaying
  `recent_count` map, and a `dirty` set (the cache work queue).
- This is the only thing we make durable (via the WAL). The cache is derived and
  can always be rebuilt from here.
- Exposes `topKByCount(prefix)` and `topKByRecency(prefix)` — the two orderings.

### 4.3 Distributed cache — shards + ring (`src/shard.js`, `src/cluster.js`)
- N shards (default 3). Each holds, for the prefixes it owns: a `basic` top-K, a
  `recency` top-K, and a `trending` board.
- **Cache-aside pattern:** the app checks the cache first; on a miss it loads from
  the source and populates the cache.
- **Expiry/invalidation (two mechanisms):**
  - **TTL** (60s) — bounds staleness even if a refresh is missed.
  - **Active invalidation** — a write marks the prefix dirty; the updater pushes a
    fresh list (rebuild-on-write, not delete-on-write).
- **Routing = consistent hashing.** `cluster.route(key)` asks the ring which shard
  owns the key. Same ring for reads and for the updater's pushes, so they always
  agree on ownership.

### 4.4 Consistent hashing — the ring (`src/consistentHash.js`)
- Keys and nodes are hashed onto a circle (0…2³²). A key belongs to the first
  node **clockwise**.
- **150 virtual nodes per shard** spread each shard around the ring → even load
  (measured ~30/34/36% over 30k keys).
- **Elasticity:** adding/removing a shard remaps only ~1/N of keys (measured
  ~25% adding a 4th), vs ~75% for naive `hash % N`. That's the whole point —
  scaling the cache doesn't cause a mass cache-miss storm.

### 4.5 Batch writer — write-behind (`src/batchWriter.js`)
- `/search` pushes to an in-memory `Map<query, delta>` and returns immediately.
- **Aggregation:** repeated queries coalesce (50× "iphone" → one `+50`).
- **Flush triggers:** buffer hits `BATCH_SIZE` (100) **or** `FLUSH_INTERVAL_MS`
  (2s) — whichever first.
- **Write reduction:** R searches over U distinct queries → U writes (measured
  ~50×). Skewed traffic does *better*.
- **Durability / failure model:** buffer is in RAM → a crash loses the un-flushed
  window. Mitigated by flush-on-shutdown + a WAL appended each flush and replayed
  on boot. Acceptable because counts are approximate. Tunable: bigger batch =
  more reduction but more risk.

### 4.6 Cache updater — reconciliation (`src/cacheUpdater.js`)
- Background loop. Drains dirty prefixes, recomputes both top-K orderings from the
  source, and **pushes them to each prefix's owning shard**.
- Also runs **decay**: `recent_count` ×0.5 periodically (recency fades), trending
  ×0.9 periodically.
- **Why it must exist (key HLD insight):** a search for query *q* affects prefixes
  routed to `hash(q)`'s shard, but a read for prefix *p* is served by `hash(p)`'s
  shard — a *different* shard. If writes touched the cache directly, the update
  would land on the wrong shard and never be seen. Routing the rebuild through the
  source + updater guarantees the fresh list lands on the shard that actually
  serves that prefix.

### 4.7 Metrics & config (`src/metrics.js`, `src/config.js`)
- Latency recorder (ring buffer → p50/p95/p99). p95 = "typical worst case",
  better than the average which hides spikes.
- All knobs centralized so every trade-off (batch size, TTL, decay, weights) is
  explicit and tunable.

---

## 5. Trending & recency — the HLD of §7

**Goal:** blend long-term popularity with short-term surge, without letting a
brief spike dominate forever.

**Score:**
```
score = HIST_WEIGHT·log2(1 + count)  +  RECENCY_WEIGHT·log2(1 + recent_count)
        (defaults 1 and 3)
```
- `log2` = diminishing returns → a burst on a mid-tier query can overtake a giant,
  but a single search can't flap the order.
- `count` never decays → permanent popularity persists.
- `recent_count` decays (×0.5 each interval) → a spike rises, then **converges
  back to the query's true all-time rank** (not out — its `count` is intact).
- **Windowing model:** exponential decay = a soft sliding window. Equivalent to
  "weight searches by how recent they are," with a tunable half-life.
- **Cache impact:** decay re-marks prefixes dirty, so the *served* recency cache
  fades too — the ranking change is reflected without read-time cost.

**Trade-off:** a second cache per prefix (≈2× cache memory) and one-cycle
eventual consistency, in exchange for zero added read latency.

---

## 6. How each module maps to real production infrastructure

Every module is a working stand-in for a real distributed service. The design and
data flow are production-grade; only the *deployment* is collapsed into one process
so it runs with one command and every line is defensible.

| Concept | At production scale | In this project |
| --- | --- | --- |
| Source of truth | **Postgres** `query_counts(query,count,recent_count)`, `dirty_prefixes` table | `SourceOfTruth` (Trie + recent map + dirty set) |
| Cache | **N Redis shards**, `q:`/`qr:`/`trending` **ZSETs** | 3 `ShardNode`s, basic/recency/trending maps |
| Routing | Consistent-hash **load balancer** | `CacheCluster` ring (MD5, 150 vnodes) |
| Topology | **N app nodes**, each owns 1 Redis shard | N logical shards in one process |
| Cache sync | Separate **cache-updater service**; pushes top-K via the owning app node | `CacheUpdater` loop pushes to owning shard |
| Single-writer rule | Each cache shard has exactly one writer (its app node) | Each shard written only via `pushCache` |
| Batch writes | Buffer → batch UPSERT in one transaction | Buffer → `applyBatch` (**~50× reduction**) |
| Recency | `log2(1+count)+3·log2(1+recent)`, decay `recent_count` | identical formula + decay |
| Trending | per-shard ZSET, periodic decay, LB merges | per-shard board, periodic decay, cluster merges |
| Durability | Postgres on disk | WAL append + replay on boot |
| Deploy | container per service, orchestrated | single `npm start` |

**The key consistency subtlety (worth raising in viva):** a search for query `q`
affects prefixes on `hash(q)`'s shard, but `/suggest?q=p` reads from `hash(p)`'s
shard — a *different* shard. If the writer touched the cache directly, the update
would land on the wrong shard and never be seen. The fix is the design used here:
**the source of truth is authoritative, and the updater computes each prefix's
top-K and pushes it to the shard that owns *that prefix*.**

**Why in-process:** real Redis/Postgres/containers add operational complexity
without changing the *design* being defended. Each module maps 1:1 to a real
service, so "swap to real Redis" is a driver change, not a redesign.

---

## 7. Trade-offs & where it breaks at scale

| Decision | Win | Cost / limit |
| --- | --- | --- |
| Cache derived from source | fast O(1) reads | eventual consistency (one updater cycle) |
| Write-behind batching | ~50× fewer writes | crash loses un-flushed buffer (WAL-mitigated) |
| Consistent hashing | elastic cache, minimal remap | slightly uneven load (vnodes mitigate) |
| Top-K per Trie node | no read-time sort | extra memory; write-time bubble cost |
| Recency via decay | spikes rise then fade | 2nd cache; tuning the half-life |
| In-process shards | trivial to run | one machine's RAM caps dataset size |

**Evolution path (the "how would you scale this?" answer):**
1. Move shards to real Redis (driver swap behind `ShardNode`).
2. Move the source to Postgres; the `dirty_prefixes` table becomes the real work
   queue.
3. Run app nodes + cache-updater + LB as separate processes/containers — the
   routing logic is already identical.
4. Partition the source of truth itself when one machine can't hold the Trie.

---

## 8. One-paragraph summary (say this if asked "describe your design")

> "It's a read-optimized, write-behind system. A Trie indexes 125k queries and
> caches a top-K per node so prefix reads need no sorting. Those top-Ks are served
> from a cache distributed across 3 shards, with **consistent hashing** deciding
> ownership so the cluster is elastic. Writes never hit the store synchronously —
> they're **buffered and batch-flushed** into a durable source of truth, which
> marks affected prefixes dirty. A background **cache-updater** rebuilds those
> entries and pushes them to the owning shard, which is also how a search becomes
> visible across shards. Ranking blends all-time count with a **decaying recency
> signal**, so trends rise and then fade back to their true rank. It's the same
> architecture as a Postgres + Redis-shards + cache-updater production system,
> implemented in one process so it's easy to run and explain."
```
