/* Symbol page: price/volume chart, patterns, indicators, model record.
 * Tabs load lazily via the qe:tab event from app.js. */
"use strict";

(function () {
  const root = document.getElementById("symbol-page");
  if (!root) return;
  const SYM = root.dataset.symbol;
  const C = qe.colors();

  /* ---------- helpers ---------- */

  const whiskers = qe.whiskerSeries;

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

  function statSpan(label, value, signed) {
    const cls = signed && value != null ? (value >= 0 ? "pos" : "neg") : "";
    const text = typeof value === "string" ? value : qe.fmtPct(value);
    return '<span class="stat"><span class="v ' + cls + '">' + text +
           '</span><span class="k">' + label + "</span></span>";
  }

  /* ---------- history tab ---------- */

  let priceChart = null;
  let nDates = 0;

  async function loadHistory() {
    const p = await qe.fetch("/api/symbol/" + SYM + "/prices");
    const strip = document.getElementById("stats-strip");
    if (!p.n_bars) {
      strip.innerHTML = '<span class="muted">no price history stored</span>';
      return;
    }
    const s = p.stats;
    strip.innerHTML =
      statSpan("last close", qe.fmtNum(s.last_close), false) +
      statSpan("1d", s.returns["1d"], true) +
      statSpan("1m", s.returns["1m"], true) +
      statSpan("1y", s.returns["1y"], true) +
      statSpan("since " + s.first_date.slice(0, 4), s.returns["max"], true) +
      statSpan("vol (63d ann.)", s.ann_vol_63d, false) +
      statSpan("max drawdown", s.max_drawdown, true) +
      statSpan("vs 52w high", s.dist_from_52w_high, true) +
      statSpan("ADV $", qe.fmtCompact(s.adv_20d), false) +
      '<span class="stat"><span class="v">' + s.n_bars.toLocaleString() +
      '</span><span class="k">bars · to ' + s.last_date + "</span></span>";

    nDates = p.dates.length;
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
      tooltip: { trigger: "axis", axisPointer: { type: "cross" } },
      legend: {
        top: 0,
        data: ["Adj close", "Raw close", "Candles (raw)", "SMA 50", "SMA 200", "Dividends"],
        selected: { "Adj close": true, "Raw close": false, "Candles (raw)": false,
                    "SMA 50": false, "SMA 200": true, "Dividends": false },
      },
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
        { name: "Adj close", type: "line", data: p.adj_close, showSymbol: false,
          z: 5, itemStyle: { color: C.accent }, lineStyle: { width: 1.4, color: C.accent },
          markPoint: { symbol: "pin", symbolSize: 34, itemStyle: { color: C.ink2 },
                       label: { formatter: (o) => o.data.value, fontSize: 9, color: C.panel },
                       data: splitPoints } },
        { name: "Raw close", type: "line", data: p.close, showSymbol: false,
          itemStyle: { color: C.grey }, lineStyle: { width: 1, color: C.grey } },
        { name: "Candles (raw)", type: "candlestick", data: p.ohlc,
          itemStyle: { color: C.pos, color0: C.neg, borderColor: C.pos, borderColor0: C.neg } },
        { name: "SMA 50", type: "line", data: p.sma["50"], showSymbol: false,
          itemStyle: { color: C.series2 }, lineStyle: { width: 1.2, color: C.series2 } },
        { name: "SMA 200", type: "line", data: p.sma["200"], showSymbol: false,
          itemStyle: { color: C.ink2 }, lineStyle: { width: 1.2, color: C.ink2, type: "dashed" } },
        { name: "Dividends", type: "scatter", data: divPoints, symbolSize: 7,
          itemStyle: { color: C.grey, borderColor: C.panel, borderWidth: 1.5 } },
        { name: "Volume", type: "bar", data: p.volume, xAxisIndex: 1, yAxisIndex: 1,
          itemStyle: { color: C.soft }, large: true },
      ],
    });

    document.querySelectorAll(".rangebtns button").forEach((btn) =>
      btn.addEventListener("click", () => {
        document.querySelectorAll(".rangebtns button").forEach((b) =>
          b.classList.toggle("on", b === btn));
        const r = btn.dataset.range;
        const start = r === "all" ? 0 : Math.max(0, nDates - parseInt(r, 10));
        priceChart.dispatchAction({ type: "dataZoom", startValue: start, endValue: nDates - 1 });
      }));

    let log = false;
    document.getElementById("log-toggle").addEventListener("click", (ev) => {
      log = !log;
      ev.target.classList.toggle("on", log);
      priceChart.setOption({ yAxis: [{ type: log ? "log" : "value", scale: true }, {}] });
    });
  }

  /* ---------- patterns tab ---------- */

  async function loadPatterns() {
    const p = await qe.fetch("/api/symbol/" + SYM + "/patterns");
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
    qe.chart("chart-monthly").setOption({
      animation: false,
      tooltip: { formatter: (o) => {
        const c = byKey[o.data[0] + ":" + o.data[1]];
        return years[o.data[1]] + " " +
          ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][o.data[0]] +
          ": <b>" + qe.fmtPct(c.ret, 1) + "</b> (" + c.n_days + " days)";
      } },
      grid: { left: 48, right: 70, top: 10, bottom: 28 },
      xAxis: { type: "category",
               data: ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"] },
      yAxis: { type: "category", data: years, inverse: true,
               axisLabel: { fontSize: 10 } },
      visualMap: { min: -maxAbs, max: maxAbs, calculable: false, orient: "vertical",
                   right: 0, top: "center", itemHeight: 120,
                   inRange: { color: [C.neg, C.panel, C.pos] },
                   text: ["+" + maxAbs.toFixed(0) + "%", "-" + maxAbs.toFixed(0) + "%"] },
      series: [{ type: "heatmap", data, label: { show: false },
                 emphasis: { itemStyle: { borderColor: C.ink, borderWidth: 1 } } }],
    });
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
        return r.label + ": <b>" + (r.mean_bps == null ? "—" : r.mean_bps.toFixed(1)) +
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
    body.innerHTML = (top || []).map((d) =>
      "<tr><td class='mono'>" + d.peak_date + "</td><td class='mono'>" + d.trough_date +
      "</td><td class='mono num'>" + qe.fmtPct(d.depth) + "</td><td class='mono'>" +
      (d.recovery_date ? d.recovery_date + " (" + d.recovery_days + "d)" :
       '<span class="badge badge-warn">ongoing</span>') + "</td></tr>").join("");
  }

  function renderHistogram(h) {
    const statsEl = document.getElementById("hist-stats");
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
    const list = await qe.fetch("/api/symbol/" + SYM + "/indicators");
    const sel = document.getElementById("indicator-select");
    const cov = document.getElementById("indicator-coverage");
    if (!list.indicators.length) {
      sel.innerHTML = "<option>none stored</option>";
      cov.textContent = "no indicator values stored for this symbol " +
        "(it may never have been in a scored universe)";
      return;
    }
    sel.innerHTML = list.indicators.map((i) =>
      '<option value="' + i.indicator_id + '">' + i.indicator_id +
      (i.kind ? " · " + i.kind : "") + " · " + i.n_obs.toLocaleString() + " obs</option>").join("");
    const chart = qe.chart("chart-indicator");
    async function show(id) {
      const s = await qe.fetch("/api/symbol/" + SYM + "/indicators/" + id);
      cov.textContent = s.n_obs.toLocaleString() + " obs · " + s.n_segments +
        (s.n_segments === 1 ? " segment" : " segments (membership gaps)");
      chart.setOption(lineOption(s.dates, s.values, C.accent,
        (v) => (v == null ? "—" : Number(v).toFixed(3))), true);
    }
    sel.addEventListener("change", () => show(sel.value));
    show(sel.value);
  }

  /* ---------- model tab ---------- */

  async function loadModel() {
    const m = await qe.fetch("/api/symbol/" + SYM + "/model");
    const body = document.getElementById("model-tab-body");
    if (m.never_scored) {
      body.innerHTML = '<p class="muted">Never scored — the model scores only ' +
        "current universe members, daily since 2026-07-07.</p>";
      return;
    }
    const rr = m.rank_return;
    let html = "";
    if (m.in_book_now) {
      html += '<p class="state-line live">In the current book' +
        (m.book_since ? ' since <span class="mono">' + m.book_since + "</span>" : "") + ".</p>";
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
        "<tr><td class='mono'>" + r.score_date + "</td>" +
        "<td><span class='badge badge-" + r.source + "'>" + r.source + "</span></td>" +
        "<td class='mono num'>" + (r.rank == null ? "—" : r.rank) + "</td>" +
        "<td class='mono num'>" + (r.score == null ? "—" : r.score.toFixed(4)) + "</td>" +
        "<td class='mono num " + qe.signCls(r.realized_fwd_ret) + "'>" + qe.fmtPct(r.realized_fwd_ret, 2) + "</td>" +
        "<td class='mono num " + qe.signCls(r.realized_excess_ret) + "'>" + qe.fmtPct(r.realized_excess_ret, 2) + "</td></tr>").join("") +
      "</tbody></table></div>" +
      '<p class="note">Rows marked backfill were scored in arrears — plumbing, not evidence. ' +
      "The newest row has no realized return until its next bar lands.</p>";
    body.innerHTML = html;
    const nLive = m.predictions.filter((r) => r.source === "live").length;
    document.getElementById("pred-count").textContent =
      m.predictions.length + " scored days · " + nLive + " live";
    const sigs = m.signals.filter((s) => s.rank != null);
    if (sigs.length) {
      const opt = lineOption(sigs.map((s) => s.score_date), sigs.map((s) => s.rank),
        C.accent, (v) => (v == null ? "—" : "#" + Math.round(v)));
      opt.yAxis.inverse = true;
      opt.yAxis.min = 1;
      opt.grid = { left: 56, right: 16, top: 18, bottom: 40 };
      qe.chart("chart-rank").setOption(opt);
    }
    if (rr && rr.n_scored > 0) renderRankScatter(rr).catch((e) => console.error(e));
  }

  async function renderRankScatter(rr) {
    /* the stock's own days as dots, the all-stock decile means as a dashed
     * overlay so the anecdote sits inside its context */
    let aggLine = [];
    try {
      const rep = await qe.fetch("/api/model/" + rr.model_id + "/rank_profile");
      if (rep.available) {
        aggLine = rep.profile.bins.map((b) =>
          [(b.bucket - 0.5) * (100 / rep.profile.n_bins), b.mean_bps]);
      }
    } catch (e) { /* overlay is optional */ }
    const dots = rr.points.filter((p) => p.excess_bps != null).map((p) =>
      ({ value: [p.favorite_pct, p.excess_bps], date: p.date }));
    qe.chart("chart-rank-scatter").setOption({
      animation: false,
      legend: { top: 0, data: ["this stock", "all stocks (decile means)"] },
      tooltip: { trigger: "item", formatter: (o) =>
        o.seriesName === "this stock"
          ? o.data.date + ": rank pct " + o.value[0].toFixed(0) +
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
    document.getElementById("rr-thirds").innerHTML = rr.thirds.map((t) =>
      '<span class="stat"><span class="v ' +
      (t.mean_bps == null ? "" : t.mean_bps >= 0 ? "pos" : "neg") + '">' +
      (t.mean_bps == null ? "—" :
        (t.mean_bps >= 0 ? "+" : "") + t.mean_bps.toFixed(0) + " ± " +
        (t.se_bps == null ? "?" : t.se_bps.toFixed(0)) + " bps") +
      '</span><span class="k">when in the model’s ' + t.label +
      " (n=" + t.n + ")</span></span>").join("");
  }


  /* ---------- options (Phase Q) ---------- */

  async function loadOptions() {
    const o = await qe.fetch("/api/symbol/" + SYM + "/options");
    const strip = document.getElementById("options-summary");
    document.getElementById("options-note").textContent = o.note;
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
      statSpan("weeks sampled", o.n_weeks + " · to " + o.last_date);

    const pctAxis = (v) => (v == null ? "—" : (v * 100).toFixed(0) + "%");
    qe.chart("chart-iv").setOption({
      animation: false,
      tooltip: { trigger: "axis", valueFormatter: (v) => (v == null ? "—" : (v * 100).toFixed(1) + "%") },
      legend: { data: ["ATM implied vol, 30d (weekly)", "realized vol, 20d (daily)"] },
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
      legend: { data: ["call − put IV (ATM)", "25-delta skew (put − call)"] },
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
