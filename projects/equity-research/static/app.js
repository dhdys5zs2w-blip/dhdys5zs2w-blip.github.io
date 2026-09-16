/* Shared page plumbing: API fetch with busy handling, tabs (deep-linkable),
 * section navigation, table sort and filter, symbol search, and the small
 * formatting/tile helpers every page script builds its numbers with. No
 * frameworks; everything hangs off window.qe. */
"use strict";

(function () {
  const charts = [];

  async function qeFetch(url) {
    // portfolio demo: every /api/* call is resolved to a static file by demo-shim.js
    return window.QE_DEMO.fetch(url);
  }

  function showBusy(retrySeconds) {
    const el = document.getElementById("busy-banner");
    if (!el) return;
    el.hidden = false;
    let n = retrySeconds;
    const render = () => {
      el.textContent = "Database busy — a writer holds it (nightly run or a qe " +
        "write command). Retrying in " + n + "s…";
    };
    render();
    const t = setInterval(() => {
      n -= 1;
      if (n <= 0) { clearInterval(t); location.reload(); return; }
      render();
    }, 1000);
  }

  /* ---- design tokens → charts ----
   * Every chart colour is read from the stylesheet at load, so light and dark
   * themes render from one definition and a token change repaints the charts.
   * The evidence-state hues (live / backfill / backtest) are reserved: a series
   * wears one only when it *is* that state. */
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  function colors() {
    return {
      accent: cssVar("--accent"), series2: cssVar("--series2"), grey: cssVar("--neutral"),
      live: cssVar("--live"), backfill: cssVar("--backfill"), backtest: cssVar("--backtest"),
      pos: cssVar("--pos"), neg: cssVar("--neg"),
      ink: cssVar("--ink"), ink2: cssVar("--ink-2"), muted: cssVar("--muted"),
      line: cssVar("--line"), line2: cssVar("--line-2"), panel: cssVar("--panel"),
      soft: cssVar("--accent-soft"), zoom: cssVar("--zoom-fill"),
      mono: cssVar("--font-mono"), sans: cssVar("--font-sans"),
    };
  }
  function registerTheme() {
    const c = colors();
    const axisText = { color: c.muted, fontFamily: c.mono, fontSize: 10 };
    // axis names anchor at the axis end and extend rightwards into the plot's
    // top margin, so a long y-axis unit is never clipped at the grid's left
    const quietAxis = {
      axisLine: { show: false }, axisTick: { show: false }, axisLabel: axisText,
      splitLine: { show: true, lineStyle: { color: c.line2, width: 1 } },
      nameTextStyle: { color: c.muted, fontFamily: c.sans, fontSize: 10, align: "left" },
      nameGap: 14,
    };
    echarts.registerTheme("qe", {
      color: [c.accent, c.series2, c.live, c.backfill, c.backtest, c.neg],
      backgroundColor: "transparent",
      textStyle: { color: c.ink2, fontFamily: c.sans, fontSize: 11 },
      legend: { textStyle: { color: c.ink2, fontFamily: c.sans, fontSize: 11 }, itemWidth: 14, itemHeight: 8, icon: "roundRect", itemGap: 14 },
      tooltip: { backgroundColor: c.panel, borderColor: c.line, borderWidth: 1, padding: [8, 10],
                 textStyle: { color: c.ink, fontFamily: c.sans, fontSize: 12 },
                 extraCssText: "box-shadow: 0 8px 24px rgba(0,0,0,0.14); border-radius: 6px;" },
      categoryAxis: { axisLine: { lineStyle: { color: c.line } }, axisTick: { show: false }, axisLabel: axisText,
                      splitLine: { show: false }, nameTextStyle: { color: c.muted, fontFamily: c.sans, fontSize: 10 } },
      valueAxis: quietAxis, logAxis: quietAxis, timeAxis: quietAxis,
      line: { symbol: "none", lineStyle: { width: 2, cap: "round", join: "round" } },
      dataZoom: { textStyle: { color: c.muted, fontFamily: c.mono, fontSize: 10 }, borderColor: c.line, fillerColor: c.zoom,
                  handleStyle: { color: c.panel, borderColor: c.muted }, moveHandleStyle: { color: c.line },
                  dataBackground: { lineStyle: { color: c.line }, areaStyle: { color: c.line2 } },
                  selectedDataBackground: { lineStyle: { color: c.accent }, areaStyle: { color: c.zoom } },
                  brushStyle: { color: c.zoom } },
      markLine: { lineStyle: { color: c.muted } },
    });
  }
  registerTheme();

  /* bars with the rounded end on the data side and square at the baseline —
   * negative bars round downward. `colorOf(v)` picks the fill. */
  function bars(values, colorOf) {
    return values.map((v) => (v == null ? null : {
      value: v,
      itemStyle: { color: colorOf(v), borderRadius: v >= 0 ? [3, 3, 0, 0] : [0, 0, 3, 3] },
    }));
  }

  function mkChart(id) {
    const el = document.getElementById(id);
    if (!el) return null;
    const c = echarts.init(el, "qe");
    charts.push(c);
    return c;
  }
  window.addEventListener("resize", () => charts.forEach((c) => c.resize()));

  /* theme toggle: auto → light → dark → auto; remembered per browser. Charts
   * read their colours at init, so a change reloads the page. */
  function initTheme() {
    const btn = document.getElementById("theme-toggle");
    if (!btn) return;
    let mode = "auto";
    try { mode = localStorage.getItem("qe-theme") || "auto"; } catch (e) { /* private window */ }
    const label = btn.querySelector(".label");
    if (label) label.textContent = mode;
    btn.addEventListener("click", () => {
      const next = mode === "auto" ? "light" : mode === "light" ? "dark" : "auto";
      try { if (next === "auto") localStorage.removeItem("qe-theme"); else localStorage.setItem("qe-theme", next); } catch (e) { /* ignore */ }
      if (next === "auto") delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = next;
      location.reload();
    });
  }
  document.addEventListener("DOMContentLoaded", initTheme);

  /* shared chart pieces */
  function whiskerSeries(data, color) {
    // data: [[xIndex, lo, hi], ...] — ±1 SE whiskers drawn over bars
    return {
      type: "custom", z: 10, silent: true, data,
      renderItem: (params, api) => {
        const x = api.value(0), lo = api.value(1), hi = api.value(2);
        const p1 = api.coord([x, lo]), p2 = api.coord([x, hi]);
        const w = 5, s = { stroke: color, lineWidth: 1.4 };
        return { type: "group", children: [
          { type: "line", shape: { x1: p1[0], y1: p1[1], x2: p2[0], y2: p2[1] }, style: s },
          { type: "line", shape: { x1: p1[0] - w, y1: p1[1], x2: p1[0] + w, y2: p1[1] }, style: s },
          { type: "line", shape: { x1: p2[0] - w, y1: p2[1], x2: p2[0] + w, y2: p2[1] }, style: s },
        ] };
      },
    };
  }

  /* the rank-profile chart: mean realized excess per model-rank decile,
   * left = model's least favorite tenth, right = favorite tenth */
  function renderRankProfile(elId, payload) {
    const el = document.getElementById(elId);
    if (!el || !payload.available) return null;
    const prof = payload.profile;
    const labels = prof.bins.map((b) =>
      b.bucket === 1 ? "1\nleast fav." : b.bucket === prof.n_bins ? prof.n_bins + "\nfavorites" : String(b.bucket));
    const means = prof.bins.map((b) => b.mean_bps);
    const wdata = prof.bins.map((b, i) =>
      b.se_bps == null ? null : [i, b.mean_bps - b.se_bps, b.mean_bps + b.se_bps])
      .filter((x) => x !== null);
    const chart = mkChart(elId);
    const c = colors();
    chart.setOption({
      animation: false,
      tooltip: { formatter: (o) => {
        const b = prof.bins[o.dataIndex];
        return "Decile " + b.bucket + " (" + (b.bucket === prof.n_bins ? "model's favorites" :
          b.bucket === 1 ? "model's least favorites" : "middle") + "):<br><b>" +
          b.mean_bps.toFixed(1) + " bps/day</b> ± " +
          (b.se_bps == null ? "?" : b.se_bps.toFixed(1)) + " SE · " +
          b.n_days + " days · " + b.n_obs.toLocaleString() + " stock-days";
      } },
      grid: { left: 56, right: 12, top: 26, bottom: 42 },
      xAxis: { type: "category", data: labels,
               name: "model rank decile →", nameLocation: "middle", nameGap: 30,
               nameTextStyle: { fontSize: 10 }, axisLabel: { fontSize: 9 } },
      yAxis: { type: "value", name: "realized excess, bps/day",
               nameTextStyle: { fontSize: 10 } },
      series: [
        { type: "bar", data: bars(means, (v) => (v >= 0 ? c.pos : c.neg)), barMaxWidth: 24, barWidth: "60%",
          itemStyle: { opacity: 0.85 } },
        whiskerSeries(wdata, c.ink2),
      ],
    });
    return chart;
  }

  function rankProfileMeta(rep) {
    const ic = rep.ic;
    const icPart = ic && ic.mean_ic != null
      ? " · mean daily IC " + (ic.mean_ic >= 0 ? "+" : "") + ic.mean_ic.toFixed(3) +
        " ± " + (ic.se_ic == null ? "?" : ic.se_ic.toFixed(3)) +
        " (" + ic.n_positive + "/" + ic.n_days + " days positive)"
      : "";
    return rep.profile.n_dates + " scored days, " + rep.first_date + " → " + rep.last_date +
      " (" + rep.live_days + " live, " + rep.backfill_days + " recovered in arrears)" +
      " · " + rep.profile.n_obs.toLocaleString() + " stock-days" + icPart;
  }

  /* formatting */
  const fmtPct = (v, d = 1) => (v == null ? "—" : (v >= 0 ? "+" : "") + (v * 100).toFixed(d) + "%");
  const fmtNum = (v, d = 2) => (v == null ? "—" : Number(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }));
  const fmtCompact = (v) => {
    if (v == null) return "—";
    const a = Math.abs(v);
    if (a >= 1e9) return (v / 1e9).toFixed(2) + "B";
    if (a >= 1e6) return (v / 1e6).toFixed(2) + "M";
    if (a >= 1e3) return (v / 1e3).toFixed(1) + "k";
    return String(Math.round(v));
  };
  const fmtBps = (v, d = 2) => (v == null ? "—" : (v >= 0 ? "+" : "") + Number(v).toFixed(d) + " bps");
  /* "mean ± SE" as markup; an unknown SE says so rather than pretending */
  const pm = (v, se, d = 2, unit = " bps") => {
    if (v == null) return "—";
    const head = (v >= 0 ? "+" : "") + Number(v).toFixed(d) + unit;
    return head + '<span class="se">± ' + (se == null ? "?" : Number(se).toFixed(d)) + "</span>";
  };
  const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));

  /* one stat tile: label above, value, optional one-line sub. `value` is
   * markup (callers format numbers first); everything else is escaped. */
  function tile(label, value, opts) {
    const o = opts || {};
    const cls = ["tile", o.cls || "", o.big ? "big" : "", o.boxed ? "boxed" : ""].join(" ").trim();
    return '<div class="' + cls + '"' + (o.title ? ' title="' + esc(o.title) + '"' : "") + ">" +
      '<span class="t-label">' + esc(label) + "</span>" +
      '<span class="t-value">' + (value == null || value === "" ? "—" : value) +
      (o.badge ? ' <span class="badge badge-' + esc(o.badge) + '">' + esc(o.badge) + "</span>" : "") + "</span>" +
      (o.sub ? '<span class="t-sub">' + o.sub + "</span>" : "") + "</div>";
  }
  const signCls = (v) => (v == null ? "" : v >= 0 ? "pos" : "neg");

  /* tabs: buttons carry data-tab, panes are #tab-<name>; fires qe:tab once
   * per pane so charts initialize lazily. The active tab is mirrored into
   * the URL hash so a tab can be linked to and survives a reload. */
  const seenTabs = new Set();
  function initTabs() {
    const tabs = document.querySelectorAll(".tabs .tab");
    if (!tabs.length) return;
    const select = (btn, push) => {
      tabs.forEach((b) => {
        b.classList.toggle("active", b === btn);
        b.setAttribute("aria-selected", b === btn ? "true" : "false");
      });
      document.querySelectorAll(".tabpane").forEach((p) =>
        p.classList.toggle("active", p.id === "tab-" + btn.dataset.tab));
      if (push) history.replaceState(null, "", "#" + btn.dataset.tab);
      activateTab(btn.dataset.tab);
    };
    tabs.forEach((btn) => btn.addEventListener("click", () => select(btn, true)));
    const wanted = location.hash.replace(/^#/, "");
    const initial = Array.from(tabs).find((b) => b.dataset.tab === wanted) ||
                    document.querySelector(".tabs .tab.active") || tabs[0];
    select(initial, false);
  }
  function activateTab(name) {
    charts.forEach((c) => c.resize());
    if (seenTabs.has(name)) return;
    seenTabs.add(name);
    document.dispatchEvent(new CustomEvent("qe:tab", { detail: { tab: name } }));
  }

  /* section navigation: highlight the .subnav link whose section is in view */
  function initSubnav() {
    const nav = document.querySelector(".subnav");
    if (!nav || !("IntersectionObserver" in window)) return;
    const links = Array.from(nav.querySelectorAll('a[href^="#"]'));
    const targets = links.map((a) => document.getElementById(a.getAttribute("href").slice(1))).filter(Boolean);
    if (!targets.length) return;
    const visible = new Map();
    const pick = () => {
      let best = null;
      for (const t of targets) {
        if (visible.get(t)) { best = t; break; }
      }
      if (!best) return;
      links.forEach((a) => a.classList.toggle("active", a.getAttribute("href") === "#" + best.id));
    };
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => visible.set(e.target, e.isIntersecting));
      pick();
    }, { rootMargin: "-40% 0px -50% 0px", threshold: 0 });
    targets.forEach((t) => io.observe(t));
  }

  /* sortable tables: numeric via data-v (blank/None -> bottom) */
  function initSortable() {
    document.querySelectorAll("table.sortable").forEach((table) => {
      const head = table.tHead ? table.tHead.rows[table.tHead.rows.length - 1] : table.rows[0];
      Array.from(head.cells).forEach((th, idx) =>
        th.addEventListener("click", () => {
          const dir = th.classList.contains("sorted-desc") ? 1 : -1;
          Array.from(head.cells).forEach((h) =>
            h.classList.remove("sorted-asc", "sorted-desc"));
          th.classList.add(dir === 1 ? "sorted-asc" : "sorted-desc");
          const body = table.tBodies[0];
          const rows = Array.from(body.rows);
          const key = (row) => {
            const cell = row.cells[idx];
            const v = cell.dataset.v;
            if (v !== undefined) {
              const f = parseFloat(v);
              return isNaN(f) ? null : f;
            }
            return cell.textContent.trim().toLowerCase();
          };
          rows.sort((a, b) => {
            const ka = key(a), kb = key(b);
            if (ka === null && kb === null) return 0;
            if (ka === null) return 1;   // nulls last either way
            if (kb === null) return -1;
            return ka < kb ? -dir : ka > kb ? dir : 0;
          });
          rows.forEach((r) => body.appendChild(r));
        }));
    });
  }

  /* client-side row filter for a table whose rows carry data-search (free
   * text) and optional data-* facets. `facets` maps a control element to the
   * row attribute it filters on; a control with an empty value matches all. */
  function tableFilter(tableId, opts) {
    const table = document.getElementById(tableId);
    if (!table) return;
    const rows = Array.from(table.tBodies[0].rows);
    const q = opts.search ? document.getElementById(opts.search) : null;
    const facets = (opts.facets || []).map((f) => ({ el: document.getElementById(f.id), attr: f.attr, test: f.test }))
      .filter((f) => f.el);
    const count = opts.count ? document.getElementById(opts.count) : null;
    const apply = () => {
      const needle = q ? q.value.trim().toLowerCase() : "";
      let shown = 0;
      rows.forEach((r) => {
        let ok = !needle || (r.dataset.search || "").includes(needle);
        for (const f of facets) {
          if (!ok) break;
          const want = f.el.type === "checkbox" ? f.el.checked : f.el.value;
          if (!want) continue;
          ok = f.test ? f.test(r, want) : (r.dataset[f.attr] || "") === want;
        }
        r.hidden = !ok;
        if (ok) shown += 1;
      });
      if (count) count.innerHTML = '<span class="mono">' + shown + "</span> of <span class=\"mono\">" + rows.length + "</span> rows";
    };
    if (q) q.addEventListener("input", apply);
    facets.forEach((f) => f.el.addEventListener(f.el.type === "checkbox" ? "change" : "input", apply));
    apply();
    return apply;
  }

  /* symbol search boxes */
  function wireSearch(inputId, resultsId) {
    const input = document.getElementById(inputId);
    const box = document.getElementById(resultsId);
    if (!input || !box) return;
    let timer = null;
    let sel = -1;
    const close = () => { box.hidden = true; box.innerHTML = ""; sel = -1; };
    const render = (matches) => {
      if (!matches.length) { close(); return; }
      box.innerHTML = matches.map((m) =>
        '<a href="' + window.QE_ROOT + 'symbol/' + m.symbol + '.html"><span class="mono strong">' + m.symbol +
        '</span><span class="s-name">' + esc(m.name || "") + "</span>" +
        (m.status === "Delisted" ? '<span class="badge badge-warn">delisted</span>' : "") +
        "</a>").join("");
      box.hidden = false;
      sel = -1;
    };
    input.addEventListener("input", () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (!q) { close(); return; }
      timer = setTimeout(async () => {
        try { render((await qeFetch("/api/search?q=" + encodeURIComponent(q))).matches); }
        catch (e) { close(); }
      }, 140);
    });
    input.addEventListener("keydown", (ev) => {
      const links = box.querySelectorAll("a");
      if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
        ev.preventDefault();
        sel += ev.key === "ArrowDown" ? 1 : -1;
        sel = Math.max(0, Math.min(links.length - 1, sel));
        links.forEach((l, i) => l.classList.toggle("sel", i === sel));
      } else if (ev.key === "Enter") {
        if (links.length) { ev.preventDefault(); links[Math.max(sel, 0)].click(); }
      } else if (ev.key === "Escape") close();
    });
    document.addEventListener("click", (ev) => {
      if (!box.contains(ev.target) && ev.target !== input) close();
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    initTabs();
    initSubnav();
    initSortable();
    wireSearch("nav-search", "nav-search-results");
    wireSearch("hero-search", "hero-search-results");
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "/" && document.activeElement.tagName !== "INPUT" &&
          document.activeElement.tagName !== "TEXTAREA" &&
          document.activeElement.tagName !== "SELECT") {
        const input = document.getElementById("nav-search") || document.getElementById("hero-search");
        if (input) { ev.preventDefault(); input.focus(); }
      }
    });
  });

  window.qe = { fetch: qeFetch, chart: mkChart, colors, bars, fmtPct, fmtNum, fmtCompact, fmtBps, pm, esc,
                tile, signCls, tableFilter, whiskerSeries, renderRankProfile, rankProfileMeta };
})();
