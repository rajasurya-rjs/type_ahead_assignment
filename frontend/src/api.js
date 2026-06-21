// api.js — thin wrapper over the backend. All calls go through the Vite /api proxy.

const BASE = '/api';

export async function fetchSuggestions(prefix, rank, signal) {
  const url = `${BASE}/suggest?q=${encodeURIComponent(prefix)}&rank=${rank}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`suggest failed: ${res.status}`);
  return res.json(); // { prefix, rank, source, latencyMs, suggestions }
}

export async function submitSearch(query) {
  const res = await fetch(`${BASE}/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`search failed: ${res.status}`);
  return res.json(); // { message: "Searched", query }
}

export async function fetchTrending(n = 10) {
  const res = await fetch(`${BASE}/trending?n=${n}`);
  if (!res.ok) throw new Error(`trending failed: ${res.status}`);
  return res.json(); // { trending: [{query, score}] }
}

export async function fetchCacheDebug(prefix) {
  const res = await fetch(`${BASE}/cache/debug?prefix=${encodeURIComponent(prefix)}`);
  if (!res.ok) throw new Error(`cache/debug failed: ${res.status}`);
  return res.json();
}
