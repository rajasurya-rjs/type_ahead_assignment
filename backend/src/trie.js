/**
 * trie.js — Primary data store for query → count.
 *
 * WHY A TRIE?
 * A typeahead must answer "give me queries starting with <prefix>" on every
 * keystroke. If we kept queries in a flat list, every lookup would scan all
 * 100k+ rows. A Trie (prefix tree) lets us walk straight to the prefix node in
 * O(prefix length) and then read suggestions from the subtree below it.
 *
 * KEY OPTIMIZATION — top-K per node:
 * Walking the whole subtree under a short prefix like "i" could touch tens of
 * thousands of nodes. So each node caches the best `K` queries living beneath
 * it (sorted by count). We maintain this list incrementally on every insert /
 * increment, so a /suggest read is just "walk to node, read its topK array".
 * That turns reads into O(prefix length + K).
 */

const K = 30; // candidates cached per node (>10 so trending can re-rank a pool)

class TrieNode {
  constructor() {
    this.children = new Map(); // char -> TrieNode
    this.isWord = false;
    this.query = null; // the full query string, set on the terminal node
    this.count = 0; // search count for this exact query
    this.top = []; // cached top-K {query, count} in this subtree, desc by count
  }
}

export class Trie {
  constructor() {
    this.root = new TrieNode();
    this.size = 0; // number of distinct queries
  }

  /**
   * Insert a query or set its count. Used during dataset load.
   * Records the path so we can refresh each ancestor's top-K list.
   */
  insert(query, count) {
    const q = query.toLowerCase();
    let node = this.root;
    const path = [this.root];
    for (const ch of q) {
      if (!node.children.has(ch)) node.children.set(ch, new TrieNode());
      node = node.children.get(ch);
      path.push(node);
    }
    if (!node.isWord) this.size++;
    node.isWord = true;
    node.query = q;
    node.count = count;
    // Refresh top-K along the path from root to this word.
    for (const n of path) this._bubble(n, q, count);
  }

  /**
   * Fast bulk load for dataset ingestion.
   *
   * Inserting one-by-one re-sorts the top-K at every node on every insert
   * (O(queries · prefix-len · K log K)). Instead we first place all counts with
   * NO top-K maintenance, then compute every node's top-K in a single post-order
   * pass that merges each node's children — each node is sorted exactly once.
   * This turns a ~2-minute load into a couple of seconds.
   *
   * @param {Array<[string, number]>} entries  [query, count] pairs
   */
  bulkInsert(entries) {
    for (const [query, count] of entries) {
      const q = query.toLowerCase();
      let node = this.root;
      for (const ch of q) {
        if (!node.children.has(ch)) node.children.set(ch, new TrieNode());
        node = node.children.get(ch);
      }
      if (!node.isWord) this.size++;
      node.isWord = true;
      node.query = q;
      node.count = count;
    }
    this._rebuildTop(this.root);
  }

  /** Post-order: a node's top-K = top-K of (itself + all children's top-K). */
  _rebuildTop(node) {
    const merged = [];
    if (node.isWord) merged.push({ query: node.query, count: node.count });
    for (const child of node.children.values()) {
      this._rebuildTop(child); // children computed first
      for (const e of child.top) merged.push(e); // child.top already sorted, ≤ K
    }
    merged.sort((a, b) => b.count - a.count);
    if (merged.length > K) merged.length = K;
    node.top = merged;
  }

  /**
   * Increment an existing query's count by `delta` (or insert if new).
   * Called by the batch writer when flushing buffered searches.
   */
  increment(query, delta = 1) {
    const q = query.toLowerCase();
    let node = this.root;
    const path = [this.root];
    for (const ch of q) {
      if (!node.children.has(ch)) node.children.set(ch, new TrieNode());
      node = node.children.get(ch);
      path.push(node);
    }
    if (!node.isWord) {
      this.size++;
      node.isWord = true;
      node.query = q;
    }
    node.count += delta;
    for (const n of path) this._bubble(n, q, node.count);
    return node.count;
  }

  /**
   * Insert/update {query,count} into a node's cached top-K list.
   * The list stays sorted desc by count and capped at K entries.
   */
  _bubble(node, query, count) {
    const top = node.top;
    const i = top.findIndex((e) => e.query === query);
    if (i !== -1) top[i].count = count;
    else top.push({ query, count });
    top.sort((a, b) => b.count - a.count);
    if (top.length > K) top.length = K;
  }

  /** Walk to the node representing `prefix`, or null if no such path. */
  _node(prefix) {
    let node = this.root;
    for (const ch of prefix) {
      if (!node.children.has(ch)) return null;
      node = node.children.get(ch);
    }
    return node;
  }

  /**
   * Candidate suggestions for a prefix: up to K {query,count}, sorted by count.
   * The caller (suggestion service) takes 10 directly, or re-ranks for trending.
   */
  suggest(prefix) {
    const p = (prefix || '').toLowerCase();
    const node = this._node(p);
    if (!node) return [];
    return node.top.map((e) => ({ query: e.query, count: e.count }));
  }

  /** Current stored count for an exact query (0 if absent). */
  getCount(query) {
    const node = this._node((query || '').toLowerCase());
    return node && node.isWord ? node.count : 0;
  }
}
