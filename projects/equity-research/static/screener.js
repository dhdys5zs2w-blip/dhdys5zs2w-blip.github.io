/* Screener: the server-rendered membership table, made explorable.
 *
 *  - filters (text, sector chips mirroring the <select>, the top-50 switch)
 *    in one pass that also counts every chip and feeds the summary strip;
 *  - the strip: rows shown, the chosen return's distribution against the
 *    universe's, how many of the model's top 50 are on screen, and the
 *    volatility of what is shown — descriptions of the rows, never signals;
 *  - diverging in-cell bars for the signed columns, scaled per column;
 *  - sort feedback and keyboard-operable headers (the sort itself is app.js);
 *  - a keyboard cursor: j/k or the arrows walk the visible rows, Enter or o
 *    opens one, p peeks, f focuses the filter;
 *  - the peek: the last 63 adjusted closes, fetched only once a pointer (or
 *    the following cursor) has rested on a row for half a second, or at once
 *    when p is pressed; one request at a time, cached for the visit.
 *
 * Nothing here runs on a timer against the server and nothing fetches on load.
 * Motion is skipped under prefers-reduced-motion; the table itself is plain
 * server HTML and reads the same without this file. */
"use strict";

(function () {
  const table = document.getElementById("screener-table");
  if (!table) return;
  const reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const $ = (id) => document.getElementById(id);
  const tbody = table.tBodies[0];
  const head = table.tHead.rows[table.tHead.rows.length - 1];
  const keys = Array.from(head.cells).map((th) => th.dataset.k);
  const colOf = (k) => keys.indexOf(k);
  const wrap = $("scr-wrap");
  const q = $("screener-q"), sectorSel = $("screener-sector"), book = $("screener-book");

  const VALS = ["ret_1d", "ret_1m", "ret_3m", "ret_1y", "atr_pct_v1", "beta_spy_v1", "dist_sma200_pct_v1"];
  const numOf = (cell) => {
    const f = cell ? parseFloat(cell.dataset.v) : NaN;
    return isFinite(f) ? f : null;
  };
  const rows = Array.from(tbody.rows).map((tr) => {
    const v = {};
    VALS.forEach((k) => { const i = colOf(k); v[k] = i < 0 ? null : numOf(tr.cells[i]); });
    const rank = parseFloat(tr.dataset.modelRank);
    return { tr, v, search: tr.dataset.search || "", sector: tr.dataset.sector || "",
             rank: isFinite(rank) ? rank : null };
  });
  const inTop = (r) => r.rank != null && r.rank <= 50;

  /* ---- small maths ---------------------------------------------------------- */
  const sorted = (xs) => xs.filter((x) => x != null).sort((a, b) => a - b);
  function quantile(xs, p) {
    const s = sorted(xs);
    if (!s.length) return null;
    const i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
    return s[lo] + (s[hi] - s[lo]) * (i - lo);
  }
  const median = (xs) => quantile(xs, 0.5);
  const pct1 = (v) => (v == null ? "—" : (v >= 0 ? "+" : "−") + Math.abs(v * 100).toFixed(1) + "%");
  const vol1 = (v) => (v == null ? "—" : (v * 100).toFixed(1) + "%");
  const num2 = (v) => (v == null ? "—" : v.toFixed(2));
  const int0 = (v) => String(Math.round(v));

  /* a number that moves to its new value instead of jumping; the last frame
     always prints exactly fmt(to) */
  function tween(el, to, fmt) {
    if (!el) return;
    const st = el._tw || (el._tw = { cur: null, raf: 0 });
    cancelAnimationFrame(st.raf);
    if (to == null || !isFinite(to)) { st.cur = null; el.textContent = "—"; return; }
    const from = st.cur == null ? 0 : st.cur;
    if (reduced || from === to) { st.cur = to; el.textContent = fmt(to); return; }
    const t0 = performance.now(), dur = st.cur == null ? 700 : 380;
    const step = (now) => {
      const p = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - p, 3);
      st.cur = p < 1 ? from + (to - from) * e : to;
      el.textContent = fmt(st.cur);
      if (p < 1) st.raf = requestAnimationFrame(step);
    };
    st.raf = requestAnimationFrame(step);
  }
  const signed = (el, v) => {
    if (!el) return;
    el.classList.toggle("pos", v != null && v >= 0);
    el.classList.toggle("neg", v != null && v < 0);
  };

  /* ---- sector chips ---------------------------------------------------------- */
  const chipsBox = $("scr-chips");
  const toolbar = $("scr-toolbar");
  let chips = [];
  if (chipsBox && sectorSel) {
    chipsBox.innerHTML = Array.from(sectorSel.options).map((o) =>
      '<button type="button" class="scr-chip" data-sector="' + qe.esc(o.value) + '" aria-pressed="' +
      (o.value === sectorSel.value) + '"><span class="c-name">' + qe.esc(o.value ? o.textContent : "All sectors") +
      '</span><span class="c-n">0</span><i class="c-bar" aria-hidden="true"></i></button>').join("");
    chips = Array.from(chipsBox.querySelectorAll(".scr-chip"));
    toolbar.classList.add("has-chips");
    chipsBox.addEventListener("click", (ev) => {
      const b = ev.target.closest(".scr-chip");
      if (!b) return;
      const s = b.dataset.sector;
      sectorSel.value = s && sectorSel.value === s ? "" : s;   // a second click clears it
      apply();
    });
    chipsBox.addEventListener("scroll", chipEdge, { passive: true });
    window.addEventListener("resize", chipEdge);
  }
  // on a narrow screen the chips scroll sideways under a fade; the fade says
  // more is off to the right, so it lifts once nothing is
  function chipEdge() {
    if (!chipsBox) return;
    chipsBox.classList.toggle("more", chipsBox.scrollWidth - chipsBox.clientWidth - chipsBox.scrollLeft > 2);
  }

  /* ---- the strip ------------------------------------------------------------- */
  const strip = $("scr-strip");
  const HIST_N = 24, HW = 240, HH = 60;
  let period = "ret_1m";
  const universeMed = {};
  const clip95 = {};
  VALS.forEach((k) => { universeMed[k] = median(rows.map((r) => r.v[k])); });
  ["ret_1d", "ret_1m", "ret_3m", "ret_1y"].forEach((k) => {
    clip95[k] = quantile(rows.map((r) => (r.v[k] == null ? null : Math.abs(r.v[k]))), 0.95) || 0.01;
  });

  const svgNS = "http://www.w3.org/2000/svg";
  const hist = $("scr-hist");
  let barsEls = [], medLine = null;
  // what the strip's shapes should show; painted now, or on the frame after
  // they first appear so the ring, meter and bars grow in from zero
  const shape = { ring: 0, meter: 0, counts: null, peak: 1, medX: HW / 2, med: false };
  let fresh = true;
  function binOf(v, c) {
    const w = (2 * c) / HIST_N;
    return Math.max(0, Math.min(HIST_N - 1, Math.floor((v + c) / w)));
  }
  const xOf = (v, c) => ((Math.max(-c, Math.min(c, v)) + c) / (2 * c)) * HW;
  function buildHist() {
    if (!hist) return;
    hist.textContent = "";
    const c = clip95[period], bw = HW / HIST_N;
    const mk = (tag, attrs) => {
      const el = document.createElementNS(svgNS, tag);
      Object.entries(attrs).forEach(([a, v]) => el.setAttribute(a, v));
      hist.appendChild(el);
      return el;
    };
    const counts = new Array(HIST_N).fill(0);
    rows.forEach((r) => { const v = r.v[period]; if (v != null) counts[binOf(v, c)] += 1; });
    const peak = Math.max(1, ...counts);
    barsEls = counts.map((_, i) => mk("rect", {
      x: (i * bw + 0.6).toFixed(2), y: 0, width: (bw - 1.2).toFixed(2), height: HH,
      class: (i + 0.5) * bw < HW / 2 ? "h-neg" : "h-pos", style: "transform: scaleY(0)",
    }));
    // the universe outline: a step line over the same bins, scaled to its own peak
    let d = "M0," + HH;
    counts.forEach((n, i) => {
      const y = (HH - (n / peak) * HH).toFixed(2);
      d += " L" + (i * bw).toFixed(2) + "," + y + " L" + ((i + 1) * bw).toFixed(2) + "," + y;
    });
    mk("path", { d: d + " L" + HW + "," + HH, class: "h-ghost" });
    mk("line", { x1: HW / 2, x2: HW / 2, y1: 0, y2: HH, class: "h-zero" });
    const um = universeMed[period];
    mk("line", { x1: 0, x2: 0, y1: -3, y2: HH, class: "h-med-all",
                 style: "transform: translateX(" + (um == null ? HW / 2 : xOf(um, c)).toFixed(2) + "px)" });
    medLine = mk("line", { x1: 0, x2: 0, y1: -3, y2: HH, class: "h-med",
                           style: "transform: translateX(" + (HW / 2) + "px)" });
    // the end bins also collect everything past ±c, so the ends are bounds
    const lo = $("scr-axis-lo"), hi = $("scr-axis-hi");
    if (lo) lo.textContent = "≤" + pct1(-c);
    if (hi) hi.textContent = "≥" + pct1(c);
    fresh = true;
  }
  function paintShapes() {
    const ring = $("scr-ring");
    if (ring) ring.style.setProperty("--ring", shape.ring.toFixed(1));
    const meter = $("scr-top-meter");
    if (meter) meter.style.width = shape.meter.toFixed(1) + "%";
    if (shape.counts) {
      barsEls.forEach((el, i) => { el.style.transform = "scaleY(" + (shape.counts[i] / shape.peak).toFixed(3) + ")"; });
    }
    if (medLine) {
      medLine.style.transform = "translateX(" + shape.medX.toFixed(2) + "px)";
      medLine.style.opacity = shape.med ? 1 : 0;
    }
  }
  function paint() {
    if (fresh && !reduced) {
      fresh = false;
      requestAnimationFrame(() => requestAnimationFrame(paintShapes));
    } else {
      fresh = false;
      paintShapes();
    }
  }

  function drawStrip(shown) {
    if (!strip) return;
    const n = shown.length, total = rows.length;
    tween($("scr-shown-n"), n, int0);
    // the animated figure is hidden from assistive tech; this carries the final one
    const live = $("scr-live"), said = n + " of " + total + " rows shown";
    if (live && live.textContent !== said) live.textContent = said;
    tween($("scr-shown-pct"), total ? (100 * n) / total : 0, int0);
    shape.ring = total ? (100 * n) / total : 0;
    const bits = [];
    if (sectorSel && sectorSel.value) bits.push(sectorSel.value);
    if (book && book.checked) bits.push("model's top 50");
    if (q && q.value.trim()) bits.push("“" + q.value.trim() + "”");
    const sub = $("scr-shown-sub");
    if (sub) sub.textContent = bits.length ? bits.join(" · ") : "every member";

    // distribution of the chosen return
    const vals = shown.map((r) => r.v[period]);
    const med = median(vals);
    const medEl = $("scr-median");
    tween(medEl, med, pct1);
    signed(medEl, med);
    const ua = $("scr-median-all");
    if (ua) ua.textContent = pct1(universeMed[period]);
    const c = clip95[period], counts = new Array(HIST_N).fill(0);
    vals.forEach((v) => { if (v != null) counts[binOf(v, c)] += 1; });
    shape.counts = counts;
    shape.peak = Math.max(1, ...counts);
    shape.med = med != null;
    shape.medX = med == null ? HW / 2 : xOf(med, c);

    // the model's top 50: always out of 50. A universe holding only part of
    // the book can never fill it, and the card says how much it can hold.
    const topShown = shown.filter(inTop).length;
    tween($("scr-top-n"), topShown, int0);
    shape.meter = Math.min(100, (100 * topShown) / 50);
    const share = $("scr-top-share");
    if (share) share.textContent = n ? Math.round((100 * topShown) / n) + "%" : "—";

    // volatility of what is shown, beside the universe's
    tween($("scr-atr"), median(shown.map((r) => r.v.atr_pct_v1)), vol1);
    tween($("scr-beta"), median(shown.map((r) => r.v.beta_spy_v1)), num2);
    const aa = $("scr-atr-all"), ba = $("scr-beta-all");
    if (aa) aa.textContent = vol1(universeMed.atr_pct_v1);
    if (ba) ba.textContent = num2(universeMed.beta_spy_v1);
    paint();
  }

  const periodSeg = $("scr-period");
  if (periodSeg) {
    periodSeg.addEventListener("click", (ev) => {
      const b = ev.target.closest("button[data-k]");
      if (!b || b.dataset.k === period) return;
      period = b.dataset.k;
      periodSeg.querySelectorAll("button").forEach((x) => {
        const on = x === b;
        x.classList.toggle("on", on);
        x.setAttribute("aria-pressed", on ? "true" : "false");
      });
      buildHist();
      apply();
    });
  }

  /* ---- filtering: one pass for rows, chips and strip -------------------------- */
  const reset = $("scr-reset");
  function apply() {
    const needle = q ? q.value.trim().toLowerCase() : "";
    const sector = sectorSel ? sectorSel.value : "";
    const top = !!(book && book.checked);
    const counts = new Map();
    let base = 0;
    const shown = [];
    for (const r of rows) {
      const okBase = (!needle || r.search.includes(needle)) && (!top || inTop(r));
      if (okBase) { base += 1; counts.set(r.sector, (counts.get(r.sector) || 0) + 1); }
      const ok = okBase && (!sector || r.sector === sector);
      if (r.tr.hidden === ok) r.tr.hidden = !ok;
      if (ok) shown.push(r);
    }
    // chips count what each would show given the other filters
    let peak = 1;
    counts.forEach((n) => { peak = Math.max(peak, n); });
    chips.forEach((b) => {
      const s = b.dataset.sector;
      const n = s ? counts.get(s) || 0 : base;
      const el = b.querySelector(".c-n");
      const prev = el._tw && el._tw.cur != null ? Math.round(el._tw.cur) : null;
      tween(el, n, int0);
      if (prev != null && prev !== n && !reduced) {
        b.classList.remove("bump");
        void b.offsetWidth;   // restart the nudge
        b.classList.add("bump");
      }
      b.style.setProperty("--share", s ? (n / peak).toFixed(3) : base ? 1 : 0);
      b.classList.toggle("zero", n === 0);
      b.setAttribute("aria-pressed", s === sector ? "true" : "false");
      b.setAttribute("aria-label", (s || "All sectors") + ", " + n + (n === 1 ? " row" : " rows"));
    });
    chipEdge();
    if (reset) reset.hidden = !(needle || sector || top);
    drawStrip(shown);
    if (cur && cur.hidden) setCursor(null);
    else placeCursor();
    hidePeek();
  }
  if (q) q.addEventListener("input", apply);
  if (sectorSel) sectorSel.addEventListener("change", apply);
  if (book) book.addEventListener("change", apply);
  if (reset) reset.addEventListener("click", () => {
    if (q) q.value = "";
    if (sectorSel) sectorSel.value = "";
    if (book) book.checked = false;
    apply();
    if (q) q.focus();
  });

  /* ---- in-cell bars ------------------------------------------------------------ */
  const BAR_KEYS = ["ret_1d", "ret_1m", "ret_3m", "ret_1y", "dist_sma200_pct_v1"];
  function drawBars() {
    BAR_KEYS.forEach((k) => {
      const i = colOf(k);
      if (i < 0) return;
      const clip = quantile(rows.map((r) => (r.v[k] == null ? null : Math.abs(r.v[k]))), 0.9);
      if (!(clip > 0)) return;
      rows.forEach((r) => {
        const v = r.v[k], td = r.tr.cells[i];
        if (v == null || !td) return;
        td.classList.add("bar");
        if (v < 0) td.classList.add("bar-neg");
        if (Math.abs(v) > clip) td.classList.add("bar-clip");
        td.style.setProperty("--b", Math.min(1, Math.abs(v) / clip).toFixed(3));
      });
      const th = head.cells[i];
      if (th) th.title = th.title + " · bars clipped at ±" + (clip * 100).toFixed(1) + "%";
    });
  }
  const barsBox = $("scr-bars"), barsToggle = $("scr-bars-toggle");
  let barsOn = true;
  try { barsOn = localStorage.getItem("qe-screener-bars") !== "off"; } catch (e) { /* private window */ }
  drawBars();
  const settle = () => {
    table.classList.remove("settled");
    if (reduced) { table.classList.add("settled"); return; }
    setTimeout(() => table.classList.add("settled"), 1000);
  };
  table.classList.toggle("bars", barsOn);
  settle();
  if (barsBox) {
    barsBox.checked = barsOn;
    if (barsToggle) barsToggle.hidden = false;
    barsBox.addEventListener("change", () => {
      barsOn = barsBox.checked;
      table.classList.toggle("bars", barsOn);
      if (barsOn) settle();
      try { localStorage.setItem("qe-screener-bars", barsOn ? "on" : "off"); } catch (e) { /* ignore */ }
    });
  }

  /* ---- sorting: feedback and keyboard access (the sort itself is app.js) ------- */
  const cols = Array.from(table.querySelectorAll("colgroup col"));
  let sortedIdx = -1;
  const sortHint = $("scr-sort-hint");
  Array.from(head.cells).forEach((th) => {
    th.tabIndex = 0;
    // a description, not a label: the header's name stays the column's name
    // for every cell under it
    if (sortHint) th.setAttribute("aria-describedby", "scr-sort-hint");
    th.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); th.click(); }
    });
  });
  // delegated on the head so it runs after app.js's own handler on the cell
  table.tHead.addEventListener("click", (ev) => {
    const th = ev.target.closest("th");
    if (!th || !th.dataset.k) return;
    const idx = Array.from(head.cells).indexOf(th);
    Array.from(head.cells).forEach((h) => {
      if (h === th) h.setAttribute("aria-sort", th.classList.contains("sorted-asc") ? "ascending" : "descending");
      else h.removeAttribute("aria-sort");
    });
    cols.forEach((c, i) => c.classList.toggle("sorted", i === idx));
    if (idx !== sortedIdx && !reduced) {
      th.classList.remove("pop");
      void th.offsetWidth;
      th.classList.add("pop");
      setTimeout(() => th.classList.remove("pop"), 450);
    }
    sortedIdx = idx;
    if (wrap) wrap.scrollTop = 0;
    if (!reduced) {
      const vis = Array.from(tbody.rows).filter((r) => !r.hidden).slice(0, 22);
      Array.from(tbody.querySelectorAll("tr.flash")).forEach((r) => r.classList.remove("flash"));
      void tbody.offsetWidth;
      vis.forEach((r, i) => { r.style.setProperty("--ri", i); r.classList.add("flash"); });
      setTimeout(() => vis.forEach((r) => r.classList.remove("flash")), 1000);
    }
    placeCursor();
    hidePeek();
  });

  /* ---- keyboard cursor ------------------------------------------------------------ */
  let cur = null;
  const cursorEl = document.createElement("div");
  cursorEl.className = "scr-cursor";
  cursorEl.setAttribute("aria-hidden", "true");
  if (wrap) wrap.appendChild(cursorEl);
  const visibleRows = () => Array.from(tbody.rows).filter((r) => !r.hidden);
  const linkOf = (tr) => tr && tr.cells[0] && tr.cells[0].querySelector("a");

  // the cursor row keeps its tint when focus leaves the table for a control
  let marked = null;
  function placeCursor() {
    if (marked !== cur) {
      if (marked) marked.classList.remove("is-cur");
      if (cur) cur.classList.add("is-cur");
      marked = cur;
    }
    if (!wrap || !cur || cur.hidden) { cursorEl.classList.remove("on"); return; }
    const wr = wrap.getBoundingClientRect(), rr = cur.getBoundingClientRect();
    const y = rr.top - wr.top - wrap.clientTop + wrap.scrollTop;
    cursorEl.style.height = rr.height + "px";
    cursorEl.style.transform = "translate(" + wrap.scrollLeft + "px," + y.toFixed(1) + "px)";
    cursorEl.classList.add("on");
  }
  // keep the row inside the table's own scroller (below its sticky head) and
  // inside the window (below the sticky nav)
  function reveal(tr) {
    if (wrap) {
      const wr = wrap.getBoundingClientRect(), rr = tr.getBoundingClientRect();
      const headH = table.tHead.getBoundingClientRect().height;
      if (rr.top < wr.top + headH) wrap.scrollTop -= wr.top + headH - rr.top;
      else if (rr.bottom > wr.bottom - 2) wrap.scrollTop += rr.bottom - wr.bottom + 2;
    }
    const rr = tr.getBoundingClientRect();
    const nav = document.querySelector(".topnav");
    const top = nav ? nav.getBoundingClientRect().bottom : 0;
    // instant, not the page's smooth scrolling: a held j would queue a glide per row
    if (rr.top < top + 8) window.scrollBy({ top: rr.top - top - 8, behavior: "instant" });
    else if (rr.bottom > window.innerHeight - 8) window.scrollBy({ top: rr.bottom - window.innerHeight + 8, behavior: "instant" });
  }
  function setCursor(tr, focus) {
    cur = tr;
    if (!tr) { placeCursor(); if (follow) hidePeek(); return; }
    if (focus !== false) {
      const a = linkOf(tr);
      if (a) a.focus({ preventScroll: true });
    }
    reveal(tr);
    placeCursor();
    if (follow) schedulePeek(tr, null, 220);
  }
  function move(delta) {
    const list = visibleRows();
    if (!list.length) return;
    let i = cur ? list.indexOf(cur) : -1;
    // with no cursor yet, either direction starts at the top: k should not
    // throw the page to row 500
    if (i < 0) i = 0;
    else i = Math.max(0, Math.min(list.length - 1, i + delta));
    setCursor(list[i]);
  }
  const open = (tr) => { const a = linkOf(tr); if (a) location.href = a.href; };

  // a click on a row (not its link) selects it, so j/k carry on from there
  tbody.addEventListener("click", (ev) => {
    if (ev.target.closest("a")) return;
    // leave a text selection alone: people copy tickers and figures from here
    const sel = window.getSelection && window.getSelection();
    if (sel && String(sel).trim()) return;
    const tr = ev.target.closest("tr");
    if (tr) setCursor(tr);
  });
  tbody.addEventListener("focusin", (ev) => {
    const tr = ev.target.closest("tr");
    if (tr && tr !== cur) { cur = tr; placeCursor(); }
  });
  if (wrap) wrap.addEventListener("scroll", () => {
    wrap.classList.toggle("scrolled-x", wrap.scrollLeft > 2);
    placeCursor();
    if (!follow) hidePeek(); else if (peekRow) positionPeek(peekRow, null);
  }, { passive: true });
  window.addEventListener("scroll", () => {
    if (!follow) hidePeek(); else if (peekRow) positionPeek(peekRow, null);
  }, { passive: true });
  window.addEventListener("resize", () => { placeCursor(); hidePeek(); });

  const GO = new Set(["o", "s", "m", "r", "h"]);   // fx.js's g-chords
  let gAt = 0;
  document.addEventListener("keydown", (ev) => {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const a = document.activeElement, tag = a && a.tagName;
    const typing = tag === "TEXTAREA" || tag === "SELECT" ||
      (tag === "INPUT" && !/^(checkbox|radio|button)$/.test(a.type));
    if (typing) {
      if (a === q && ev.key === "ArrowDown") { ev.preventDefault(); setCursor(null); move(1); }
      else if (a === q && ev.key === "Enter") {
        const list = visibleRows();
        if (list.length === 1) { ev.preventDefault(); open(list[0]); }
      }
      return;
    }
    if (document.querySelector(".palette:not([hidden])")) return;
    const k = ev.key;
    if (k === "g") { gAt = Date.now(); return; }
    if (gAt && Date.now() - gAt < 900 && GO.has(k)) return;
    const onRow = a && tbody.contains(a);
    if (k === "j" || (k === "ArrowDown" && onRow)) { ev.preventDefault(); move(1); }
    else if (k === "k" || (k === "ArrowUp" && onRow)) { ev.preventDefault(); move(-1); }
    else if ((k === "Home" || k === "End") && onRow) {
      ev.preventDefault();
      const list = visibleRows();
      if (list.length) setCursor(k === "Home" ? list[0] : list[list.length - 1]);
    } else if (k === "o" && cur && !cur.hidden) { ev.preventDefault(); open(cur); }
    else if (k === "p" && cur && !cur.hidden) {
      ev.preventDefault();
      if (follow) { follow = false; hidePeek(); }
      else { follow = true; schedulePeek(cur, null, 0, 0); }   // asked for: fetch now
    } else if (k === "f" && q) { ev.preventDefault(); q.focus(); q.select(); }
    else if (k === "Escape") { follow = false; hidePeek(); }
  });

  /* ---- peek ------------------------------------------------------------------------ */
  const peek = $("scr-peek");
  const canHover = window.matchMedia && window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  const cache = new Map();
  let inflight = false, want = null;
  let peekRow = null, follow = false, dwell = 0, pointerX = null, hoverRow = null;
  // The prices endpoint serves a symbol's whole history (~0.75 MB for a long
  // one) to draw 63 points, so the box may follow the pointer from row to row
  // but a request waits until a row has held it this long. A sweep down the
  // table then costs nothing; a rest costs one request.
  const REST = 500;
  let fetchT = 0;

  // the prices endpoint serves the whole history; keep only what the peek draws
  function slim(p) {
    const dates = p.dates || [], closes = p.adj_close || [];
    const d = [], c = [];
    for (let i = closes.length - 1; i >= 0 && c.length < 63; i--) {
      if (closes[i] != null && isFinite(closes[i])) { c.unshift(closes[i]); d.unshift(dates[i]); }
    }
    return { dates: d, closes: c };
  }
  // one request at a time, and only the newest wish survives a busy spell
  function series(sym) {
    if (cache.has(sym)) return Promise.resolve(cache.get(sym));
    return new Promise((resolve) => { want = { sym, resolve }; pump(); });
  }
  function pump() {
    if (inflight || !want) return;
    const { sym, resolve } = want;
    want = null;
    if (cache.has(sym)) { resolve(cache.get(sym)); pump(); return; }
    inflight = true;
    qe.fetch("/api/symbol/" + encodeURIComponent(sym) + "/prices")
      .then(slim, () => ({ dates: [], closes: [], failed: true }))
      .then((s) => {
        cache.set(sym, s);   // a failure is kept too, so resting on the row again does not re-ask
        inflight = false;
        resolve(s);
        pump();
      });
  }

  function spark(s) {
    const W = 256, H = 72, P = 6, n = s.closes.length;
    const lo = Math.min(...s.closes), hi = Math.max(...s.closes);
    const span = hi - lo || 1;
    const x = (i) => (n === 1 ? W / 2 : 1 + (i * (W - 2)) / (n - 1));
    const y = (v) => P + (1 - (v - lo) / span) * (H - 2 * P);
    let d = "";
    s.closes.forEach((v, i) => { d += (i ? " L" : "M") + x(i).toFixed(1) + "," + y(v).toFixed(1); });
    const area = d + " L" + x(n - 1).toFixed(1) + "," + H + " L" + x(0).toFixed(1) + "," + H + " Z";
    const y0 = y(s.closes[0]).toFixed(1);
    return '<svg viewBox="0 0 ' + W + " " + H + '" width="' + W + '" height="' + H + '" aria-hidden="true">' +
      '<path class="spark-area" d="' + area + '"/>' +
      '<line class="spark-base" x1="0" x2="' + W + '" y1="' + y0 + '" y2="' + y0 + '"/>' +
      '<path class="spark-line" pathLength="1" d="' + d + '"/>' +
      '<circle class="spark-dot" r="3" cx="' + x(n - 1).toFixed(1) + '" cy="' + y(s.closes[n - 1]).toFixed(1) + '"/>' +
      "</svg>" +
      '<div class="peek-stats"><span>lo ' + qe.fmtNum(lo) + " · hi " + qe.fmtNum(hi) + "</span><span>" +
      qe.esc(s.dates[0]) + " → " + qe.esc(s.dates[n - 1]) + "</span></div>";
  }

  function positionPeek(tr, x) {
    if (!peek || peek.hidden) return;
    const rr = tr.getBoundingClientRect();
    const pw = peek.offsetWidth, ph = peek.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
    let left = x != null ? x + 18 : tr.cells[0].getBoundingClientRect().right + 12;
    if (left + pw > vw - 12) left = Math.max(12, Math.min(vw - 12, x != null ? x - 18 : vw) - pw);
    let top = rr.bottom + 6;
    if (top + ph > vh - 8) top = Math.max(8, rr.top - ph - 6);
    peek.style.left = Math.round(left) + "px";
    peek.style.top = Math.round(top) + "px";
  }

  function showPeek(tr, x, fetchIn) {
    clearTimeout(fetchT);
    if (!peek || !tr || tr.hidden) return;
    const a = linkOf(tr);
    if (!a) return;
    const sym = a.textContent.trim();
    if (peekRow && peekRow !== tr) { const pa = linkOf(peekRow); if (pa) pa.removeAttribute("aria-describedby"); }
    peekRow = tr;
    a.setAttribute("aria-describedby", "scr-peek");
    $("scr-peek-sym").textContent = sym;
    $("scr-peek-name").textContent = tr.cells[1] ? tr.cells[1].textContent.trim() : "";
    const body = $("scr-peek-body");
    const draw = (s) => {
      body.innerHTML = s.closes.length >= 2 ? spark(s)
        : '<p class="peek-empty">' + (s.failed ? "could not load prices" : "no price history") + "</p>";
    };
    if (cache.has(sym)) draw(cache.get(sym));
    else body.innerHTML = '<p class="loading">loading prices…</p>';
    const wasHidden = peek.hidden;
    peek.hidden = false;
    positionPeek(tr, x);
    if (wasHidden) requestAnimationFrame(() => peek.classList.add("open"));
    if (!cache.has(sym)) {
      const go = () => series(sym).then((s) => {
        if (peekRow !== tr || peek.hidden) return;
        draw(s);
        positionPeek(tr, follow ? null : pointerX);
      });
      if (fetchIn > 0) fetchT = setTimeout(go, fetchIn);
      else go();
    }
  }
  function hidePeek() {
    clearTimeout(dwell);
    clearTimeout(fetchT);
    if (!peek || peek.hidden) { peekRow = null; return; }
    if (peekRow) { const a = linkOf(peekRow); if (a) a.removeAttribute("aria-describedby"); }
    peekRow = null;
    peek.classList.remove("open");
    peek.hidden = true;
  }
  // show after `delay`; request prices once the row has been rested on for
  // `rest` in all (REST unless given), counted from now
  function schedulePeek(tr, x, delay, rest) {
    clearTimeout(dwell);
    clearTimeout(fetchT);   // the row being left has not earned its request
    const fetchIn = Math.max(0, (rest == null ? REST : rest) - delay);
    dwell = setTimeout(() => showPeek(tr, x, fetchIn), delay);
  }

  if (peek && canHover) {
    tbody.addEventListener("pointermove", (ev) => { pointerX = ev.clientX; }, { passive: true });
    tbody.addEventListener("pointerover", (ev) => {
      if (ev.pointerType && ev.pointerType !== "mouse") return;
      const tr = ev.target.closest("tr");
      if (!tr || tr === hoverRow) return;
      hoverRow = tr;
      follow = false;
      // a first peek waits for the pointer to rest; once one is open, the
      // next row follows quickly, like a run of tooltips
      schedulePeek(tr, ev.clientX, peek.hidden ? 350 : 140);
    });
    tbody.addEventListener("pointerleave", () => {
      hoverRow = null;
      if (!follow) hidePeek();
    });
  }

  /* ---- steady columns ------------------------------------------------------------------ */
  // An auto-layout table re-measures its columns from whichever rows are
  // visible, so every keystroke in the filter would shuffle them sideways.
  // Pin the widths the full universe produced, once the web fonts have landed.
  function pinColumns() {
    if (cols.length !== head.cells.length) return;
    // measure against every row, whatever a restored filter has hidden
    const hiddenNow = rows.filter((r) => r.tr.hidden);
    hiddenNow.forEach((r) => { r.tr.hidden = false; });
    const widths = Array.from(head.cells).map((th) => th.getBoundingClientRect().width);
    hiddenNow.forEach((r) => { r.tr.hidden = true; });
    if (widths.some((w) => !(w > 0))) return;
    cols.forEach((c, i) => { c.style.width = widths[i].toFixed(1) + "px"; });
    table.style.tableLayout = "fixed";
  }
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(pinColumns);
  else pinColumns();

  /* ---- start ------------------------------------------------------------------------- */
  buildHist();
  if (strip) strip.hidden = false;
  const keysHint = $("scr-keys");
  if (keysHint) keysHint.hidden = false;
  apply();
})();
