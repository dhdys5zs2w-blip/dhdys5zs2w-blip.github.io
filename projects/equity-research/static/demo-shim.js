/* Portfolio demo shim for the qe research browser.
 *
 * The real app fetches JSON from /api/*; this static copy has no server, so app.js is patched to
 * route every fetch through QE_DEMO.fetch, which resolves the same URLs to files under data/ and
 * decodes the compact per-symbol bundles written by tools/export_demo.py back into the exact
 * payload shapes the page scripts expect. Runs in the browser and (for the verifier) in Node. */
"use strict";

(function (root) {
  const ROOT = (typeof window !== "undefined" && window.QE_ROOT) || "";
  const bundles = new Map();
  let calendar = null;
  let searchIndex = null;

  async function getJSON(path) {
    const res = await root.fetch(ROOT + path);
    if (!res.ok) throw new Error("HTTP " + res.status + " for " + path);
    return res.json();
  }

  async function getCalendar() {
    if (!calendar) calendar = await getJSON("data/calendar.json");
    return calendar;
  }

  /* runs of calendar indices ([start, count]) or literal ISO strings -> ISO strings */
  function decodeDates(enc, cal) {
    const out = [];
    for (const e of enc) {
      if (Array.isArray(e)) for (let i = 0; i < e[1]; i++) out.push(cal[e[0] + i]);
      else if (typeof e === "number") out.push(cal[e]);
      else out.push(e);
    }
    return out;
  }

  /* every {dates_e} becomes {dates}, recursively; everything else is passed through */
  function inflate(obj, cal) {
    if (Array.isArray(obj)) return obj.map((x) => inflate(x, cal));
    if (obj && typeof obj === "object") {
      const o = {};
      for (const k of Object.keys(obj)) {
        if (k === "dates_e") o.dates = decodeDates(obj[k], cal);
        else o[k] = inflate(obj[k], cal);
      }
      return o;
    }
    return obj;
  }

  /* rolling mean with polars semantics: null until the window holds `w` non-null values */
  function sma(values, w) {
    const n = values.length;
    const out = new Array(n).fill(null);
    let sum = 0, nulls = 0;
    for (let i = 0; i < n; i++) {
      const v = values[i];
      if (v == null) nulls += 1; else sum += v;
      if (i >= w) {
        const d = values[i - w];
        if (d == null) nulls -= 1; else sum -= d;
      }
      if (i >= w - 1 && nulls === 0) out[i] = sum / w;
    }
    return out;
  }

  function decodePrices(p, cal) {
    if (!p.n_bars) return p;
    const dates = decodeDates(p.dates_e, cal);
    const n = dates.length;
    const close = p.c.map((x) => (x == null ? null : x / 100));
    const rebuild = (d) => p.c.map((x, i) => (x == null || d[i] == null ? null : (x + d[i]) / 100));
    const open = rebuild(p.dO), high = rebuild(p.dH), low = rebuild(p.dL);
    let adj;
    if (p.adj_e.raw) adj = p.adj_e.raw;
    else {
      const seg = p.adj_e.seg;
      adj = new Array(n);
      let s = 0;
      for (let i = 0; i < n; i++) {
        while (s + 1 < seg.length && seg[s + 1][0] <= i) s += 1;
        adj[i] = close[i] == null ? null : Math.round(close[i] * seg[s][1] * 1e4) / 1e4;
      }
    }
    return {
      symbol: p.symbol, n_bars: n, dates,
      ohlc: dates.map((_, i) => [open[i], close[i], low[i], high[i]]),
      close, adj_close: adj, volume: p.v.map((x) => (x == null ? null : x * 100)),
      sma: { "50": sma(adj, 50), "200": sma(adj, 200) },
      events: p.events, stats: p.stats,
    };
  }

  /* ---- the Patterns series the export leaves to the browser (mirrors qe.web.analytics) ---- */

  /* rows with a usable adjusted close, as (date, value) pairs in date order */
  function usable(dates, adj) {
    const d = [], v = [];
    for (let i = 0; i < dates.length; i++) if (adj[i] != null && adj[i] > 0) { d.push(dates[i]); v.push(adj[i]); }
    return { dates: d, values: v };
  }

  function drawdown(dates, adj) {
    const u = usable(dates, adj);
    let peak = -Infinity;
    const values = u.values.map((a) => { if (a > peak) peak = a; return a / peak - 1; });
    return { dates: u.dates, values };
  }

  /* pct_change over the usable rows; the first row has no return and is dropped */
  function dailyReturns(dates, adj) {
    const u = usable(dates, adj);
    const d = [], r = [];
    for (let i = 1; i < u.values.length; i++) {
      const ret = u.values[i] / u.values[i - 1] - 1;
      if (Number.isFinite(ret)) { d.push(u.dates[i]); r.push(ret); }
    }
    return { dates: d, values: r };
  }

  /* trailing sample standard deviation of daily returns, annualised; defined from the w-th return */
  function rollingVol(returns, w) {
    const r = returns.values, d = [], v = [];
    if (r.length < w) return { dates: [], values: [], window: w };
    for (let i = w - 1; i < r.length; i++) {
      let mean = 0;
      for (let j = i - w + 1; j <= i; j++) mean += r[j];
      mean /= w;
      let ss = 0;
      for (let j = i - w + 1; j <= i; j++) ss += (r[j] - mean) * (r[j] - mean);
      d.push(returns.dates[i]);
      v.push(Math.sqrt(ss / (w - 1)) * Math.sqrt(252));
    }
    return { dates: d, values: v, window: w };
  }

  /* cumulative ratio to the benchmark rebased to 1 at the first common date */
  function relStrength(prices, bench) {
    const b = new Map();
    bench.dates.forEach((dt, i) => { if (bench.adj_close[i] != null && bench.adj_close[i] > 0) b.set(dt, bench.adj_close[i]); });
    const dates = [], ratio = [];
    let p0 = null, b0 = null;
    prices.dates.forEach((dt, i) => {
      const p = prices.adj_close[i], q = b.get(dt);
      if (p == null || !(p > 0) || q == null) return;
      if (p0 == null) { p0 = p; b0 = q; }
      dates.push(dt);
      ratio.push((p / p0) / (q / b0));
    });
    return dates.length < 2 ? { dates: [], ratio: [] } : { dates, ratio };
  }

  async function getBundle(sym) {
    const key = String(sym).toUpperCase();
    if (!bundles.has(key)) {
      bundles.set(key, (async () => {
        const [raw, cal] = await Promise.all([getJSON("data/symbols/" + key + ".json"), getCalendar()]);
        return decodeBundle(raw, cal);
      })());
    }
    return bundles.get(key);
  }

  async function decodeBundle(raw, cal) {
    const prices = decodePrices(raw.prices, cal);
    const series = {};
    for (const k of Object.keys(raw.indicator_series || {})) series[k] = inflate(raw.indicator_series[k], cal);
    const patterns = raw.patterns ? inflate(raw.patterns, cal) : null;
    if (patterns) {
      if (patterns.drawdown && patterns.drawdown.computed) patterns.drawdown = drawdown(prices.dates, prices.adj_close);
      if (patterns.rolling_vol && patterns.rolling_vol.computed)
        patterns.rolling_vol = rollingVol(dailyReturns(prices.dates, prices.adj_close), patterns.rolling_vol.window || 63);
      if (patterns.rel_spy && patterns.rel_spy.computed)
        patterns.rel_spy = raw.symbol === "SPY" ? { dates: [], ratio: [] } : relStrength(prices, (await getBundle("SPY")).prices);
      if (patterns.rolling_beta && patterns.rolling_beta.ref) {
        const s = series[patterns.rolling_beta.ref];
        patterns.rolling_beta = s ? { dates: s.dates, values: s.values, n_segments: s.n_segments }
                                  : { dates: [], values: [], n_segments: 0 };
      }
    }
    const options = inflate(raw.options, cal);
    if (options.realized_vol && options.realized_vol.ref) {
      const s = series[options.realized_vol.ref], k = options.realized_vol.scale;
      options.realized_vol = s ? { dates: s.dates, values: s.values.map((v) => (v == null ? null : v * k)), n_segments: s.n_segments }
                               : { dates: [], values: [], n_segments: 0 };
    }
    return { symbol: raw.symbol, prices, patterns, indicators: raw.indicators, indicator_series: series,
             model: raw.model, options };
  }

  /* mirrors queries.search_symbols: prefix on the symbol or substring of the name, exact match
   * first, then prefix matches, then shorter symbols */
  async function search(q) {
    q = q.trim().slice(0, 32);
    if (!q) return [];
    if (!searchIndex) searchIndex = await getJSON("data/search.json");
    const Q = q.toUpperCase(), ql = q.toLowerCase();
    const hits = searchIndex.filter((s) =>
      s.symbol.toUpperCase().startsWith(Q) || (s.name || "").toLowerCase().includes(ql));
    hits.sort((a, b) =>
      ((b.symbol === Q) - (a.symbol === Q)) ||
      ((b.symbol.startsWith(Q)) - (a.symbol.startsWith(Q))) ||
      (a.symbol.length - b.symbol.length) ||
      (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
    return hits.slice(0, 20);
  }

  async function demoFetch(url) {
    // Set window.QE_API_BASE (e.g. "https://qe.example.com") before app.js loads and every page
    // talks to a hosted instance of the real API instead of the static files.
    if (root.QE_API_BASE) {
      const res = await root.fetch(root.QE_API_BASE + url);
      if (!res.ok) throw new Error("HTTP " + res.status + " for " + url);
      return res.json();
    }
    let m;
    if ((m = url.match(/^\/api\/symbol\/([^/]+)\/(prices|patterns|indicators|model|options)(?:\/([^/?#]+))?$/))) {
      const b = await getBundle(m[1]);
      if (m[2] === "indicators" && m[3]) {
        const s = b.indicator_series[m[3]];
        if (!s) throw new Error("HTTP 404 for " + url);
        return s;
      }
      if (m[2] === "patterns" && !b.patterns) throw new Error("HTTP 404 for " + url);
      return b[m[2]];
    }
    if ((m = url.match(/^\/api\/search\?q=(.*)$/))) return { matches: await search(decodeURIComponent(m[1])) };
    if ((m = url.match(/^\/api\/model\/([^/]+)\/([a-z_]+)(?:\?source=([a-z]+))?$/)))
      return getJSON("data/api/model/" + m[1] + "/" + m[2] + (m[3] ? "_" + m[3] : "") + ".json");
    if (url === "/api/research") return getJSON("data/api/research.json");
    throw new Error("demo: no static mapping for " + url);
  }

  root.QE_DEMO = { fetch: demoFetch, bundle: getBundle, decodeBundle, decodeDates, inflate, sma, search };
})(typeof window !== "undefined" ? window : globalThis);
