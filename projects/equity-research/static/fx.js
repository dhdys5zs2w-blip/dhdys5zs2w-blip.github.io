/* The interaction layer: the site nav's two disclosures ("Under the hood"
 * and, on a phone, the menu), command palette (⌘K), keyboard navigation (g o,
 * g s, g l, g m, g r, g h; ? for help; t for theme), the fetch bar, numbers
 * that count up once when they first scroll into view, panels that rise in,
 * and a cursor spotlight on panels.
 *
 * The rule this file keeps: motion goes to navigation and to the arrival of
 * a number, never to its size. Nothing here colours a value, and nothing
 * here may borrow the live/backfill/backtest hues. Everything is skipped
 * under prefers-reduced-motion, and the pages read the same without it. */
"use strict";

(function () {
  const reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const root = document.documentElement;
  const REVEAL = ".panel, .pulse-card, .card";
  // Anything already on screen is marked revealed *before* motion is enabled,
  // so the first paint is never a blank page waiting on an animation frame (a
  // throttled or background tab may not deliver one for a while). Only what
  // sits below the fold rises in as it is scrolled to.
  if (!reduced) {
    const h = window.innerHeight || 800;
    document.querySelectorAll(REVEAL).forEach((el) => {
      if (el.getBoundingClientRect().top < h) el.classList.add("in");
    });
    root.classList.add("fx");
  }

  /* ---- fetch bar ---------------------------------------------------------- */
  document.addEventListener("qe:inflight", (ev) => {
    const bar = document.getElementById("fetch-bar");
    if (!bar) return;
    if (ev.detail.n > 0) { bar.classList.remove("done"); bar.classList.add("on"); }
    else { bar.classList.add("done"); setTimeout(() => bar.classList.remove("on", "done"), 380); }
  });

  /* ---- count-up ----------------------------------------------------------- */
  // Animates the first text node of an element whose text is a plain number
  // (optionally signed, with commas, decimals and a short unit suffix). The
  // final text is exactly the server's, so a number never ends on a value
  // the page did not print.
  const NUM_RE = /^([+\-−]?\$?)([\d,]*\.?\d+)(.*)$/;
  function countUp(el) {
    if (reduced || el.dataset.counted) return;
    el.dataset.counted = "1";
    const node = Array.from(el.childNodes).find((n) => n.nodeType === 3 && n.textContent.trim());
    if (!node) return;
    const text = node.textContent;
    const m = text.trim().match(NUM_RE);
    if (!m) return;
    const target = parseFloat(m[2].replace(/,/g, ""));
    if (!isFinite(target) || target === 0) return;
    const decimals = (m[2].split(".")[1] || "").length;
    const commas = m[2].includes(",");
    const lead = text.slice(0, text.indexOf(text.trim()));
    const t0 = performance.now(), dur = 900 + Math.min(600, Math.log10(Math.abs(target) + 1) * 180);
    const fmt = (v) => {
      let s = v.toFixed(decimals);
      if (commas) s = Number(s).toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
      return lead + m[1] + s + m[3];
    };
    const step = (now) => {
      const p = Math.min(1, (now - t0) / dur);
      const e = 1 - Math.pow(1 - p, 4);
      node.textContent = p < 1 ? fmt(target * e) : text;
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /* ---- reveal + count on first view --------------------------------------- */
  let io = null;
  function watch(scope) {
    if (reduced || !("IntersectionObserver" in window)) return;
    if (!io) {
      io = new IntersectionObserver((entries) => {
        entries.forEach((e) => {
          if (!e.isIntersecting) return;
          const el = e.target;
          io.unobserve(el);
          if (el.matches(REVEAL)) el.classList.add("in");
          else countUp(el);
        });
      }, { rootMargin: "0px 0px -6% 0px", threshold: 0.05 });
    }
    scope.querySelectorAll(REVEAL.split(", ").map((x) => x + ":not(.in)").join(", ")).forEach((el) => io.observe(el));
    scope.querySelectorAll(".tile .t-value:not([data-counted]), [data-count]:not([data-counted])")
      .forEach((el) => io.observe(el));
  }
  // tiles built later by the page scripts (qe.tile) are watched as they land
  function watchMutations() {
    if (reduced || !("MutationObserver" in window)) return;
    let queued = false;
    new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; watch(document); });
    }).observe(document.querySelector("main") || document.body, { childList: true, subtree: true });
  }

  /* ---- spotlight ---------------------------------------------------------- */
  function spotlight() {
    if (reduced || !window.matchMedia("(hover: hover)").matches) return;
    document.addEventListener("pointermove", (ev) => {
      const p = ev.target.closest && ev.target.closest(".panel, .pulse-card");
      if (!p) return;
      const r = p.getBoundingClientRect();
      p.style.setProperty("--mx", (ev.clientX - r.left) + "px");
      p.style.setProperty("--my", (ev.clientY - r.top) + "px");
    }, { passive: true });
  }

  /* ---- site nav --------------------------------------------------------------- */
  // "Under the hood" and the phone menu are disclosures, not ARIA menus: a
  // button with aria-expanded that shows a list of ordinary links. Esc closes
  // and hands focus back to the button; a press or focus anywhere but the
  // button and its panel closes too. base.html only folds them away under
  // `.nav-js`, and unfolds them again if this file never marks the nav wired,
  // so a page whose script never ran, or failed, still shows every link.
  const navs = [];
  function disclosure(btn, host, panel, cls) {
    const isOpen = () => btn.getAttribute("aria-expanded") === "true";
    // "inside" is the button and its panel, not the host: the phone menu's host
    // is the whole bar, and the search box in that bar must close the menu or
    // the open panel would sit on top of the search results
    const inside = (el) => btn.contains(el) || panel.contains(el);
    const links = () => Array.from(panel.querySelectorAll("a")).filter((a) => a.getClientRects().length);
    const set = (on, refocus) => {
      btn.setAttribute("aria-expanded", on ? "true" : "false");
      host.classList.toggle(cls, on);
      if (!on && refocus) btn.focus();
    };
    btn.addEventListener("click", () => set(!isOpen()));
    btn.addEventListener("keydown", (ev) => {
      if (ev.key !== "ArrowDown") return;
      ev.preventDefault();
      set(true);
      const l = links();
      if (l.length) l[0].focus();
    });
    // the phone menu's panel holds the hood's list, so a closed disclosure must
    // leave the keys alone or one press would move focus twice
    panel.addEventListener("keydown", (ev) => {
      if (!isOpen()) return;
      const l = links(), i = l.indexOf(document.activeElement);
      if (!l.length || i < 0) return;
      const to = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: l.length - 1 }[ev.key];
      if (to === undefined) return;
      ev.preventDefault();
      l[(to + l.length) % l.length].focus();
    });
    host.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && isOpen()) { ev.stopPropagation(); set(false, true); }
    });
    // focus arriving anywhere else closes it, however it got there: Tab, a tap
    // on the search box, or the "/" key focusing the search from the button
    document.addEventListener("focusin", (ev) => {
      if (isOpen() && !inside(ev.target)) set(false);
    });
    document.addEventListener("pointerdown", (ev) => {
      if (isOpen() && !inside(ev.target)) set(false);
    });
    const d = { close: () => { if (isOpen()) set(false); } };
    navs.push(d);
    return d;
  }
  const closeNavs = () => navs.forEach((d) => d.close());
  function initNav() {
    const hb = document.getElementById("hood-btn"), hm = document.getElementById("hood-menu");
    if (hb && hm) disclosure(hb, hb.parentElement, hm, "open");
    const mb = document.getElementById("nav-menu-btn"), sn = document.getElementById("site-nav");
    const top = mb && mb.closest(".topnav");
    if (mb && sn && top) disclosure(mb, top, sn, "menu-open");
    // base.html unfolds the menus again at `load` unless this mark is set
    root.dataset.nav = "ready";
  }

  /* ---- command palette ---------------------------------------------------- */
  // `also` is matched too, so the names a returning reader knows ("screener",
  // "overview", "ledger") still find the renamed pages.
  const PAGES = [
    { label: "The story", hint: "g o", also: "home start overview front", href: qe.href("/") },
    { label: "Explore stocks", hint: "g s", also: "screener universe symbols", href: qe.href("/screener") },
    { label: "Research notebook", hint: "g l", also: "lab overview pulse", href: qe.href("/lab") },
    { label: "Model dashboard", hint: "g m", also: "record book", href: qe.href("/model") },
    { label: "Research log", hint: "g r", also: "ledger research tests", href: qe.href("/research") },
    { label: "Data health", hint: "g h", also: "freshness runs", href: qe.href("/health") },
    { label: "Market map", hint: "notebook", href: qe.href("/lab#s-map") },
    { label: "What changed", hint: "notebook", also: "changelog", href: qe.href("/lab#s-changes") },
  ];
  // the g-keys are the pages' own hints, so the sheet and the keys cannot drift
  const GO = Object.fromEntries(PAGES.filter((p) => /^g [a-z]$/.test(p.hint)).map((p) => [p.hint.slice(2), p.href]));
  const ACTIONS = [
    { label: "Cycle the colour theme", hint: "t", run: () => { const b = document.getElementById("theme-toggle"); if (b) b.click(); } },
    { label: "Keyboard shortcuts", hint: "?", run: () => showHelp() },
    { label: "Jump to the top", hint: "", run: () => window.scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" }) },
  ];
  let pal = null, palOpen = false;

  function sections() {
    return Array.from(document.querySelectorAll(".subnav a[href^='#']")).map((a) => ({
      label: a.textContent.trim(), hint: "this page", href: a.getAttribute("href"),
    }));
  }

  // subsequence match with a bonus for prefix and word-start hits
  function score(q, s) {
    if (!q) return 1;
    q = q.toLowerCase(); s = s.toLowerCase();
    if (s.startsWith(q)) return 100 - s.length * 0.01;
    const idx = s.indexOf(q);
    if (idx >= 0) return 60 - idx;
    let i = 0, sc = 0, last = -2;
    for (let j = 0; j < s.length && i < q.length; j++) {
      if (s[j] === q[i]) { sc += (j === last + 1 ? 3 : 1) + (j === 0 || s[j - 1] === " " ? 2 : 0); last = j; i++; }
    }
    return i === q.length ? sc : 0;
  }
  // A word of the label, or of a page's old name, that starts with the query is
  // a strong hit, so "story", "health", "map" or "ledger" lands on the page and
  // not on a stock whose name happens to contain the word; a ticker typed in
  // full still comes first. Label words wait for a second letter, so a single
  // keystroke still lists symbols ahead of every page that shares its initial.
  function scoreItem(q, x) {
    const s = score(q, x.label);
    if (!q) return s;
    const lq = q.toLowerCase();
    const words = (lq.length > 1 ? x.label.toLowerCase().split(" ") : [])
      .concat(x.also ? x.also.split(" ") : []);
    return Math.max(s, words.some((w) => w.startsWith(lq)) ? 80 : 0);
  }

  // The order the rows are listed in. A listed ticker typed in full comes
  // first: MA, KEY or DASH + Enter opens Mastercard, KeyCorp or DoorDash, not
  // the market map, the shortcuts sheet or the dashboard a word of whose name
  // starts the same way. A page or section a word of the query names outright
  // (80 and up) comes next, ahead of an exact ticker only when that ticker is
  // delisted, which is how "scr" and "lab" still reach their pages (SCR and LAB
  // are delisted). Then the other strong hits, the symbols, and the weak hits.
  // A single letter names no page, so it keeps its ticker first.
  function order(q, local, symItems) {
    const lq = q.toLowerCase();
    const exact = symItems.filter((x) => x.sym.toLowerCase() === lq);
    const listed = exact.filter((x) => !x.delisted), gone = exact.filter((x) => x.delisted);
    const named = lq.length > 1 ? local.filter((x) => x.s >= 80) : [];
    const strong = local.filter((x) => x.s >= 60 && !named.includes(x)), weak = local.filter((x) => x.s < 60);
    const syms = symItems.filter((x) => !exact.includes(x));
    return [...listed, ...named, ...gone, ...strong, ...syms, ...weak].slice(0, 14);
  }

  function buildPalette() {
    const wrap = document.createElement("div");
    wrap.className = "palette";
    wrap.hidden = true;
    wrap.innerHTML =
      '<div class="palette-scrim"></div>' +
      '<div class="palette-box" role="dialog" aria-modal="true" aria-label="Command palette">' +
      '<div class="palette-input"><span class="palette-icon" aria-hidden="true">›</span>' +
      '<input type="text" placeholder="Jump to a page, a section, or a stock…" autocomplete="off" spellcheck="false" aria-label="Command">' +
      '<kbd>esc</kbd></div>' +
      '<div class="palette-list" role="listbox"></div>' +
      '<div class="palette-foot"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>↵</kbd> open</span>' +
      '<span>type a ticker to search every symbol</span></div></div>';
    document.body.appendChild(wrap);
    const input = wrap.querySelector("input");
    const list = wrap.querySelector(".palette-list");
    // `moved` is set once the reader picks a row with the arrows or the mouse;
    // until then the highlight is the top row. `pending` settles when the
    // symbol search for the current text has answered and been drawn.
    let items = [], sel = 0, symTimer = null, symItems = [], seq = 0, moved = false, pending = null, entering = false;

    const render = () => {
      const q = input.value.trim();
      const local = [
        ...PAGES.map((x) => ({ ...x, group: "Pages" })),
        ...sections().map((x) => ({ ...x, group: "On this page" })),
        ...ACTIONS.map((x) => ({ ...x, group: "Actions" })),
      ].map((x) => ({ ...x, s: scoreItem(q, x) })).filter((x) => x.s > 0);
      if (q) local.sort((a, b) => b.s - a.s);
      // A row the reader moved to stays highlighted when late results reorder
      // the list; otherwise the highlight is the top row, so a ticker that
      // arrives late and takes the top is what Enter opens.
      const keyOf = (x) => x && (x.href || x.label);
      const was = moved ? keyOf(items[sel]) : null;
      items = order(q, local, symItems);
      const again = was ? items.findIndex((x) => keyOf(x) === was) : -1;
      if (again >= 0) sel = again; else if (!moved) sel = 0;
      sel = Math.min(sel, Math.max(0, items.length - 1));
      let group = null;
      list.innerHTML = items.map((x, i) => {
        const head = x.group !== group ? '<div class="palette-group">' + qe.esc(x.group) + "</div>" : "";
        group = x.group;
        return head + '<div class="palette-item' + (i === sel ? " sel" : "") + '" role="option" data-i="' + i + '">' +
          (x.sym ? '<span class="mono strong">' + qe.esc(x.sym) + "</span>" : "") +
          '<span class="p-label">' + qe.esc(x.label) + "</span>" +
          (x.hint ? '<span class="p-hint">' + qe.esc(x.hint) + "</span>" : "") + "</div>";
      }).join("") || '<div class="palette-empty">Nothing matches.</div>';
      const cur = list.querySelector(".sel");
      if (cur) cur.scrollIntoView({ block: "nearest" });
    };

    const searchSymbols = () => {
      clearTimeout(symTimer);
      const q = input.value.trim();
      const my = ++seq;
      if (!q || q.length > 12) { symItems = []; pending = null; render(); return; }
      let settle;
      pending = new Promise((r) => { settle = r; });
      symTimer = setTimeout(async () => {
        try {
          const res = await qe.fetch("/api/search?q=" + encodeURIComponent(q));
          if (my !== seq) return;
          symItems = res.matches.slice(0, 6).map((m) => ({
            sym: m.symbol, label: m.name || "", group: "Symbols", delisted: m.status === "Delisted",
            hint: m.status === "Delisted" ? "delisted" : "", href: qe.symbolHref(m.symbol),
          }));
        } catch (e) {
          if (my !== seq) return;
          symItems = [];
        } finally { settle(); }
        render();
      }, 110);
    };

    // Enter opens the top row of the finished list: a query whose symbol search
    // has not answered yet waits for it, briefly, so what "ma" + Enter opens does
    // not depend on how fast the search answers. A row the reader picked opens
    // at once.
    const enter = async () => {
      if (entering) return;
      const q = input.value;
      if (pending && !moved) {
        entering = true;
        try { await Promise.race([pending, new Promise((r) => setTimeout(r, 900))]); } finally { entering = false; }
        if (!palOpen || input.value !== q) return;
      }
      go(items[sel]);
    };

    const go = (x) => {
      if (!x) return;
      close();
      if (x.run) { x.run(); return; }
      if (x.href.startsWith("#")) {
        const t = document.querySelector(x.href);
        if (t) t.scrollIntoView({ behavior: reduced ? "auto" : "smooth" });
        history.replaceState(null, "", x.href);
      } else location.href = x.href;
    };

    input.addEventListener("input", () => { sel = 0; moved = false; render(); searchSymbols(); });
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
        ev.preventDefault();
        sel = (sel + (ev.key === "ArrowDown" ? 1 : -1) + items.length) % Math.max(1, items.length);
        moved = true;
        render();
      } else if (ev.key === "Enter") { ev.preventDefault(); enter(); }
      else if (ev.key === "Escape") { ev.preventDefault(); close(); }
    });
    list.addEventListener("click", (ev) => {
      const it = ev.target.closest(".palette-item");
      if (it) go(items[+it.dataset.i]);
    });
    list.addEventListener("mousemove", (ev) => {
      const it = ev.target.closest(".palette-item");
      if (it && +it.dataset.i !== sel) { sel = +it.dataset.i; moved = true; render(); }
    });
    wrap.querySelector(".palette-scrim").addEventListener("click", close);
    return { wrap, input, render, reset: () => { input.value = ""; symItems = []; sel = 0; moved = false; pending = null; seq++; } };
  }

  function open() {
    if (!pal) pal = buildPalette();
    closeHelp();
    closeNavs();
    pal.reset();
    palOpen = true;
    pal.wrap.hidden = false;
    requestAnimationFrame(() => pal.wrap.classList.add("open"));
    pal.render();
    pal.input.focus();
  }
  function close() {
    if (!pal || pal.wrap.hidden) return;
    palOpen = false;
    pal.wrap.classList.remove("open");
    setTimeout(() => { pal.wrap.hidden = true; }, reduced ? 0 : 140);
  }

  /* ---- shortcuts help ----------------------------------------------------- */
  let help = null;
  function showHelp() {
    if (!help) {
      help = document.createElement("div");
      help.className = "palette help-sheet";
      help.innerHTML = '<div class="palette-scrim"></div><div class="palette-box" role="dialog" aria-label="Keyboard shortcuts">' +
        '<h3>Keyboard</h3><dl class="keys">' +
        [["⌘K / Ctrl K", "command palette"], ["/", "find a stock"], ["esc", "leave a text field, or close"],
         ...PAGES.filter((p) => /^g [a-z]$/.test(p.hint)).map((p) => [p.hint, p.label]),
         ["t", "cycle the theme"], ["?", "this sheet"]]
          .map(([k, v]) => "<div><dt><kbd>" + qe.esc(k) + "</kbd></dt><dd>" + qe.esc(v) + "</dd></div>").join("") +
        "</dl></div>";
      document.body.appendChild(help);
      help.querySelector(".palette-scrim").addEventListener("click", closeHelp);
    }
    help.hidden = false;
    requestAnimationFrame(() => help.classList.add("open"));
  }
  function closeHelp() {
    if (!help || help.hidden) return;
    help.classList.remove("open");
    help.hidden = true;
  }

  /* ---- keys ----------------------------------------------------------------- */
  let gAt = 0;
  function keys() {
    document.addEventListener("keydown", (ev) => {
      if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "k") {
        ev.preventDefault();
        if (pal && !pal.wrap.hidden) close(); else open();
        return;
      }
      const tag = document.activeElement && document.activeElement.tagName;
      // Esc leaves a text field, so the single-key shortcuts work even on a
      // page whose search box took focus on load
      if (ev.key === "Escape" && (tag === "INPUT" || tag === "TEXTAREA") &&
          !(pal && !pal.wrap.hidden)) { document.activeElement.blur(); return; }
      // "?" from an empty search box is a request for help, not a query
      if (ev.key === "?" && tag === "INPUT" && !document.activeElement.value &&
          !(pal && !pal.wrap.hidden)) { ev.preventDefault(); document.activeElement.blur(); showHelp(); return; }
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || ev.metaKey || ev.ctrlKey || ev.altKey) return;
      if (ev.key === "Escape") { close(); closeHelp(); closeNavs(); return; }
      if (ev.key === "?") { ev.preventDefault(); showHelp(); return; }
      if (ev.key === "t") { const b = document.getElementById("theme-toggle"); if (b) b.click(); return; }
      if (ev.key === "g") { gAt = Date.now(); return; }
      if (gAt && Date.now() - gAt < 900 && GO[ev.key]) { gAt = 0; location.href = GO[ev.key]; }
    });
    const btn = document.getElementById("palette-open");
    if (btn) {
      if (!/Mac|iPhone|iPad/.test(navigator.platform || "")) btn.querySelector("kbd").textContent = "Ctrl K";
      btn.addEventListener("click", open);
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    initNav();
    keys();
    spotlight();
    watch(document);
    watchMutations();
  });

  window.qe = Object.assign(window.qe || {}, { countUp, palette: open });
})();
