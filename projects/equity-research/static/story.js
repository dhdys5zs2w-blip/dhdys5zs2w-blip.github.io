/* The story page: the model told to someone who was never part of building
 * it, one chapter per idea. This script draws what the server could not —
 * the charts, the universe as dots, today's picks, the countdown — from three
 * requests made once each: /api/story, /api/market_map and the model's
 * schedule. Nothing is polled; the countdown is a client clock, read in the
 * platform's own time zone (US Eastern).
 *
 * What it keeps:
 *  - Every figure comes from those payloads or from the page's own server
 *    text, and every average travels with its give-or-take (the block
 *    bootstrap SE the payload carries). Percentages are basis points / 100.
 *  - The evidence hues are the series they name: C.backtest draws only the
 *    tested decade, C.live only the live days since July 1. Picks and
 *    progress are the accent; signed daily moves are pos/neg.
 *  - Motion is for arrival and navigation: charts draw as their chapter is
 *    reached, nothing animates a result's size, and under reduced motion
 *    every chart is drawn still and at once.
 *  - Stock links go through qe.symbolHref, stored strings through qe.esc. */
"use strict";

(function () {
  const story = document.getElementById("story");
  if (!story) return;
  const reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const canWatch = "IntersectionObserver" in window;
  const touch = window.matchMedia && window.matchMedia("(hover: none)").matches;
  const MODEL = story.dataset.modelId || "";
  const $ = (id) => document.getElementById(id);

  /* ---- arrival: primed first, so a later failure never leaves it hidden ---- */
  story.classList.add("js");
  if (!reduced && canWatch) story.classList.add("primed");
  initReveal();

  function initReveal() {
    const els = Array.from(story.querySelectorAll("[data-reveal]"));
    if (!story.classList.contains("primed")) { els.forEach((el) => el.classList.add("in")); return; }
    const h = window.innerHeight || 800;
    const io = new IntersectionObserver((entries) => entries.forEach((e) => {
      if (!e.isIntersecting) return;
      e.target.classList.add("in");
      io.unobserve(e.target);
    }), { rootMargin: "0px 0px -8% 0px", threshold: 0.06 });
    els.forEach((el) => { if (el.getBoundingClientRect().top < h * 0.92) el.classList.add("in"); else io.observe(el); });
  }

  // Run `fn` once `el` is about to be seen; at once when motion is off.
  function whenNear(el, fn) {
    if (!el) return;
    const run = () => { try { fn(); } catch (err) { console.error(err); showFail(el.id, "This chart"); } };
    if (reduced || !canWatch) { run(); return; }
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      run();
    }, { rootMargin: "0px 0px -12% 0px", threshold: 0.01 });
    io.observe(el);
  }

  /* ---- formatting -------------------------------------------------------------- */
  const MINUS = "−";
  const signed = (v, d) => (v < 0 ? MINUS : "+") + Math.abs(v).toFixed(d);
  // basis points (hundredths of a percent) as a signed percentage, and as a size
  const pct = (bps, d) => (bps == null ? "—" : signed(bps / 100, d) + "%");
  const size = (bps, d) => (bps == null ? "—" : Math.abs(bps / 100).toFixed(d) + "%");
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August",
                  "September", "October", "November", "December"];
  const day = (iso, long) => {
    if (!iso) return "—";
    const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number);
    const mon = MONTHS[m - 1] || "";
    return (long ? mon : mon.slice(0, 3)) + " " + d + ", " + y;
  };
  const listing = (xs) => (xs.length < 2 ? xs.join("") : xs.slice(0, -1).join(", ") + " and " + xs[xs.length - 1]);
  const sectorName = (s) => (!s || s === "UNKNOWN" ? "No sector label"
    : String(s).toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()));
  const median = (xs) => {
    const v = xs.filter((x) => x != null && isFinite(x)).sort((a, b) => a - b);
    if (!v.length) return null;
    const k = (v.length - 1) / 2;
    return (v[Math.floor(k)] + v[Math.ceil(k)]) / 2;
  };
  const quantile = (sorted, q) => sorted[Math.max(0, Math.min(sorted.length - 1, Math.round(q * (sorted.length - 1))))];
  const lastValue = (xs) => { for (let i = xs.length - 1; i >= 0; i--) if (xs[i] != null) return xs[i]; return null; };
  // the date of the last point that has a value: the decade's final dates carry
  // no result yet, and its range should end where its results do
  const lastDated = (dates, xs) => { for (let i = xs.length - 1; i >= 0; i--) if (xs[i] != null) return dates[i]; return null; };
  const short = (iso) => day(iso).replace(/, \d{4}$/, "");
  const put = (id, text) => { const el = $(id); if (el) el.textContent = text; return el; };
  function showFail(id, what) {
    const el = $(id);
    if (el) el.innerHTML = '<p class="st-fail">' + qe.esc(what) + " did not load. The rest of the page is unaffected.</p>";
  }
  // A tick step of 1, 2 or 5 × 10^k giving about `n` ticks over [lo, hi].
  function niceStep(lo, hi, n) {
    const raw = Math.max(1e-9, (hi - lo) / n);
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
  }

  /* ---- chapter rail --------------------------------------------------------------- */
  function initRail() {
    const nav = $("story-nav");
    if (!nav) return;
    const list = nav.querySelector(".sn-list");
    const links = Array.from(nav.querySelectorAll("a[href^='#']"));
    const chapters = links.map((a) => $(a.getAttribute("href").slice(1))).filter(Boolean);
    const topnav = document.querySelector(".topnav");
    const setTop = () => story.style.setProperty("--st-top", (topnav ? topnav.getBoundingClientRect().height : 50) + "px");
    let active = null, queued = false;
    const mark = (id) => {
      let before = true;
      links.forEach((a) => {
        const on = a.getAttribute("href") === "#" + id;
        if (on) before = false;
        a.classList.toggle("on", on);
        a.classList.toggle("done", before && !on);
        if (on) a.setAttribute("aria-current", "step"); else a.removeAttribute("aria-current");
        // on the phone strip, keep the current chapter in view without moving the page
        if (on && list && list.scrollWidth > list.clientWidth) {
          list.scrollTo({ left: a.offsetLeft - (list.clientWidth - a.offsetWidth) / 2, behavior: reduced ? "auto" : "smooth" });
        }
      });
    };
    // The current chapter is the last one whose top has passed a reading line
    // 38% down the screen. The rail's fill runs dot to dot: it reaches a
    // chapter's dot as the chapter arrives and creeps toward the next one as
    // it is read, so the line and the highlighted dot always agree.
    const measure = () => {
      queued = false;
      if (!chapters.length) return;
      const line = window.innerHeight * 0.38;
      const tops = chapters.map((c) => c.getBoundingClientRect().top);
      let i = 0;
      tops.forEach((t, k) => { if (t <= line) i = k; });
      // the last chapter is short: at the very bottom of the page it is the one being read
      const atEnd = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
      if (atEnd) i = chapters.length - 1;
      const next = tops[i + 1];
      const frac = atEnd || next == null ? 0 : Math.min(1, Math.max(0, (line - tops[i]) / Math.max(1, next - tops[i])));
      nav.style.setProperty("--progress", (chapters.length > 1 ? Math.min(1, (i + frac) / (chapters.length - 1)) : 1).toFixed(4));
      if (chapters[i].id !== active) { active = chapters[i].id; mark(active); }
    };
    const soon = () => { if (!queued) { queued = true; requestAnimationFrame(measure); } };
    window.addEventListener("scroll", soon, { passive: true });
    window.addEventListener("resize", () => { setTop(); soon(); });
    setTop();
    measure();

    // j / k step through the chapters, as the screener's keys step through rows
    document.addEventListener("keydown", (ev) => {
      if (ev.key !== "j" && ev.key !== "k") return;
      const tag = document.activeElement && document.activeElement.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || ev.metaKey || ev.ctrlKey || ev.altKey) return;
      // the command palette and the shortcuts sheet (fx.js) sit over the page:
      // while either is open the page behind it stays put
      if (document.querySelector(".palette:not([hidden])")) return;
      const i = Math.max(0, chapters.findIndex((c) => c.id === active));
      const next = chapters[Math.max(0, Math.min(chapters.length - 1, i + (ev.key === "j" ? 1 : -1)))];
      if (next) next.scrollIntoView({ behavior: reduced ? "auto" : "smooth" });
    });
  }
  initRail();

  /* ---- sparklines -------------------------------------------------------------------- */
  // A small line over the running total, drawn in the hue of the series it is.
  function spark(svg, values, cls) {
    if (!svg) return;
    const pts = [];
    values.forEach((v, i) => { if (v != null) pts.push([i, v]); });
    if (pts.length < 2) return;
    const step = Math.max(1, Math.ceil(pts.length / 160));
    const s = pts.filter((p, i) => i % step === 0 || i === pts.length - 1);
    const W = 160, H = 30, pad = 2;
    const x0 = s[0][0], x1 = s[s.length - 1][0];
    let lo = 0, hi = 0;
    s.forEach((p) => { lo = Math.min(lo, p[1]); hi = Math.max(hi, p[1]); });
    const X = (x) => (pad + (x - x0) / Math.max(1, x1 - x0) * (W - 2 * pad)).toFixed(1);
    const Y = (y) => (H - pad - (y - lo) / Math.max(1e-9, hi - lo) * (H - 2 * pad)).toFixed(1);
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.innerHTML = '<line class="spark-zero" x1="0" x2="' + W + '" y1="' + Y(0) + '" y2="' + Y(0) + '"/>' +
      '<path class="spark-line ' + cls + '" pathLength="1" vector-effect="non-scaling-stroke" d="' +
      s.map((p, i) => (i ? "L" : "M") + X(p[0]) + " " + Y(p[1])).join(" ") + '"/>';
    requestAnimationFrame(() => requestAnimationFrame(() => svg.classList.add("in")));
  }

  /* ---- give-or-take plots ------------------------------------------------------------ */
  // One row per average: a dot at the mean, a thick bar ±1 give-or-take, a thin
  // bar ±2, zero dashed. Positions are percentages of one shared axis.
  function rangePlot(el, rows) {
    if (!el) return;
    rows = rows.filter((r) => r.mean != null && r.se != null);
    if (!rows.length) return;
    let lo = 0, hi = 0;
    rows.forEach((r) => { lo = Math.min(lo, r.mean - 2.3 * r.se); hi = Math.max(hi, r.mean + 2.3 * r.se); });
    const step = niceStep(lo, hi, 5);
    lo = Math.floor(lo / step) * step;
    hi = Math.ceil(hi / step) * step;
    const X = (v) => (100 * (v - lo) / (hi - lo));
    const at = (v) => X(v).toFixed(2) + "%";
    const bar = (cls, a, b) => '<span class="' + cls + '" style="left:' + at(a) + ";width:" +
      (X(b) - X(a)).toFixed(2) + '%"></span>';
    const zero = '<span class="rg-zero" style="left:' + at(0) + '"></span>';
    const body = rows.map((r) => {
      return '<div class="rg-row"><div class="rg-label"><b>' + qe.esc(r.label) + "</b>" + qe.esc(r.sub) + "</div>" +
        '<div class="rg-plot">' + zero + bar("rg-two", r.mean - 2 * r.se, r.mean + 2 * r.se) +
        bar("rg-one", r.mean - r.se, r.mean + r.se) +
        '<span class="rg-dot ' + r.cls + '" style="left:' + at(r.mean) + '" title="' +
        qe.esc(pct(r.mean, 2) + " a day, give or take " + size(r.se, 2)) + '"></span></div></div>';
    }).join("");
    let ticks = "";
    for (let v = lo; v <= hi + step / 2; v += step) {
      const t = Math.abs(v) < step / 2 ? 0 : v;
      ticks += '<span class="' + (t === 0 ? "zero" : "") + '" style="left:' + at(t) + '">' +
        (t === 0 ? "0" : pct(t, step < 1 ? 3 : 2)) + "</span>";
    }
    el.innerHTML = body + '<div class="rg-axis" aria-hidden="true">' + ticks + "</div>";
    el.setAttribute("role", "img");
    if (story.classList.contains("primed")) whenNear(el, () => el.classList.add("in"));
    else el.classList.add("in");
  }

  /* ---- the story payload: hero, tested decade, live days ------------------------------ */
  function drawStory(s) {
    if (!s || !s.available) { storyMissing(); return; }
    const bt = s.backtest || {}, lv = s.live || {};
    heroLive(lv);
    if (bt.implementable_cum_bps) spark($("spark-decade"), bt.implementable_cum_bps, "spark-bt");

    const decadeRow = {
      label: "The tested decade", sub: (bt.n_days_implementable || 0).toLocaleString("en-US") + " trading days",
      mean: bt.implementable_bps, se: bt.implementable_se_bps, cls: "bt",
    };
    rangePlot($("range-decade"), [decadeRow]);
    const end = lastDated(bt.dates || [], bt.implementable_cum_bps || []) || bt.last_date;
    if (bt.first_date && end) put("decade-meta", day(bt.first_date) + " – " + day(end));
    whenNear($("chart-decade"), () => drawDecade(bt));
    whenNear($("chart-years"), () => drawYears(bt, end));
    readYears(bt, end);
    readDecade(bt);

    liveNumbers(lv, bt);
    const ld = lv.dates || [];
    if (ld.length) put("live-meta", day(ld[0]) + " – " + day(ld[ld.length - 1]) + ", the days with a result so far");
    whenNear($("chart-live"), () => drawLive(lv, bt));
    readLumps(lv);
    rangePlot($("range-live"), [decadeRow, {
      label: "Live since July 1", sub: (lv.n_days_with_return || 0) + " days with a result",
      mean: lv.mean_bps, se: lv.se_bps, cls: "live",
    }]);
    readLive(lv, bt);
    readOverlap(lv, bt, end);
  }

  function storyMissing() {
    put("hero-live-cum", "—");
    ["chart-decade", "chart-years", "chart-live"].forEach((id) => showFail(id, "This chart"));
  }

  function heroLive(lv) {
    const n = lv.n_days_with_return || 0;
    if (!n) {
      put("hero-live-cum", "—");
      put("hero-live-sub", "no live day has a result yet");
      return;
    }
    const cum = lastValue(lv.cum_pct || []);
    // the give-or-take of a sum of n days is n times that of their average
    const gt = lv.se_bps == null ? null : lv.se_bps * n / 100;
    // a count may count up as it arrives; a return is simply shown
    put("hero-live-cum", cum == null ? "—" : signed(cum, 1) + "%");
    put("hero-live-gt", gt == null ? "" : "give or take " + gt.toFixed(1) + "%");
    put("hero-live-sub", "each day's edge added up over the " + n + " days with a result so far, on paper and " +
      "before trading costs. " + liveVerdict(lv));
    spark($("spark-live"), lv.cum_pct || [], "spark-live");
  }

  // Where the live average stands against zero, by the rule the page states
  // under "Is it the same edge?": twice the give-or-take either side. The hero
  // shows a sum, and a sum's range and its average's range agree on this.
  function liveVerdict(lv) {
    const m = lv.mean_bps, se = lv.se_bps, n = lv.n_days_with_return || 0;
    if (m == null || se == null || !n) return "";
    const few = n < 250 ? ", on few days so far" : "";
    if (m - 2 * se > 0) return "Clear of zero by twice its give-or-take" + few + ".";
    if (m + 2 * se < 0) return "Below zero by more than twice its give-or-take" + few + ".";
    return "Too few days yet to tell it apart from zero.";
  }

  function drawDecade(bt) {
    const C = qe.colors();
    const BT = C.backtest;   // the tested decade's own series
    const cum = bt.implementable_cum_bps || [];
    const data = (bt.dates || []).map((d, i) => [d, cum[i] == null ? null : cum[i] / 100]);
    const chart = qe.chart("chart-decade");
    chart.setOption({
      animation: !reduced, animationDuration: 2400, animationEasing: "cubicOut",
      grid: { left: 54, right: 18, top: 24, bottom: 30 },
      tooltip: {
        trigger: "axis",
        formatter: (ps) => {
          const p = ps[0];
          return day(p.value[0], true) + "<br>added up so far: <b>" +
            (p.value[1] == null ? "—" : signed(p.value[1], 1) + "%") + "</b>";
        },
      },
      xAxis: { type: "time", splitLine: { show: false }, axisLabel: { hideOverlap: true } },
      yAxis: { type: "value", min: (v) => Math.min(0, Math.floor(v.min / 10) * 10), axisLabel: { formatter: (v) => v + "%" } },
      series: [{
        name: "The tested decade", type: "line", data, showSymbol: false, connectNulls: false,
        color: BT, lineStyle: { width: 2 }, areaStyle: { opacity: 0.1 },
        markLine: { silent: true, symbol: "none", label: { show: false }, data: [{ yAxis: 0 }],
                    lineStyle: { color: C.muted, type: "dashed", width: 1 } },
      }],
    });
  }

  // The year still in progress, if the record ends before 31 December.
  const partialYear = (end) => (end && !String(end).endsWith("-12-31") ? Number(String(end).slice(0, 4)) : null);

  function drawYears(bt, end) {
    const rows = bt.by_year || [];
    if (!rows.length) { showFail("chart-years", "This chart"); return; }
    const C = qe.colors();
    const partial = partialYear(end);
    const cats = rows.map((r) => String(r.year) + (r.year === partial ? "*" : ""));
    const vals = rows.map((r) => (r.mean_bps == null ? null : r.mean_bps / 100));
    const whisk = rows.map((r, i) => (r.se_bps == null || r.mean_bps == null ? null
      : [i, (r.mean_bps - r.se_bps) / 100, (r.mean_bps + r.se_bps) / 100])).filter((x) => x);
    const chart = qe.chart("chart-years");
    chart.setOption({
      animation: !reduced, animationDuration: 900, animationDelay: (i) => i * 70,
      grid: { left: 58, right: 12, top: 18, bottom: 30 },
      tooltip: {
        trigger: "item",
        formatter: (o) => {
          const r = rows[o.dataIndex];
          if (!r) return "";
          return "<b>" + r.year + "</b>" + (r.year === partial ? " (through " + day(end) + ")" : "") +
            "<br>average day " + pct(r.mean_bps, 3) + ", give or take " + size(r.se_bps, 3) +
            "<br>" + r.n_days + " trading days · ahead on " + Math.round(100 * (r.share_positive || 0)) + "% of them";
        },
      },
      xAxis: { type: "category", data: cats },
      yAxis: { type: "value", axisLabel: { formatter: (v) => (v === 0 ? "0" : signed(v, 2) + "%") } },
      series: [
        { name: "The tested decade, by year", type: "bar", barMaxWidth: 34,
          data: qe.bars(vals, () => C.backtest) },   // the tested decade's own series
        qe.whiskerSeries(whisk, C.ink2),
      ],
    });
  }

  // The chart's words and its table. Both are filled at load, not when the
  // chart is reached: the table is the chart's text alternative, so it must be
  // there even if the chart never draws.
  function readYears(bt, end) {
    const all = bt.by_year || [];
    const partial = partialYear(end);
    const body = $("years-table");
    if (body) {
      body.innerHTML = all.map((r) => "<tr><td>" + qe.esc(String(r.year)) + (r.year === partial ? "*" : "") + "</td>" +
        '<td class="num">' + pct(r.mean_bps, 3) + '</td><td class="num">' + size(r.se_bps, 3) + "</td>" +
        '<td class="num">' + qe.esc(String(r.n_days)) + '</td><td class="num">' + Math.round(100 * (r.share_positive || 0)) + "%</td></tr>").join("");
    }
    const rows = all.filter((r) => r.mean_bps != null);
    if (!rows.length) return;
    const below = rows.filter((r) => r.mean_bps < 0).map((r) => String(r.year));
    const top = rows.slice().sort((a, b) => b.mean_bps - a.mean_bps).slice(0, 2).map((r) => r.year).sort().map(String);
    put("years-read", (below.length ? "Below zero in " + listing(below) + "; " : "Above zero every year; ") +
      "strongest in " + listing(top) + ". An edge that is there in total is not the same as an edge that is " +
      "there every year." + (partial ? " *" + partial + " runs through " + day(end) + "." : ""));
  }

  // How lumpy the decade's total is: the share of it that the two biggest
  // years supplied. A year's part of the sum is its average day times its days.
  function readDecade(bt) {
    const rows = (bt.by_year || []).filter((r) => r.mean_bps != null && r.n_days);
    if (rows.length < 4) return;
    const part = (r) => r.mean_bps * r.n_days;
    const total = rows.reduce((a, r) => a + part(r), 0);
    if (!(total > 0)) return;
    const top = rows.slice().sort((a, b) => part(b) - part(a)).slice(0, 2);
    const share = top.reduce((a, r) => a + part(r), 0) / total;
    const years = listing(top.map((r) => String(r.year)).sort());
    put("decade-read", share > 0.5
      ? " More than half of the added-up total — about " + Math.round(100 * share) + "% of it — came from just two years, " +
        years + "; the other " + (rows.length - 2) + " years together make up the rest."
      : " The two biggest years, " + years + ", supplied about " + Math.round(100 * share) + "% of the added-up total.");
  }

  function liveNumbers(lv, bt) {
    const n = lv.n_days_with_return || 0;
    if (!n) {
      ["live-cum", "live-avg", "live-pos"].forEach((id) => put(id, "—"));
      put("live-cum-sub", "no live day has a result yet");
      return;
    }
    const cum = lastValue(lv.cum_pct || []);
    put("live-cum", cum == null ? "—" : signed(cum, 1) + "%");
    put("live-cum-sub", lv.se_bps == null ? "over " + n + " days" :
      "give or take " + (lv.se_bps * n / 100).toFixed(1) + "%, over " + n + " days, before trading costs");
    put("live-avg", pct(lv.mean_bps, 2));
    put("live-avg-sub", "give or take " + size(lv.se_bps, 2) + " · the tested decade's was " + pct(bt.implementable_bps, 2));
    const ahead = Math.round((lv.share_positive || 0) * n);
    put("live-pos", ahead + " of " + n);
    put("live-pos-sub", Math.round(100 * (lv.share_positive || 0)) + "% of the days with a result");
  }

  function readLive(lv, bt) {
    const m = lv.mean_bps, se = lv.se_bps, b = bt.implementable_bps;
    const n = lv.n_days_with_return || 0;
    if (m == null || se == null || !n) { put("live-read", "The live days have no results yet."); return; }
    const lo = m - 2 * se, hi = m + 2 * se;
    const hasZero = lo <= 0 && hi >= 0;
    const hasDecade = b != null && lo <= b && hi >= b;
    let text = "With " + n + " days the live range runs from " + pct(lo, 2) + " to " + pct(hi, 2) + " a day. ";
    if (hasZero && hasDecade) {
      text += "That still includes zero, and it includes the tested decade's " + pct(b, 2) +
        ": the live days so far are consistent with the test, and far too few to say whether live is better, worse or the same.";
    } else if (hasDecade) {
      text += "That is clear of zero and includes the tested decade's " + pct(b, 2) +
        ": consistent with the test so far, though still too few days to say it matches it.";
    } else if (hasZero) {
      text += "That includes zero but not the tested decade's " + pct(b, 2) + ": so far the live days sit apart from the test.";
    } else {
      text += "That is clear of zero and does not include the tested decade's " + pct(b, 2) +
        ": so far the live days sit apart from the test, in the direction shown.";
    }
    put("live-read", text);
  }

  // How much of the live total rests on its two largest days, in the
  // direction of the total. A short record is lumpy, and a newcomer judging
  // the sum should see how few days carry it.
  function readLumps(lv) {
    const d = lv.daily_bps || [], dates = lv.dates || [];
    const cum = lastValue(lv.cum_pct || []);
    if ((lv.n_days_with_return || 0) < 5 || cum == null || cum === 0) return;
    const up = cum > 0;
    const two = d.map((v, i) => [v, i]).filter((x) => x[0] != null)
      .sort((a, b) => (up ? b[0] - a[0] : a[0] - b[0])).slice(0, 2);
    const sum = two.reduce((a, x) => a + x[0], 0) / 100;
    const days = listing(two.map((x) => short(dates[x[1]]) + " (" + signed(x[0] / 100, 1) + "%)"));
    put("live-lumps", " The " + (up ? "best" : "worst") + " two days, " + days + ", add up to " + signed(sum, 1) +
      "% of the " + signed(cum, 1) + "% total" + (Math.abs(sum) > Math.abs(cum) / 2 ? " — more than half of it." : "."));
  }

  // The tested decade runs into the summer the live record starts in, so the
  // two rows of the comparison share some days. Say how many.
  function readOverlap(lv, bt, end) {
    const d = lv.daily_bps || [];
    const liveDays = new Set((lv.dates || []).filter((x, i) => d[i] != null));
    const cum = bt.implementable_cum_bps || [];
    const shared = (bt.dates || []).filter((x, i) => cum[i] != null && liveDays.has(x)).length;
    if (!shared) return;
    put("live-overlap", "The two rows are not fully separate: the tested decade runs to " + day(end) + ", so " +
      shared + " of its " + (bt.n_days_implementable || 0).toLocaleString("en-US") +
      " days are also live days here — a small share of it.");
  }

  function drawLive(lv, bt) {
    const dates = lv.dates || [];
    if (!dates.length) { showFail("chart-live", "The live chart"); return; }
    const C = qe.colors();
    const LIVE = C.live;   // the live days' own series
    const b = bt.implementable_bps;
    const pace = dates.map((d, i) => (b == null ? null : b * (i + 1) / 100));
    const daily = (lv.daily_bps || []).map((v) => (v == null ? null : v / 100));
    const names = ["The live days, added up", "At the tested decade's average pace", "Each day"];
    // on a phone the legend wraps to two lines; the plot starts below it
    const top = ($("chart-live").clientWidth || 800) < 560 ? 64 : 40;
    const chart = qe.chart("chart-live");
    chart.setOption({
      animation: !reduced, animationDuration: 1800, animationEasing: "cubicOut",
      legend: { top: 0, left: 0, data: names.slice(0, 2) },
      axisPointer: { link: [{ xAxisIndex: "all" }] },
      tooltip: {
        trigger: "axis",
        formatter: (ps) => {
          const i = ps[0].dataIndex;
          return day(dates[i], true) +
            "<br>added up: <b>" + (lv.cum_pct[i] == null ? "—" : signed(lv.cum_pct[i], 2) + "%") + "</b>" +
            (pace[i] == null ? "" : "<br>at the decade's pace: " + signed(pace[i], 2) + "%") +
            "<br>that day: " + (daily[i] == null ? "—" : signed(daily[i], 2) + "%");
        },
      },
      grid: [{ left: 54, right: 58, top, height: "52%" }, { left: 54, right: 58, top: "75%", bottom: 28 }],
      xAxis: [
        { type: "category", data: dates, gridIndex: 0, axisLabel: { show: false }, axisTick: { show: false } },
        { type: "category", data: dates, gridIndex: 1, axisLabel: { formatter: (v) => day(v).replace(/, \d{4}$/, ""), hideOverlap: true } },
      ],
      yAxis: [
        { type: "value", gridIndex: 0, axisLabel: { formatter: (v) => v + "%" } },
        { type: "value", gridIndex: 1, splitNumber: 2, axisLabel: { formatter: (v) => (v === 0 ? "0" : signed(v, 1) + "%") } },
      ],
      series: [
        { name: names[0], type: "line", data: lv.cum_pct, xAxisIndex: 0, yAxisIndex: 0, showSymbol: false,
          color: LIVE, lineStyle: { width: 2.5 }, areaStyle: { opacity: 0.08 }, z: 3,
          endLabel: { show: true, color: C.ink, fontFamily: C.mono, fontSize: 11,
                      formatter: (o) => (o.value == null ? "" : signed(o.value, 1) + "%") } },
        { name: names[1], type: "line", data: pace, xAxisIndex: 0, yAxisIndex: 0, showSymbol: false,
          color: C.grey, lineStyle: { width: 1.5, type: "dashed" } },
        { name: names[2], type: "bar", data: qe.bars(daily, (v) => (v >= 0 ? C.pos : C.neg)),
          xAxisIndex: 1, yAxisIndex: 1, barMaxWidth: 7 },
      ],
    });
  }

  /* ---- the market map payload: the dot field, the example, the scatter, the picks ------ */
  function drawMarket(m) {
    const names = [];
    (m.sectors || []).forEach((s) => s.names.forEach((n) => names.push(Object.assign({ sector: s.sector }, n))));
    if (!names.length) { showFail("chart-universe", "The picture of today's stocks"); return; }
    field(m, names);
    example(m, names);
    whenNear($("chart-universe"), () => drawUniverse(names));
    readSees(names);
    drawPicks(m);
  }

  // The hero: every stock in today's list as one dot, in sector order (largest
  // sector first) with alternate sectors shaded so the groups show, its current
  // picks lit. A lit dot opens that stock.
  function field(m, names) {
    const svg = $("universe-field");
    if (!svg) return;
    // once the hero stacks (story.css, 860px) the field spans the column: a wide,
    // short strip there, rather than a square that fills a phone's screen
    const stacked = window.matchMedia && window.matchMedia("(max-width: 860px)").matches;
    const cols = stacked ? 40 : 25, cell = 16;
    const rows = Math.ceil(names.length / cols);
    let band = -1, prev = null;
    svg.setAttribute("viewBox", "0 0 " + cols * cell + " " + rows * cell);
    svg.innerHTML = names.map((n, i) => {
      if (n.sector !== prev) { band++; prev = n.sector; }
      const x = (i % cols) * cell + cell / 2, y = Math.floor(i / cols) * cell + cell / 2;
      const cls = [n.in_book ? "lit" : "", band % 2 ? "alt" : ""].filter(Boolean).join(" ");
      return '<circle cx="' + x + '" cy="' + y + '" r="' + (n.in_book ? 5.6 : 4.4) + '"' +
        (cls ? ' class="' + cls + '"' : "") + (n.in_book ? ' data-sym="' + qe.esc(n.symbol) + '"' : "") +
        ' style="--i:' + i + '">' + "<title>" + qe.esc(n.symbol) + (n.name ? " — " + qe.esc(n.name) : "") +
        " · " + qe.esc(sectorName(n.sector)) + (n.in_book ? " · one of the model's picks" : "") + "</title></circle>";
    }).join("");
    svg.addEventListener("click", (ev) => {
      const c = ev.target.closest && ev.target.closest("circle[data-sym]");
      if (c) location.href = qe.symbolHref(c.dataset.sym);
    });
    requestAnimationFrame(() => requestAnimationFrame(() => svg.classList.add("in")));
    put("field-caption", names.length + " stocks in today's list, one dot each, grouped by sector (alternate " +
      "sectors shaded). The " + (m.n_book || 0) + " the model holds now are lit.");
    put("step-universe", String(names.length));
  }

  function example(m, names) {
    const el = $("idea-example");
    if (!el) return;
    const ranked = names.filter((n) => n.rank != null).sort((a, b) => a.rank - b.rank);
    const top = ranked[0];
    if (!top) return;
    const unranked = names.length - ranked.length;
    const medAtr = median(names.map((n) => n.atr_pct));
    let html = "On " + qe.esc(day(m.signals_date || m.as_of, true)) + ", the model's favourite of the " +
      ranked.length + " stocks it ranked" + (unranked ? " (the other " + unranked + " in the list had no score that evening)" : "") +
      " was " + '<a class="sym" href="' + qe.symbolHref(top.symbol) + '">' +
      qe.esc(top.symbol) + "</a>" + (top.name ? " (" + qe.esc(top.name) + ")" : "") + ".";
    if (top.atr_pct != null && medAtr != null) {
      html += " It typically moves " + (top.atr_pct * 100).toFixed(1) + "% of its price in a day, where the median stock " +
        "in the list moves " + (medAtr * 100).toFixed(1) + "%";
      if (top.dist_sma200 != null) {
        html += ", and it trades " + Math.abs(top.dist_sma200 * 100).toFixed(0) + "% " +
          (top.dist_sma200 < 0 ? "below" : "above") + " its 200-day average";
      }
      html += ".";
    }
    html += ' <a href="#c-sees">See where it sits among the rest &mdash; it is labelled on the chart&nbsp;&darr;</a>';
    el.innerHTML = html;
  }

  function drawUniverse(names) {
    const pts = names.filter((n) => n.atr_pct != null && n.dist_sma200 != null);
    if (!pts.length) { showFail("chart-universe", "The picture of today's stocks"); return; }
    const C = qe.colors();
    // a handful of extreme names would squash everyone else into a corner, so
    // the axes stop just past the 0.5th/99.5th percentile and the few names
    // beyond are pinned to the edge, drawn as triangles and labelled so
    const xs = pts.map((n) => n.atr_pct * 100).sort((a, b) => a - b);
    const ys = pts.map((n) => n.dist_sma200 * 100).sort((a, b) => a - b);
    const xStep = niceStep(0, quantile(xs, 0.995), 6), yStep = niceStep(quantile(ys, 0.005), quantile(ys, 0.995), 6);
    const xHi = Math.ceil(quantile(xs, 0.995) / xStep) * xStep;
    const yLo = Math.floor(quantile(ys, 0.005) / yStep) * yStep, yHi = Math.ceil(quantile(ys, 0.995) / yStep) * yStep;
    const item = (n) => {
      const x = n.atr_pct * 100, y = n.dist_sma200 * 100;
      const pinned = x > xHi || y > yHi || y < yLo;
      return { value: [Math.min(x, xHi), Math.max(yLo, Math.min(y, yHi))], n, pinned,
               symbol: pinned ? "triangle" : "circle" };
    };
    const picks = pts.filter((n) => n.in_book).map(item);
    const rest = pts.filter((n) => !n.in_book).map(item);
    // the model's favourite carries its name on the chart: chapter 1's example
    // points here, and a reader should not have to hunt for it by hovering.
    // A canvas label is plain text, never markup.
    const fav = picks.filter((p) => p.n.rank != null).sort((a, b) => a.n.rank - b.n.rank)[0];
    if (fav) {
      const tag = [fav.n.symbol, "#" + fav.n.rank].join(" · ");
      fav.label = { show: true, position: fav.value[0] > xHi * 0.7 ? "left" : "right", distance: 7, color: C.ink,
                    fontFamily: C.mono, fontSize: 12, fontWeight: 600, formatter: () => tag };
    }
    const medX = median(xs);
    let armed = null;
    const chart = qe.chart("chart-universe");
    chart.setOption({
      animation: !reduced, animationDuration: 900, animationDelay: (i) => Math.min(900, i * 2),
      grid: { left: 58, right: 20, top: 40, bottom: 54 },
      tooltip: {
        trigger: "item", confine: true,
        formatter: (o) => {
          const d = o.data;
          if (!d || !d.n) return "";
          const n = d.n;
          return '<b class="mono">' + qe.esc(n.symbol) + "</b> " + qe.esc(n.name || "") +
            "<br>" + (n.in_book ? "<b>one of the model's picks</b> · " : "") +
            (n.rank != null ? "ranked #" + n.rank : "not ranked") +
            "<br>typical daily move: " + (n.atr_pct * 100).toFixed(1) + "% of its price" +
            "<br>" + Math.abs(n.dist_sma200 * 100).toFixed(0) + "% " + (n.dist_sma200 < 0 ? "below" : "above") +
            " its 200-day average" + (d.pinned ? "<br><i>beyond the chart's edge, pinned to it</i>" : "") +
            '<br><span style="color:' + C.muted + '">' + (touch ? "tap again to open" : "click to open") + "</span>";
        },
      },
      xAxis: { type: "value", min: 0, max: xHi, interval: xStep, name: "typical daily move, % of price  →", nameLocation: "middle",
               nameGap: 32, nameTextStyle: { align: "center" }, axisLabel: { formatter: (v) => v + "%" } },
      yAxis: { type: "value", min: yLo, max: yHi, interval: yStep, name: "↑ above its 200-day average",
               axisLabel: { formatter: (v) => (v > 0 ? "+" : v < 0 ? MINUS : "") + Math.abs(v) + "%" } },
      series: [
        { name: "every other stock", type: "scatter", data: rest, symbolSize: 7,
          itemStyle: { color: C.grey, opacity: 0.4 },
          emphasis: { scale: 1.8, itemStyle: { opacity: 1, borderColor: C.ink, borderWidth: 1 } },
          // the two reference lines are named in the key above the chart, so a
          // narrow chart has no labels to collide with its axis name
          markLine: { silent: true, symbol: "none", lineStyle: { color: C.muted, type: "dashed", width: 1 },
                      label: { show: false }, data: [{ yAxis: 0 }, { xAxis: medX }] } },
        { name: "the model's picks", type: "scatter", data: picks, symbolSize: 12, z: 5,
          itemStyle: { color: C.accent, borderColor: C.panel, borderWidth: 1.5 },
          emphasis: { scale: 1.5, itemStyle: { borderColor: C.ink } } },
      ],
    });
    chart.on("click", (o) => {
      const n = o.data && o.data.n;
      if (!n) return;
      // on a touch screen the first tap shows the stock, the second opens it
      if (touch && armed !== n.symbol) { armed = n.symbol; return; }
      location.href = qe.symbolHref(n.symbol);
    });
  }

  function readSees(names) {
    const held = names.filter((n) => n.in_book), rest = names.filter((n) => !n.in_book);
    const a = median(held.map((n) => n.atr_pct)), b = median(rest.map((n) => n.atr_pct));
    if (a == null || b == null) return;
    const below = held.filter((n) => n.dist_sma200 != null && n.dist_sma200 < 0).length;
    const known = held.filter((n) => n.dist_sma200 != null).length;
    put("sees-read", "Today the picks' median daily move is " + (a * 100).toFixed(1) + "% of price, against " +
      (b * 100).toFixed(1) + "% for the stocks it does not hold" + (b > 0 ? " — about " + (a / b).toFixed(1) + " times as much" : "") +
      ". " + below + " of the " + known + " picks sit below their 200-day average and " + (known - below) + " above it.");
  }

  // how many picks show before "show all": two full rows of the widest grid
  const PICKS_FIRST = 10;

  function drawPicks(m) {
    const box = $("picks-grid");
    if (!box) return;
    const groups = (m.sectors || []).map((s) => ({
      sector: s.sector, n: s.n,
      held: s.names.filter((n) => n.in_book).sort((a, b) => (a.rank == null) - (b.rank == null) || a.rank - b.rank ||
        a.symbol.localeCompare(b.symbol)),
    })).filter((g) => g.held.length);
    if (!groups.length) { box.innerHTML = '<p class="st-fail">The model holds no stocks yet.</p>'; return; }
    // First the few it likes best, in rank order; every pick, by sector, one
    // click away. A wall of all of them was the longest part of the page and
    // the least informative.
    const all = [];
    groups.forEach((g) => g.held.forEach((n) => all.push(n)));
    const lead = all.filter((n) => n.rank != null).sort((a, b) => a.rank - b.rank).slice(0, PICKS_FIRST);
    let k = 0;
    const bySector = groups.map((g) => '<section class="st-sector"><h3>' + qe.esc(sectorName(g.sector)) +
      "<span>" + g.held.length + (g.held.length === 1 ? " pick" : " picks") + " of " + g.n + "</span></h3>" +
      '<div class="st-pick-grid">' + g.held.map((n) => pickCard(n, k++)).join("") + "</div></section>").join("");
    if (lead.length >= all.length || !lead.length) {
      box.innerHTML = bySector;
    } else {
      const firstText = "The " + lead.length + " highest-ranked of the " + all.length + " picks";
      const allText = "All " + all.length + " picks, by sector";
      box.innerHTML = '<div class="st-picks-head"><p id="picks-showing">' + firstText + "</p>" +
        '<button type="button" class="st-more" id="picks-more" aria-expanded="false" aria-controls="picks-all">Show all ' +
        all.length + " picks, by sector</button></div>" +
        '<div class="st-pick-grid" id="picks-first">' + lead.map((n, i) => pickCard(n, i)).join("") + "</div>" +
        '<div id="picks-all" hidden>' + bySector + "</div>";
      const btn = $("picks-more"), first = $("picks-first"), rest = $("picks-all");
      btn.addEventListener("click", () => {
        const open = btn.getAttribute("aria-expanded") !== "true";
        btn.setAttribute("aria-expanded", String(open));
        rest.hidden = !open;
        first.hidden = open;
        btn.textContent = open ? "Show only the " + lead.length + " highest-ranked" : "Show all " + all.length + " picks, by sector";
        put("picks-showing", open ? allText : firstText);
      });
    }
    if (story.classList.contains("primed")) whenNear(box, () => box.classList.add("in"));
    drawMix(m, groups);
  }

  // A pick shows the two measurements chapter 2 plotted, not its last day's
  // move: one day of one stock says nothing about the model, and a page of
  // red and green squares reads as a verdict on it.
  function pickCard(n, i) {
    const sig = [];
    if (n.atr_pct != null) sig.push("moves " + (n.atr_pct * 100).toFixed(1) + "% a day");
    if (n.dist_sma200 != null) {
      sig.push(Math.abs(n.dist_sma200 * 100).toFixed(0) + "% " + (n.dist_sma200 < 0 ? "below" : "above") + " its 200\u2011day\u00a0avg.");
    }
    return '<a class="pick" style="--i:' + i + '" href="' + qe.symbolHref(n.symbol) + '" title="' +
      qe.esc(n.symbol) + (n.name ? " — " + qe.esc(n.name) : "") + ': open its page">' +
      '<span class="pick-sym">' + qe.esc(n.symbol) + "</span>" +
      '<span class="pick-rank">' + (n.rank != null ? "#" + qe.esc(String(n.rank)) : "") + "</span>" +
      '<span class="pick-name">' + qe.esc(n.name || "") + "</span>" +
      (sig.length ? sig.map((s) => '<span class="pick-sig">' + s + "</span>").join("") : '<span class="pick-sig">no signals recorded</span>') +
      "</a>";
  }

  function drawMix(m, groups) {
    const box = $("mix-rows");
    if (!box) return;
    const nBook = m.n_book || groups.reduce((a, g) => a + g.held.length, 0);
    const nAll = m.n_names || (m.sectors || []).reduce((a, s) => a + s.n, 0);
    if (!nBook || !nAll) return;
    const rows = (m.sectors || []).map((s) => ({ sector: s.sector, held: s.n_book || 0, share: (s.n_book || 0) / nBook, base: s.n / nAll }))
      .filter((r) => r.held || r.base >= 0.02).sort((a, b) => b.share - a.share || b.base - a.base);
    const top = Math.max(...rows.map((r) => Math.max(r.share, r.base)), 0.01);
    box.innerHTML = rows.map((r) => '<div class="mix-row"><span>' + qe.esc(sectorName(r.sector)) + "</span><b>" +
      r.held + "</b>" + '<span class="mix-bar" title="' + qe.esc(Math.round(100 * r.share) + "% of the picks · " +
      Math.round(100 * r.base) + "% of all the stocks") + '"><span style="--w:' + (100 * r.share / top).toFixed(1) +
      '%"></span><i style="--u:' + (100 * r.base / top).toFixed(1) + '%"></i></span></div>').join("");
  }

  /* ---- the schedule: a countdown in US Eastern time ---------------------------------- */
  // The runs fire on the platform's own clock, which keeps US Eastern time, so
  // the countdown reads "now" in that zone whatever the viewer's own is. A run
  // scores something only after a weekday session, so the next run is the next
  // weekday evening.
  const hm = (s) => { const [h, mm] = String(s).split(":").map(Number); return h * 60 + mm; };
  const pad = (n) => String(n).padStart(2, "0");
  const clock = (mins) => pad(Math.floor(mins / 60) % 24) + ":" + pad(mins % 60);
  const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  function easternNow() {
    try {
      const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "long",
        hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(new Date());
      const get = (t) => (parts.find((p) => p.type === t) || {}).value;
      const wd = WEEKDAYS.indexOf(get("weekday"));
      const mins = (Number(get("hour")) % 24) * 60 + Number(get("minute"));
      return wd < 0 || !isFinite(mins) ? null : { wd, mins };
    } catch (err) { return null; }
  }
  // Minutes from `now` to the next weekday run at `run`, and how to name that day.
  function nextRun(now, run) {
    for (let k = 0; k < 8; k++) {
      const wd = (now.wd + k) % 7;
      if (wd === 0 || wd === 6 || (k === 0 && now.mins >= run)) continue;
      const when = k === 0 ? (run >= 17 * 60 ? "tonight" : "today") : k === 1 ? "tomorrow" : "on " + WEEKDAYS[wd];
      return { left: k * 1440 + run - now.mins, when };
    }
    return null;
  }
  function startClock(schedule) {
    const fires = ((schedule && schedule.fire_times) || []).map(hm).filter((x) => isFinite(x)).sort((a, b) => a - b);
    if (!fires.length) return;
    const run = fires[0], retries = fires.slice(1);
    const retryText = retries.length ? ", with a retry at " + retries.map(clock).join(" and ") + " if needed" : "";
    put("clock-time", clock(run) + " ET");
    // a static snapshot states the schedule; a countdown would be counting to
    // an evening long past
    if (qe.snapshot) {
      put("clock-label", "Scoring runs");
      put("clock-sub", "every weekday evening, US Eastern time" + retryText + ". This page is a snapshot from " +
        String(qe.snapshot.exported_at).slice(0, 10) + ".");
      return;
    }
    const tick = () => {
      const now = easternNow();
      const next = now && nextRun(now, run);
      if (!next) { put("clock-sub", "every weekday evening, US Eastern time" + retryText); return; }
      const h = Math.floor(next.left / 60), mm = next.left % 60;
      const within = next.left < 1440 ? ", in " + (h ? h + " h " : "") + mm + " min" : "";
      put("clock-sub", next.when + within + ". It runs each weekday evening after the close, US Eastern time" + retryText + ".");
    };
    tick();
    setInterval(tick, 20000);
  }

  /* ---- load, once each ------------------------------------------------------------------- */
  qe.fetch("/api/story").then(drawStory).catch((err) => { console.error(err); storyMissing(); });
  qe.fetch("/api/market_map").then(drawMarket).catch((err) => {
    console.error(err);
    showFail("chart-universe", "The picture of today's stocks");
    showFail("picks-grid", "Today's picks");
  });
  if (MODEL) {
    qe.fetch("/api/model/" + encodeURIComponent(MODEL) + "/pulse")
      .then((p) => startClock(p.schedule)).catch((err) => console.error(err));
  }
})();
