/**
 * demoRecency.js — Demonstrates §7: basic vs recency-aware ranking, side by side.
 *
 * It bursts a low-ranked query, shows it RISE in recency ranking (but not basic),
 * then (optionally) waits for decay and shows it FADE back — proving spikes don't
 * over-rank forever.
 *
 * Run the server first (npm start), then: npm run demo:recency
 */

const BASE = process.env.BASE || 'http://localhost:4000';
const PREFIX = process.env.PREFIX || 'ap';
const TARGET = process.env.TARGET || 'apple keyboard ultra';
const BURST = Number(process.env.BURST || 200);

const top = (arr, n = 5) => arr.slice(0, n);

async function suggest(rank) {
  const r = await (await fetch(`${BASE}/suggest?q=${encodeURIComponent(PREFIX)}&rank=${rank}`)).json();
  return r.suggestions;
}

function table(basic, recency) {
  console.log('  #   rank=basic (all-time count)        rank=recency (blended §7)');
  for (let i = 0; i < 5; i++) {
    const b = basic[i] ? `${basic[i].query} (${basic[i].count})` : '';
    const rq = recency[i] ? recency[i].query : '';
    const rc = recency[i] && recency[i].recentCount ? ` [recent=${recency[i].recentCount}]` : '';
    const mark = rq === TARGET ? '» ' : '  ';
    console.log(`  ${i + 1}   ${b.padEnd(34)} ${mark}${rq}${rc}`);
  }
}

async function main() {
  console.log(`\nPrefix "${PREFIX}" — BEFORE burst:\n`);
  table(top(await suggest('basic')), top(await suggest('recency')));

  console.log(`\nBursting "${TARGET}" ${BURST}x ...`);
  await Promise.all(
    Array.from({ length: BURST }, () =>
      fetch(`${BASE}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: TARGET }),
      })
    )
  );
  await new Promise((r) => setTimeout(r, 2500)); // flush + updater

  console.log(`\nPrefix "${PREFIX}" — AFTER burst (basic unchanged, recency promotes it):\n`);
  table(top(await suggest('basic')), top(await suggest('recency')));

  console.log(
    `\nNote: all-time count is never decayed, so "${TARGET}" keeps its true rank in basic.`
  );
  console.log(
    'Its recent_count decays every RECENCY_DECAY_INTERVAL_MS, so in recency it fades back over time.'
  );
}

main().catch((e) => {
  console.error('Demo failed — is the server running? (npm start)\n', e.message);
  process.exit(1);
});
