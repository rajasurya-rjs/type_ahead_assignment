/**
 * batchWriter.js — Absorbs the write storm from search submissions.
 *
 * THE PROBLEM:
 * Every POST /search wants to bump a query's count. Writing to the source of
 * truth synchronously per request = one DB write per search — a bottleneck.
 *
 * THE APPROACH (write-behind / coalescing buffer):
 *   1. record(query) adds +1 to an in-memory buffer Map. O(1), no I/O.
 *   2. Repeated queries AGGREGATE: 50 searches for "iphone" collapse to +50.
 *   3. A flush applies the whole buffer to the source of truth in ONE batch
 *      (UPSERT-equivalent), bumps the trending board, and appends to the WAL.
 *      The source marks affected prefixes dirty; the cache-updater refreshes
 *      their caches asynchronously.
 *   4. Flush fires on a timer OR when the buffer hits BATCH_SIZE.
 *
 * WRITE REDUCTION: R searches over U distinct queries between flushes => U
 * source writes instead of R. Both counters are exposed for the perf report.
 *
 * FAILURE TRADE-OFF (viva-ready):
 * The buffer is in memory. A crash between flushes loses the buffered window
 * (up to BATCH_SIZE-1 searches / one interval). We accept it because counts are
 * approximate popularity signals — losing a few increments out of millions can't
 * change a top-K. Mitigations: flush on SIGINT/SIGTERM (we do); smaller batch =
 * less at risk; a true WAL-before-buffer would make it fully durable at a write
 * cost. The knobs make the durability vs throughput trade explicit.
 */

import { config } from './config.js';

export class BatchWriter {
  /**
   * @param {object} deps
   * @param {import('./sourceOfTruth.js').SourceOfTruth} deps.source
   * @param {import('./cluster.js').CacheCluster} deps.cluster   for trending bumps
   * @param {(query:string, delta:number)=>void} [deps.onApplied]  WAL hook
   */
  constructor({ source, cluster, onApplied }) {
    this.source = source;
    this.cluster = cluster;
    this.onApplied = onApplied;
    this.buffer = new Map(); // query -> pending delta
    this.stats = { searchesRecorded: 0, sourceWrites: 0, flushes: 0, lastFlushSize: 0 };
    this.timer = null;
  }

  start() {
    this.timer = setInterval(() => this.flush('interval'), config.FLUSH_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.flush('shutdown'); // best-effort durability on graceful exit
  }

  /** Buffer one search; trigger a size-based flush when the buffer is full. */
  record(query) {
    const q = query.toLowerCase().trim();
    if (!q) return;
    this.buffer.set(q, (this.buffer.get(q) || 0) + 1);
    this.stats.searchesRecorded++;
    if (this.buffer.size >= config.BATCH_SIZE) this.flush('size');
  }

  /** Apply the whole buffer to the source of truth + trending + WAL in one pass. */
  flush(reason = 'manual') {
    if (this.buffer.size === 0) return { applied: 0, reason };
    const batch = this.buffer;
    this.buffer = new Map(); // swap out so new searches keep buffering

    // 1) Source of truth: bump count + recent_count, mark prefixes dirty.
    this.source.applyBatch(batch);

    // 2) Trending board (per-shard) + WAL durability.
    for (const [query, delta] of batch) {
      this.cluster.incrTrending(query, delta);
      this.onApplied?.(query, delta);
      this.stats.sourceWrites++;
    }

    this.stats.flushes++;
    this.stats.lastFlushSize = batch.size;
    return { applied: batch.size, reason };
  }

  report() {
    const { searchesRecorded, sourceWrites } = this.stats;
    return {
      ...this.stats,
      pendingInBuffer: this.buffer.size,
      writeReductionFactor:
        sourceWrites === 0 ? '0x' : `${(searchesRecorded / sourceWrites).toFixed(1)}x`,
      writeReductionPct:
        searchesRecorded === 0
          ? '0%'
          : `${(100 * (1 - sourceWrites / searchesRecorded)).toFixed(1)}%`,
    };
  }
}
