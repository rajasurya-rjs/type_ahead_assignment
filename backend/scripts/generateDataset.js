/**
 * generateDataset.js — Produces data/queries.csv with 100k+ (query,count) rows.
 *
 * The assignment allows any open-source-style dataset with a count per query.
 * To keep the project runnable offline, we synthesize a realistic e-commerce /
 * search corpus by combining brands x products x modifiers. Counts follow a
 * ZIPF distribution (rank^-s): a handful of head queries are hugely popular and
 * a long tail is rare — the shape real search traffic actually has. This is
 * what makes "sorted by count" meaningful.
 *
 * To use a REAL dataset instead, just drop a CSV with a `query,count` header at
 * backend/data/queries.csv and skip this script. See README "Dataset".
 *
 * Run:  npm run generate
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'data', 'queries.csv');

const brands = [
  'apple', 'samsung', 'sony', 'dell', 'hp', 'lenovo', 'asus', 'acer', 'lg', 'nike',
  'adidas', 'puma', 'canon', 'nikon', 'bose', 'jbl', 'xiaomi', 'oneplus', 'google',
  'microsoft', 'amazon', 'logitech', 'razer', 'intel', 'amd', 'nvidia', 'huawei',
  'oppo', 'vivo', 'realme', 'motorola', 'nokia', 'philips', 'panasonic', 'toshiba',
  'sandisk', 'seagate', 'corsair', 'anker', 'belkin',
];

const products = [
  'phone', 'laptop', 'tablet', 'charger', 'cable', 'headphones', 'earbuds', 'speaker',
  'mouse', 'keyboard', 'monitor', 'webcam', 'router', 'ssd', 'hard drive', 'power bank',
  'smartwatch', 'tv', 'camera', 'lens', 'tripod', 'microphone', 'gpu', 'cpu', 'ram',
  'motherboard', 'cooler', 'case', 'shoes', 'sneakers', 'backpack', 'jacket', 'watch',
  'sunglasses', 'wallet', 'controller', 'console', 'projector', 'printer', 'scanner',
  'dock', 'hub', 'adapter', 'stand', 'mount', 'sd card', 'usb drive', 'battery',
  'fan', 'light', 'lamp', 'desk', 'chair', 'phone case', 'screen protector',
  'stylus', 'remote', 'bluetooth speaker', 'gaming chair', 'mechanical keyboard',
];

const modifiers = [
  '', 'pro', 'max', 'mini', 'plus', 'ultra', 'lite', 'air', '2024', '2025', 'wireless',
  'bluetooth', 'usb c', 'fast charging', 'cheap', 'best', 'budget', 'premium', 'gaming',
  'portable', 'rgb', '4k', 'hd', 'noise cancelling', 'waterproof', 'review', 'price',
  'deals', 'black', 'white', 'silver', 'gold', 'red', 'blue', 'case', 'cover', 'stand',
  'for laptop', 'for phone', 'for gaming', 'for travel', 'with mic', 'under 100',
  'under 50', 'refurbished', 'new', 'original', 'replacement', 'set', 'kit', 'bundle',
];

// Small deterministic PRNG so re-runs are reproducible (seeded LCG).
let seed = 1234567;
function rand() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}

// Build a de-duplicated set of queries.
const set = new Set();
for (const b of brands) {
  set.add(b);
  for (const p of products) {
    set.add(`${b} ${p}`);
    for (const m of modifiers) {
      if (m) set.add(`${b} ${p} ${m}`);
    }
  }
}
for (const p of products) {
  set.add(p);
  for (const m of modifiers) if (m) set.add(`${p} ${m}`);
}

let queries = [...set];

// Shuffle so popularity rank is independent of alphabetical order.
for (let i = queries.length - 1; i > 0; i--) {
  const j = Math.floor(rand() * (i + 1));
  [queries[i], queries[j]] = [queries[j], queries[i]];
}

// Zipf counts: count(rank) = floor(C / rank^s) with a little noise, min 1.
const s = 1.05;
const C = 2_000_000;
const rows = ['query,count'];
queries.forEach((q, i) => {
  const rank = i + 1;
  const base = C / Math.pow(rank, s);
  const noisy = base * (0.6 + 0.8 * rand()); // +/- noise so ties break naturally
  const count = Math.max(1, Math.round(noisy));
  // CSV-escape queries containing commas (a few do, e.g. none here, but be safe).
  const cell = q.includes(',') ? `"${q}"` : q;
  rows.push(`${cell},${count}`);
});

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, rows.join('\n'), 'utf8');
console.log(`Wrote ${queries.length.toLocaleString()} queries to ${OUT}`);
console.log('Sample (head queries by count):');
const sorted = rows.slice(1).map((r) => r.split(',')).sort((a, b) => +b[1] - +a[1]);
for (const [q, c] of sorted.slice(0, 8)) console.log(`  ${c.padStart(8)}  ${q}`);
