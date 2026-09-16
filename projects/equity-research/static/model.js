/* Model dashboard: overview tiles, paper equity curve (live vs backfill drawn
 * differently, SPY overlay), rank profile and daily IC, the P1/P3 timing
 * comparison, the P2 regime map, book quintiles, positions and trades. */
"use strict";

(function () {
  const root = document.getElementById("model-page");
  if (!root) return;
  const MODEL = root.dataset.modelId;
  const C = qe.colors();
  const BT = C.backtest;
  const whiskers = qe.whiskerSeries;
  const bps = (v, d) => qe.fmtBps(v, d == null ? 2 : d);
  const money = (v) => (v == null ? "—" : "$" + qe.fmtNum(v, 0));
  const vcls = (v) => (/^(ATTAINABLE|IMPLEMENTABLE|PASS|REGIME-DEPENDENT|OK)$/i.test(v) ? "pos"
                       : /^(NOT ATTAINABLE|NOT IMPLEMENTABLE|FAIL)/i.test(v) ? "neg" : "");

  /* fill one of the server-rendered overview tiles */
  function setTile(id, valueHtml, sub, cls) {
    const t = document.getElementById(id);
    if (!t) return;
    t.querySelector(".t-value").innerHTML = valueHtml;
    if (sub != null) t.querySelector(".t-sub").innerHTML = sub;
    t.classList.remove("pos", "neg");
    if (cls) t.classList.add(cls);
  }

  async function loadPaper() {
    const p = await qe.fetch("/api/model/" + MODEL + "/paper");
    const summary = document.getElementById("paper-summary");
    if (p.empty) {
      summary.innerHTML = '<span class="muted">' + qe.esc(p.note) + "</span>";
      setTile("ov-value", "—", "no recorded days yet");
      return;
    }
    const s = p.summary;
    summary.innerHTML =
      qe.tile("Account value", money(s.closing_value),
              { sub: "from $100,000 · " + s.n_days_with_pnl + " days with P&amp;L" }) +
      qe.tile("Total net return", qe.fmtPct(s.total_net_return),
              { cls: qe.signCls(s.total_net_return), sub: "live and backfilled days together" }) +
      qe.tile("Net return, live days only", qe.fmtPct(s.live_only_net_return),
              { cls: qe.signCls(s.live_only_net_return), sub: s.n_live_days + " live days — the only evidence" }) +
      qe.tile("Days recorded",
              s.n_live_days + ' <span class="badge badge-live">live</span> &nbsp;' +
              s.n_backfill_days + ' <span class="badge badge-backfill">backfill</span>',
              { sub: "through " + qe.esc(p.as_of) }) +
      qe.tile("Mean net per day", s.mean_net_return == null ? "—" : bps(s.mean_net_return * 1e4, 1),
              { sub: "after 3 bps round-trip on turnover" }) +
      qe.tile("Mean turnover", qe.fmtPct(s.mean_turnover),
              { sub: "share of the book replaced per day · modelled ~22%" }) +
      qe.tile("Mean excess vs SPY", s.mean_excess_vs_spy == null ? "—" : bps(s.mean_excess_vs_spy * 1e4, 1),
              { sub: "net return minus SPY, per day" }) +
      qe.tile("Positions", String(s.positions_held), { sub: "held at the latest book" });
    setTile("ov-value", money(s.closing_value),
            "total net " + qe.fmtPct(s.total_net_return) + " over " + s.n_days + " recorded days");
    setTile("ov-live-net", qe.fmtPct(s.live_only_net_return),
            s.n_live_days + " live days — the only figure that is evidence",
            qe.signCls(s.live_only_net_return));

    /* equity curve: one x axis, live and backfill as separate series so the
     * eye cannot read backfill as evidence */
    const d = p.daily;
    const liveVals = [], backVals = [], spyVals = [];
    let spyLevel = 100000;
    for (let i = 0; i < d.date.length; i++) {
      const v = d.closing_value[i];
      liveVals.push(d.source[i] === "live" ? v : null);
      backVals.push(d.source[i] !== "live" ? v : null);
      if (d.spy_return[i] != null) spyLevel *= 1 + d.spy_return[i];
      spyVals.push(spyLevel);
    }
    // duplicate each regime-boundary point on both series so the curve is
    // continuous while the two regimes stay visually distinct
    for (let i = 1; i < d.date.length; i++) {
      const cur = d.source[i] === "live", prev = d.source[i - 1] === "live";
      if (cur !== prev) {
        if (cur) backVals[i] = d.closing_value[i];
        else liveVals[i] = d.closing_value[i];
      }
    }
    qe.chart("chart-equity").setOption({
      animation: false,
      tooltip: { trigger: "axis", valueFormatter: (v) => (v == null ? "—" : "$" + qe.fmtNum(v, 0)) },
      legend: { data: ["live", "backfill (not evidence)", "SPY (same $)"] },
      grid: { left: 76, right: 20, top: 34, bottom: 46 },
      xAxis: { type: "category", data: d.date, boundaryGap: false },
      yAxis: { type: "value", scale: true, axisLabel: { formatter: (v) => "$" + qe.fmtCompact(v) } },
      dataZoom: [{ type: "inside" }, { type: "slider", bottom: 6, height: 18 }],
      series: [
        { name: "backfill (not evidence)", type: "line", data: backVals, showSymbol: false,
          connectNulls: false, itemStyle: { color: C.backfill },
          lineStyle: { width: 1.6, color: C.backfill, type: "dashed" } },
        { name: "live", type: "line", data: liveVals, showSymbol: false,
          connectNulls: false, itemStyle: { color: C.live },
          lineStyle: { width: 2, color: C.live } },
        { name: "SPY (same $)", type: "line", data: spyVals, showSymbol: false,
          itemStyle: { color: C.grey }, lineStyle: { width: 1, color: C.grey } },
      ],
    });

    document.getElementById("positions-count").textContent = p.positions.length + " names, equal weight";
    document.querySelector("#positions-table tbody").innerHTML =
      p.positions.map((r) =>
        "<tr><td><a class='mono strong' href='" + window.QE_ROOT + "symbol/" + r.symbol + ".html'>" + r.symbol +
        "</a></td><td class='mono'>" + r.entered_on + "</td><td class='mono num'>" +
        qe.fmtPct(r.weight) + "</td><td class='mono num'>$" +
        qe.fmtNum(r.target_value, 0) + "</td></tr>").join("") ||
      '<tr><td colspan="4" class="muted">none</td></tr>';
    document.getElementById("trades-count").textContent = "last " + p.trades.length + " entries and exits";
    document.querySelector("#trades-table tbody").innerHTML =
      p.trades.slice().reverse().map((r) =>
        "<tr><td class='mono'>" + r.date + "</td><td>" +
        (r.action === "BUY" ? '<span class="badge badge-live">BUY</span>'
                            : '<span class="badge badge-warn">SELL</span>') +
        "</td><td><a class='mono' href='" + window.QE_ROOT + "symbol/" + r.symbol + ".html'>" + r.symbol +
        "</a></td></tr>").join("") ||
      '<tr><td colspan="3" class="muted">none</td></tr>';
  }

  async function loadDeciles(source) {
    const rep = await qe.fetch("/api/model/" + MODEL + "/deciles?source=" + source);
    const warn = document.getElementById("decile-warning");
    if (!rep.available) {
      warn.textContent = rep.reason;
      return;
    }
    warn.textContent = rep.warning + (rep.backfill_caveat ? " " + rep.backfill_caveat : "");
    const labels = rep.deciles.map((dd) => "Q" + (dd.bucket + 1));
    const means = rep.deciles.map((dd) => dd.mean_bps);
    const wdata = rep.deciles.map((dd, i) =>
      dd.se_bps == null ? null : [i, dd.mean_bps - dd.se_bps, dd.mean_bps + dd.se_bps])
      .filter((x) => x !== null);
    qe.chart("chart-deciles").setOption({
      animation: false,
      tooltip: { formatter: (o) => {
        const dd = rep.deciles[o.dataIndex];
        return labels[o.dataIndex] + " (bottom→top): <b>" + dd.mean_bps.toFixed(2) +
          " bps</b> ± " + dd.se_bps.toFixed(2) + " SE · " + dd.n_days + " days";
      } },
      grid: { left: 56, right: 12, top: 24, bottom: 30 },
      xAxis: { type: "category", data: labels,
               name: "score bucket within the book →", nameLocation: "middle", nameGap: 22,
               nameTextStyle: { fontSize: 10 } },
      yAxis: { type: "value", name: "realized excess, bps/day", nameTextStyle: { fontSize: 10 } },
      series: [
        { type: "bar", data: qe.bars(means, (v) => (v >= 0 ? C.pos : C.neg)), barMaxWidth: 24,
          barWidth: "55%", itemStyle: { opacity: 0.85 } },
        whiskers(wdata, C.ink2),
      ],
    }, true);
  }

  async function loadRankProfile() {
    const rep = await qe.fetch("/api/model/" + MODEL + "/rank_profile");
    const meta = document.getElementById("rank-profile-meta");
    if (!rep.available) {
      meta.textContent = rep.reason;
      return;
    }
    meta.textContent = qe.rankProfileMeta(rep);
    qe.renderRankProfile("chart-rank-profile", rep);
    const ic = rep.ic;
    qe.chart("chart-ic").setOption({
      animation: false,
      tooltip: { trigger: "axis",
                 valueFormatter: (v) => (v == null ? "—" : Number(v).toFixed(3)) },
      grid: { left: 56, right: 12, top: 26, bottom: 42 },
      xAxis: { type: "category", data: ic.dates, axisLabel: { fontSize: 9 } },
      yAxis: { type: "value", name: "daily rank IC (score vs outcome)",
               nameTextStyle: { fontSize: 10 } },
      series: [
        { type: "bar", data: ic.ic, barWidth: "60%",
          itemStyle: { color: (o) => (o.value >= 0 ? C.pos : C.neg), opacity: 0.85 },
          markLine: { silent: true, symbol: "none",
                      lineStyle: { color: C.ink2, type: "dashed" },
                      label: { formatter: "mean " + (ic.mean_ic >= 0 ? "+" : "") +
                               ic.mean_ic.toFixed(3), fontSize: 9, position: "insideEndTop" },
                      data: [{ yAxis: ic.mean_ic }] } },
      ],
    });
  }

  /* Phase P: the P1/P3 timing comparison and the P2 regime map. Backtest
   * series are drawn in the backtest colour and labelled as such; only the
   * live column is evidence. */
  function fillCell(key, mean, se, n) {
    const td = document.querySelector('#timing-table td[data-k="' + key + '"]');
    if (!td) return;
    if (mean == null) { td.innerHTML = '<span class="muted">—</span>'; return; }
    td.innerHTML = '<span class="v">' + bps(mean) + '</span><span class="se">± ' +
      (se == null ? "?" : se.toFixed(2)) + "</span>" +
      (n != null ? '<span class="n">' + n + " days</span>" : "");
  }

  async function loadExecution() {
    const rep = await qe.fetch("/api/model/" + MODEL + "/execution");
    const verdicts = document.getElementById("timing-verdicts");
    const note = document.getElementById("execution-note");
    note.textContent = rep.notes.execution;
    if (!rep.available) {
      verdicts.innerHTML = '<span class="muted">no registered backtest series for this model yet ' +
        "(scripts/p1_attainable_regimes.py, then p1_persist_daily.py)</span>";
      return;
    }
    const b = rep.backtest, v3 = rep.registered_p3 || {};
    fillCell("implementable", b.implementable_bps, b.implementable_se_bps, b.n_days_implementable);
    const l = rep.live;
    if (l && l.n_days_implementable) {
      fillCell("implementable-live", l.implementable_bps, l.implementable_se_bps, l.n_days_implementable);
    } else {
      const td = document.querySelector('#timing-table td[data-k="implementable-live"]');
      if (td) td.innerHTML = '<span class="muted small">no live days with a realized open-to-open return yet</span>';
    }
    const vb = (label, verdict, detail) =>
      '<span><span class="muted">' + label + '</span><span class="verdict ' + vcls(verdict) + '">' +
      qe.esc(verdict) + "</span>" + (detail ? '<span class="muted small">' + detail + "</span>" : "") + "</span>";
    let html = "";
    if (v3.verdict) html += vb("P3 · lagged execution", v3.verdict, "open t+1 → open t+2");
    if (!html) html = '<span class="muted">no registered verdict recorded yet</span>';
    const ln = l ? l.n_days_implementable : 0;
    html += '<span class="muted small">' + b.n_days_implementable + " holdout days" +
      (ln ? " · " + ln + " live days" + (ln < 100 ? " — not enough to mean anything yet" : "") : "") +
      "</span>";
    verdicts.innerHTML = html;
    qe.chart("chart-execution").setOption({
      animation: false,
      tooltip: { trigger: "axis", valueFormatter: (x) => (x == null ? "—" : x.toFixed(0) + " bps") },
      grid: { left: 70, right: 20, top: 34, bottom: 46 },
      xAxis: { type: "category", data: b.dates, boundaryGap: false },
      yAxis: { type: "value", name: "cumulative excess, bps", nameTextStyle: { fontSize: 10 } },
      dataZoom: [{ type: "inside" }, { type: "slider", bottom: 6, height: 18 }],
      series: [
        { name: "implementable, open→open (backtest)", type: "line", data: b.implementable_cum_bps,
          showSymbol: false, itemStyle: { color: C.accent }, lineStyle: { width: 2, color: C.accent } },
      ],
    });
  }

  async function loadRegimes() {
    const rep = await qe.fetch("/api/model/" + MODEL + "/regimes");
    const meta = document.getElementById("regime-meta");
    const note = document.getElementById("regime-note");
    const chips = document.getElementById("regime-current");
    note.textContent = rep.notes.null;
    if (!rep.available) {
      meta.textContent = "no registered backtest series for this model yet";
      return;
    }
    const cur = rep.current;
    if (cur) {
      chips.innerHTML = ["vol", "trend", "dispersion"].map((k) =>
        '<span class="chip"><span class="chip-k">' + k + '</span><span class="chip-v">' + qe.esc(cur[k]) + "</span></span>").join("") +
        '<span class="muted small">current state as of ' + qe.esc(cur.as_of) + "</span>";
    }
    meta.textContent = rep.n_days + " holdout days in the registered backtest series";
    const rows = rep.rows;
    const labels = rows.map((r) => r.variable + " " + r.regime);
    const means = rows.map((r) => r.implementable_bps);
    const wdata = rows.map((r, i) => (r.implementable_se_bps == null || r.implementable_bps == null) ? null
      : [i, r.implementable_bps - r.implementable_se_bps, r.implementable_bps + r.implementable_se_bps]).filter((x) => x);
    // the current state's bars are highlighted so the reader can find "now"
    const isNow = (r) => cur && cur[r.variable] === r.regime;
    qe.chart("chart-regimes").setOption({
      animation: false,
      tooltip: { formatter: (o) => {
        const r = rows[o.dataIndex];
        return labels[o.dataIndex] + (isNow(r) ? " (current)" : "") + ": <b>" + bps(r.implementable_bps) + "</b>" +
          (r.implementable_se_bps == null ? "" : " ± " + r.implementable_se_bps.toFixed(2) + " SE") +
          " · " + r.n_days_implementable + " days";
      } },
      grid: { left: 56, right: 12, top: 24, bottom: 48 },
      xAxis: { type: "category", data: labels, axisLabel: { fontSize: 10, interval: 0, rotate: 20 } },
      yAxis: { type: "value", name: "implementable excess, bps/day (backtest)", nameTextStyle: { fontSize: 10 } },
      series: [
        { type: "bar", data: rows.map((r, i) => (means[i] == null ? null : {
            value: means[i],
            itemStyle: { color: means[i] >= 0 ? BT : C.neg, opacity: isNow(r) ? 1 : 0.55,
                         borderRadius: means[i] >= 0 ? [3, 3, 0, 0] : [0, 0, 3, 3],
                         borderColor: isNow(r) ? C.ink : "transparent", borderWidth: isNow(r) ? 1.5 : 0 },
          })), barMaxWidth: 24, barWidth: "55%" },
        whiskers(wdata, C.ink2),
      ],
    }, true);
    // p, q and verdict only: the registered test ran on the credited leg, so its
    // observed difference and null percentile are in credited bps and would be
    // read as belonging to the bars above. The mismatch note says so in words.
    document.querySelector("#regime-tests tbody").innerHTML = rep.tests.map((t) =>
      "<tr><td>" + t.variable + " (top − bottom)</td><td class='mono num'>" +
      (t.p_value == null ? "—" : t.p_value.toFixed(3)) +
      "</td><td class='mono num'>" + (t.q_value == null ? "—" : t.q_value.toFixed(3)) +
      "</td><td><span class='verdict " + vcls(t.verdict || "") + "'>" +
      (t.verdict || "—") + "</span></td></tr>").join("") ||
      '<tr><td colspan="4" class="muted">no registered tests recorded</td></tr>';
    const mismatch = document.getElementById("regime-leg-mismatch");
    if (mismatch) mismatch.textContent = rep.notes.leg_mismatch;
  }

  ["src-live", "src-backfill"].forEach((id) => {
    const btn = document.getElementById(id);
    btn.addEventListener("click", () => {
      document.getElementById("src-live").classList.toggle("on", id === "src-live");
      document.getElementById("src-backfill").classList.toggle("on", id === "src-backfill");
      loadDeciles(btn.dataset.src).catch((e) => console.error(e));
    });
  });

  loadPaper().catch((e) => console.error(e));
  loadDeciles("live").catch((e) => console.error(e));
  loadRankProfile().catch((e) => console.error(e));
  loadExecution().catch((e) => console.error(e));
  loadRegimes().catch((e) => console.error(e));
})();
