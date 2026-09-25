/* Overview: the record's pulse (committed ring, unbroken nights, countdown to
 * the next scoring run, the evidence calendar), the book ticker and the
 * market map.
 *
 * The calendar draws the committed-in-advance test day by day. A restamped
 * day keeps the live hue — it is what the database says — and is told apart
 * by an outline, never by a new hue: committed is a count, not a fourth
 * evidence state. */
"use strict";

(function () {
  const pulse = document.getElementById("s-pulse");
  if (!pulse) return;
  const MODEL = pulse.dataset.modelId;
  const reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---- ring: fill on first paint ---------------------------------------- */
  requestAnimationFrame(() => pulse.classList.add("armed"));

  /* ---- countdown ----------------------------------------------------------- */
  const hm = (s) => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };
  function startClock(schedule) {
    const fires = schedule.fire_times.map(hm).sort((a, b) => a - b);
    const quiet = schedule.quiet_windows.map(([a, b]) => [hm(a), hm(b)]);
    const count = document.getElementById("clock-count");
    const label = document.getElementById("clock-label");
    const sub = document.getElementById("clock-sub");
    const now = document.getElementById("day-now");
    const card = document.getElementById("pulse-clock");
    const track = card.querySelector(".day-track");
    // tick marks for each fire time, shaded spans for each quiet window
    quiet.forEach(([a, b]) => {
      const q = document.createElement("span");
      q.className = "day-quiet";
      q.style.left = (a / 14.4) + "%";
      q.style.width = (((b - a + 1440) % 1440) / 14.4) + "%";
      track.appendChild(q);
    });
    fires.forEach((f) => {
      const t = document.createElement("span");
      t.className = "day-fire";
      t.style.left = (f / 14.4) + "%";
      track.appendChild(t);
    });
    const pad = (n) => String(n).padStart(2, "0");
    // a static snapshot states the schedule; a countdown in the viewer's own
    // clock would be to someone else's evening
    if (qe.snapshot) {
      now.hidden = true;
      label.textContent = "Nightly scoring run";
      count.textContent = pad(Math.floor(fires[0] / 60)) + ":" + pad(fires[0] % 60);
      sub.textContent = "on the platform's own clock, with a retry at " +
        fires.slice(1).map((f) => pad(Math.floor(f / 60)) + ":" + pad(f % 60)).join(", ") +
        ". This page is a snapshot exported " + String(qe.snapshot.exported_at).slice(0, 10) +
        "; nothing on it is live.";
      return;
    }
    const tick = () => {
      const d = new Date();
      const mins = d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
      now.style.left = (mins / 14.4) + "%";
      const inQuiet = quiet.some(([a, b]) => (a <= b ? mins >= a && mins < b : mins >= a || mins < b));
      let next = fires.find((f) => f > mins);
      const tomorrow = next === undefined;
      if (tomorrow) next = fires[0] + 1440;
      let secs = Math.max(0, Math.round((next - mins) * 60));
      count.textContent = pad(Math.floor(secs / 3600)) + ":" + pad(Math.floor((secs % 3600) / 60)) + ":" + pad(secs % 60);
      const nextLabel = pad(Math.floor((next % 1440) / 60)) + ":" + pad(next % 60);
      card.classList.toggle("quiet", inQuiet);
      if (inQuiet) {
        label.textContent = "Quiet window — the writer's turn";
        sub.textContent = "these pages step off the database until the nightly run is clear";
      } else {
        label.textContent = next % 1440 === fires[0] ? "Next scoring run" : "Next retry";
        sub.textContent = (tomorrow ? "tomorrow " : "today ") + nextLabel +
          " local — a schedule, not a promise the run succeeds";
      }
    };
    tick();
    setInterval(tick, 1000);
  }

  /* ---- evidence calendar --------------------------------------------------- */
  const iso = (d) => d.toISOString().slice(0, 10);
  function drawCalendar(p) {
    const box = document.getElementById("evcal");
    if (!p.days.length) { box.innerHTML = '<span class="muted small">no scored days yet</span>'; return; }
    const byDate = new Map(p.days.map((d) => [d.date, d]));
    // weekdays only, Monday-aligned columns, first scored week to the newest
    const start = new Date(p.first_date + "T12:00:00Z");
    start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
    const end = new Date(p.last_date + "T12:00:00Z");
    const cols = [];
    for (let w = new Date(start); w <= end; w.setUTCDate(w.getUTCDate() + 7)) {
      const col = [];
      for (let k = 0; k < 5; k++) {
        const d = new Date(w); d.setUTCDate(d.getUTCDate() + k);
        col.push(d > end ? null : iso(d));
      }
      cols.push(col);
    }
    let i = 0;
    box.innerHTML = cols.map((col) => '<div class="evcol">' + col.map((ds) => {
      if (!ds) return '<i class="cell c-void"></i>';
      const d = byDate.get(ds);
      const cls = !d ? "c-none" : d.committed ? "c-committed" : d.source === "live" ? "c-restamped" : "c-backfill";
      const what = !d ? "not scored" : d.committed ? "committed in advance"
        : d.source === "live" ? "live stamp, scored in arrears — not evidence" : "backfill — not evidence";
      return '<i class="cell ' + cls + '" style="--i:' + (i++) + '" title="' + ds + " · " + what +
        (d ? " · " + d.n_names + " names" : "") + '"></i>';
    }).join("") + "</div>").join("");
    document.getElementById("cal-range").textContent = p.days.length + " scored days · " +
      p.first_date + " → " + p.last_date;
    requestAnimationFrame(() => box.classList.add("in"));
  }

  function drawStreak(p) {
    const el = document.getElementById("pulse-streak");
    el.textContent = String(p.streak);
    el.dataset.count = p.streak;
    delete el.dataset.counted;
    if (qe.countUp) qe.countUp(el);
    document.getElementById("pulse-best").textContent =
      "longest run " + p.best_streak + " · " + p.committed_days + " committed of " +
      p.days.length + " scored";
    pulse.querySelector(".pulse-streak").classList.toggle("lit", p.streak > 0);
  }

  qe.fetch("/api/model/" + MODEL + "/pulse").then((p) => {
    startClock(p.schedule);
    drawStreak(p);
    drawCalendar(p);
  }).catch((e) => console.error(e));

  /* ---- market map + ticker ---------------------------------------------------- */
  const mapEl = document.getElementById("chart-map");
  const CLIP = { ret_1d: 0.03, ret_1m: 0.12, ret_3m: 0.2, ret_1y: 0.4 };
  const PLABEL = { ret_1d: "1 day", ret_1m: "1 month", ret_3m: "3 months", ret_1y: "1 year" };
  let data = null, period = "ret_1d", bookOnly = false, chart = null;

  // mix two #rrggbb colours; the scale runs neg → a neutral surface → pos
  const hex = (h) => { h = h.replace("#", ""); if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); };
  const mixRgb = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
  const rgb = (c) => "rgb(" + c.join(",") + ")";
  // WCAG relative luminance, to pick a legible label over each fill
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  function fillFor(v, C) {
    if (v == null) return hex(C.line);
    const t = Math.max(-1, Math.min(1, v / CLIP[period]));
    const mid = hex(C.panel2), pos = hex(C.pos), neg = hex(C.neg);
    const s = Math.pow(Math.abs(t), 0.75);
    return t >= 0 ? mixRgb(mid, pos, s) : mixRgb(mid, neg, s);
  }
  // the theme's own ink or panel colour, whichever stands further from the fill
  let inkOn = (c) => c;
  const pickInk = (C) => {
    const a = hex(C.ink), b = hex(C.panel);
    const contrast = (x, y) => { const l1 = lum(x), l2 = lum(y); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
    inkOn = (c) => (contrast(c, a) >= contrast(c, b) ? C.ink : C.panel);
  };

  function drawMap() {
    if (!data || !mapEl) return;
    const C = qe.colors();
    C.panel2 = getComputedStyle(document.documentElement).getPropertyValue("--panel-2").trim();
    pickInk(C);
    const tree = data.sectors.map((s) => {
      const names = s.names.filter((n) => !bookOnly || n.in_book);
      return {
        name: s.sector.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()),
        value: names.reduce((a, n) => a + n.adv, 0),
        children: names.map((n) => {
          const fill = fillFor(n[period], C), ink = inkOn(fill);
          return {
          name: n.symbol, value: n.adv, raw: n,
          label: { rich: { s: { color: ink }, r: { color: ink, opacity: 0.85 } } },
          itemStyle: {
            color: rgb(fill),
            borderColor: n.in_book ? C.accent : C.panel,
            borderWidth: n.in_book ? 2 : 1,
          },
          };
        }),
      };
    }).filter((s) => s.children.length);
    chart = chart || qe.chart("chart-map");
    chart.setOption({
      animation: !reduced, animationDurationUpdate: 600, animationEasingUpdate: "cubicOut",
      tooltip: {
        formatter: (o) => {
          const n = o.data && o.data.raw;
          if (!n) return "<b>" + qe.esc(o.name) + "</b><br>" + qe.fmtCompact(o.value) + " traded / day (20d)";
          const r = n[period];
          return '<b class="mono">' + qe.esc(n.symbol) + "</b> " + qe.esc(n.name || "") +
            "<br>" + PLABEL[period] + ": <b>" + (r == null ? "—" : qe.fmtPct(r, 2)) + "</b>" +
            "<br>$" + qe.fmtCompact(n.adv) + " traded / day" +
            (n.rank != null ? "<br>model rank " + n.rank : "") +
            (n.in_book ? "<br><b>in the model's latest book</b>" : "");
        },
      },
      series: [{
        type: "treemap", roam: false, nodeClick: "zoomToNode", leafDepth: null,
        left: 0, right: 0, top: 4, bottom: 30, visibleMin: 300, squareRatio: 0.62,
        breadcrumb: { show: true, bottom: 2, left: 0, height: 20, emptyItemWidth: 40,
                      itemStyle: { color: C.panel2, borderColor: C.line, borderWidth: 1,
                                   textStyle: { color: C.ink2, fontFamily: C.sans, fontSize: 11 } },
                      emphasis: { itemStyle: { color: C.soft, textStyle: { color: C.ink } } } },
        label: {
          show: true, fontFamily: C.mono, fontSize: 11, color: C.ink,
          formatter: (o) => {
            const n = o.data && o.data.raw;
            if (!n) return o.name;
            const r = n[period];
            return "{s|" + n.symbol + "}\n{r|" + (r == null ? "" : qe.fmtPct(r, 1)) + "}";
          },
          rich: { s: { fontFamily: C.mono, fontWeight: 500, fontSize: 11, color: C.ink },
                  r: { fontFamily: C.mono, fontSize: 10, color: C.ink2 } },
        },
        upperLabel: { show: true, height: 20, color: C.ink2, fontFamily: C.sans, fontSize: 11, fontWeight: 600,
                      backgroundColor: "transparent" },
        levels: [
          { itemStyle: { borderColor: C.panel, borderWidth: 0, gapWidth: 3 } },
          { itemStyle: { borderColor: C.line, borderWidth: 1, gapWidth: 1, borderRadius: 4 },
            upperLabel: { show: true } },
          { itemStyle: { gapWidth: 0, borderRadius: 2 } },
        ],
        data: tree,
      }],
    }, true);
    chart.off("click");
    chart.on("click", (o) => {
      const n = o.data && o.data.raw;
      if (n) location.href = qe.symbolHref(n.symbol);
    });
    document.getElementById("map-lo").textContent = qe.fmtPct(-CLIP[period], 0) + " or worse";
    document.getElementById("map-hi").textContent = qe.fmtPct(CLIP[period], 0) + " or better";
    document.getElementById("map-meta").textContent = data.n_names + " names · " + data.n_book +
      " in the book · as of " + (data.as_of || "—");
  }

  function drawTicker() {
    const wrap = document.getElementById("book-ticker");
    const track = document.getElementById("ticker-track");
    if (!wrap || !data) return;
    const held = data.sectors.flatMap((s) => s.names).filter((n) => n.in_book)
      .sort((a, b) => (a.rank == null) - (b.rank == null) || a.rank - b.rank || a.symbol.localeCompare(b.symbol));
    if (!held.length) return;
    const one = held.map((n) => {
      const r = n.ret_1d;
      return '<a class="tick" href="' + qe.symbolHref(n.symbol) + '"><span class="mono strong">' +
        qe.esc(n.symbol) + '</span><span class="mono ' + qe.signCls(r) + '">' +
        (r == null ? "—" : (r >= 0 ? "▲ " : "▼ ") + qe.fmtPct(Math.abs(r), 2).replace("+", "")) + "</span></a>";
    }).join("");
    track.innerHTML = one + '<span aria-hidden="true" class="tick-dup">' + one + "</span>";
    track.style.setProperty("--dur", Math.max(30, held.length * 2.2) + "s");
    wrap.hidden = false;
  }

  if (mapEl) {
    document.querySelectorAll("#map-period button").forEach((b) => b.addEventListener("click", () => {
      period = b.dataset.p;
      document.querySelectorAll("#map-period button").forEach((x) => x.classList.toggle("on", x === b));
      drawMap();
    }));
    document.getElementById("map-book").addEventListener("change", (ev) => { bookOnly = ev.target.checked; drawMap(); });
    qe.fetch("/api/market_map").then((m) => { data = m; drawMap(); drawTicker(); })
      .catch((e) => { document.getElementById("map-meta").textContent = "market map unavailable"; console.error(e); });
  }
})();
