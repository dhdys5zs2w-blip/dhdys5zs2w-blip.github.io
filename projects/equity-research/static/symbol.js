/* Symbol page: the hero quote, the price/volume chart (period chips, a
 * crosshair readout, SPY beside it on request), patterns, indicators, options
 * and the model record.
 *
 * One /prices fetch feeds the hero, the stats strip and the History chart;
 * one /model fetch feeds the book badge and the Model tab (one request on
 * arrival, never repeated — the badge is the only thing on the page that
 * needs it early). Tab contents load
 * lazily via the qe:tab event from app.js; SPY's prices are fetched only when
 * the reader switches the overlay on.
 *
 * Motion here is navigation and the arrival of a number: the tab ink slides,
 * a period chip eases the zoom window, the 52-week marker and the sparkline
 * arrive once. None of it colours a value by how good it looks, none of it
 * borrows the live/backfill/backtest hues (only the predictions table's
 * source badges wear them, because those rows *are* that state), and all of
 * it is skipped under prefers-reduced-motion. */
"use strict";

(function () {
  const root = document.getElementById("symbol-page");
  if (!root) return;
  const SYM = root.dataset.symbol;
  const API = "/api/symbol/" + encodeURIComponent(SYM);
  const C = qe.colors();
  const reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const $ = (id) => document.getElementById(id);

  /* ---------- helpers ---------- */

  const whiskers = qe.whiskerSeries;
  // one request per payload, shared by everything on the page that reads it
  const once = (fn) => { let p = null; return () => (p = p || fn()); };
  const getPrices = once(() => qe.fetch(API + "/prices"));
  const getModel = once(() => qe.fetch(API + "/model"));
  // ECharts' default inactive legend grey is a light-theme literal
  const legendOff = { inactiveColor: C.line, inactiveBorderColor: C.line };

  function lineOption(dates, values, color, fmt, extra) {
    return Object.assign({
      animation: false,
      grid: { left: 60, right: 16, top: 18, bottom: 40 },
      tooltip: { trigger: "axis", valueFormatter: fmt },
      xAxis: { type: "category", data: dates, boundaryGap: false },
      yAxis: { type: "value", scale: true, axisLabel: { formatter: fmt } },
      series: [{ type: "line", data: values, showSymbol: false, connectNulls: false,
                 lineStyle: { width: 2, color } }],
    }, extra || {});
  }

  const pctAxis = (v) => (v * 100).toFixed(0) + "%";
  const pctTip = (v) => (v == null ? "—" : (v * 100).toFixed(2) + "%");
  const plainPct = (v, d = 1) => (v == null ? "—" : (v * 100).toFixed(d) + "%");

  /* a stat cell; `data-count` lets fx.js count the number in once on view */
  function statSpan(label, value, signed) {
    const cls = signed && value != null ? (value > 0 ? "pos" : value < 0 ? "neg" : "") : "";
    const text = typeof value === "string" ? value : qe.fmtPct(value);
    return '<span class="stat"><span class="v ' + cls + '" data-count>' + text +
           '</span><span class="k">' + label + "</span></span>";
  }

  // first index whose date is >= d / > d, on the sorted ISO date array
  function lowerBound(arr, d) {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < d) lo = m + 1; else hi = m; }
    return lo;
  }
  function upperBound(arr, d) {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] <= d) lo = m + 1; else hi = m; }
    return lo;
  }

  /* ---------- tabs: sliding ink, keyboard, direction-aware pane entry ---------- */

  const nav = document.querySelector(".sym-tabbar .tabs");
  const tabs = nav ? Array.from(nav.querySelectorAll(".tab")) : [];
  const ink = nav ? nav.querySelector(".tab-ink") : null;
  const activeIdx = () => Math.max(0, tabs.findIndex((t) => t.classList.contains("active")));

  function syncTabs() {
    const act = tabs[activeIdx()];
    if (!act) return;
    // roving tabindex: Tab reaches the active tab, the arrows move between them
    tabs.forEach((t) => { t.tabIndex = t === act ? 0 : -1; });
    if (ink) {
      ink.style.width = act.offsetWidth + "px";
      ink.style.transform = "translateX(" + act.offsetLeft + "px)";
      nav.classList.add("inked");
    }
    syncStickyTop();
    // a resize while History was hidden measured its chips at zero width and
    // left the thumb alone; seat it again now that the pane can be measured
    if (act.dataset.tab === "history") seatThumb();
  }
  /* the top nav's real height, so the sticky tab bar sits flush under it
   * (--nav-h is the nav's minimum; its padding and border make it taller) */
  const topnav = document.querySelector(".topnav");
  function syncStickyTop() {
    if (topnav) root.style.setProperty("--sym-sticky-top", Math.ceil(topnav.getBoundingClientRect().height) + "px");
  }
  function goTab(i, focus) {
    const t = tabs[(i + tabs.length) % tabs.length];
    if (!t) return;
    t.click();
    if (focus) t.focus();
  }
  if (nav) {
    // capture: runs before app.js's own click handler flips the classes
    nav.addEventListener("click", (ev) => {
      const t = ev.target.closest(".tab");
      if (!t) return;
      const dir = tabs.indexOf(t) >= activeIdx() ? 1 : -1;
      root.style.setProperty("--pane-dx", (dir * 18) + "px");
      requestAnimationFrame(syncTabs);
    }, true);
    nav.addEventListener("keydown", (ev) => {
      const i = tabs.indexOf(document.activeElement);
      if (i < 0) return;
      if (ev.key === "Home") { ev.preventDefault(); goTab(0, true); }
      else if (ev.key === "End") { ev.preventDefault(); goTab(tabs.length - 1, true); }
    });
  }
  // inside a chip group the arrows move between its buttons (and stop there,
  // so the page-level handler below never sees them)
  root.addEventListener("keydown", (ev) => {
    if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
    const seg = ev.target.closest && ev.target.closest(".seg");
    if (!seg) return;
    const btns = Array.from(seg.querySelectorAll("button:not(:disabled)"));
    const i = btns.indexOf(ev.target);
    if (i < 0) return;
    ev.preventDefault();
    btns[(i + (ev.key === "ArrowRight" ? 1 : -1) + btns.length) % btns.length].focus();
  });
  document.addEventListener("keydown", (ev) => {
    if (!tabs.length || ev.metaKey || ev.ctrlKey || ev.altKey || ev.defaultPrevented) return;
    const a = document.activeElement;
    const tag = a && a.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (a && a.isContentEditable)) return;
    if (document.querySelector(".palette:not([hidden])")) return;
    // the arrows switch tabs only from a tab or with nothing focused: on any
    // other element (a chip, a table that scrolls sideways) they keep their
    // own meaning
    const onTab = tabs.includes(a);
    const idle = !a || a === document.body || a === document.documentElement;
    let next = null;
    if (ev.key === "ArrowRight" || ev.key === "ArrowLeft") {
      if (!onTab && !idle) return;
      next = activeIdx() + (ev.key === "ArrowRight" ? 1 : -1);
    }
    else if (/^[1-9]$/.test(ev.key) && +ev.key <= tabs.length) next = +ev.key - 1;
    if (next === null) return;
    ev.preventDefault();
    goTab(next, onTab);
  });
  document.addEventListener("DOMContentLoaded", () => {
    syncTabs();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(syncTabs);
  });
  window.addEventListener("resize", () => requestAnimationFrame(syncTabs));
  syncStickyTop();

  function selectTab(name) {
    const t = tabs.find((b) => b.dataset.tab === name);
    if (t && !t.classList.contains("active")) t.click();
  }

  /* ---------- hero: quote, 1-day pill, sparkline, 52-week range ---------- */

  function renderHero(p) {
    const price = $("q-price");
    if (!p.n_bars) {
      price.innerHTML = '<span class="muted small">no price history stored</span>';
      return;
    }
    const s = p.stats;
    const adj = p.adj_close;
    const n = adj.length;
    const last = adj[n - 1];
    price.textContent = qe.fmtNum(last);
    price.setAttribute("data-count", "");
    $("q-asof").textContent = "as of " + s.last_date;

    const r1 = s.returns ? s.returns["1d"] : null;
    const prev = n > 1 ? adj[n - 2] : null;
    if (r1 != null && prev != null && last != null) {
      const d = last - prev;
      const pill = $("q-change");
      // an exactly flat day is neither up nor down: the neutral pill, no arrow
      pill.className = "chg-pill" + (r1 > 0 ? " pos" : r1 < 0 ? " neg" : "");
      pill.innerHTML = (r1 === 0 ? "" : '<span class="arrow" aria-hidden="true">' + (r1 > 0 ? "▲" : "▼") + "</span>") +
        (d > 0 ? "+" : d < 0 ? "−" : "") + Math.abs(d).toFixed(2) + '<span class="sep" aria-hidden="true">·</span>' +
        qe.fmtPct(r1, 2) + '<span class="k">1 day</span>';
      pill.hidden = false;
    }

    // 52-week range over the same window the server's "vs 52w high" uses
    const tail = adj.slice(-252).filter((v) => v != null);
    if (tail.length >= 2 && last != null) {
      const lo = Math.min(...tail), hi = Math.max(...tail);
      const at = hi > lo ? (last - lo) / (hi - lo) : 1;
      const box = $("range52");
      box.style.setProperty("--at", (at * 100).toFixed(1) + "%");
      $("r-label").textContent = tail.length >= 252 ? "52-week range" : "range, last " + tail.length + " sessions";
      $("r-lo").textContent = qe.fmtNum(lo);
      $("r-hi").textContent = qe.fmtNum(hi);
      const dist = s.dist_from_52w_high;
      $("r-dist").textContent = dist == null ? "" :
        dist > -0.0005 ? "at the high" : plainPct(-dist) + " below the high";
      $("r-track").setAttribute("aria-label", "Latest adjusted close " + qe.fmtNum(last) +
        " in a range from " + qe.fmtNum(lo) + " to " + qe.fmtNum(hi));
      box.hidden = false;
    }
    drawSpark(adj.slice(-253));
    $("q-foot").textContent = "Adjusted for splits and dividends; the last raw close was " +
      qe.fmtNum(s.last_close) + ".";
    const card = $("sym-quote");
    // two frames so the starting state paints before the transition target
    requestAnimationFrame(() => requestAnimationFrame(() => card.classList.add("armed")));
  }

  function drawSpark(vals) {
    const svg = $("q-spark");
    const pts = vals.map((v, i) => [i, v]).filter((d) => d[1] != null);
    if (pts.length < 10) return;
    const W = 300, H = 56, pad = 5;
    const lo = Math.min(...pts.map((d) => d[1])), hi = Math.max(...pts.map((d) => d[1]));
    const x = (i) => (i / (vals.length - 1)) * W;
    const y = (v) => (hi > lo ? pad + (1 - (v - lo) / (hi - lo)) * (H - 2 * pad) : H / 2);
    const line = pts.map((d, k) => (k ? "L" : "M") + x(d[0]).toFixed(1) + " " + y(d[1]).toFixed(1)).join("");
    const end = pts[pts.length - 1];
    const area = line + "L" + x(end[0]).toFixed(1) + " " + H + "L" + x(pts[0][0]).toFixed(1) + " " + H + "Z";
    svg.innerHTML =
      '<path class="sp-area" d="' + area + '"></path>' +
      '<path class="sp-line" pathLength="1" d="' + line + '"></path>' +
      '<circle class="sp-dot" r="3.2" cx="' + x(end[0]).toFixed(1) + '" cy="' + y(end[1]).toFixed(1) + '"></circle>';
    const btn = $("q-spark-btn");
    btn.hidden = false;
    btn.addEventListener("click", () => showRange(252));
  }

  function renderStrip(p) {
    const strip = $("stats-strip");
    if (!p.n_bars) {
      strip.innerHTML = '<span class="muted">no price history stored</span>';
      return;
    }
    const s = p.stats;
    // the last close and the 1-day move sit in the hero above; the strip
    // carries the longer horizons and the risk numbers
    strip.innerHTML =
      statSpan("1m", s.returns["1m"], true) +
      statSpan("3m", s.returns["3m"], true) +
      statSpan("1y", s.returns["1y"], true) +
      statSpan("since " + qe.esc(s.first_date.slice(0, 4)), s.returns["max"], true) +
      statSpan("vol (63d ann.)", plainPct(s.ann_vol_63d), false) +
      statSpan("max drawdown", s.max_drawdown, true) +
      statSpan("ADV $ (20d)", qe.fmtCompact(s.adv_20d), false) +
      '<span class="stat"><span class="v" data-count>' + s.n_bars.toLocaleString() +
      '</span><span class="k">bars to ' + qe.esc(s.last_date) + "</span></span>";
  }

  getPrices().then((p) => { renderHero(p); renderStrip(p); })
    .catch((err) => console.error(err));

  getModel().then((m) => {
    if (!m.in_book_now) return;
    const b = $("book-badge");
    $("book-since").textContent = m.book_since ? " since " + m.book_since : "";
    b.hidden = false;
    b.addEventListener("click", (ev) => { ev.preventDefault(); selectTab("model"); });
    $("tab-book-dot").hidden = false;
  }).catch((err) => console.error(err));

  /* ---------- history tab ---------- */

  let priceChart = null;
  let P = null, n = 0;
  // the two series shown by default lead, so a phone's first legend page has both
  const LEGEND = ["Adj close", "SMA 200", "SMA 50", "Raw close", "Candles (raw)", "Dividends"];
  let spyOn = false, spyAligned = null;
  let resolveHistory;
  const historyReady = new Promise((r) => { resolveHistory = r; });
  const chipBox = $("range-chips");
  const chips = chipBox ? Array.from(chipBox.querySelectorAll("button")) : [];

  function currentWindow() {
    if (!priceChart) return [0, Math.max(0, n - 1)];
    try {
      const r = priceChart.getModel().getComponent("dataZoom", 0).getValueRange();
      if (r && isFinite(r[0]) && isFinite(r[1])) {
        return [Math.max(0, Math.round(r[0])), Math.min(n - 1, Math.round(r[1]))];
      }
    } catch (e) { /* fall back to the percent window */ }
    const o = priceChart.getOption().dataZoom[0];
    return [Math.round((o.start / 100) * (n - 1)), Math.round((o.end / 100) * (n - 1))];
  }

  // a chip's window matches the strip's period return: r returns, r+1 bars
  const chipWindow = (r) => (r === "all" ? [0, n - 1] : [Math.max(0, n - 1 - parseInt(r, 10)), n - 1]);

  let tweenId = 0, tweening = false;
  /* `chip` is the period button that asked for this window, if one did: it
   * reads as chosen from the first frame and the thumb slides straight to it,
   * because the chips are not re-matched against the window mid-tween */
  function zoomTo(a, b, chip) {
    a = Math.max(0, Math.min(n - 1, a));
    b = Math.max(a, Math.min(n - 1, b));
    const my = ++tweenId;
    markChip(chip || null);
    const [a0, b0] = currentWindow();
    if (reduced || (a0 === a && b0 === b)) {
      tweening = false;
      priceChart.dispatchAction({ type: "dataZoom", startValue: a, endValue: b });
      return;
    }
    tweening = true;
    // ease the window's width in log space so a Max → 1M zoom reads as one
    // continuous move rather than a long drift and a snap
    const w0 = Math.max(1, b0 - a0), w1 = Math.max(1, b - a);
    const pct = (i) => (i / Math.max(1, n - 1)) * 100;
    const t0 = performance.now(), dur = 460;
    const step = (now) => {
      if (my !== tweenId) return;
      const t = Math.min(1, (now - t0) / dur);
      const e = 1 - Math.pow(1 - t, 3);
      if (t < 1) {
        const w = Math.exp(Math.log(w0) + (Math.log(w1) - Math.log(w0)) * e);
        const end = b0 + (b - b0) * e;
        priceChart.dispatchAction({ type: "dataZoom", start: pct(Math.max(0, end - w)), end: pct(end) });
        requestAnimationFrame(step);
      } else {
        tweening = false;   // the landing window is matched to a chip as usual
        priceChart.dispatchAction({ type: "dataZoom", startValue: a, endValue: b });
      }
    };
    requestAnimationFrame(step);
  }

  function setFocusBand(a, b, label) {
    if (!priceChart) return;
    priceChart.setOption({ series: [{ id: "adj", markArea: {
      silent: true, itemStyle: { color: C.zoom, borderColor: C.accent, borderWidth: 1, borderType: "dashed" },
      label: { show: !!label, position: "insideTop", color: C.muted, fontSize: 10, fontFamily: C.mono },
      data: a == null ? [] : [[{ xAxis: P.dates[a], name: label || "" }, { xAxis: P.dates[b] }]],
    } }] });
  }

  function showRange(r) {
    selectTab("history");
    historyReady.then(() => {
      setFocusBand(null);
      const [a, b] = chipWindow(r);
      zoomTo(a, b, chips.find((c) => c.dataset.range === String(r)));
    });
  }

  /* open the History tab zoomed onto [from, to] (ISO dates) with the span
   * outlined — the Patterns tab's month cells and drawdown rows use this */
  function showOnHistory(from, to, label) {
    selectTab("history");
    historyReady.then(() => {
      const a = lowerBound(P.dates, from), b = upperBound(P.dates, to) - 1;
      if (b < a) return;
      const padN = Math.max(3, Math.round((b - a) * 0.12));
      setFocusBand(a, b, label);
      zoomTo(a - padN, b + padN);
      $("chart-price").scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "center" });
    });
  }

  function syncChips(a, b) {
    let hit = null;
    chips.forEach((c) => {
      const [ca, cb] = chipWindow(c.dataset.range);
      if (hit === null && ca === a && cb === b) hit = c;
    });
    markChip(hit);
  }

  function markChip(hit) {
    chips.forEach((c) => {
      c.classList.toggle("on", c === hit);
      c.setAttribute("aria-pressed", c === hit ? "true" : "false");
    });
    moveThumb(hit);
  }

  /* The thumb is the chosen chip's fill. While it shows, the chip's own fill
   * steps aside (`.thumb-on` on the group); whenever it is hidden the chip
   * keeps its ordinary pressed style, so the choice can never read blank. */
  function moveThumb(btn) {
    if (!chipBox) return;
    let thumb = chipBox.querySelector(".seg-thumb");
    if (!thumb) {
      thumb = document.createElement("span");
      thumb.className = "seg-thumb";
      thumb.setAttribute("aria-hidden", "true");
      chipBox.prepend(thumb);
    }
    if (!btn) {
      thumb.style.opacity = "0";
      chipBox.classList.remove("thumb-on");
      return;
    }
    // History is display:none behind another tab and measures zero: leave the
    // thumb as it was; syncTabs seats it again when History is shown
    if (!btn.offsetWidth) return;
    thumb.style.opacity = "1";
    thumb.style.width = btn.offsetWidth + "px";
    thumb.style.transform = "translateX(" + btn.offsetLeft + "px)";
    chipBox.classList.add("thumb-on");
  }
  function seatThumb() {
    if (chips.length) moveThumb(chips.find((c) => c.classList.contains("on")) || null);
  }

  function windowReadout(a, b) {
    const el = $("win-readout");
    let i = a;
    while (i < b && P.adj_close[i] == null) i++;
    const first = P.adj_close[i], last = P.adj_close[b];
    if (first == null || last == null || !(first > 0) || b <= i) { el.textContent = ""; return; }
    const r = last / first - 1;
    el.innerHTML = '<span class="k">in view</span><span class="' + qe.signCls(r) + '">' + qe.fmtPct(r, 1) +
      "</span> <span class=\"muted\">" + qe.esc(P.dates[i]) + " → " + qe.esc(P.dates[b]) + " · " +
      (b - i + 1).toLocaleString() + " sessions</span>";
  }

  function readout(i) {
    const el = $("chart-readout");
    if (!P || i == null || i < 0 || i >= n) return;
    const a = P.adj_close[i], prev = i > 0 ? P.adj_close[i - 1] : null;
    const chg = a != null && prev ? a / prev - 1 : null;
    const o = P.ohlc[i] || [];   // ECharts order: open, close, low, high
    const part = (k, v) => '<span class="rd"><span class="rd-k">' + k + "</span>" + v + "</span>";
    let html = '<span class="rd rd-date">' + qe.esc(P.dates[i]) +
      (i === n - 1 ? ' <span class="rd-latest">latest</span>' : "") + "</span>" +
      part("adj", qe.fmtNum(a)) +
      part("day", '<span class="' + qe.signCls(chg) + '">' + qe.fmtPct(chg, 2) + "</span>") +
      part("raw o/h/l/c", qe.fmtNum(o[0]) + " / " + qe.fmtNum(o[3]) + " / " + qe.fmtNum(o[2]) + " / " + qe.fmtNum(o[1])) +
      part("vol", qe.fmtCompact(P.volume[i]));
    const sma = P.sma && P.sma["200"] ? P.sma["200"][i] : null;
    if (sma != null) html += part("sma 200", qe.fmtNum(sma));
    if (spyOn && spyShown && spyShown[i] != null) html += part("spy, rebased", qe.fmtNum(spyShown[i]));
    el.innerHTML = html;
  }

  let zoomQueued = false;
  function onZoom() {
    if (zoomQueued) return;
    zoomQueued = true;
    requestAnimationFrame(() => {
      zoomQueued = false;
      const [a, b] = currentWindow();
      if (!tweening) syncChips(a, b);
      windowReadout(a, b);
      readout(b);
      if (spyOn) rebaseSpy(a);
    });
  }

  async function toggleSpy(on) {
    spyOn = on;
    $("spy-caption").hidden = !on;
    if (on && !spyAligned) {
      try {
        const s = await qe.fetch("/api/symbol/SPY/prices");
        const at = new Map((s.dates || []).map((d, i) => [d, s.adj_close[i]]));
        spyAligned = P.dates.map((d) => (at.has(d) ? at.get(d) : null));
      } catch (err) {
        console.error(err);
        spyOn = false;
        $("spy-toggle").checked = false;
        $("spy-caption").hidden = true;
        return;
      }
    }
    rebaseSpy(currentWindow()[0]);
  }
  let spyShown = null;
  function rebaseSpy(a) {
    if (!spyOn || !spyAligned) {
      spyShown = null;
      priceChart.setOption({ legend: { data: LEGEND }, series: [{ id: "spy", data: [] }] });
      return;
    }
    let k = a;
    while (k < n && (spyAligned[k] == null || P.adj_close[k] == null)) k++;
    const f = k < n ? P.adj_close[k] / spyAligned[k] : null;
    spyShown = f == null ? null : spyAligned.map((v) => (v == null ? null : +(v * f).toFixed(4)));
    priceChart.setOption({ legend: { data: LEGEND.concat(["SPY, rebased"]) },
                           series: [{ id: "spy", data: spyShown || [] }] });
  }

  async function loadHistory() {
    const p = await getPrices();
    if (!p.n_bars) {
      $("chart-readout").innerHTML = '<span class="muted">no price history stored</span>';
      return;
    }
    P = p;
    n = p.dates.length;
    const adjAt = {};
    p.dates.forEach((d, i) => { adjAt[d] = p.adj_close[i]; });
    const splitPoints = p.events.splits.map((ev) => ({
      coord: [ev.date, adjAt[ev.date]],
      value: ev.split_coef >= 1 ? Math.round(ev.split_coef) + ":1"
                                : "1:" + Math.round(1 / ev.split_coef),
    }));
    const divPoints = p.events.dividends.map((ev) => [ev.date, adjAt[ev.date]]);

    priceChart = qe.chart("chart-price");
    priceChart.setOption({
      animation: false,
      axisPointer: { link: [{ xAxisIndex: [0, 1] }] },
      // the readout line above the chart replaces the tooltip box
      tooltip: { trigger: "axis", showContent: false,
                 axisPointer: { type: "cross", lineStyle: { color: C.muted, type: "dashed" },
                                crossStyle: { color: C.muted },
                                label: { backgroundColor: C.ink2, color: C.panel, fontFamily: C.mono, fontSize: 10,
                                         // price to the cent, volume compact, the date as stored
                                         formatter: (o) => (o.axisDimension !== "y" ? o.value
                                           : o.axisIndex === 1 ? qe.fmtCompact(o.value) : qe.fmtNum(o.value)) } } },
      legend: Object.assign({
        top: 0, type: "scroll", pageIconColor: C.accent, pageIconInactiveColor: C.line,
        pageTextStyle: { color: C.muted, fontFamily: C.mono, fontSize: 10 },
        data: LEGEND,
        selected: { "Adj close": true, "Raw close": false, "Candles (raw)": false,
                    "SMA 50": false, "SMA 200": true, "Dividends": false },
      }, legendOff),
      grid: [{ left: 64, right: 16, top: 34, height: "56%" },
             { left: 64, right: 16, top: "72%", height: "15%" }],
      xAxis: [
        { type: "category", data: p.dates, gridIndex: 0, boundaryGap: true },
        { type: "category", data: p.dates, gridIndex: 1, axisLabel: { show: false } },
      ],
      yAxis: [
        { scale: true, gridIndex: 0 },
        { gridIndex: 1, axisLabel: { formatter: qe.fmtCompact }, splitNumber: 2 },
      ],
      dataZoom: [
        { type: "inside", xAxisIndex: [0, 1] },
        { type: "slider", xAxisIndex: [0, 1], bottom: 6, height: 18 },
      ],
      series: [
        { id: "adj", name: "Adj close", type: "line", data: p.adj_close, showSymbol: false,
          z: 5, itemStyle: { color: C.accent }, lineStyle: { width: 1.4, color: C.accent },
          markPoint: { symbol: "pin", symbolSize: 34, itemStyle: { color: C.ink2 },
                       label: { formatter: (o) => o.data.value, fontSize: 9, color: C.panel },
                       data: splitPoints } },
        { id: "raw", name: "Raw close", type: "line", data: p.close, showSymbol: false,
          itemStyle: { color: C.grey }, lineStyle: { width: 1, color: C.grey } },
        { id: "candles", name: "Candles (raw)", type: "candlestick", data: p.ohlc,
          itemStyle: { color: C.pos, color0: C.neg, borderColor: C.pos, borderColor0: C.neg } },
        { id: "sma50", name: "SMA 50", type: "line", data: p.sma["50"], showSymbol: false,
          itemStyle: { color: C.series2 }, lineStyle: { width: 1.2, color: C.series2 } },
        { id: "sma200", name: "SMA 200", type: "line", data: p.sma["200"], showSymbol: false,
          itemStyle: { color: C.ink2 }, lineStyle: { width: 1.2, color: C.ink2, type: "dashed" } },
        { id: "div", name: "Dividends", type: "scatter", data: divPoints, symbolSize: 7,
          itemStyle: { color: C.grey, borderColor: C.panel, borderWidth: 1.5 } },
        // SPY is the recessive reference hue, never an evidence state
        { id: "spy", name: "SPY, rebased", type: "line", data: [], showSymbol: false, z: 4,
          itemStyle: { color: C.grey }, lineStyle: { width: 1.3, color: C.grey, type: [4, 3] } },
        { id: "vol", name: "Volume", type: "bar", data: p.volume, xAxisIndex: 1, yAxisIndex: 1,
          itemStyle: { color: C.soft }, large: true },
      ],
    });

    priceChart.on("updateAxisPointer", (ev) => {
      const ax = (ev.axesInfo || []).find((x) => x.axisDim === "x");
      if (ax && ax.value != null) readout(Math.round(ax.value));
    });
    // off the chart, the readout rests on the last session in view
    priceChart.getZr().on("globalout", () => readout(currentWindow()[1]));
    priceChart.on("datazoom", onZoom);
    readout(n - 1);

    chips.forEach((btn) => btn.addEventListener("click", () => {
      setFocusBand(null);
      const [a, b] = chipWindow(btn.dataset.range);
      zoomTo(a, b, btn);
    }));
    $("log-toggle").addEventListener("change", (ev) => {
      priceChart.setOption({ yAxis: [{ type: ev.target.checked ? "log" : "value", scale: true }, {}] });
    });
    const spyToggle = $("spy-toggle");
    if (spyToggle) spyToggle.addEventListener("change", (ev) => toggleSpy(ev.target.checked));

    syncChips(0, n - 1);
    windowReadout(0, n - 1);
    window.addEventListener("resize", seatThumb);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(seatThumb);
    resolveHistory();
  }

  /* ---------- patterns tab ---------- */

  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  async function loadPatterns() {
    const p = await qe.fetch(API + "/patterns");
    renderMonthly(p.monthly);
    renderSeason("chart-season-month", p.by_month);
    renderSeason("chart-season-weekday", p.by_weekday);
    renderDrawdown(p.drawdown, p.top_drawdowns);
    if (p.rolling_vol.dates.length) {
      qe.chart("chart-vol").setOption(
        lineOption(p.rolling_vol.dates, p.rolling_vol.values, C.neg, pctAxis));
    }
    if (p.rolling_beta.dates.length) {
      qe.chart("chart-beta").setOption(lineOption(
        p.rolling_beta.dates, p.rolling_beta.values, C.series2,
        (v) => (v == null ? "—" : Number(v).toFixed(2))));
    }
    renderHistogram(p.histogram);
    if (p.rel_spy.dates.length) {
      const opt = lineOption(p.rel_spy.dates, p.rel_spy.ratio, C.accent,
        (v) => (v == null ? "—" : Number(v).toFixed(2)));
      opt.series[0].markLine = { symbol: "none", silent: true,
        lineStyle: { color: C.grey, type: "dashed" },
        data: [{ yAxis: 1 }], label: { formatter: "SPY" } };
      qe.chart("chart-rel").setOption(opt);
    }
  }

  function renderMonthly(m) {
    if (!m.cells.length) return;
    const years = m.years.map(String);
    const data = m.cells.map((c) => [c.month - 1, years.indexOf(String(c.year)),
                                     c.ret == null ? null : +(c.ret * 100).toFixed(2)]);
    const maxAbs = Math.max(5, ...m.cells.map((c) => Math.abs((c.ret || 0) * 100)));
    const byKey = {};
    m.cells.forEach((c) => { byKey[(c.month - 1) + ":" + years.indexOf(String(c.year))] = c; });
    const chart = qe.chart("chart-monthly");
    chart.setOption({
      animation: false,
      tooltip: { formatter: (o) => {
        const c = byKey[o.data[0] + ":" + o.data[1]];
        return years[o.data[1]] + " " + MONTHS[o.data[0]] +
          ": <b>" + qe.fmtPct(c.ret, 1) + "</b> (" + c.n_days + " days)" +
          '<br><span style="color:' + C.muted + '">click to see it on the price chart</span>';
      } },
      grid: { left: 48, right: 70, top: 10, bottom: 28 },
      xAxis: { type: "category", data: MONTHS },
      yAxis: { type: "category", data: years, inverse: true,
               axisLabel: { fontSize: 10 } },
      visualMap: { min: -maxAbs, max: maxAbs, calculable: false, orient: "vertical",
                   right: 0, top: "center", itemHeight: 120,
                   inRange: { color: [C.neg, C.panel, C.pos] },
                   text: ["+" + maxAbs.toFixed(0) + "%", "-" + maxAbs.toFixed(0) + "%"] },
      series: [{ type: "heatmap", data, label: { show: false },
                 emphasis: { itemStyle: { borderColor: C.ink, borderWidth: 1 } } }],
    });
    const showMonth = (mi, yi) => {
      const y = years[yi], mm = String(mi + 1).padStart(2, "0");
      showOnHistory(y + "-" + mm + "-01", y + "-" + mm + "-31", MONTHS[mi] + " " + y);
    };
    chart.on("click", (o) => { if (o.data) showMonth(o.data[0], o.data[1]); });

    // the canvas cells take no focus, so the same drill-in is offered as two
    // selects and a button, preset to the latest month stored
    const ySel = $("mp-year"), mSel = $("mp-month"), go = $("mp-show");
    ySel.innerHTML = years.map((y, i) => '<option value="' + i + '">' + qe.esc(y) + "</option>").join("");
    const lastCell = m.cells.reduce((acc, c) =>
      (!acc || c.year > acc.year || (c.year === acc.year && c.month > acc.month) ? c : acc), null);
    ySel.value = String(years.indexOf(String(lastCell.year)));
    mSel.value = String(lastCell.month - 1);
    const has = () => !!byKey[mSel.value + ":" + ySel.value];
    const sync = () => { go.disabled = !has(); };
    ySel.addEventListener("change", sync);
    mSel.addEventListener("change", sync);
    go.addEventListener("click", () => { if (has()) showMonth(+mSel.value, +ySel.value); });
    sync();
    $("month-pick").hidden = false;
  }

  function renderSeason(id, rows) {
    if (!rows.length) return;
    const labels = rows.map((r) => r.label);
    const means = rows.map((r) => r.mean_bps);
    const wdata = rows.map((r, i) =>
      r.se_bps == null ? null : [i, r.mean_bps - r.se_bps, r.mean_bps + r.se_bps])
      .filter((d) => d !== null);
    qe.chart(id).setOption({
      animation: false,
      tooltip: { formatter: (o) => {
        const r = rows[o.dataIndex];
        return qe.esc(r.label) + ": <b>" + (r.mean_bps == null ? "—" : r.mean_bps.toFixed(1)) +
          " bps</b> ± " + (r.se_bps == null ? "?" : r.se_bps.toFixed(1)) +
          " SE · n=" + r.n;
      } },
      grid: { left: 52, right: 12, top: 14, bottom: 26 },
      xAxis: { type: "category", data: labels },
      yAxis: { type: "value", name: "bps/day", nameTextStyle: { fontSize: 10 } },
      series: [
        { type: "bar", data: qe.bars(means, (v) => (v >= 0 ? C.pos : C.neg)), barMaxWidth: 24,
          barWidth: "55%", itemStyle: { opacity: 0.85 },
          label: { show: true, position: "insideBottom", fontSize: 9, color: C.muted,
                   fontFamily: C.mono, formatter: (o) => "n=" + rows[o.dataIndex].n } },
        whiskers(wdata, C.ink2),
      ],
    });
  }

  function renderDrawdown(dd, top) {
    if (dd.dates.length) {
      const opt = lineOption(dd.dates, dd.values, C.neg, pctAxis,
        { tooltip: { trigger: "axis", valueFormatter: pctTip } });
      opt.series[0].areaStyle = { color: C.neg, opacity: 0.12 };
      qe.chart("chart-drawdown").setOption(opt);
    }
    const body = document.querySelector("#dd-table tbody");
    const lastDate = dd.dates.length ? dd.dates[dd.dates.length - 1] : null;
    body.innerHTML = (top || []).map((d) => {
      const to = d.recovery_date || lastDate || d.trough_date;
      return "<tr><td class='mono'>" + qe.esc(d.peak_date) + "</td><td class='mono'>" + qe.esc(d.trough_date) +
        "</td><td class='mono num'>" + qe.fmtPct(d.depth) + "</td><td class='mono'>" +
        (d.recovery_date ? qe.esc(d.recovery_date) + " (" + d.recovery_days + "d)" :
         '<span class="badge badge-warn">ongoing</span>') + "</td>" +
        '<td><button type="button" class="dd-show" data-from="' + qe.esc(d.peak_date) +
        '" data-to="' + qe.esc(to) + '" data-label="' + qe.esc(qe.fmtPct(d.depth)) +
        '" aria-label="Show the drawdown from ' + qe.esc(d.peak_date) + ' on the price chart">chart ›</button></td></tr>';
    }).join("");
    body.addEventListener("click", (ev) => {
      const b = ev.target.closest(".dd-show");
      if (b) showOnHistory(b.dataset.from, b.dataset.to, "drawdown " + b.dataset.label);
    });
  }

  function renderHistogram(h) {
    const statsEl = $("hist-stats");
    if (!h || h.too_few) {
      statsEl.textContent = "not drawn: only " + (h ? h.n : 0) +
        " daily returns — a histogram of that is noise, not shape";
      return;
    }
    const centers = [];
    for (let i = 0; i < h.counts.length; i++) {
      centers.push((((h.bin_edges[i] + h.bin_edges[i + 1]) / 2) * 100).toFixed(2) + "%");
    }
    statsEl.textContent = "n=" + h.n + " · skew " + h.skew.toFixed(2) +
      " · excess kurtosis " + h.excess_kurtosis.toFixed(1) +
      " · normal overlay uses sample mean/sd";
    qe.chart("chart-hist").setOption({
      animation: false,
      tooltip: { trigger: "axis" },
      grid: { left: 52, right: 12, top: 14, bottom: 40 },
      xAxis: { type: "category", data: centers,
               axisLabel: { interval: Math.floor(h.counts.length / 7) } },
      yAxis: { type: "value" },
      series: [
        { name: "days", type: "bar", data: h.counts, barWidth: "90%",
          itemStyle: { color: C.soft } },
        { name: "normal", type: "line", data: h.normal, showSymbol: false, smooth: true,
          lineStyle: { width: 1.4, color: C.neg } },
      ],
    });
  }

  /* ---------- indicators tab ---------- */

  async function loadIndicators() {
    const list = await qe.fetch(API + "/indicators");
    const sel = $("indicator-select");
    const cov = $("indicator-coverage");
    const prevBtn = $("ind-prev"), nextBtn = $("ind-next");
    if (!list.indicators.length) {
      sel.innerHTML = "<option>none stored</option>";
      prevBtn.disabled = nextBtn.disabled = true;
      cov.textContent = "no indicator values stored for this symbol " +
        "(it may never have been in a scored universe)";
      return;
    }
    sel.innerHTML = list.indicators.map((i) =>
      '<option value="' + qe.esc(i.indicator_id) + '">' + qe.esc(i.indicator_id) +
      (i.kind ? " · " + qe.esc(i.kind) : "") + " · " + i.n_obs.toLocaleString() + " obs</option>").join("");
    const chart = qe.chart("chart-indicator");
    async function show(id) {
      const s = await qe.fetch(API + "/indicators/" + encodeURIComponent(id));
      if (id !== sel.value) return;  // the reader has already picked another one
      cov.textContent = s.n_obs.toLocaleString() + " obs · " + s.n_segments +
        (s.n_segments === 1 ? " segment" : " segments (membership gaps)") +
        " · " + (sel.selectedIndex + 1) + " of " + sel.options.length;
      const opt = lineOption(s.dates, s.values, C.accent,
        (v) => (v == null ? "—" : Number(v).toFixed(3)));
      opt.dataZoom = [{ type: "inside" }];
      chart.setOption(opt, true);
    }
    const step = (d) => {
      sel.selectedIndex = (sel.selectedIndex + d + sel.options.length) % sel.options.length;
      show(sel.value).catch((err) => console.error(err));
    };
    prevBtn.addEventListener("click", () => step(-1));
    nextBtn.addEventListener("click", () => step(1));
    sel.addEventListener("change", () => show(sel.value).catch((err) => console.error(err)));
    show(sel.value);
  }

  /* ---------- model tab ---------- */

  async function loadModel() {
    const m = await getModel();
    const body = $("model-tab-body");
    if (m.never_scored) {
      body.innerHTML = '<p class="muted">Never scored — the model scores only ' +
        "current universe members, daily since 2026-07-07.</p>";
      return;
    }
    const rr = m.rank_return;
    let html = "";
    if (m.in_book_now) {
      // a position, not an evidence state: the accent dot, never the live hue
      html += '<p class="state-line"><span>In the current book' +
        (m.book_since ? ' since <span class="mono">' + qe.esc(m.book_since) + "</span>" : "") + ".</span></p>";
    }
    html += '<div class="grid2"><div class="panel"><h3>Where the model has ranked this stock</h3>' +
      '<p class="panel-sub">Cross-sectional rank on each scored day; 1 is the model’s favorite, and ' +
      "roughly the top 49 form the book.</p>" +
      '<div id="chart-rank" class="chart short"></div></div>';
    if (rr && rr.n_scored > 0) {
      html += '<div class="panel"><h3>Rank vs next-day result</h3>' +
        '<p class="panel-sub">' + rr.n_scored + " scored days, " + rr.n_realized +
        " with a realized next day. The dashed line is the aggregate rank profile across all stocks.</p>" +
        '<div id="chart-rank-scatter" class="chart short"></div>' +
        '<div id="rr-thirds" class="stats-strip"></div>' +
        '<p class="note">A single stock has only a few dozen scored days. ' +
        "Against an effect of a few basis points per day, that is nowhere near " +
        "enough: this scatter is anecdote, not evidence, and any pattern in it is more likely " +
        "noise than not. Read the aggregate profile instead.</p></div>";
    }
    html += "</div>";
    html += '<h3 style="margin-top: 1rem">Predictions for this symbol <small id="pred-count"></small></h3>' +
      '<div class="tablewrap scroll"><table class="data"><thead><tr>' +
      "<th>Date</th><th>Source</th><th class='num'>Rank</th><th class='num'>Score</th>" +
      "<th class='num' title='Realized forward return, next day'>Realized fwd</th>" +
      "<th class='num' title='Realized sector-excess return, centered across the day'>Realized excess</th></tr></thead><tbody>" +
      m.predictions.slice().reverse().map((r) =>
        "<tr><td class='mono'>" + qe.esc(r.score_date) + "</td>" +
        // the source badge is the one place this tab wears an evidence hue:
        // the row *is* a live or a backfilled prediction
        "<td><span class='badge badge-" + qe.esc(r.source) + "'>" + qe.esc(r.source) + "</span></td>" +
        "<td class='mono num'>" + (r.rank == null ? "—" : r.rank) + "</td>" +
        "<td class='mono num'>" + (r.score == null ? "—" : r.score.toFixed(4)) + "</td>" +
        "<td class='mono num " + qe.signCls(r.realized_fwd_ret) + "'>" + qe.fmtPct(r.realized_fwd_ret, 2) + "</td>" +
        "<td class='mono num " + qe.signCls(r.realized_excess_ret) + "'>" + qe.fmtPct(r.realized_excess_ret, 2) + "</td></tr>").join("") +
      "</tbody></table></div>" +
      '<p class="note">Rows marked backfill were scored in arrears — plumbing, not evidence. ' +
      "The newest row has no realized return until its next bar lands.</p>";
    body.innerHTML = html;
    const nLive = m.predictions.filter((r) => r.source === "live").length;
    $("pred-count").textContent =
      m.predictions.length + " scored days · " + nLive + " live";
    const sigs = m.signals.filter((s) => s.rank != null);
    if (sigs.length) {
      const opt = lineOption(sigs.map((s) => s.score_date), sigs.map((s) => s.rank),
        C.accent, (v) => (v == null ? "—" : "#" + Math.round(v)));
      opt.yAxis.inverse = true;
      opt.yAxis.min = 1;
      opt.grid = { left: 56, right: 16, top: 18, bottom: 40 };
      opt.series[0].showSymbol = sigs.length < 90;
      opt.series[0].symbolSize = 4;
      opt.series[0].itemStyle = { color: C.accent };
      // where "roughly the top 49" sits, so a rank reads against the book's edge
      opt.series[0].markArea = { silent: true, itemStyle: { color: C.soft, opacity: 0.8 },
        label: { show: true, position: "insideTopLeft", color: C.muted, fontSize: 10, fontFamily: C.sans },
        data: [[{ yAxis: 1, name: "≈ book (top 49)" }, { yAxis: 49 }]] };
      qe.chart("chart-rank").setOption(opt);
    }
    if (rr && rr.n_scored > 0) renderRankScatter(rr).catch((e) => console.error(e));
  }

  async function renderRankScatter(rr) {
    /* the stock's own days as dots, the all-stock decile means as a dashed
     * overlay so the anecdote sits inside its context */
    let aggLine = [];
    try {
      const rep = await qe.fetch("/api/model/" + encodeURIComponent(rr.model_id) + "/rank_profile");
      if (rep.available) {
        aggLine = rep.profile.bins.map((b) =>
          [(b.bucket - 0.5) * (100 / rep.profile.n_bins), b.mean_bps]);
      }
    } catch (e) { /* overlay is optional */ }
    const dots = rr.points.filter((p) => p.excess_bps != null).map((p) =>
      ({ value: [p.favorite_pct, p.excess_bps], date: p.date }));
    qe.chart("chart-rank-scatter").setOption({
      animation: false,
      legend: Object.assign({ top: 0, data: ["this stock", "all stocks (decile means)"] }, legendOff),
      tooltip: { trigger: "item", formatter: (o) =>
        o.seriesName === "this stock"
          ? qe.esc(o.data.date) + ": rank pct " + o.value[0].toFixed(0) +
            ", next day " + (o.value[1] >= 0 ? "+" : "") + o.value[1].toFixed(0) + " bps"
          : "decile mean: " + (o.value[1] >= 0 ? "+" : "") + o.value[1].toFixed(1) + " bps" },
      grid: { left: 56, right: 16, top: 30, bottom: 44 },
      xAxis: { type: "value", min: 0, max: 100,
               name: "model rank percentile that day (100 = favorite)",
               nameLocation: "middle", nameGap: 26, nameTextStyle: { fontSize: 10 } },
      yAxis: { type: "value", name: "next-day excess, bps",
               nameTextStyle: { fontSize: 10 } },
      series: [
        { name: "this stock", type: "scatter", data: dots, symbolSize: 7,
          itemStyle: { color: C.accent, opacity: 0.75 } },
        { name: "all stocks (decile means)", type: "line", data: aggLine,
          showSymbol: true, symbolSize: 4, itemStyle: { color: C.grey },
          lineStyle: { color: C.grey, width: 1.4, type: "dashed" } },
      ],
    });
    $("rr-thirds").innerHTML = rr.thirds.map((t) =>
      '<span class="stat"><span class="v ' +
      (t.mean_bps == null ? "" : t.mean_bps >= 0 ? "pos" : "neg") + '">' +
      (t.mean_bps == null ? "—" :
        (t.mean_bps >= 0 ? "+" : "") + t.mean_bps.toFixed(0) + " ± " +
        (t.se_bps == null ? "?" : t.se_bps.toFixed(0)) + " bps") +
      '</span><span class="k">when in the model’s ' + qe.esc(t.label) +
      " (n=" + t.n + ")</span></span>").join("");
  }


  /* ---------- options (Phase Q) ---------- */

  async function loadOptions() {
    const o = await qe.fetch(API + "/options");
    const strip = $("options-summary");
    $("options-note").textContent = o.note;
    if (!o.available) {
      strip.innerHTML = '<span class="muted">no option-chain summaries for this symbol yet — ' +
        "the weekly backfill fills newest weeks first</span>";
      return;
    }
    const L = o.latest;
    const volTxt = (v) => (v == null ? "—" : (v * 100).toFixed(1) + "%");
    const ptsTxt = (v) => (v == null ? "—" : (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + " pts");
    strip.innerHTML =
      statSpan("ATM implied vol, 30d", volTxt(L.atm_iv30)) +
      statSpan("call − put IV", ptsTxt(L.cp_iv_spread)) +
      statSpan("25-delta skew", ptsTxt(L.skew25)) +
      statSpan("put / call open interest", L.pc_oi_ratio == null ? "—" : L.pc_oi_ratio.toFixed(2)) +
      statSpan("contracts", String(L.n_contracts)) +
      statSpan("weeks sampled", o.n_weeks + " · to " + qe.esc(o.last_date));

    const pctAxis = (v) => (v == null ? "—" : (v * 100).toFixed(0) + "%");
    qe.chart("chart-iv").setOption({
      animation: false,
      tooltip: { trigger: "axis", valueFormatter: (v) => (v == null ? "—" : (v * 100).toFixed(1) + "%") },
      legend: Object.assign({ data: ["ATM implied vol, 30d (weekly)", "realized vol, 20d (daily)"] }, legendOff),
      grid: { left: 56, right: 16, top: 34, bottom: 40 },
      xAxis: { type: "time" },
      yAxis: { type: "value", axisLabel: { formatter: pctAxis }, min: 0 },
      dataZoom: [{ type: "inside" }],
      series: [
        { name: "realized vol, 20d (daily)", type: "line", showSymbol: false, connectNulls: false,
          data: o.realized_vol.dates.map((d, i) => [d, o.realized_vol.values[i]]),
          itemStyle: { color: C.grey }, lineStyle: { width: 1.4, color: C.grey } },
        { name: "ATM implied vol, 30d (weekly)", type: "line", showSymbol: true, symbolSize: 5, connectNulls: false,
          data: o.dates.map((d, i) => [d, o.atm_iv30[i]]),
          itemStyle: { color: C.accent, borderColor: C.panel, borderWidth: 1.5 }, lineStyle: { width: 2, color: C.accent } },
      ],
    });
    qe.chart("chart-skew").setOption({
      animation: false,
      tooltip: { trigger: "axis", valueFormatter: (v) => (v == null ? "—" : (v * 100).toFixed(2) + " pts") },
      legend: Object.assign({ data: ["call − put IV (ATM)", "25-delta skew (put − call)"] }, legendOff),
      grid: { left: 56, right: 16, top: 34, bottom: 40 },
      xAxis: { type: "time" },
      yAxis: { type: "value", axisLabel: { formatter: (v) => (v * 100).toFixed(0) + " pts" } },
      dataZoom: [{ type: "inside" }],
      series: [
        { name: "call − put IV (ATM)", type: "line", showSymbol: true, symbolSize: 4, connectNulls: false,
          data: o.dates.map((d, i) => [d, o.cp_iv_spread[i]]),
          itemStyle: { color: C.series2 }, lineStyle: { width: 2, color: C.series2 },
          markLine: { silent: true, symbol: "none", lineStyle: { color: C.line, type: "solid" }, data: [{ yAxis: 0 }], label: { show: false } } },
        { name: "25-delta skew (put − call)", type: "line", showSymbol: true, symbolSize: 4, connectNulls: false,
          data: o.dates.map((d, i) => [d, o.skew25[i]]),
          itemStyle: { color: C.ink2 }, lineStyle: { width: 2, color: C.ink2, type: "dashed" } },
      ],
    });
  }

  /* ---------- wiring ---------- */

  const loaders = { history: loadHistory, patterns: loadPatterns,
                    indicators: loadIndicators, options: loadOptions, model: loadModel };
  document.addEventListener("qe:tab", (ev) => {
    const fn = loaders[ev.detail.tab];
    if (fn) fn().catch((err) => console.error(err));
  });
})();
