import { useState, useEffect, useRef, useCallback } from 'react';
import { fetchSuggestions, submitSearch, fetchTrending, fetchCacheDebug } from './api.js';

const DEBOUNCE_MS = 150; // wait this long after the last keystroke before calling the API

// Highlight the typed prefix inside a suggestion.
function Highlighted({ text, prefix }) {
  if (!prefix || !text.toLowerCase().startsWith(prefix.toLowerCase())) return <>{text}</>;
  return (
    <>
      <strong>{text.slice(0, prefix.length)}</strong>
      {text.slice(prefix.length)}
    </>
  );
}

export default function App() {
  const [query, setQuery] = useState('');
  const [rank, setRank] = useState('basic'); // 'basic' | 'recency'
  const [suggestions, setSuggestions] = useState([]);
  const [meta, setMeta] = useState(null); // { source, latencyMs }
  const [active, setActive] = useState(-1); // highlighted suggestion index
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [searchResult, setSearchResult] = useState(null); // dummy {message:"Searched"}
  const [trending, setTrending] = useState([]);
  const [cacheDebug, setCacheDebug] = useState(null);

  const abortRef = useRef(null);
  const debounceRef = useRef(null);

  // --- Debounced suggestion fetching -----------------------------------------
  const runSuggest = useCallback(
    (q, r) => {
      if (!q.trim()) {
        setSuggestions([]);
        setMeta(null);
        setOpen(false);
        return;
      }
      abortRef.current?.abort(); // cancel any in-flight request
      const controller = new AbortController();
      abortRef.current = controller;
      setLoading(true);
      setError(null);
      fetchSuggestions(q.trim(), r, controller.signal)
        .then((data) => {
          setSuggestions(data.suggestions);
          setMeta({ source: data.source, latencyMs: data.latencyMs });
          setOpen(true);
          setActive(-1);
        })
        .catch((e) => {
          if (e.name !== 'AbortError') setError('Could not load suggestions.');
        })
        .finally(() => setLoading(false));
    },
    []
  );

  useEffect(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => runSuggest(query, rank), DEBOUNCE_MS);
    return () => clearTimeout(debounceRef.current);
  }, [query, rank, runSuggest]);

  // --- Trending board (polls every 4s) ---------------------------------------
  useEffect(() => {
    let alive = true;
    const load = () => fetchTrending(10).then((d) => alive && setTrending(d.trending)).catch(() => {});
    load();
    const id = setInterval(load, 4000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  // --- Submit a search -------------------------------------------------------
  async function doSearch(q) {
    const term = (q ?? query).trim();
    if (!term) return;
    setOpen(false);
    try {
      const res = await submitSearch(term); // returns {message:"Searched"}
      setSearchResult({ ...res, at: new Date().toLocaleTimeString() });
      // Show which cache shard owns this prefix (debug panel).
      fetchCacheDebug(term.slice(0, 3)).then(setCacheDebug).catch(() => {});
    } catch {
      setError('Search request failed.');
    }
  }

  // --- Keyboard navigation ---------------------------------------------------
  function onKeyDown(e) {
    if (!open || suggestions.length === 0) {
      if (e.key === 'Enter') doSearch();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, -1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const chosen = active >= 0 ? suggestions[active].query : query;
      setQuery(chosen);
      doSearch(chosen);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  return (
    <div className="page">
      <header>
        <h1>🔎 Search Typeahead</h1>
        <p className="sub">
          Sharded cache (consistent hashing) · write-behind batching · recency-aware ranking
        </p>
      </header>

      <div className="rank-toggle">
        <span>Ranking:</span>
        <button className={rank === 'basic' ? 'on' : ''} onClick={() => setRank('basic')}>
          Basic (all-time count)
        </button>
        <button className={rank === 'recency' ? 'on' : ''} onClick={() => setRank('recency')}>
          Recency-aware (§7)
        </button>
      </div>

      <div className="search-wrap">
        <div className="input-row">
          <input
            autoFocus
            value={query}
            placeholder="Start typing… e.g. apple, samsung, nike"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            onFocus={() => suggestions.length && setOpen(true)}
          />
          <button className="go" onClick={() => doSearch()}>
            Search
          </button>
        </div>

        {loading && <div className="status">Loading…</div>}
        {error && <div className="status err">{error}</div>}

        {open && suggestions.length > 0 && (
          <ul className="dropdown" role="listbox">
            {suggestions.map((s, i) => (
              <li
                key={s.query}
                role="option"
                aria-selected={i === active}
                className={i === active ? 'active' : ''}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  setQuery(s.query);
                  doSearch(s.query);
                }}
              >
                <span className="q">
                  <Highlighted text={s.query} prefix={query.trim()} />
                </span>
                <span className="meta">
                  {rank === 'recency' && s.recentCount ? (
                    <span className="recent">▲ {s.recentCount} recent</span>
                  ) : null}
                  <span className="count">{s.count.toLocaleString()}</span>
                </span>
              </li>
            ))}
          </ul>
        )}

        {open && !loading && query.trim() && suggestions.length === 0 && (
          <div className="status">No suggestions for “{query.trim()}”.</div>
        )}

        {meta && (
          <div className="latency">
            served from <b>{meta.source === 'cache' ? 'cache (HIT)' : 'source of truth (MISS)'}</b>{' '}
            in {meta.latencyMs} ms
          </div>
        )}
      </div>

      {searchResult && (
        <div className="card search-result">
          <h3>Search response</h3>
          <pre>{JSON.stringify({ message: searchResult.message, query: searchResult.query }, null, 2)}</pre>
          <span className="ts">submitted at {searchResult.at}</span>
          {cacheDebug && (
            <div className="debug">
              prefix <code>{cacheDebug.prefix}</code> is owned by{' '}
              <b>{cacheDebug.ownerShard}</b> — basic: {cacheDebug.basic.status}, recency:{' '}
              {cacheDebug.recency.status}
            </div>
          )}
        </div>
      )}

      <div className="card trending">
        <h3>🔥 Trending right now</h3>
        {trending.length === 0 ? (
          <p className="muted">No trending searches yet — submit a few searches to see them here.</p>
        ) : (
          <ol>
            {trending.map((t) => (
              <li key={t.query} onClick={() => { setQuery(t.query); doSearch(t.query); }}>
                <span>{t.query}</span>
                <span className="score">{t.score}</span>
              </li>
            ))}
          </ol>
        )}
      </div>

      <footer>
        <p>
          Try: type <code>ap</code> (cache HIT), then switch to <b>Recency-aware</b> and search a
          niche query a few times — watch it climb.
        </p>
      </footer>
    </div>
  );
}
