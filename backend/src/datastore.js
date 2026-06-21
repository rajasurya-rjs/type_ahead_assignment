/**
 * datastore.js — Loads the dataset into the Trie and gives the counts durability.
 *
 * Two files back the primary store:
 *   1. data/queries.csv  — the immutable base dataset (query,count).
 *   2. data/wal.log      — an append-only Write-Ahead Log of count deltas applied
 *                          since load, one "query<TAB>delta" line per flush entry.
 *
 * On boot we load the CSV, then REPLAY the WAL so any counts accumulated before
 * the last shutdown/crash are restored. The batch writer appends to the WAL when
 * it flushes, so a crash loses at most the in-memory buffer (not yet flushed) —
 * exactly the trade-off documented in batchWriter.js.
 */

import { readFileSync, existsSync, appendFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
export const CSV_PATH = join(DATA_DIR, 'queries.csv');
export const WAL_PATH = join(DATA_DIR, 'wal.log');

/** Parse one CSV line into [query, count], handling a quoted query cell. */
function parseCsvLine(line) {
  if (line.startsWith('"')) {
    const end = line.indexOf('"', 1);
    return [line.slice(1, end), Number(line.slice(end + 2))];
  }
  const i = line.lastIndexOf(',');
  return [line.slice(0, i), Number(line.slice(i + 1))];
}

/** Load the base CSV into the source of truth. Returns the row count. */
export function loadDataset(source) {
  if (!existsSync(CSV_PATH)) {
    throw new Error(
      `Dataset not found at ${CSV_PATH}. Run "npm run generate" (or drop your own queries.csv there).`
    );
  }
  const text = readFileSync(CSV_PATH, 'utf8');
  const lines = text.split('\n');
  const entries = [];
  for (let i = 1; i < lines.length; i++) {
    // skip header
    const line = lines[i].trim();
    if (!line) continue;
    const [query, count] = parseCsvLine(line);
    if (query && Number.isFinite(count)) entries.push([query, count]);
  }
  source.loadBulk(entries); // single fast bottom-up build
  return entries.length;
}

/**
 * Replay the WAL so previously-flushed count deltas are restored after a restart.
 * Only the permanent `count` is replayed — `recent_count` is a transient signal
 * that decays anyway, so it's intentionally not persisted.
 */
export function replayWal(source) {
  if (!existsSync(WAL_PATH)) return 0;
  const text = readFileSync(WAL_PATH, 'utf8');
  let n = 0;
  for (const line of text.split('\n')) {
    if (!line) continue;
    const tab = line.lastIndexOf('\t');
    const query = line.slice(0, tab);
    const delta = Number(line.slice(tab + 1));
    if (query && Number.isFinite(delta)) {
      source.trie.increment(query, delta);
      n++;
    }
  }
  return n;
}

/** Append one applied delta to the WAL (called from the batch writer flush). */
export function appendWal(query, delta) {
  appendFileSync(WAL_PATH, `${query}\t${delta}\n`);
}

/** Optional: truncate the WAL (e.g. after compacting into the CSV). */
export function resetWal() {
  writeFileSync(WAL_PATH, '');
}
