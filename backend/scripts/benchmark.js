/**
 * benchmark.js — Measures suggestion latency (p50/p95/p99), cache hit rate, and
 * batch write reduction against a RUNNING server. Powers PERFORMANCE.md.
 *
 * Run the server first (npm start), then: npm run bench
 */

const BASE = process.env.BASE || 'http://localhost:4000';
const N = Number(process.env.N || 5000);

const PREFIXES = ['a', 'ap', 'app', 'sa', 'sam', 'so', 'de', 'hp', 'le', 'ni', 'nik', 'go', 'mi', 'xi', 'lo', 'ra', 'in', 'am', 'as', 'ac'];

function percentile(sorted, p) {
  const i = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(Math.max(i, 0), sorted.length - 1)];
}

async function main() {
  console.log(`Benchmarking ${BASE} with ${N} /suggest requests...\n`);

  // Warm + measure latency over a realistic prefix mix.
  const samples = [];
  for (let i = 0; i < N; i++) {
    const q = PREFIXES[i % PREFIXES.length];
    const t0 = process.hrtime.bigint();
    await fetch(`${BASE}/suggest?q=${q}`);
    samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  samples.sort((a, b) => a - b);

  console.log('--- /suggest latency (client-side, includes HTTP) ---');
  console.log(`  count : ${samples.length}`);
  console.log(`  mean  : ${(samples.reduce((s, x) => s + x, 0) / samples.length).toFixed(3)} ms`);
  console.log(`  p50   : ${percentile(samples, 50).toFixed(3)} ms`);
  console.log(`  p95   : ${percentile(samples, 95).toFixed(3)} ms`);
  console.log(`  p99   : ${percentile(samples, 99).toFixed(3)} ms`);
  console.log(`  max   : ${samples[samples.length - 1].toFixed(3)} ms`);

  // Drive some searches to demonstrate batch write reduction.
  console.log('\n--- driving 1000 searches over 20 distinct queries (batch test) ---');
  const writeQueries = PREFIXES.map((p) => `${p} bench query`);
  await Promise.all(
    Array.from({ length: 1000 }, (_, i) =>
      fetch(`${BASE}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: writeQueries[i % writeQueries.length] }),
      })
    )
  );
  await new Promise((r) => setTimeout(r, 2500)); // let the batch flush

  const m = await (await fetch(`${BASE}/metrics`)).json();
  console.log('\n--- server /metrics snapshot ---');
  console.log(`  server-side suggest p95 : ${m.suggestLatency.p95Ms} ms`);
  console.log(`  cache hit rate          : ${(m.cache.hitRate * 100).toFixed(1)}%`);
  console.log(`  searches recorded       : ${m.batchWriter.searchesRecorded}`);
  console.log(`  source writes           : ${m.batchWriter.sourceWrites}`);
  console.log(`  write reduction         : ${m.batchWriter.writeReductionFactor} (${m.batchWriter.writeReductionPct})`);
  console.log(`  dataset size            : ${m.datasetSize.toLocaleString()}`);

  // Consistent-hash balance.
  const d = await (await fetch(`${BASE}/ring/distribution?n=30000`)).json();
  console.log('\n--- consistent-hash distribution (30k keys) ---');
  for (const [shard, c] of Object.entries(d.perShard)) {
    console.log(`  ${shard}: ${c} keys (${((100 * c) / 30000).toFixed(1)}%)`);
  }
}

main().catch((e) => {
  console.error('Benchmark failed — is the server running? (npm start)\n', e.message);
  process.exit(1);
});
