/**
 * metrics.js — Lightweight latency recorder for the suggestions endpoint.
 *
 * We keep a ring buffer of the most recent N latency samples (in ms) and compute
 * percentiles on demand. p95 is the value below which 95% of requests fall — a
 * better "typical worst case" than the average, which hides spikes. The ring
 * buffer bounds memory and naturally reflects recent behavior.
 */

export class LatencyMeter {
  constructor(capacity = 5000) {
    this.capacity = capacity;
    this.samples = [];
    this.idx = 0;
  }

  record(ms) {
    if (this.samples.length < this.capacity) this.samples.push(ms);
    else this.samples[this.idx] = ms; // overwrite oldest
    this.idx = (this.idx + 1) % this.capacity;
  }

  _percentile(sorted, p) {
    if (sorted.length === 0) return 0;
    const rank = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)];
  }

  report() {
    const sorted = [...this.samples].sort((a, b) => a - b);
    const n = sorted.length;
    const avg = n === 0 ? 0 : sorted.reduce((s, x) => s + x, 0) / n;
    return {
      count: n,
      avgMs: Number(avg.toFixed(3)),
      p50Ms: Number(this._percentile(sorted, 50).toFixed(3)),
      p95Ms: Number(this._percentile(sorted, 95).toFixed(3)),
      p99Ms: Number(this._percentile(sorted, 99).toFixed(3)),
      maxMs: Number((sorted[n - 1] || 0).toFixed(3)),
    };
  }
}
