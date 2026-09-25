/* Data health: lamps on the status tiles, the check board, how far each table
 * reaches, the fetch-outcome bar that finds its row, the options ring, the
 * run timeline and its stage filter, and a schedule strip that says how old
 * this page is.
 *
 * Nothing here fetches. The page is server-rendered once per load and never
 * re-reads the database by itself — a held read connection when the nightly
 * writer opens costs a live-evidence day — so every clock below is the
 * browser's, and "reload" is always the reader's decision.
 *
 * "On schedule" is judged by the browser's own clock, in weekdays: tonight's
 * bar is due once the first run has had until its cap to finish. Exchange
 * holidays are not known here, and the page says so where it judges. */
"use strict";

(function () {
  const sched = document.getElementById("hl-sched");
  if (!sched) return;
  const reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const pad = (n) => String(n).padStart(2, "0");
  const hm = (s) => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };
  const hhmm = (m) => pad(Math.floor((m % 1440) / 60)) + ":" + pad(m % 60);
  const fires = (sched.dataset.fire || "").split(",").filter(Boolean).map(hm);
  const dones = (sched.dataset.done || "").split(",").filter(Boolean).map(hm);
  const quiet = (sched.dataset.quiet || "").split(",").filter(Boolean)
    .map((w) => w.split("-").map(hm));

  /* ---- weekday arithmetic on ISO dates (UTC noon, so no DST edge) ---------- */
  const parse = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d, 12)); };
  const iso = (d) => d.toISOString().slice(0, 10);
  const isWd = (d) => { const w = d.getUTCDay(); return w !== 0 && w !== 6; };
  const step = (d, k) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + k); return x; };
  // weekdays after a up to and including b; negative when b is before a
  function wdBetween(a, b) {
    if (+a === +b) return 0;
    const dir = a < b ? 1 : -1;
    let n = 0, d = new Date(a), guard = 0;
    while ((dir > 0 ? d < b : d > b) && guard++ < 20000) {
      if (isWd(dir > 0 ? step(d, 1) : d)) n += dir;
      d = step(d, dir);
    }
    return n;
  }
  const plural = (n, w) => n + " " + w + (n === 1 ? "" : "s");
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  // Per-second writes go to one text node's nodeValue: fx.js watches <main> for
  // childList mutations, and textContent/innerHTML would re-run its document-wide
  // scan every second for the life of the tab.
  function setText(el, s) {
    if (!el) return;
    const t = el.firstChild;
    if (t && t.nodeType === 3 && !t.nextSibling) { if (t.nodeValue !== s) t.nodeValue = s; }
    else el.textContent = s;
  }
  // after a resize settles, once per frame
  function onResize(fn) {
    let queued = false;
    window.addEventListener("resize", () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; fn(); });
    });
  }

  // The newest date whose nightly run should have finished by now.
  function dueDate(now) {
    const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), 12));
    const mins = now.getHours() * 60 + now.getMinutes();
    if (isWd(d) && dones.length && mins >= dones[0]) return d;
    let x = step(d, -1);
    while (!isWd(x)) x = step(x, -1);
    return x;
  }

  /* ---- the check board ----------------------------------------------------- */
  const checks = Array.from(document.querySelectorAll(".hl-check[data-check]"));
  const STATE_WORDS = { ok: " \u2014 reads as expected", warn: " \u2014 needs a look", idle: " \u2014 nothing to judge" };
  checks.forEach((c, i) => {
    c.parentElement.style.setProperty("--i", i);
    if (c.dataset.say) c.title = c.dataset.say;      // the server-judged chips
  });
  function setCheck(name, state, say) {
    const c = checks.find((x) => x.dataset.check === name);
    if (!c) return;
    c.dataset.state = state;
    if (say) c.dataset.say = say;
    c.title = say || "";
    // pass or fail in words, not only in the lamp's colour and ping
    const sr = c.querySelector("[data-state-text]");
    if (sr) sr.textContent = STATE_WORDS[state] || "";
  }
  function summarise() {
    const line = document.getElementById("hl-board-line");
    const judged = checks.filter((c) => c.dataset.state === "ok" || c.dataset.state === "warn");
    if (!line || !judged.length) return;
    const bad = judged.filter((c) => c.dataset.state === "warn");
    const tail = " These are the checks this page can make from what it reads &mdash; a missing symptom here is not proof the run was sound.";
    const list = bad.map((c) => '<a href="' + qe.esc(c.getAttribute("href")) + '">' +
      qe.esc(c.dataset.say || c.textContent.trim()) + "</a>").join("; ");
    if (document.getElementById("hl-board").dataset.degraded) {
      // one filesystem check is not a verdict on last night's run; say so
      // the list opens a sentence here, so its first word is capitalised
      const first = bad.length ? '<a href="' + qe.esc(bad[0].getAttribute("href")) + '">' +
        qe.esc(cap(bad[0].dataset.say || bad[0].textContent.trim())) + "</a>" : "";
      const rest = bad.slice(1).map((c) => '<a href="' + qe.esc(c.getAttribute("href")) + '">' +
        qe.esc(c.dataset.say || c.textContent.trim()) + "</a>");
      line.innerHTML = "<strong>Degraded: only the database file could be checked.</strong> " +
        (bad.length ? [first].concat(rest).join("; ") + ". " : "") + "Nothing on this page says whether last night's run did its job until the database can be read.";
      return;
    }
    const lead = bad.length
      ? "<strong>" + bad.length + " of " + plural(judged.length, "check") + " need a look:</strong> " + list + "."
      : "<strong>All " + plural(judged.length, "check") + " read as expected.</strong>";
    line.innerHTML = lead + tail;
  }

  /* ---- status tiles judged against the schedule ----------------------------- */
  function judgeSchedule(now) {
    const due = dueDate(now);
    const mins = now.getHours() * 60 + now.getMinutes();
    const retryOpen = fires.length > 1 && dones.length > 1 && isWd(new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), 12)))
      && mins >= dones[0] && mins < dones[1];
    document.querySelectorAll(".hl-tile[data-sched]").forEach((tile) => {
      const name = tile.dataset.sched, lagEl = tile.querySelector("[data-lag]");
      const what = name === "prices" ? "prices" : "the latest scored day";
      if (!tile.dataset.date) {
        tile.dataset.state = "idle";
        setCheck(name, "idle", "no " + what + " to judge");
        return;
      }
      const lag = wdBetween(parse(tile.dataset.date), due);
      if (lag <= 0) {
        tile.dataset.state = "ok";
        lagEl.textContent = "on schedule — the " + iso(due) + " run is in";
        setCheck(name, "ok", what + " on schedule");
      } else {
        tile.dataset.state = "warn";
        lagEl.textContent = plural(lag, "weekday") + " behind schedule — " + iso(due) + " was due" +
          (retryOpen ? "; the " + hhmm(fires[1]) + " retry can still land it" : "");
        setCheck(name, "warn", what + " " + plural(lag, "weekday") + " behind the schedule");
      }
    });
  }

  /* ---- freshness: how far each table reaches ---------------------------------- */
  function drawFreshness(now) {
    const list = document.getElementById("hl-fresh");
    if (!list || !list.dataset.anchor) { setCheck("keepup", "idle", "no prices to measure against"); return; }
    const anchor = parse(list.dataset.anchor);
    const due = dueDate(now);
    const rows = Array.from(list.querySelectorAll(".hl-fresh-row"));
    const dated = rows.filter((r) => r.dataset.date).map((r) => parse(r.dataset.date));
    // six weekdays ending at whichever is newest: the schedule, prices, or a table
    let end = [due, anchor, ...dated].reduce((a, b) => (b > a ? b : a));
    while (!isWd(end)) end = step(end, -1);
    const cols = [end];
    while (cols.length < 6) { let x = step(cols[0], -1); while (!isWd(x)) x = step(x, -1); cols.unshift(x); }
    const n = cols.length, start = cols[0];
    const xOf = (d) => {                 // right edge of that weekday's column, %
      if (d < start) return 0;
      const k = wdBetween(start, d) + (isWd(start) ? 1 : 0);
      return Math.max(0, Math.min(100, (100 * k) / n));
    };
    const xPrices = xOf(anchor), xDue = xOf(due);

    const scale = document.createElement("li");
    scale.className = "hl-fresh-scale";
    scale.setAttribute("aria-hidden", "true");
    scale.innerHTML = '<span></span><span></span><span class="hl-scale"></span>' +
      '<span class="hl-scale-key"><span><i class="k-prices"></i>prices</span><span><i class="k-due"></i>due by schedule</span></span>';
    list.insertBefore(scale, list.firstChild);
    const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const scaleEl = scale.querySelector(".hl-scale");
    let lastEvery = 0;
    // A label is about 40 px wide ("09-21"), so every column end is labelled
    // where a column has room for one, every other or every third where not.
    // Measured again on resize: the bar narrows to its 6rem minimum at 981 px.
    function labelScale() {
      const barW = (rows[0] && rows[0].querySelector(".hl-f-bar").getBoundingClientRect().width) || 0;
      const colW = barW / n;
      const every = colW >= 46 ? 1 : colW >= 23 ? 2 : 3;
      if (every === lastEvery) return;
      lastEvery = every;
      scaleEl.innerHTML = cols.map((d, i) =>
        (n - 1 - i) % every ? "" : '<span style="left:' + (100 * (i + 1)) / n + '%"><b>' + DOW[d.getUTCDay()] +
        "</b>" + iso(d).slice(5) + "</span>").join("");
    }
    labelScale();
    onResize(labelScale);

    let behind = [];
    rows.forEach((row, i) => {
      const bar = row.querySelector(".hl-f-bar"), lagEl = row.querySelector("[data-lag]");
      row.style.setProperty("--i", i);
      if (!row.dataset.date) { row.dataset.state = "idle"; lagEl.textContent = "no rows"; return; }
      const d = parse(row.dataset.date), allow = +row.dataset.allow || 0;
      const isPrices = row.dataset.key === "prices";
      const lag = isPrices ? wdBetween(d, due) : wdBetween(d, anchor);
      const x = xOf(d);
      const allowPart = !isPrices && allow > 0
        ? '<span class="allow" style="--a0:' + Math.max(0, xPrices - (100 * allow) / n) + "%;--aw:" + Math.min(xPrices, (100 * allow) / n) + '%"></span>' : "";
      bar.innerHTML = allowPart + '<span class="fill" style="--w:' + x + '%"></span>' +
        '<i class="mk mk-due" style="--x:' + xDue + '%"></i><i class="mk mk-prices" style="--x:' + xPrices + '%"></i>';
      const over = lag > (isPrices ? 0 : allow);
      row.dataset.state = over ? "warn" : "ok";
      if (isPrices) {
        lagEl.textContent = lag <= 0 ? "the anchor · on schedule" : "the anchor · " + plural(lag, "weekday") + " behind the schedule";
      } else if (lag <= 0) {
        lagEl.textContent = lag < 0 ? "ahead of prices" : "level with prices";
      } else {
        lagEl.textContent = plural(lag, "weekday") + " behind prices" + (lag <= allow ? " — allowed" : "");
        if (over) behind.push(row.querySelector(".hl-f-name").textContent.trim().toLowerCase());
      }
      if (d < start) lagEl.textContent += " (older than the scale)";
    });
    // each universe's newest membership date, in the same weekday units
    document.querySelectorAll(".hl-urow[data-date]").forEach((tr) => {
      const el = tr.querySelector("[data-lag]");
      if (!tr.dataset.date || !el) return;
      const lag = wdBetween(parse(tr.dataset.date), anchor);
      el.textContent = lag <= 0 ? "level with prices" : plural(lag, "weekday") + " behind prices";
    });
    setCheck("keepup", behind.length ? "warn" : "ok",
      behind.length ? behind.join(", ") + " trail prices by more than allowed" : "every table keeps up with prices");
    arm(list);
  }

  /* ---- fetch outcomes: a row and its segment find each other ------------------- */
  function linkOutcomes() {
    const stack = document.getElementById("hl-stack"), table = document.getElementById("hl-outcomes");
    if (!stack || !table) return;
    const segs = Array.from(stack.querySelectorAll(".hl-seg"));
    const rows = Array.from(table.querySelectorAll("tr[data-outcome]"));
    const hot = (key) => {
      stack.classList.toggle("hot", key != null);
      segs.forEach((s) => s.classList.toggle("hot", s.dataset.outcome === key));
      rows.forEach((r) => r.classList.toggle("hot", r.dataset.outcome === key));
    };
    [...segs, ...rows].forEach((el) => {
      el.addEventListener("pointerenter", () => hot(el.dataset.outcome));
      el.addEventListener("pointerleave", () => hot(null));
    });
    // the keyboard's way in: a row takes focus and lights its segment
    rows.forEach((r) => {
      r.tabIndex = 0;
      r.addEventListener("focus", () => hot(r.dataset.outcome));
      r.addEventListener("blur", () => hot(null));
    });
  }

  /* ---- things that fill once when they are first seen ---------------------------- */
  function arm(el) {
    if (reduced || !("IntersectionObserver" in window)) { el.classList.add("armed"); return; }
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) { el.classList.add("armed"); io.disconnect(); } });
    }, { threshold: 0.2 });
    io.observe(el);
  }

  /* ---- recent runs: stage filter ---------------------------------------------------- */
  function runFilter() {
    const list = document.getElementById("hl-runs"), seg = document.getElementById("hl-run-filter");
    if (!list || !seg) return;
    const runs = Array.from(list.querySelectorAll(".hl-run"));
    runs.forEach((r, i) => r.style.setProperty("--i", i));
    arm(list);
    // The list is focusable so the keyboard can scroll it; where it does not
    // scroll (below 981 px, or filtered short) that is a dead tab stop. The
    // server renders tabindex so the list stays reachable without script.
    const tabStop = () => {
      if (list.scrollHeight > list.clientHeight + 1) list.setAttribute("tabindex", "0");
      else if (document.activeElement !== list) list.removeAttribute("tabindex");
    };
    tabStop();
    onResize(tabStop);
    const stages = [...new Set(runs.map((r) => r.dataset.stage))].sort();
    if (stages.length < 2) return;
    const counts = Object.fromEntries(stages.map((s) => [s, runs.filter((r) => r.dataset.stage === s).length]));
    seg.innerHTML = ['<button type="button" class="on" data-stage="" aria-pressed="true">all ' + runs.length + "</button>"]
      .concat(stages.map((s) => '<button type="button" data-stage="' + qe.esc(s) + '" aria-pressed="false">' +
        qe.esc(s) + " " + counts[s] + "</button>")).join("");
    seg.hidden = false;
    seg.addEventListener("click", (ev) => {
      const b = ev.target.closest("button");
      if (!b) return;
      const want = b.dataset.stage;
      seg.querySelectorAll("button").forEach((x) => {
        x.classList.toggle("on", x === b);
        x.setAttribute("aria-pressed", String(x === b));
      });
      const days = new Set();
      runs.forEach((r) => {
        const show = !want || r.dataset.stage === want;
        r.hidden = !show;
        if (show) days.add(r.dataset.day);
      });
      list.querySelectorAll(".hl-run-day").forEach((d) => { d.hidden = !days.has(d.dataset.day); });
      tabStop();
      if (!reduced) { list.classList.remove("armed"); void list.offsetWidth; list.classList.add("armed"); }
    });
  }

  /* ---- the schedule strip and the age of this page ------------------------------ */
  // A static snapshot (window.QE_SNAPSHOT, set by the portfolio export) was
  // read when it was exported, not when a visitor opened it: its age, the
  // schedule verdicts and the countdown are all taken at that moment.
  const SNAP = qe.snapshot && qe.snapshot.exported_at ? new Date(qe.snapshot.exported_at) : null;
  const loadedAt = SNAP || new Date(Math.round(performance.timeOrigin || Date.now()));
  function clock() {
    const count = document.getElementById("hl-sched-count");
    const label = document.getElementById("hl-sched-label");
    const sub = document.getElementById("hl-sched-sub");
    const track = document.getElementById("hl-track");
    const nowDot = document.getElementById("hl-now");
    const age = document.getElementById("hl-age");
    const ageRow = document.getElementById("hl-age-row");
    if (fires.length) {
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
      track.hidden = false;
      count.hidden = false;
    }
    if (SNAP) {
      count.hidden = false;
      count.textContent = SNAP.getFullYear() + "-" + pad(SNAP.getMonth() + 1) + "-" + pad(SNAP.getDate()) +
        " " + pad(SNAP.getHours()) + ":" + pad(SNAP.getMinutes());
      label.textContent = "Snapshot exported";
      age.textContent = "A static copy read once, at export. Nothing on it is live and nothing refreshes; " +
        "the checks below are judged as of that moment.";
      const reloadEl = document.getElementById("hl-reload");
      if (reloadEl) reloadEl.remove();   // .replay-btn's display would beat [hidden]
      if (nowDot) nowDot.hidden = true;
      return;
    }
    const staticSub = sub.textContent;
    const ago =(s) => s < 60 ? s + " s" : s < 3600 ? Math.floor(s / 60) + " min" :
      Math.floor(s / 3600) + " h " + Math.floor((s % 3600) / 60) + " min";
    const stamp = (d) => pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
    // the newest scheduled fire that has passed since the page was read, if any
    function firedSince(now) {
      let best = null;
      for (let day = new Date(loadedAt.getFullYear(), loadedAt.getMonth(), loadedAt.getDate());
           day <= now; day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)) {
        fires.forEach((f, k) => {
          const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(f / 60), f % 60);
          if (at > loadedAt && at <= now && (!best || at > best.at)) best = { at, k };
        });
      }
      return best;
    }
    // the first minute-of-day m at or after a moment
    const atOrAfter = (from, m) => {
      const x = new Date(from.getFullYear(), from.getMonth(), from.getDate(), Math.floor(m / 60), m % 60);
      if (x < from) x.setDate(x.getDate() + 1);
      return x;
    };
    // What a fire since the read means for a reload. Inside its quiet window the
    // server refuses the database, so a reload returns the degraded page; after
    // it the run may still be writing until its cap.
    function staleWords(fired, now) {
      const f = fires[fired.k], lbl = hhmm(f);
      const q = quiet.find(([a, b]) => (a <= b ? f >= a && f < b : f >= a || f < b));
      const until = dones[fired.k] !== undefined ? atOrAfter(fired.at, dones[fired.k]) : null;
      if (q && now < atOrAfter(fired.at, q[1])) {
        return "The " + lbl + " run has fired since \u2014 reload after " + hhmm(q[1]) +
          (until ? " (it has until " + hhmm(dones[fired.k]) + ")." : ".");
      }
      if (until && now < until) {
        return "The " + lbl + " run has fired since and has until " + hhmm(dones[fired.k]) +
          " \u2014 reload to see what it wrote so far.";
      }
      return "The " + lbl + " run has fired since \u2014 reload to see what it wrote.";
    }
    // built once; each second only two text nodes change (see setText)
    age.innerHTML = 'Read at <span class="mono">' + stamp(loadedAt) + '</span> &middot; <span class="mono" data-ago>0 s</span> ago. ' +
      "<span data-tail>Nothing here refreshes by itself.</span>";
    const agoEl = age.querySelector("[data-ago]"), tailEl = age.querySelector("[data-tail]");
    let lastFired = null, lastCheck = 0;
    const tick = () => {
      const d = new Date();
      const mins = d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
      if (fires.length) {
        nowDot.style.left = (mins / 14.4) + "%";
        const inQuiet = quiet.find(([a, b]) => (a <= b ? mins >= a && mins < b : mins >= a || mins < b));
        let target, what;
        if (inQuiet) {
          target = inQuiet[1];
          what = "Quiet window — connections resume in";
        } else {
          target = fires.find((f) => f > mins);
          what = target === undefined || target === fires[0] ? "Next nightly run in" : "Next retry in";
          if (target === undefined) target = fires[0] + 1440;
        }
        const secs = Math.max(0, Math.round(((target - mins + 1440) % 1440) * 60));
        setText(count, pad(Math.floor(secs / 3600)) + ":" + pad(Math.floor((secs % 3600) / 60)) + ":" + pad(secs % 60));
        setText(label, what);
        sched.classList.toggle("quiet", !!inQuiet);
        setText(sub, inQuiet
          ? "The writer's turn: this page steps off the database until " + hhmm(inQuiet[1]) + ". Reload after that to read it again."
          : staticSub);
      }
      const s = Math.max(0, Math.round((d - loadedAt) / 1000));
      if (d - lastCheck > 15000) { lastCheck = d; lastFired = firedSince(d); }
      setText(agoEl, ago(s));
      setText(tailEl, lastFired ? staleWords(lastFired, d) : "Nothing here refreshes by itself.");
      ageRow.classList.toggle("stale", !!lastFired);
    };
    tick();
    setInterval(tick, 1000);

    const reload = document.getElementById("hl-reload");
    reload.addEventListener("click", (ev) => {
      ev.preventDefault();
      if (!reduced) reload.classList.add("spin");
      location.reload();   // keeps ?theme= and the scroll position
    });
  }

  /* ---- wire up ----------------------------------------------------------------------- */
  const now = SNAP || new Date();
  judgeSchedule(now);
  drawFreshness(now);
  summarise();
  linkOutcomes();
  runFilter();
  const opts = document.querySelector(".hl-options");
  if (opts) arm(opts);
  clock();
})();
