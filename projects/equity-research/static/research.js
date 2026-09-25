/* Research ledger (/research): filter the block cards by outcome, family and
 * text; draw each card's registration → run interval; bring the cards and
 * the closed directions in as they are reached; fill the registrations rail
 * as it is read; open a block's raw statistics when it is jumped to.
 *
 * Everything here is navigation and arrival. The page is complete without
 * it — the toolbar ships hidden, every card and table is server-rendered —
 * and nothing fetches: the ledger is small enough to arrive whole, and this
 * browser never polls the database. Every animation checks
 * prefers-reduced-motion first; a failed block moves exactly like a passing
 * one, and no colour is chosen here. */
"use strict";

(function () {
  const grid = document.getElementById("rs-grid");
  if (!grid) return;
  const reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const cards = Array.from(grid.querySelectorAll(".rs-card"));
  const results = Array.from(document.querySelectorAll(".rs-result"));
  const cardOf = new Map(cards.map((c) => [c.dataset.block, c]));
  const esc = (s) => (window.qe && qe.esc ? qe.esc(s) : String(s).replace(/[&<>"]/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch])));

  /* ---- the interval between registration and run --------------------------- */
  // The strings are the server's str() of a naive TIMESTAMP ("2026-09-09
  // 22:04:31.123456"); parsed field by field so no engine's Date parser has
  // to guess at six fractional digits or a missing "T".
  function parseTs(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?/.exec(s || "");
    if (!m) return null;
    const ms = m[7] ? Math.floor(Number("0." + m[7]) * 1000) : 0;
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0), ms).getTime();
  }
  function span(ms) {
    const s = Math.abs(ms) / 1000;
    if (s < 60) return Math.max(1, Math.round(s)) + " s";
    const m = s / 60;
    if (m < 60) return Math.round(m) + " min";
    const h = m / 60;
    if (h < 48) return (h < 10 ? h.toFixed(1) : Math.round(h)) + " h";
    return Math.round(h / 24) + " days";
  }
  document.querySelectorAll(".rs-tl").forEach((tl) => {
    const a = parseTs(tl.dataset.reg), b = parseTs(tl.dataset.run);
    const gap = tl.querySelector(".rs-tl-gap");
    if (a == null || b == null || !gap) return;
    const d = b - a;
    gap.textContent = (d >= 0 ? "+" : "−") + span(d);
    gap.title = d >= 0 ? "results written this long after the registration"
                       : "results timestamped this long before the registration";
  });

  /* ---- the ledger ring ------------------------------------------------------ */
  const ledger = document.getElementById("rs-ledger");
  if (ledger && !reduced) {
    ledger.classList.add("rs-wait");
    requestAnimationFrame(() => requestAnimationFrame(() => ledger.classList.remove("rs-wait")));
  }

  /* ---- entrances: armed here, played when first in view --------------------- */
  // Armed by this script, never by CSS alone, so a page whose script failed
  // shows every card. Settled once played, so a card a filter brings back
  // fades in on its own rather than replaying the whole cascade.
  function stage(el, settleMs) {
    if (!el || reduced || !("IntersectionObserver" in window)) return;
    el.classList.add("rs-armed");
    const play = () => {
      el.classList.add("play");
      setTimeout(() => el.classList.add("settled"), settleMs);
    };
    const r = el.getBoundingClientRect();
    if (r.top < (window.innerHeight || 800) && r.bottom > 0) { requestAnimationFrame(play); return; }
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      play();
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.02 });
    io.observe(el);
  }
  stage(grid, 1600 + cards.length * 55);
  // fx.js reveals a panel once 5% of it is in view; the registrations panel
  // runs to thousands of pixels on a phone, so it would sit blank for a
  // screenful. Here any panel rises as soon as its top edge arrives.
  if (!reduced && "IntersectionObserver" in window && document.documentElement.classList.contains("fx")) {
    const early = new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); early.unobserve(e.target); } });
    }, { rootMargin: "0px 0px -40px 0px", threshold: 0 });
    document.querySelectorAll("main .panel:not(.in)").forEach((el) => early.observe(el));
  }
  const closedGrid = document.getElementById("rs-closed");
  stage(closedGrid, 1600 + (closedGrid ? closedGrid.children.length * 60 : 0));

  /* ---- filters -------------------------------------------------------------- */
  const toolbar = document.getElementById("rs-toolbar");
  const qBox = document.getElementById("rs-q");
  const outcomeSeg = document.getElementById("rs-outcome");
  const familySeg = document.getElementById("rs-family");
  const countEl = document.getElementById("rs-count");
  const emptyEl = document.getElementById("rs-empty");
  const resetBtn = document.getElementById("rs-reset");
  const resultsNote = document.getElementById("rs-results-filter");
  const state = { outcome: "", family: "", q: "" };

  const matches = (card, st) =>
    (!st.outcome || (card.dataset.outcome || "").split(" ").includes(st.outcome)) &&
    (!st.family || card.dataset.family === st.family) &&
    (!st.q || (card.dataset.search || "").includes(st.q));
  const filtered = () => !!(state.outcome || state.family || state.q);

  function bump(el, text) {
    if (!el || el.textContent === text) return;
    const first = el.textContent === "";
    el.textContent = text;
    if (reduced || first) return;
    el.classList.remove("bump");
    void el.offsetWidth;
    el.classList.add("bump");
  }

  // highlight the query inside a card's question; the text is the server's,
  // re-escaped piece by piece, so nothing from the database reaches innerHTML raw
  function mark(card) {
    const el = card.querySelector(".rs-q");
    if (!el) return;
    if (el.dataset.orig === undefined) el.dataset.orig = el.textContent;
    const text = el.dataset.orig;
    const q = state.q;
    if (!q) { if (el.dataset.marked) { el.textContent = text; delete el.dataset.marked; } return; }
    const low = text.toLowerCase();
    let out = "", i = 0, j;
    while ((j = low.indexOf(q, i)) >= 0) {
      out += esc(text.slice(i, j)) + "<mark>" + esc(text.slice(j, j + q.length)) + "</mark>";
      i = j + q.length;
    }
    el.innerHTML = out + esc(text.slice(i));
    el.dataset.marked = "1";
  }

  function facetCounts() {
    const tally = (seg, key) => {
      if (!seg) return;
      seg.querySelectorAll("button").forEach((b) => {
        const st = Object.assign({}, state, { [key]: b.dataset.v });
        const n = cards.filter((c) => matches(c, st)).length;
        bump(b.querySelector(".rs-n"), String(n));
        b.classList.toggle("zero", n === 0);
      });
    };
    tally(outcomeSeg, "outcome");
    tally(familySeg, "family");
  }

  // First, Last, Invert, Play: cards that stay glide from where they were,
  // cards that arrive fade up. Positions are read before and after one
  // layout change, so the grid never animates through a state it never had.
  function apply(animate) {
    const glide = animate && !reduced && typeof grid.animate === "function";
    const before = new Map();
    if (glide) cards.forEach((c) => { if (!c.hidden) before.set(c, c.getBoundingClientRect()); });
    let shown = 0;
    cards.forEach((c) => {
      const ok = matches(c, state);
      c.hidden = !ok;
      if (ok) shown += 1;
      mark(c);
    });
    if (glide) {
      cards.forEach((c) => {
        if (c.hidden) return;
        const was = before.get(c);
        const now = c.getBoundingClientRect();
        if (was) {
          const dx = was.left - now.left, dy = was.top - now.top;
          if (Math.abs(dx) + Math.abs(dy) > 1) {
            c.animate([{ transform: "translate(" + dx + "px," + dy + "px)" }, { transform: "none" }],
                      { duration: 420, easing: "cubic-bezier(.2,.8,.2,1)" });
          }
        } else {
          c.animate([{ opacity: 0, transform: "translateY(10px) scale(.96)" }, { opacity: 1, transform: "none" }],
                    { duration: 360, easing: "cubic-bezier(.2,.8,.2,1)" });
        }
      });
    }
    // the raw statistics below follow the same filter, so a reader narrowing
    // to one family sees only that family's tables
    let shownRes = 0;
    results.forEach((r) => {
      const card = cardOf.get(r.dataset.block);
      // a block with results but no digest row has no card: judge it on its own facets
      const ok = card ? !card.hidden : matches({ dataset: {
        outcome: r.dataset.outcome, family: r.dataset.family, search: (r.dataset.block || "").toLowerCase(),
      } }, state);
      r.hidden = !ok;
      if (ok) shownRes += 1;
    });
    if (countEl) {
      const nums = countEl.querySelectorAll(".mono");
      if (nums.length === 2) { bump(nums[0], String(shown)); nums[1].textContent = String(cards.length); }
    }
    if (emptyEl) emptyEl.hidden = shown > 0 || !cards.length;
    if (resetBtn) resetBtn.hidden = !filtered();
    if (resultsNote) {
      resultsNote.hidden = !filtered();
      if (filtered()) {
        resultsNote.innerHTML = "Filtered above: <span class=\"mono\">" + shownRes + "</span> of <span class=\"mono\">" +
          results.length + "</span> blocks shown " +
          '<button type="button" class="rs-reset" data-reset>Show all</button>';
      }
    }
    facetCounts();
    syncUrl();
  }

  function press(seg, v) {
    if (!seg) return;
    seg.querySelectorAll("button").forEach((b) => {
      const on = b.dataset.v === v;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }

  // the filter lives in the query string so a narrowed view can be linked;
  // replaceState only — a filter is not a page in the history
  function syncUrl() {
    try {
      const u = new URL(location.href);
      [["outcome", state.outcome], ["family", state.family], ["q", state.q]].forEach(([k, v]) => {
        if (v) u.searchParams.set(k, v); else u.searchParams.delete(k);
      });
      if (u.href !== location.href) history.replaceState(history.state, "", u.href);
    } catch (e) { /* an old engine without URL: the filter still works */ }
  }

  function reset(animate) {
    state.outcome = ""; state.family = ""; state.q = "";
    if (qBox) qBox.value = "";
    press(outcomeSeg, ""); press(familySeg, "");
    apply(animate);
  }

  if (toolbar && cards.length) {
    toolbar.hidden = false;
    // restore a linked filter, accepting only values a control offers
    const params = new URLSearchParams(location.search);
    const offered = (seg, v) => !!seg && Array.from(seg.querySelectorAll("button")).some((b) => b.dataset.v === v);
    if (offered(outcomeSeg, params.get("outcome"))) state.outcome = params.get("outcome");
    if (offered(familySeg, params.get("family"))) state.family = params.get("family");
    state.q = (params.get("q") || "").trim().toLowerCase().slice(0, 80);
    if (qBox) qBox.value = state.q;
    press(outcomeSeg, state.outcome);
    press(familySeg, state.family);

    [[outcomeSeg, "outcome"], [familySeg, "family"]].forEach(([seg, key]) => {
      if (!seg) return;
      seg.addEventListener("click", (ev) => {
        const b = ev.target.closest("button");
        if (!b || !seg.contains(b)) return;
        state[key] = b.dataset.v;
        press(seg, state[key]);
        apply(true);
      });
    });
    let t = null;
    if (qBox) {
      qBox.addEventListener("input", () => {
        clearTimeout(t);
        t = setTimeout(() => { state.q = qBox.value.trim().toLowerCase(); apply(true); }, 90);
      });
      qBox.addEventListener("keydown", (ev) => {
        if (ev.key === "Escape" && qBox.value) { ev.preventDefault(); ev.stopPropagation(); qBox.value = ""; state.q = ""; apply(true); }
      });
    }
    apply(false);
  }

  document.addEventListener("click", (ev) => {
    if (ev.target.closest("[data-reset], #rs-reset")) reset(true);
  });

  /* ---- jumping to a block's raw statistics ---------------------------------- */
  function reveal(id, smooth) {
    const target = document.getElementById(id);
    if (!target) return false;
    if (target.hidden) reset(false);            // a filtered-out block is brought back first
    const det = target.querySelector("details.rs-raw");
    if (det) det.open = true;
    target.scrollIntoView({ behavior: smooth && !reduced ? "smooth" : "auto", block: "start" });
    if (!reduced) {
      target.classList.remove("rs-flash");
      void target.offsetWidth;
      target.classList.add("rs-flash");
    }
    return true;
  }
  document.addEventListener("click", (ev) => {
    const a = ev.target.closest("a[data-open]");
    if (!a || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button !== 0) return;
    if (reveal(a.dataset.open, true)) {
      ev.preventDefault();
      history.replaceState(history.state, "", "#" + a.dataset.open);
    }
  });
  const fromHash = () => {
    const id = decodeURIComponent(location.hash.slice(1));
    if (/^block-[A-Za-z0-9_-]+$/.test(id)) reveal(id, false);
  };
  window.addEventListener("hashchange", fromHash);
  if (location.hash) requestAnimationFrame(fromHash);

  /* ---- open or close every raw table at once --------------------------------- */
  const openAll = document.getElementById("rs-openall");
  if (openAll) {
    const raws = Array.from(document.querySelectorAll("details.rs-raw"));
    const label = openAll.querySelector(".rs-openall-label");
    const sync = () => {
      const all = raws.length > 0 && raws.every((d) => d.open);
      openAll.setAttribute("aria-pressed", all ? "true" : "false");
      if (label) label.textContent = all ? "Close every table" : "Open every table";
    };
    openAll.hidden = raws.length === 0;
    openAll.addEventListener("click", () => {
      const open = !raws.every((d) => d.open);
      raws.forEach((d) => { d.open = open; });
      sync();
    });
    raws.forEach((d) => d.addEventListener("toggle", sync));
    sync();
  }

  /* ---- registrations: the committed items, shown or folded ------------------- */
  const regs = document.getElementById("rs-regs");
  const itemsSwitch = document.getElementById("rs-items-switch");
  const itemsBox = document.getElementById("rs-items");
  if (regs && itemsSwitch && itemsBox) {
    itemsSwitch.hidden = false;
    try { if (localStorage.getItem("qe-research-items") === "folded") itemsBox.checked = false; } catch (e) { /* private window */ }
    const syncItems = () => regs.classList.toggle("rs-compact", !itemsBox.checked);
    itemsBox.addEventListener("change", () => {
      syncItems();
      try { localStorage.setItem("qe-research-items", itemsBox.checked ? "shown" : "folded"); } catch (e) { /* ignore */ }
    });
    syncItems();
  }

  /* ---- registrations: the rail fills to the reading line --------------------- */
  // A client-side scroll effect only: nothing is fetched as the reader scrolls.
  if (regs && !reduced) {
    const rail = regs.querySelector(".rs-rail");
    const items = Array.from(regs.querySelectorAll(".rs-reg"));
    regs.classList.add("rs-scrolly");
    let queued = false;
    const draw = () => {
      queued = false;
      const line = (window.innerHeight || 800) * 0.62;
      const box = regs.getBoundingClientRect();
      const p = Math.max(0, Math.min(1, (line - box.top) / Math.max(1, box.height)));
      if (rail) rail.style.setProperty("--p", p.toFixed(4));
      items.forEach((li) => {
        const node = li.querySelector(".rs-node");
        const y = (node || li).getBoundingClientRect().top;
        const passed = y < line;
        if (li.classList.contains("passed") !== passed) li.classList.toggle("passed", passed);
      });
    };
    const queue = () => { if (!queued) { queued = true; requestAnimationFrame(draw); } };
    window.addEventListener("scroll", queue, { passive: true });
    window.addEventListener("resize", queue, { passive: true });
    if (itemsBox) itemsBox.addEventListener("change", queue);
    draw();
  }
})();
