/* Model dashboard: overview tiles, paper equity curve (live vs backfill drawn
 * differently, SPY overlay), rank profile and daily IC, the P1/P3 timing
 * comparison, the P2 regime map, book quintiles, positions and trades.
 *
 * The interaction layer on top (css/model.css): a section rail under the
 * subnav, keys 1–9 to jump to a section, the committed ring filling and the
 * verdicts being stamped on first view, and the two bar charts growing once.
 * Motion goes to navigation and to a figure arriving, never to its size, and
 * every JS-driven piece of it is skipped under prefers-reduced-motion. */
"use strict";

(function () {
  const root = document.getElementById("model-page");
  if (!root) return;
  const MODEL = root.dataset.modelId;
  const C = qe.colors();
  const BT = C.backtest;
  const whiskers = qe.whiskerSeries;
  const reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const bps = (v, d) => qe.fmtBps(v, d == null ? 2 : d);
  const money = (v) => (v == null ? "—" : "$" + qe.fmtNum(v, 0));
  const vcls = (v) => (/^(ATTAINABLE|IMPLEMENTABLE|PASS|REGIME-DEPENDENT|OK)$/i.test(v) ? "pos"
                       : /^(NOT ATTAINABLE|NOT IMPLEMENTABLE|FAIL)/i.test(v) ? "neg" : "");
  /* Every leg-based number is recomputed from prices_daily on request, so it
   * moves when a bar is restated overnight. Say which prices produced it. */
  const asOf = (d) => (d == null ? "" :
    "Computed from prices as of " + qe.esc(d) +
    "; derived rows restate nightly by up to 6 bps on single days.");
  /* An undefined SE is not a zero one: below the block length the bootstrap
   * has nothing to resample and the honest answer is that we cannot say. */
  const UNDEFINED_SE = "undefined below 6 days";
  const se = (v) => (v == null ? UNDEFINED_SE : bps(v));

  /* Two returns, never one: the days committed before their outcome existed are
   * evidence, and the live stamp is not the same set — 30 days scored in
   * arrears were restamped on 2026-09-12 (C20). Each number carries the count
   * it was taken over, so neither can be read as the other. */
  const committedSub = (s) =>
    "over " + s.n_committed_days + " days committed before the outcome existed — " +
    "the only figure that is evidence";
  const stampedSub = (s) =>
    "over " + s.n_live_days + " stamped-live days, including " +
    (s.n_live_days - s.n_committed_days) + " restamped in arrears (C20) — not evidence";

  /* run `fn` once, the first time `el` scrolls into view */
  function onFirstView(el, fn) {
    if (!el) return;
    if (!("IntersectionObserver" in window)) { fn(); return; }
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      fn();
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.1 });
    io.observe(el);
  }

  /* ---- arrival: the committed ring fills, the verdicts are stamped --------
   * The server draws both complete. Only this script hides them for their
   * arrival (`.primed`), and it does so first, before anything else here can
   * throw — so a script that fails to load or breaks later leaves every
   * verdict and the ring on screen. `.hold` keeps the hiding itself from
   * animating: the reader must never watch a verdict fade out. */
  function primeArrival(el, go) {
    if (!el || reduced || !document.documentElement.classList.contains("fx")) return;
    el.classList.add("hold", "primed");
    void el.offsetWidth;  // commit the hidden state with transitions off
    el.classList.remove("hold");
    onFirstView(el, () => requestAnimationFrame(() => el.classList.add(go)));
  }
  primeArrival(document.getElementById("glance-ring"), "armed");
  primeArrival(document.getElementById("verdict-stamps"), "in");

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
    const box = (o) => Object.assign({ boxed: true }, o);
    summary.innerHTML =
      qe.tile("Account value", money(s.closing_value),
              box({ sub: "from $100,000 · " + s.n_days_with_pnl + " days with P&amp;L" })) +
      qe.tile("Total net return", qe.fmtPct(s.total_net_return),
              box({ cls: qe.signCls(s.total_net_return), sub: "live and backfilled days together" })) +
      qe.tile("Net return, committed days only", qe.fmtPct(s.net_return_committed),
              box({ cls: qe.signCls(s.net_return_committed), sub: committedSub(s) })) +
      qe.tile("Net return, stamped-live days", qe.fmtPct(s.live_only_net_return),
              box({ cls: qe.signCls(s.live_only_net_return), sub: stampedSub(s) })) +
      qe.tile("Days recorded",
              s.n_live_days + ' <span class="badge badge-live">live</span> <span class="se">(' +
              s.n_committed_days + ' committed in advance)</span> &nbsp;' +
              s.n_backfill_days + ' <span class="badge badge-backfill">backfill</span>',
              box({ sub: "through " + qe.esc(p.as_of) })) +
      qe.tile("Mean net per day", s.mean_net_return == null ? "—" : bps(s.mean_net_return * 1e4, 1),
              box({ sub: "after 3 bps round-trip on turnover" })) +
      qe.tile("Mean turnover", qe.fmtPct(s.mean_turnover),
              box({ sub: "share of the book replaced per day · modelled ~22%" })) +
      qe.tile("Mean excess vs SPY", s.mean_excess_vs_spy == null ? "—" : bps(s.mean_excess_vs_spy * 1e4, 1),
              box({ sub: "net return minus SPY, per day" })) +
      qe.tile("Positions", String(s.positions_held), box({ sub: "held at the latest book" }));
    setTile("ov-value", money(s.closing_value),
            "total net " + qe.fmtPct(s.total_net_return) + " over " + s.n_days + " recorded days");
    setTile("ov-live-net", qe.fmtPct(s.net_return_committed), committedSub(s),
            qe.signCls(s.net_return_committed));

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

    initReplay(d, backVals, liveVals, spyVals);

    document.getElementById("positions-count").textContent = p.positions.length + " names, equal weight";
    document.querySelector("#positions-table tbody").innerHTML =
      p.positions.map((r) =>
        "<tr><td><a class='mono strong' href='" + qe.symbolHref(r.symbol) + "'>" + qe.esc(r.symbol) +
        "</a></td><td class='mono'>" + qe.esc(r.entered_on == null ? "—" : r.entered_on) +
        "</td><td class='mono num'>" + qe.fmtPct(r.weight) + "</td><td class='mono num'>$" +
        qe.fmtNum(r.target_value, 0) + "</td></tr>").join("") ||
      '<tr><td colspan="4" class="muted">none</td></tr>';
    // data-act is one of two literals chosen here, never the stored string; the
    // trailing row speaks only when the filter leaves nothing to show
    document.querySelector("#trades-table tbody").innerHTML =
      p.trades.slice().reverse().map((r) => {
        const buy = r.action === "BUY";
        return "<tr data-act='" + (buy ? "BUY" : "SELL") + "'><td class='mono'>" + qe.esc(r.date) + "</td><td>" +
          (buy ? '<span class="badge badge-info">BUY</span>'
               : '<span class="badge badge-warn">SELL</span>') +
          "</td><td><a class='mono' href='" + qe.symbolHref(r.symbol) + "'>" + qe.esc(r.symbol) +
          "</a></td></tr>";
      }).join("") +
      '<tr id="trades-none" hidden><td colspan="3" class="muted">none</td></tr>';
    filterTrades(tradeAct);
  }

  /* The stamp a recorded day carries, read from that day's own source and
   * committed flags — never from which drawn series holds its point. The
   * newest day has no closing value until its return is realized, and every
   * live/backfill boundary point is drawn on both series so the curve stays
   * continuous; either would put the wrong word on a day. A live stamp that
   * was not committed in advance is one of the days scored in arrears and
   * restamped (C20), and says so. */
  const dayStamp = (source, committed) => (source === "live"
    ? (committed ? "live · committed in advance" : "live stamp · scored in arrears (C20) · not evidence")
    : "backfill · not evidence");

  /* Replay: redraw the paper record one recorded day at a time, with a
   * readout of the date and its evidence state — deliberately not the account
   * value, which would make the replay a ticking P&L counter. Same data, same
   * series, same hues; the only thing that moves is how much of the record is
   * drawn. It is a requestAnimationFrame loop, so it is not offered under
   * reduced motion: the whole record is already drawn, and nothing is hidden
   * by its absence. */
  function initReplay(d, back, live, spy) {
    if (reduced) return;
    const host = document.getElementById("chart-equity");
    const dates = d.date;
    if (!host || dates.length < 3 || document.getElementById("replay-btn")) return;
    const bar = document.createElement("div");
    bar.className = "chart-tools";
    bar.innerHTML = '<button type="button" class="replay-btn" id="replay-btn"><span class="ico"></span>' +
      '<span class="lbl">Replay the record</span></button><span class="replay-read" id="replay-read"></span>';
    host.parentNode.insertBefore(bar, host);
    const btn = bar.querySelector("button"), read = bar.querySelector("#replay-read");
    const chart = qe.chart("chart-equity");
    const n = dates.length;
    let raf = 0, i = 0;
    const cut = (arr, k) => arr.map((v, j) => (j <= k ? v : null));
    const draw = (k) => {
      chart.setOption({ series: [{ data: cut(back, k) }, { data: cut(live, k) }, { data: cut(spy, k) }] });
      read.textContent = dates[k] + " · " + dayStamp(d.source[k], d.committed && d.committed[k]) +
        (d.closing_value[k] == null ? " · " + (k === n - 1 ? "no closing value yet" : "no closing value") : "");
    };
    // however it ends, the whole record is drawn and the readout is cleared:
    // a per-day label must not outlive the frame it described
    const stop = () => {
      cancelAnimationFrame(raf); raf = 0;
      btn.classList.remove("playing");
      btn.querySelector(".lbl").textContent = "Replay the record";
      draw(n - 1);
      read.textContent = "";
    };
    btn.addEventListener("click", () => {
      if (raf) { stop(); return; }
      btn.classList.add("playing");
      btn.querySelector(".lbl").textContent = "Stop";
      i = 1;
      const perDay = Math.max(25, Math.min(220, 5000 / n));  // ~5 s however long the record
      let last = 0;
      // the newest day's frame is held a little longer so its label can be
      // read before the readout clears; Stop still ends it at once
      const step = (t) => {
        if (t - last >= (i >= n ? Math.max(perDay, 1400) : perDay)) {
          if (i >= n) { stop(); return; }
          last = t; draw(i); i += 1;
        }
        raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    });
  }

  /* Bars grow from the baseline once, the first time the chart is in view
   * (and again on a user's own redraw, such as the live/backfill toggle). The
   * chart is always drawn complete first, so with motion reduced, without an
   * observer, or before it is scrolled to, the reader sees the whole figure.
   * The ±1 SE whiskers do not animate: the uncertainty is already on the
   * chart when the estimate arrives inside it. */
  function growBars(id) {
    if (reduced) return;
    const el = document.getElementById(id);
    const chart = el && echarts.getInstanceByDom(el);
    if (!chart) return;
    const replay = () => {
      const opt = chart.getOption();
      if (!opt || !opt.series || !opt.series.length) return;
      opt.animation = true;
      opt.series.forEach((s) => {
        if (s.type === "bar") {
          s.animation = true;
          s.animationDuration = 650;
          s.animationEasing = "cubicOut";
          s.animationDelay = (i) => i * 45;
        } else {
          s.animation = false;
        }
      });
      // clear + set in one task: the browser never paints the empty frame
      chart.clear();
      chart.setOption(opt);
    };
    if (el.dataset.grown) replay();
    else onFirstView(el, () => { el.dataset.grown = "1"; replay(); });
  }

  // a slow live response must not land under the backfill button (or the
  // reverse): only the newest request may draw
  let decileSeq = 0;
  async function loadDeciles(source) {
    const my = ++decileSeq;
    const rep = await qe.fetch("/api/model/" + MODEL + "/deciles?source=" + source);
    if (my !== decileSeq) return;
    const warn = document.getElementById("decile-warning");
    if (!rep.available) {
      warn.textContent = rep.reason;
      // the other source's bars must not stay drawn under this source's button
      const prev = echarts.getInstanceByDom(document.getElementById("chart-deciles"));
      if (prev) prev.clear();
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
          " bps</b> ± " + (dd.se_bps == null ? "?" : dd.se_bps.toFixed(2)) + " SE · " + dd.n_days + " days";
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
    growBars("chart-deciles");
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
    growBars("chart-rank-profile");
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
  function fillCell(key, mean, se, n, seUnknown) {
    const td = document.querySelector('#timing-table td[data-k="' + key + '"]');
    if (!td) return;
    if (mean == null) { td.innerHTML = '<span class="muted">—</span>'; return; }
    td.innerHTML = '<span class="v">' + bps(mean) + '</span><span class="se">' +
      (se != null ? "± " + se.toFixed(2) : (seUnknown || "± ?")) + "</span>" +
      (n != null ? '<span class="n">' + n + " days</span>" : "");
  }

  async function loadExecution() {
    const rep = await qe.fetch("/api/model/" + MODEL + "/execution");
    const verdicts = document.getElementById("timing-verdicts");
    const note = document.getElementById("execution-note");
    note.textContent = rep.notes.execution;
    document.getElementById("execution-asof").textContent = asOf(rep.prices_as_of);
    if (!rep.available) {
      verdicts.innerHTML = '<span class="muted">no registered backtest series for this model yet ' +
        "(scripts/p1_attainable_regimes.py, then p1_persist_daily.py)</span>";
      return;
    }
    const b = rep.backtest, v3 = rep.registered_p3 || {};
    fillCell("implementable", b.implementable_bps, b.implementable_se_bps, b.n_days_implementable);
    /* the cell is the committed-in-advance series; the stamped-live one goes in
     * the note under the table, labelled as including the C20 restamps */
    const l = rep.live_committed;
    if (l && l.n_days_implementable) {
      fillCell("implementable-live", l.implementable_bps, l.implementable_se_bps,
               l.n_days_implementable, "SE " + UNDEFINED_SE);
    } else {
      const td = document.querySelector('#timing-table td[data-k="implementable-live"]');
      if (td) td.innerHTML = '<span class="muted small">no day committed in advance carries a realized open-to-open return yet</span>';
    }
    const sl = rep.live;
    const stamped = document.getElementById("execution-stamped");
    if (stamped) {
      stamped.textContent = sl && sl.n_days_implementable
        ? bps(sl.implementable_bps) + " ± " +
          (sl.implementable_se_bps == null ? UNDEFINED_SE : sl.implementable_se_bps.toFixed(2)) +
          " over " + sl.n_days_implementable + " days"
        : "— (no live-stamped day carries the leg yet)";
    }
    const vb = (label, verdict, detail) =>
      '<span><span class="muted">' + label + '</span><span class="verdict ' + vcls(verdict) + '">' +
      qe.esc(verdict) + "</span>" + (detail ? '<span class="muted small">' + detail + "</span>" : "") + "</span>";
    let html = "";
    if (v3.verdict) html += vb("P3 · lagged execution", v3.verdict, "open t+1 → open t+2");
    if (!html) html = '<span class="muted">no registered verdict recorded yet</span>';
    const ln = l ? l.n_days_implementable : 0;
    html += '<span class="muted small">' + b.n_days_implementable + " holdout days" +
      (ln ? " · " + ln + " days committed in advance" +
            (ln < 100 ? " — not enough to mean anything yet" : "") : "") +
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

  /* The paper companion: the paired series when one is fixed, the four
   * candidates and what each could ever settle when none is. The power line
   * and the MDE show in both states — they are the reason to expect little
   * from this panel, and hiding them until a companion exists would make the
   * fixed state read as more informative than it is. */
  function powerLine(rows) {
    if (!rows || !rows.length) return "No power figures for this characteristic.";
    const span = (x) => (x.days == null ? "—"
      : x.days.toLocaleString() + " days (" + qe.fmtNum(x.years, 0) + " y)");
    const one = (p) =>
      qe.esc(p.characteristic) + ": " + span(p.whole_book) +
      " for a difference the size of the model's whole gross, " + span(p.observed) +
      " for the " + bps(p.observed_diff_bps, 2) + "/day AG-020 measured";
    return "Days to t = 2, at AG-020's own dispersion — " + rows.map(one).join("; ") + ".";
  }

  async function loadCompanion() {
    const rep = await qe.fetch("/api/model/" + MODEL + "/companion");
    const summary = document.getElementById("companion-summary");
    if (!summary) return;
    document.getElementById("companion-asof").textContent = asOf(rep.prices_as_of);
    document.getElementById("companion-power").textContent = powerLine(rep.power);
    if (!rep.fixed) {
      summary.innerHTML = rep.candidates.map((c) =>
        qe.tile(c.characteristic, qe.esc(c.direction),
                { boxed: true,
                  sub: "turnover " + qe.fmtNum(
                    (rep.power.find((p) => p.characteristic === c.characteristic) || {}).turnover_pct, 2) +
                  "%/day on AG-020's panel" })).join("");
      return;
    }
    const p = rep.paired, t = rep.turnover;
    const be = (x) => (x.breakeven_bps == null ? "—" : bps(x.breakeven_bps, 1));
    const turn = (x) => (x.replaced == null ? "—" : qe.fmtPct(x.replaced) + " /day");
    summary.innerHTML =
      qe.tile("Days scored", String(rep.days.live + rep.days.backfill),
              { boxed: true,
                sub: rep.days.live + ' <span class="badge badge-live">live</span> &nbsp;' +
                     rep.days.backfill + ' <span class="badge badge-backfill">backfill</span>' }) +
      qe.tile("Committed in advance", String(rep.days.committed),
              { boxed: true, sub: rep.days.restamped + " live-stamped days were scored in arrears" }) +
      qe.tile("Paired days", String(p.n_days),
              { boxed: true, sub: "dates both books committed before the outcome existed" }) +
      qe.tile("Model − companion", bps(p.diff_bps),
              { boxed: true, cls: qe.signCls(p.diff_bps),
                sub: "SE " + se(p.diff_se_bps) + " · MDE " + se(p.mde_bps) }) +
      qe.tile("Model turnover", turn(t.model),
              { boxed: true,
                sub: "breakeven " + be(t.model) + " round-trip (R2's convention), gross of an unmeasured cost" }) +
      qe.tile("Companion turnover", turn(t.companion),
              { boxed: true,
                sub: "breakeven " + be(t.companion) + " round-trip (R2's convention), gross of an unmeasured cost" });
  }

  /* A failed payload says so in its panel instead of spinning forever; the
   * server-rendered method copy around it is unaffected, and the failure is
   * still logged for whoever has the console open. */
  const failNote = (err, what) => '<span class="load-failed">' + what + " did not load (" +
    qe.esc(err && err.message ? err.message : "request failed") + ").</span>";
  const showFail = (id, what, also) => (err) => {
    console.error(err);
    const el = document.getElementById(id);
    if (el) el.innerHTML = failNote(err, what);
    if (also) also();
  };

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
    const rows = rep.rows;
    const labels = rows.map((r) => r.variable + " " + r.regime);
    const means = rows.map((r) => r.implementable_bps);
    const wdata = rows.map((r, i) => (r.implementable_se_bps == null || r.implementable_bps == null) ? null
      : [i, r.implementable_bps - r.implementable_se_bps, r.implementable_bps + r.implementable_se_bps]).filter((x) => x);
    // the current state's bars are highlighted so the reader can find "now"
    const isNow = (r) => cur && cur[r.variable] === r.regime;
    if (cur) {
      // each chip is a button that finds its own bar in the chart beside it
      chips.innerHTML = ["vol", "trend", "dispersion"].map((k) => {
        const idx = rows.findIndex((r) => r.variable === k && r.regime === cur[k]);
        return '<button type="button" class="chip" data-idx="' + idx + '"><span class="chip-k">' + k +
          '</span><span class="chip-v">' + qe.esc(cur[k]) + "</span></button>";
      }).join("") +
        '<span class="muted small">current state as of ' + qe.esc(cur.as_of) +
        " &middot; point at a state to find its bar</span>";
    }
    meta.textContent = rep.n_days + " holdout days in the registered backtest series";
    const chart = qe.chart("chart-regimes");
    chart.setOption({
      animation: false,
      tooltip: { formatter: (o) => {
        const r = rows[o.dataIndex];
        return qe.esc(labels[o.dataIndex]) + (isNow(r) ? " (current)" : "") + ": <b>" + bps(r.implementable_bps) + "</b>" +
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
          })), barMaxWidth: 24, barWidth: "55%", emphasis: { focus: "self" } },
        whiskers(wdata, C.ink2),
      ],
    }, true);
    chips.querySelectorAll("button.chip").forEach((b) => {
      const i = +b.dataset.idx;
      if (!(i >= 0)) return;
      const on = () => {
        chart.dispatchAction({ type: "highlight", seriesIndex: 0, dataIndex: i });
        chart.dispatchAction({ type: "showTip", seriesIndex: 0, dataIndex: i });
      };
      const off = () => {
        chart.dispatchAction({ type: "downplay", seriesIndex: 0, dataIndex: i });
        chart.dispatchAction({ type: "hideTip" });
      };
      b.addEventListener("mouseenter", on);
      b.addEventListener("focus", on);
      b.addEventListener("click", on);
      b.addEventListener("mouseleave", off);
      b.addEventListener("blur", off);
    });
    // p, q and verdict only: the registered test ran on the credited leg, so its
    // observed difference and null percentile are in credited bps and would be
    // read as belonging to the bars above. The mismatch note says so in words.
    document.querySelector("#regime-tests tbody").innerHTML = rep.tests.map((t) =>
      "<tr><td>" + qe.esc(t.variable) + " (top − bottom)</td><td class='mono num'>" +
      (t.p_value == null ? "—" : t.p_value.toFixed(3)) +
      "</td><td class='mono num'>" + (t.q_value == null ? "—" : t.q_value.toFixed(3)) +
      "</td><td><span class='verdict " + vcls(t.verdict || "") + "'>" +
      qe.esc(t.verdict || "—") + "</span></td></tr>").join("") ||
      '<tr><td colspan="4" class="muted">no registered tests recorded</td></tr>';
    const mismatch = document.getElementById("regime-leg-mismatch");
    if (mismatch) mismatch.textContent = rep.notes.leg_mismatch;
  }

  /* ---- the book: which trades to show ------------------------------------- */
  /* The count beside the heading says what the filter leaves, out of what,
   * and a filter that leaves nothing says so rather than showing a bare table. */
  let tradeAct = "";
  const TRADE_WORDS = { "": "entries and exits", BUY: "entries", SELL: "exits" };
  function filterTrades(act) {
    tradeAct = TRADE_WORDS[act] ? act : "";
    const rows = Array.from(document.querySelectorAll("#trades-table tbody tr[data-act]"));
    let shown = 0;
    rows.forEach((r) => {
      r.hidden = !!tradeAct && r.dataset.act !== tradeAct;
      if (!r.hidden) shown += 1;
    });
    const none = document.getElementById("trades-none");
    if (!none) return;  // the record has not loaded, or did not load
    none.hidden = shown > 0;
    none.cells[0].textContent = tradeAct
      ? "no " + TRADE_WORDS[tradeAct] + " among the last " + rows.length + " trades" : "none";
    document.getElementById("trades-count").textContent = tradeAct
      ? shown + " " + TRADE_WORDS[tradeAct] + " of the last " + rows.length + " trades"
      : "last " + rows.length + " " + TRADE_WORDS[""];
  }
  function pressOne(group, btn) {
    group.querySelectorAll("button").forEach((x) => {
      x.classList.toggle("on", x === btn);
      x.setAttribute("aria-pressed", x === btn ? "true" : "false");
    });
  }
  const tradesSeg = document.getElementById("trades-filter");
  if (tradesSeg) {
    tradesSeg.addEventListener("click", (ev) => {
      const b = ev.target.closest("button");
      if (!b) return;
      pressOne(tradesSeg, b);
      filterTrades(b.dataset.act);
    });
  }

  ["src-live", "src-backfill"].forEach((id) => {
    const btn = document.getElementById(id);
    btn.addEventListener("click", () => {
      pressOne(btn.parentNode, btn);
      loadDeciles(btn.dataset.src).catch(showFail("decile-warning", "The book's quintiles"));
    });
  });

  /* ---- navigation: the section rail, keys 1–9, the arrival flash ----------- */
  function arrive(sec) {
    if (reduced || !sec) return;
    sec.classList.remove("arrive");
    void sec.offsetWidth;  // restart the animation on a repeat jump
    sec.classList.add("arrive");
    clearTimeout(sec._arriveT);
    sec._arriveT = setTimeout(() => sec.classList.remove("arrive"), 1300);
  }

  function initNav() {
    const nav = document.querySelector(".subnav");
    if (!nav) return;
    const links = Array.from(nav.querySelectorAll('a[href^="#"]'));
    const secs = links.map((a) => document.getElementById(a.getAttribute("href").slice(1)));
    if (!secs.length || secs.some((s) => !s)) return;
    nav.classList.add("numbered");
    // the visible hint below is decoration; this is what a screen reader hears
    links.slice(0, 9).forEach((a, i) => a.setAttribute("aria-keyshortcuts", String(i + 1)));
    const hint = document.createElement("span");
    hint.className = "subnav-keys";
    hint.setAttribute("aria-hidden", "true");
    hint.innerHTML = "<kbd>1</kbd>&ndash;<kbd>" + Math.min(9, links.length) + "</kbd> jump";
    nav.appendChild(hint);

    // the rail: one segment per section, filled as the reading line passes it
    const rail = document.createElement("div");
    rail.className = "model-rail";
    rail.setAttribute("aria-hidden", "true");
    rail.innerHTML = secs.map(() => "<i></i>").join("");
    nav.after(rail);
    const segs = Array.from(rail.children);
    const place = () => {
      const top = parseFloat(getComputedStyle(nav).top) || 0;
      rail.style.top = (top + nav.offsetHeight - 3) + "px";
      secs.forEach((s, i) => { segs[i].style.flexGrow = String(Math.max(1, s.offsetHeight)); });
    };
    let queued = false;
    const paint = () => {
      queued = false;
      const line = window.innerHeight * 0.35;
      const atEnd = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2;
      secs.forEach((s, i) => {
        const r = s.getBoundingClientRect();
        const f = atEnd ? 1 : Math.max(0, Math.min(1, (line - r.top) / Math.max(1, r.height)));
        segs[i].style.setProperty("--f", f.toFixed(4));
        segs[i].classList.toggle("cur", f > 0 && f < 1);
      });
    };
    const queue = () => { if (!queued) { queued = true; requestAnimationFrame(paint); } };
    window.addEventListener("scroll", queue, { passive: true });
    window.addEventListener("resize", () => { place(); queue(); });
    // charts and tables land after load and change every section's height
    if ("ResizeObserver" in window) new ResizeObserver(() => { place(); queue(); }).observe(root);
    place();
    paint();

    const jump = (k) => {
      const sec = secs[k];
      sec.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
      history.replaceState(null, "", "#" + sec.id);
      // keyboard focus follows, so Tab continues from the section just reached
      if (!sec.hasAttribute("tabindex")) sec.setAttribute("tabindex", "-1");
      sec.focus({ preventScroll: true });
      arrive(sec);
    };
    document.addEventListener("keydown", (ev) => {
      if (ev.metaKey || ev.ctrlKey || ev.altKey || ev.defaultPrevented) return;
      if (!/^[1-9]$/.test(ev.key)) return;
      const a = document.activeElement;
      const tag = a && a.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (a && a.isContentEditable)) return;
      if (document.querySelector(".palette:not([hidden])")) return;  // fx.js's palette or help sheet
      const k = Number(ev.key) - 1;
      if (k >= secs.length) return;
      ev.preventDefault();
      jump(k);
    });
    links.forEach((a, i) => a.addEventListener("click", () => arrive(secs[i])));
    if (location.hash) {
      const t = secs.find((s) => "#" + s.id === location.hash);
      if (t) setTimeout(() => arrive(t), 450);
    }
  }

  initNav();
  loadPaper().catch(showFail("paper-summary", "The paper record",
    () => setTile("ov-value", "—", "the paper record did not load")));
  loadDeciles("live").catch(showFail("decile-warning", "The book's quintiles"));
  loadRankProfile().catch(showFail("rank-profile-meta", "The rank profile"));
  loadExecution().catch(showFail("timing-verdicts", "The timing figures"));
  loadCompanion().catch(showFail("companion-summary", "The companion figures", () => {
    const power = document.getElementById("companion-power");
    if (power) power.textContent = "";
  }));
  loadRegimes().catch(showFail("regime-meta", "The regime figures"));
})();
