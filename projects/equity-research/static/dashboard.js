/* Dashboard: the two return cards, filled from /api/dashboard. The research
 * card is server-rendered and needs nothing here.
 *
 * Both cards lead with the days committed in advance and put the tested decade
 * beside them, as /model does. Every figure is the payload's own; this script
 * formats, it never computes a statistic. An empty cell says why it is empty. */
"use strict";

(function () {
  const root = document.getElementById("dashboard-page");
  if (!root || !root.dataset.modelId) return;
  const C = qe.colors();
  const bps = (v, d) => qe.fmtBps(v, d == null ? 2 : d);
  const pctYear = (dailyBps) => qe.fmtPct(dailyBps * 252 / 1e4);
  const ratio = (v) => v.toFixed(2);
  const days = (n) => qe.fmtNum(n, 0) + (n === 1 ? " day" : " days");
  /* an undefined SE is not a zero one: below six days the bootstrap has
   * nothing to resample */
  const pmSe = (se, d) => (se == null ? "± undefined below 6 days" : "± " + se.toFixed(d == null ? 2 : d));

  function fig(id, big, sub) {
    const el = document.getElementById(id);
    if (!el) return;
    el.querySelector(".dash-big").innerHTML = big;
    el.querySelector(".dash-sub").innerHTML = sub;
  }
  const muted = (s) => '<span class="muted small">' + s + "</span>";

  function returnCard(p) {
    const c = p.committed, b = p.backtest, s = p.since_live_start, r = p.risk;
    if (c && c.n_days_implementable) {
      fig("ret-committed",
          bps(c.implementable_bps) + ' <span class="se">' + pmSe(c.implementable_se_bps) + "</span>",
          // no yearly figure here: a few dozen noisy days scaled up by 252
          // reads as a forecast, and the ± beside it says it is not one
          days(c.n_days_implementable) + " · far too few to settle anything");
    } else {
      fig("ret-committed", "—", muted("no day committed in advance carries a realized return yet"));
    }
    if (b && b.n_days_implementable) {
      fig("ret-backtest",
          bps(b.implementable_bps) + ' <span class="se">' + pmSe(b.implementable_se_bps) + "</span>",
          days(b.n_days_implementable) + " · about " + pctYear(b.implementable_bps) + " a year");
    } else {
      fig("ret-backtest", "—", muted("no tested series for this model"));
    }

    const since = document.getElementById("ret-since");
    if (s && s.n_days_with_return) {
      since.innerHTML = "Every day since 1 July: <strong class=\"mono\">" + bps(s.mean_bps) + "</strong> a day " +
        pmSe(s.se_bps) + " over " + days(s.n_days_with_return) + ". " +
        s.n_scored_after_the_fact + " of the " + s.n_days + " days since then were scored after the fact, " +
        "so only the committed figure is evidence.";
    } else {
      since.textContent = "No day since 1 July carries a realized return yet.";
    }

    const cost = document.getElementById("ret-cost");
    const t = r.turnover.replaced;
    cost.textContent = t == null
      ? "No night-to-night turnover is recorded yet, so no breakeven cost can be stated."
      : r.breakeven_bps == null
        ? "The book has not replaced a name between scored nights, so trading costs take nothing yet."
        : "Breakeven: at about " + r.breakeven_bps.toFixed(0) + " bps a round trip the decade's return is gone, " +
          "at the " + qe.fmtPct(t).replace("+", "") + " of the picks replaced each night.";

    drawReturn(s, c);
  }

  /* every day since 1 July, and the committed days alone, summed on one axis */
  function drawReturn(s, c) {
    const el = document.getElementById("chart-dash-return");
    if (!s || !s.dates || !s.dates.length) {
      el.innerHTML = muted("nothing to draw yet");
      el.classList.add("is-empty");
      return;
    }
    const committedAt = {};
    if (c && c.dates) {
      c.dates.forEach((d, i) => {
        if (d >= s.start && c.cum_bps[i] != null) committedAt[d] = c.cum_bps[i];
      });
    }
    // the committed sum restarts at zero on 1 July, like the other line
    const before = c && c.dates ? c.dates.reduce((acc, d, i) =>
      (d < s.start && c.cum_bps[i] != null ? c.cum_bps[i] : acc), 0) : 0;
    const committed = s.dates.map((d) => (d in committedAt ? (committedAt[d] - before) / 100 : null));
    qe.chart("chart-dash-return").setOption({
      animation: false,
      tooltip: { trigger: "axis", valueFormatter: (x) => (x == null ? "—" : (x >= 0 ? "+" : "") + x.toFixed(2) + "%") },
      legend: { data: ["every day since 1 July", "committed in advance"], top: 0 },
      grid: { left: 46, right: 12, top: 30, bottom: 24 },
      xAxis: { type: "category", data: s.dates, boundaryGap: false, axisLabel: { hideOverlap: true } },
      yAxis: { type: "value", axisLabel: { formatter: (v) => v + "%" } },
      dataZoom: [{ type: "inside" }],
      series: [
        { name: "every day since 1 July", type: "line", data: s.cum_pct, showSymbol: false,
          itemStyle: { color: C.accent }, lineStyle: { width: 1.6, color: C.accent },
          markLine: { silent: true, symbol: "none", label: { show: false },
                      lineStyle: { color: C.muted, width: 1, type: "solid" }, data: [{ yAxis: 0 }] } },
        { name: "committed in advance", type: "line", data: committed, showSymbol: true, symbolSize: 3,
          connectNulls: true, itemStyle: { color: C.live }, lineStyle: { width: 1.6, color: C.live } },
      ],
    });
  }

  function riskCard(p) {
    const r = p.risk;
    const cell = (k, col, html) => {
      const td = document.querySelector('#risk-mini td[data-k="' + k + '"][data-col="' + col + '"]');
      if (td) td.innerHTML = html;
    };
    for (const col of ["live_committed", "backtest"]) {
      const s = r[col], g = s && s.n_days ? s.by_cost[0] : null;
      if (!g) {
        const why = col === "backtest" ? "no tested series" : "no committed day yet";
        ["sharpe", "vol", "dd"].forEach((k) => cell(k, col, muted(k === "sharpe" ? why : "—")));
        continue;
      }
      cell("sharpe", col, g.sharpe == null ? muted("needs 2 days")
        : '<span class="v">' + ratio(g.sharpe) + '</span> <span class="se">' + pmSe(g.sharpe_se) + "</span>" +
          '<span class="n">' + days(s.n_days) + "</span>");
      cell("vol", col, g.ann_vol_bps == null ? muted("needs 2 days")
        : '<span class="v">' + (g.ann_vol_bps / 100).toFixed(1) + "%</span>");
      cell("dd", col, g.max_drawdown_bps == null ? "—"
        : '<span class="v">' + qe.fmtNum(g.max_drawdown_bps, 0) + " bps</span>" +
          // one date a line: inline, a narrow column broke them mid-date
          (g.dd_trough_date ? '<span class="n"><span class="dd-date">' +
            qe.esc(g.dd_peak_date || "from the first day") + ' →</span><br><span class="dd-date">' +
            qe.esc(g.dd_trough_date) + "</span></span>" : ""));
    }

    // the paper account's own charge, 3 bps a round trip, is the second level
    const b = r.backtest, at3 = r.cost_levels_bps.indexOf(3);
    const cost = document.getElementById("risk-cost");
    if (b && b.n_days && at3 > 0 && b.by_cost[at3].sharpe != null) {
      cost.textContent = "After 3 bps a round trip on the picks replaced each night, the decade's Sharpe ratio is " +
        ratio(b.by_cost[at3].sharpe) + ". No cash rate is subtracted: the return is already a spread over sector peers.";
    } else {
      cost.textContent = "No cost level can be charged yet: the book has no measured turnover. " +
        "No cash rate is subtracted: the return is already a spread over sector peers.";
    }
    const power = document.getElementById("risk-power");
    const g = b && b.n_days ? b.by_cost[0] : null;
    const have = r.live_committed ? r.live_committed.n_days : 0;
    if (g && g.sharpe != null && b.days_to_t2 && b.days_to_t2.days != null) {
      power.textContent = "If the true Sharpe ratio is the decade's " + ratio(g.sharpe) +
        ", the live record needs about " + qe.fmtNum(b.days_to_t2.days, 0) + " committed days (" +
        b.days_to_t2.years.toFixed(1) + " years) before its own could be told from zero. It has " + have + ".";
    }
  }

  function fail(err) {
    console.error(err);
    const msg = '<span class="load-failed">The return figures did not load (' +
      qe.esc(err && err.message ? err.message : "request failed") + ").</span>";
    ["ret-committed", "ret-backtest"].forEach((id) => fig(id, "—", msg));
    document.querySelectorAll("#risk-mini td .loading").forEach((el) => { el.outerHTML = "—"; });
  }

  qe.fetch("/api/dashboard").then((p) => {
    if (!p.available) {
      fail(new Error(p.reason || "no active model"));
      return;
    }
    returnCard(p);
    riskCard(p);
  }).catch(fail);
})();
