/**
 * hashRing.test.js — Consistent-hashing guarantees (run: npm test).
 *
 * Verifies the two properties the whole cache distribution relies on:
 *   1. DETERMINISM   — the same key always maps to the same shard.
 *   2. BALANCE       — keys spread roughly evenly across shards.
 *   3. STABILITY     — adding a shard only moves a small fraction of keys
 *                      (the entire point of consistent hashing vs hash % N).
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { ConsistentHashRing } from '../src/consistentHash.js';

const keys = Array.from({ length: 10000 }, (_, i) => `key-${i}`);

test('routing is deterministic', () => {
  const ring = new ConsistentHashRing(['a', 'b', 'c']);
  for (const k of keys.slice(0, 500)) {
    assert.equal(ring.getNode(k), ring.getNode(k));
  }
});

test('load is reasonably balanced across shards', () => {
  const ring = new ConsistentHashRing(['a', 'b', 'c']);
  const dist = ring.distribution(keys);
  const ideal = keys.length / 3;
  for (const count of Object.values(dist)) {
    // Each shard within 35% of the ideal share (150 vnodes smooths it out).
    assert.ok(Math.abs(count - ideal) < ideal * 0.35, `shard off-balance: ${count} vs ideal ${ideal}`);
  }
});

test('adding a shard remaps only a small fraction of keys', () => {
  const ring = new ConsistentHashRing(['a', 'b', 'c']);
  const before = new Map(keys.map((k) => [k, ring.getNode(k)]));
  ring.addNode('d');
  let moved = 0;
  for (const k of keys) if (ring.getNode(k) !== before.get(k)) moved++;
  const fraction = moved / keys.length;
  // With 4 shards, ~1/4 of keys should move. Naive hash%N would move ~3/4.
  assert.ok(fraction < 0.35, `too many keys moved: ${(fraction * 100).toFixed(1)}%`);
  console.log(`  adding a 4th shard moved ${(fraction * 100).toFixed(1)}% of keys (hash%N would move ~75%)`);
});
