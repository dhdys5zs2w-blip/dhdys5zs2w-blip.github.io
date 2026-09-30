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

  /* ---- the return explorer ----------------------------------------------------------------
   * /api/returns runs a query per question, so this copy holds only the questions the page
   * itself offers (its opening question, the view with no conditions and the example buttons),
   * answered at export by the real endpoint, with every bar's stock-days. Any other question is
   * refused with a 422, which sends the page down its own error path to returnsError below. */
  let returnsIndex = null;
  const returnsBars = new Map();
  const NUMBER_WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
                        "eleven", "twelve"];

  /* Every query parameter /api/returns takes (RETURNS_PARAMS in the exporter, which checks the
   * route still takes exactly these). The key is built from them alone, so a request carrying
   * any other is a question this copy cannot know it holds, and is refused. */
  const RETURNS_PARAMS = new Set(["from", "to", "hold", "lag", "ret", "c", "bar"]);

  /* _plain in the exporter: a plain decimal in its shortest spelling, anything else as it is */
  function plain(v) {
    if (!/^-?[0-9]+(\.[0-9]+)?$/.test(v)) return v;
    const [whole, frac = ""] = v.replace(/^-/, "").split(".");
    const f = frac.replace(/0+$/, "");
    const s = (whole.replace(/^0+/, "") || "0") + (f ? "." + f : "");
    return v[0] === "-" && s !== "0" ? "-" + s : s;
  }

  /* mirrors explorer_key in tools/export_demo.py, and the two must change together: the
   * endpoint's defaults filled in, a repeated scalar's first value, the c tokens in order and
   * decoded, numbers spelled plainly, and only & = % escaped. null for a request it cannot key. */
  function returnsKey(qs) {
    const p = new URLSearchParams(qs);
    for (const k of p.keys()) if (!RETURNS_PARAMS.has(k)) return null;
    const esc = (v) => v.replace(/%/g, "%25").replace(/&/g, "%26").replace(/=/g, "%3D");
    const token = (c) => c.split(":").map((f) => f.split(",").map(plain).join(",")).join(":");
    const parts = ["hold=" + esc(plain(p.get("hold") || "1")), "lag=" + esc(plain(p.get("lag") || "1")),
                   "ret=" + esc(p.get("ret") || "sector_excess")];
    for (const k of ["from", "to"]) if (p.has(k)) parts.push(k + "=" + esc(p.get(k)));
    for (const c of p.getAll("c")) if (c.trim()) parts.push("c=" + esc(token(c)));
    return parts.join("&");
  }

  const queryOf = (url) => (url.indexOf("?") >= 0 ? url.slice(url.indexOf("?") + 1) : "");

  function getReturnsIndex() {
    if (!returnsIndex) returnsIndex = getJSON("data/api/returns/index.json").catch((e) => { returnsIndex = null; throw e; });
    return returnsIndex;
  }

  async function returnsAnswer(url) {
    const qs = queryOf(url);
    const key = returnsKey(qs);
    const id = key == null ? null : (await getReturnsIndex()).questions[key];
    if (!id) throw new Error("HTTP 422 for " + url);
    const bar = new URLSearchParams(qs).get("bar");
    if (bar == null) return getJSON("data/api/returns/" + id + ".json");
    // one file per zoom level holds every bar's stock-days, fetched on the first click at that level
    const m = bar.match(/^([0-9a-z]{1,4}):([0-9]{1,3})$/);
    if (!m) throw new Error("HTTP 422 for " + url);
    const file = id + ".bars-" + m[1];
    if (!returnsBars.has(file))
      returnsBars.set(file, getJSON("data/api/returns/" + file + ".json").catch((e) => { returnsBars.delete(file); throw e; }));
    const rows = (await returnsBars.get(file))[String(Number(m[2]))];
    if (!rows) throw new Error("HTTP 404 for " + url);
    return rows;
  }

  /* what the page shows in place of the figures when a question has no stored answer */
  async function returnsError(url) {
    if (root.QE_API_BASE) return (await root.fetch(root.QE_API_BASE + url)).json();
    let idx = null;
    try { idx = await getReturnsIndex(); } catch (e) { /* the words below do not need it */ }
    const key = returnsKey(queryOf(url));
    // a question the live endpoint itself refused keeps the endpoint's reason
    if (key != null && idx && idx.errors && idx.errors[key]) return { error: idx.errors[key] };
    const w = (k) => NUMBER_WORDS[k] || String(k);
    const n = idx ? idx.examples : null, refused = (idx && idx.refused) || 0;
    const examples = n == null ? "the example questions"
      : (refused ? w(n - refused) + " of the " : "the ") + w(n) + " example question" + (n === 1 ? "" : "s");
    const on = idx && idx.exported ? " on " + idx.exported : " when this copy was exported";
    // the page prefixes "This question can't run: ", and hides the examples while any condition is
    // on screen, so the message ends with the way back to an answered question
    return { error: "this static copy holds answers only for " + examples + " and the view with no" +
      " conditions, as the platform answered them" + on + ". Any other question — a changed condition," +
      " holding period, start day, comparison or date range — needs the live database. Change it back, or" +
      " use “Start over” to bring the examples back." };
  }

  /* The explorer's tables list stock-days from the universe's whole history, and most of those
   * symbols have no page in this copy, which carries the current universe and the model's picks
   * (search.json lists exactly those); a link to one would be a 404, so it becomes plain text
   * that says why. */
  function unlinkMissingSymbols() {
    const tables = ["x-table", "x-drawer-table"].map((id) => document.getElementById(id)).filter(Boolean);
    if (!tables.length) return;
    let have = null;
    const pass = async () => {
      if (!have) {
        if (!searchIndex) searchIndex = await getJSON("data/search.json");
        have = new Set(searchIndex.map((s) => s.symbol));
      }
      for (const t of tables) t.querySelectorAll('tbody a[href*="symbol/"]').forEach((a) => {
        const sym = a.textContent.trim();
        if (have.has(sym)) return;
        const span = document.createElement("span");
        span.className = a.className;
        span.textContent = sym;
        span.title = "No page for " + sym + " in this copy of the site, which has pages only for the current" +
          " universe and the stocks in the model's live record since July 2026.";
        a.replaceWith(span);
      });
    };
    // replacing a link is itself a change, but the second pass finds nothing left to replace
    const watch = new MutationObserver(() => { pass().catch(() => {}); });
    tables.forEach((t) => watch.observe(t, { childList: true, subtree: true }));
  }
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", unlinkMissingSymbols);
    else unlinkMissingSymbols();
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
      // the page scripts encodeURIComponent the symbol (and the indicator id)
      const b = await getBundle(decodeURIComponent(m[1]));
      if (m[2] === "indicators" && m[3]) {
        const s = b.indicator_series[decodeURIComponent(m[3])];
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
    if (url === "/api/story") return getJSON("data/api/story.json");
    // the overview's market map: one universe is exported, so a ?universe= query reads the same file
    if (url === "/api/market_map" || url.startsWith("/api/market_map?")) return getJSON("data/api/market_map.json");
    if (url === "/api/returns" || url.startsWith("/api/returns?")) return returnsAnswer(url);
    throw new Error("demo: no static mapping for " + url);
  }

  root.QE_DEMO = { fetch: demoFetch, bundle: getBundle, decodeBundle, decodeDates, inflate, sma, search,
                   returnsKey, returnsError };
})(typeof window !== "undefined" ? window : globalThis);
