/**
 * consistentHash.js — A consistent-hashing ring.
 *
 * THE PROBLEM IT SOLVES:
 * We have several cache nodes and need to decide which node owns a given key
 * (a prefix like "ip"). The naive way is `nodeIndex = hash(key) % N`. That
 * works until N changes: add or remove one node and almost EVERY key remaps to
 * a different node, so the whole cache is invalidated at once (a "cache
 * stampede" against the DB).
 *
 * THE FIX — a hash ring:
 * Imagine a circle of positions 0 .. 2^32. We hash each node to several points
 * on the circle ("virtual nodes"). To place a key, we hash the key to a point
 * and walk clockwise to the first node we hit — that node owns the key.
 * Add/remove a node and only the keys in the arc next to it move; everyone else
 * stays put. Virtual nodes spread each physical node around the ring so load is
 * even instead of lumpy.
 */

import { createHash } from 'node:crypto';

/** Stable 32-bit hash of a string (first 8 hex chars of an MD5 digest). */
function hash32(str) {
  return parseInt(createHash('md5').update(str).digest('hex').slice(0, 8), 16);
}

export class ConsistentHashRing {
  /**
   * @param {string[]} nodes  initial physical node ids, e.g. ["cache-0", ...]
   * @param {number} vnodes   virtual points per physical node (higher = smoother)
   */
  constructor(nodes = [], vnodes = 150) {
    this.vnodes = vnodes;
    this.ring = new Map(); // ringPosition -> physical node id
    this.sortedKeys = []; // sorted ring positions, for binary search
    for (const n of nodes) this.addNode(n);
  }

  addNode(node) {
    for (let i = 0; i < this.vnodes; i++) {
      const pos = hash32(`${node}#${i}`);
      this.ring.set(pos, node);
    }
    this._resort();
  }

  removeNode(node) {
    for (let i = 0; i < this.vnodes; i++) {
      this.ring.delete(hash32(`${node}#${i}`));
    }
    this._resort();
  }

  _resort() {
    this.sortedKeys = [...this.ring.keys()].sort((a, b) => a - b);
  }

  /** Which physical node owns `key`? Walk clockwise to the next ring point. */
  getNode(key) {
    if (this.sortedKeys.length === 0) return null;
    const h = hash32(String(key));
    const idx = this._firstAtOrAfter(h);
    // Wrap around: if past the last point, the first point owns it.
    const pos = idx === this.sortedKeys.length ? this.sortedKeys[0] : this.sortedKeys[idx];
    return this.ring.get(pos);
  }

  /** Binary search: index of the smallest ring position >= h. */
  _firstAtOrAfter(h) {
    let lo = 0;
    let hi = this.sortedKeys.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.sortedKeys[mid] < h) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Distribution stats — how many of `sampleKeys` land on each node. */
  distribution(sampleKeys) {
    const counts = {};
    for (const k of sampleKeys) {
      const n = this.getNode(k);
      counts[n] = (counts[n] || 0) + 1;
    }
    return counts;
  }
}
