# Performance Report

All numbers below are reproducible: start the backend (`npm start`) and run
`npm run bench`. Hardware: local dev machine (macOS, Node 22). Dataset: 125,479
synthetic queries with Zipf counts.

> **Honest caveat:** latency is measured over localhost, so network cost is
> negligible — these reflect compute/cache cost, not a production deployment.

## 1. Suggestion latency — `GET /suggest`

Measured over 5,000 requests across a realistic mix of 20 prefixes.

| Statistic | Server-side (handler only) | Client-side (incl. HTTP loopback) |
| --- | --- | --- |
| mean | ~0.03 ms | 0.371 ms |
| p50 | ~0.02 ms | 0.196 ms |
| **p95** | **~0.03 ms** | **1.071 ms** |
| p99 | ~0.06 ms | 2.614 ms |
| max | — | 73.6 ms (first-call JIT/connect warmup) |

**Why so fast:** a cache HIT is a single `Map.get` of a pre-derived top-K list —
no scanning, no sorting at read time. Sorting happens once, off the read path,
in the cache-updater.

## 2. Cache hit rate

| Metric | Value |
| --- | --- |
| Hit rate (after short-prefix warmup, realistic prefix mix) | **99.9%** |

Short prefixes (1–2 chars) are pre-warmed at startup; the long tail is filled
lazily on first miss (`source: "db"`) and served from cache thereafter. TTL
(60 s) + updater refresh keep entries from going stale.

## 3. Write reduction from batching — §8

Drove **1,000 searches** over **20 distinct queries**, then read `/metrics`:

| Metric | Value |
| --- | --- |
| Searches recorded (would-be writes) | 1,000 |
| Actual writes to source of truth | 20 |
| **Write reduction** | **50× (98.0%)** |

The buffer coalesces repeated queries (a `Map` of query → delta), so 1,000
increments collapse into 20 batched UPSERT-equivalents. The factor scales with
traffic skew: the more repeats between flushes, the higher the reduction (a
busier system does *better*, not worse).

**Failure trade-off (the honest part §8 asks for):** the buffer is in memory. A
crash between flushes loses at most `BATCH_SIZE − 1` searches (or one
`FLUSH_INTERVAL_MS` window). Mitigations in place: flush on `SIGINT`/`SIGTERM`,
and every flush appends to an on-disk WAL that is replayed on boot. We accept the
tiny residual loss because counts are approximate popularity signals — losing a
few increments out of millions can't change a top-10.

## 4. Consistent-hashing distribution — §6

Hashed 30,000 synthetic keys across 3 shards (150 virtual nodes each):

| Shard | Keys | Share |
| --- | --- | --- |
| shard-0 | 8,886 | 29.6% |
| shard-1 | 10,292 | 34.3% |
| shard-2 | 10,822 | 36.1% |

Reasonably balanced (virtual nodes smooth the ring). **Stability test**
(`npm test`): adding a 4th shard re-maps only **~25%** of keys — vs **~75%** for
naive `hash(key) % N`. That stability is the entire reason consistent hashing is
used.

## 5. Recency ranking — §7 (qualitative)

`npm run demo:recency` bursts a low-ranked query 200× and prints basic vs recency
side by side:

```
Prefix "ap" — AFTER burst:
  basic   : [apple console waterproof, apple desk for gaming, apple shoes 2024]   (unchanged)
  recency : [apple keyboard ultra (recent=200), apple console waterproof, ...]    (promoted)
```

Basic ordering is untouched (all-time `count`); the bursting query jumps to #1 in
recency. Because the updater decays `recent_count`, it then fades back to its true
all-time rank over time — it can't be permanently over-ranked.

## How to reproduce

```bash
cd backend
npm install
npm run generate     # if data/queries.csv doesn't exist
npm start            # terminal 1
npm run bench        # terminal 2  -> prints the tables above
npm test             # consistent-hash stability proof
npm run demo:recency # §7 before/after
```
