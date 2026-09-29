/* Return explorer: a question builder over the stock-days, and the distribution
 * of the return that followed, drawn as the screener's histogram card.
 *
 * Built for someone who has never seen this project. Every condition is a
 * sentence with blanks and plain presets; every card says what it keeps and
 * why it is not applied yet when it is not; the question is restated in one
 * sentence as it is built; a timeline draws which days the return covers.
 *
 * The query string is the page's whole state. Every change rewrites it
 * (replaceState, so the back button is not flooded) and runs /api/returns;
 * a shared or reloaded link rebuilds the same question. The condition grammar
 * mirrors qe.web.explorer, which validates everything again — the page never
 * computes a statistic itself, except the look counter, which is this tab's
 * own and says how large a result chance alone would produce. */
"use strict";

(function () {
  const form = document.getElementById("x-form");
  if (!form) return;
  const $ = (id) => document.getElementById(id);
  const OPT = JSON.parse($("x-options").textContent);
  const esc = qe.esc;
  const reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---- vocabulary -------------------------------------------------------------- */
  const KINDS = { rank: "Model ranking", earn: "Earnings", ind: "Price or volume pattern", sector: "Sector",
                  liq: "Trading volume", sym: "Specific stocks", dow: "Day of the week", month: "Month" };
  const IND = Object.fromEntries(OPT.indicators.map((i) => [i.id, i]));
  const SOURCES = Object.keys(OPT.sources);
  const RANK_MODES = [["top", "in its top"], ["bottom", "in its bottom"], ["between", "between ranks"],
                      ["top_pct", "in its top percent"], ["bottom_pct", "in its bottom percent"],
                      ["book", "among the stocks it actually held"]];
  const EARN_MODES = [["day", "reported earnings"], ["window", "had its earnings reaction inside the measured return"],
                      ["none", "had no earnings report within"]];
  const EARN_DAYS = [["0:0", "on day 0 itself"], ["1:1", "on the next trading day"], ["1:5", "within the next 5 trading days"],
                     ["1:20", "within the next 20 trading days"], ["-1:-1", "on the trading day before"],
                     ["-5:-1", "within the 5 trading days before"], ["custom", "between two days I choose…"]];
  const TIMINGS = [["any", "at any time of day"], ["pre", "before the market opened"], ["post", "after the market closed"]];
  const SURPRISES = [["any", "whatever the result"], ["beat", "and beat the estimate"], ["miss", "and missed the estimate"]];
  const IND_BANDS = [["p:90:100", "in the top 10% of stocks that day"], ["p:80:100", "in the top 20% of stocks that day"],
                     ["p:50:100", "in the top half of stocks that day"], ["p:0:50", "in the bottom half of stocks that day"],
                     ["p:0:20", "in the bottom 20% of stocks that day"], ["p:0:10", "in the bottom 10% of stocks that day"],
                     ["pc", "between two percentiles…"], ["va", "above a value…"], ["vb", "below a value…"],
                     ["vr", "between two values…"]];
  const LIQ_MODES = [["most", "among the most traded"], ["least", "among the least traded"], ["range", "ranked by trading volume between"]];
  const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August",
                  "September", "October", "November", "December"];
  const SIZE = OPT.universe_size || 500;
  const DEF_FROM = OPT.span.bt_first || OPT.span.first;
  const DEF_TO = OPT.span.last;
  const DEFAULT_QUERY = "c=rank:backtest:top:50&hold=1&lag=1";
  // the return, as it reads inside a sentence
  const RET_PHRASE = { sector_excess: "return against its sector", raw: "raw return", beta_residual: "return against the market" };
  const windowWords = () => "from the close of day " + state.lag + " to the close of day " + (state.lag + state.hold);

  const titleCase = (s) => String(s).toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase());
  const int = (v) => (v == null ? "—" : Number(v).toLocaleString("en-US"));
  const sign = (v) => (v > 0 ? "+" : v < 0 ? "−" : "");
  const pct = (v, d) => (v == null ? "—" : sign(v) + Math.abs(v).toFixed(d == null ? 2 : d) + "%");
  const bps = (v, d) => (v == null ? "—" : sign(v) + Math.abs(v).toFixed(d == null ? 1 : d) + " bps");
  const share = (v) => (v == null ? "—" : v > 0 && v < 0.001 ? "<0.1%" : (v * 100).toFixed(1) + "%");
  const fmtDate = (iso) => {
    if (!iso) return "—";
    const [y, m, d] = iso.split("-").map(Number);
    return MONTHS[m - 1].slice(0, 3) + " " + d + ", " + y;
  };
  const clean = (v) => Number(Number(v).toPrecision(12));  // 0.1 * 100 is not 10
  const list = (xs, last) => (xs.length < 2 ? xs.join("") : xs.slice(0, -1).join(", ") + " " + (last || "and") + " " + xs[xs.length - 1]);
  const isNum = (s) => s !== "" && s != null && Number.isFinite(Number(s));
  const isInt = (s) => isNum(s) && Number.isInteger(Number(s));
  const indVal = (ind, v) => {
    if (v == null) return "—";
    return (IND[ind] || {}).fmt === "pct" ? pct(v * 100, Math.abs(v) < 0.1 ? 2 : 1) : Number(v).toFixed(Math.abs(v) >= 10 ? 1 : 2);
  };

  /* ---- a condition --------------------------------------------------------------
   * Held as the fields its sentence shows, as typed. `token` turns it into the
   * server's grammar (null while it is unfinished); `parse` reads one back. */
  function fresh(kind) {
    const base = { kind, neg: false };
    switch (kind) {
      case "rank": return { ...base, source: SOURCES[0] || "backtest", mode: "top", a: "50", b: "100" };
      case "earn": return { ...base, mode: "day", days: "1:1", a: "1", b: "1", timing: "any", surprise: "any", k: "5" };
      case "ind": return { ...base, id: IND.rvol20_v1 ? "rvol20_v1" : (OPT.indicators[0] || {}).id, band: "p:90:100", lo: "", hi: "" };
      case "liq": return { ...base, mode: "most", n: "100", lo: "1", hi: "100" };
      case "dow": return { ...base, items: [] };
      case "month": return { ...base, items: [] };
      case "sym": return { ...base, items: [], draft: "" };
      default: return { ...base, items: [] };  // sector
    }
  }

  function check(c) {
    // {state: "ok" | "todo" | "bad", msg}: "todo" is unfinished, "bad" is wrong
    const bad = (msg) => ({ state: "bad", msg }), todo = (msg) => ({ state: "todo", msg });
    switch (c.kind) {
      case "rank":
        if (c.mode === "book") return { state: "ok" };
        if (c.mode === "between") {
          if (!isInt(c.a) || !isInt(c.b)) return todo("Type two whole-number ranks.");
          if (+c.a < 1 || +c.b > 1000) return bad("Ranks run from 1 to about " + SIZE + ".");
          if (+c.a > +c.b) return bad("The first rank has to be the smaller one.");
          return { state: "ok" };
        }
        if (c.mode === "top_pct" || c.mode === "bottom_pct") {
          if (!isNum(c.a)) return todo("Type a percentage.");
          if (+c.a < 0.1 || +c.a > 100) return bad("Pick a percentage between 0.1 and 100.");
          return { state: "ok" };
        }
        if (!isInt(c.a)) return todo("Type how many stocks, as a whole number.");
        if (+c.a < 1 || +c.a > 1000) return bad("Pick between 1 and 1,000 stocks.");
        return { state: "ok" };
      case "earn":
        if (c.mode === "none") {
          if (!isInt(c.k)) return todo("Type a number of trading days.");
          if (+c.k < 1 || +c.k > 20) return bad("Pick between 1 and 20 trading days.");
          return { state: "ok" };
        }
        if (c.mode === "day" && c.days === "custom") {
          if (!isInt(c.a) || !isInt(c.b)) return todo("Type two day numbers.");
          if (+c.a < -20 || +c.b > 20 || +c.b < -20 || +c.a > 20) return bad("Days run from −20 to 20.");
          if (+c.a > +c.b) return bad("The first day has to come before the last.");
        }
        return { state: "ok" };
      case "ind": {
        if (!c.id) return todo("Choose a measurement.");
        const b = c.band;
        if (b.startsWith("p:")) return { state: "ok" };
        if (b === "pc") {
          if (!isNum(c.lo) || !isNum(c.hi)) return todo("Type two percentiles between 0 and 100.");
          if (+c.lo < 0 || +c.hi > 100) return bad("Percentiles run from 0 to 100.");
          if (+c.lo > +c.hi) return bad("The first percentile has to be the smaller one.");
          return { state: "ok" };
        }
        if (b === "va" && !isNum(c.lo)) return todo("Type the value it should be above.");
        if (b === "vb" && !isNum(c.hi)) return todo("Type the value it should be below.");
        if (b === "vr") {
          if (!isNum(c.lo) || !isNum(c.hi)) return todo("Type both values.");
          if (+c.lo > +c.hi) return bad("The first value has to be the smaller one.");
        }
        return { state: "ok" };
      }
      case "liq":
        if (c.mode === "range") {
          if (!isInt(c.lo) || !isInt(c.hi)) return todo("Type two whole-number ranks.");
          if (+c.lo < 1 || +c.hi > SIZE) return bad("Ranks run from 1 to " + SIZE + ".");
          if (+c.lo > +c.hi) return bad("The first rank has to be the smaller one.");
          return { state: "ok" };
        }
        if (!isInt(c.n)) return todo("Type how many stocks.");
        if (+c.n < 1 || +c.n > SIZE) return bad("Pick between 1 and " + SIZE + " stocks.");
        return { state: "ok" };
      case "sym": {
        const wrong = c.items.filter((s) => !/^[A-Z0-9.\-+]{1,12}$/.test(s));
        if (wrong.length) return bad("Not a ticker: " + wrong.join(", ") + ".");
        return c.items.length ? { state: "ok" } : todo("Type a ticker and press Enter.");
      }
      case "sector": return c.items.length ? { state: "ok" } : todo("Pick at least one sector.");
      case "dow": return c.items.length ? { state: "ok" } : todo("Pick at least one day.");
      default: return c.items.length ? { state: "ok" } : todo("Pick at least one month.");
    }
  }

  function token(c) {
    if (check(c).state !== "ok") return null;
    let f;
    switch (c.kind) {
      case "rank":
        f = [c.source, c.mode];
        if (c.mode === "between") f.push(c.a, c.b);
        else if (c.mode !== "book") f.push(c.a);
        break;
      case "earn":
        if (c.mode === "none") f = ["none", c.k];
        else if (c.mode === "window") f = ["window", c.timing, c.surprise];
        else {
          const [a, b] = c.days === "custom" ? [c.a, c.b] : c.days.split(":");
          f = ["day", a, b, c.timing, c.surprise];
        }
        break;
      case "ind": {
        const scale = (v) => (v === "" || v == null ? "" : String(IND[c.id] && IND[c.id].fmt === "pct" ? clean(v / 100) : clean(v)));
        if (c.band.startsWith("p:")) f = [c.id, "pct"].concat(c.band.split(":").slice(1));
        else if (c.band === "pc") f = [c.id, "pct", String(clean(c.lo)), String(clean(c.hi))];
        else if (c.band === "va") f = [c.id, "val", scale(c.lo), ""];
        else if (c.band === "vb") f = [c.id, "val", "", scale(c.hi)];
        else f = [c.id, "val", scale(c.lo), scale(c.hi)];
        break;
      }
      case "liq":
        if (c.mode === "most") f = ["1", String(+c.n)];
        else if (c.mode === "least") f = [String(SIZE - +c.n + 1), String(SIZE)];
        else f = [String(+c.lo), String(+c.hi)];
        break;
      default: f = [c.items.join(",")];
    }
    return (c.neg ? "!" : "") + [c.kind].concat(f.map((x) => String(x).trim())).join(":");
  }

  function parse(tok) {
    const neg = tok.startsWith("!");
    const [kind, ...f] = (neg ? tok.slice(1) : tok).split(":");
    if (!KINDS[kind]) return null;
    const c = fresh(kind);
    c.neg = neg;
    if (kind === "rank") {
      c.source = OPT.sources[f[0]] ? f[0] : c.source;
      c.mode = RANK_MODES.some(([k]) => k === f[1]) ? f[1] : "top";
      if (f[2] != null) c.a = f[2];
      if (f[3] != null) c.b = f[3];
    } else if (kind === "earn") {
      c.mode = f[0] === "none" || f[0] === "window" ? f[0] : "day";
      if (c.mode === "none") c.k = f[1] || "5";
      else if (c.mode === "window") { c.timing = f[1] || "any"; c.surprise = f[2] || "any"; }
      else {
        c.a = f[1] || "1"; c.b = f[2] || "1"; c.timing = f[3] || "any"; c.surprise = f[4] || "any";
        const key = c.a + ":" + c.b;
        c.days = EARN_DAYS.some(([k]) => k === key) ? key : "custom";
      }
    } else if (kind === "ind") {
      c.id = f[0];
      const how = f[1], lo = f[2] || "", hi = f[3] || "";
      const pctFmt = IND[c.id] && IND[c.id].fmt === "pct";
      const shown = (v) => (v === "" ? "" : String(pctFmt ? clean(v * 100) : clean(v)));
      if (how === "pct") {
        const key = "p:" + (lo || "0") + ":" + (hi || "100");
        if (IND_BANDS.some(([k]) => k === key)) c.band = key;
        else { c.band = "pc"; c.lo = lo || "0"; c.hi = hi || "100"; }
      } else {
        c.band = lo !== "" && hi !== "" ? "vr" : lo !== "" ? "va" : "vb";
        c.lo = shown(lo); c.hi = shown(hi);
      }
    } else if (kind === "liq") {
      const lo = +f[0], hi = +f[1];
      if (lo === 1 && hi < SIZE) { c.mode = "most"; c.n = String(hi); }
      else if (hi === SIZE && lo > 1) { c.mode = "least"; c.n = String(SIZE - lo + 1); }
      else { c.mode = "range"; c.lo = String(lo); c.hi = String(hi); }
    } else {
      const items = (f[0] || "").split(",").filter(Boolean);
      c.items = kind === "sector" || kind === "sym" ? items.map((s) => s.toUpperCase()) : items.map(Number);
    }
    return c;
  }

  /* the condition as a clause of the question sentence */
  function phrase(c) {
    switch (c.kind) {
      case "rank": {
        const who = c.source === "shadow" ? "the shadow model" : "the model";
        const src = c.source === "backtest" ? "" : " (" + OPT.sources[c.source].label.toLowerCase() + ")";
        const m = {
          top: () => who + " ranked it in its top " + c.a, bottom: () => who + " ranked it in its bottom " + c.a,
          between: () => who + " ranked it between " + c.a + " and " + c.b,
          top_pct: () => who + " ranked it in its top " + c.a + "%", bottom_pct: () => who + " ranked it in its bottom " + c.a + "%",
          book: () => "it was among the stocks " + who + " actually held",
        }[c.mode]();
        return m + src;
      }
      case "earn": {
        const t = { any: "", pre: " before the open", post: " after the close" }[c.timing];
        const s = { any: "", beat: ", beating the estimate", miss: ", missing the estimate" }[c.surprise];
        if (c.mode === "none") return "it had no earnings report within " + c.k + " trading days either side";
        if (c.mode === "window") return "its earnings reaction" + (t ? " (to a report" + t + ")" : "") + " falls inside the measured return" + s;
        const days = c.days === "custom" ? "between day " + c.a + " and day " + c.b
          : EARN_DAYS.find(([k]) => k === c.days)[1];
        return "it reported earnings" + t + " " + days + s;
      }
      case "ind": {
        const info = IND[c.id] || { label: c.id };
        const name = "its " + info.label.charAt(0).toLowerCase() + info.label.slice(1);
        const unit = info.fmt === "pct" ? "%" : "";
        if (c.band.startsWith("p:")) return name + " was " + IND_BANDS.find(([k]) => k === c.band)[1];
        if (c.band === "pc") return name + " was between the " + c.lo + "th and " + c.hi + "th percentile of stocks that day";
        const v = (x) => String(x).replace(/^-/, "−") + unit;
        if (c.band === "va") return name + " was above " + v(c.lo);
        if (c.band === "vb") return name + " was below " + v(c.hi);
        return name + " was between " + v(c.lo) + " and " + v(c.hi);
      }
      case "liq":
        if (c.mode === "most") return "it was among the " + c.n + " most traded stocks";
        if (c.mode === "least") return "it was among the " + c.n + " least traded stocks";
        return "its trading-volume rank was between " + c.lo + " and " + c.hi;
      case "sector": return "it is in " + list(c.items.map(titleCase), "or");
      case "sym": return "it is " + list(c.items, "or");
      case "dow": return "day 0 was a " + list(c.items.map((d) => WEEKDAYS[d - 1]), "or");
      default: return "day 0 was in " + list(c.items.map((m) => MONTHS[m - 1]), "or");
    }
  }

  /* ---- state <-> the address bar ------------------------------------------------ */
  const state = { ret: "sector_excess", hold: 1, lag: 1, from: DEF_FROM, to: DEF_TO, conds: [] };

  function readQuery(search) {
    const q = new URLSearchParams(search);
    state.ret = OPT.returns[q.get("ret")] ? q.get("ret") : "sector_excess";
    state.hold = OPT.holds.includes(Number(q.get("hold"))) ? Number(q.get("hold")) : OPT.holds[0];
    const lag = parseInt(q.get("lag"), 10);
    state.lag = Number.isFinite(lag) ? Math.max(0, Math.min(OPT.max_lag, lag)) : 1;
    state.from = q.get("from") || DEF_FROM;
    state.to = q.get("to") || DEF_TO;
    state.conds = q.getAll("c").map(parse).filter(Boolean).slice(0, OPT.max_conditions);
  }

  // the cards whose token went into the query, in order: step k of the funnel
  // belongs to card applied[k]
  let applied = [];
  function query() {
    const parts = ["hold=" + state.hold, "lag=" + state.lag];
    if (state.ret !== "sector_excess") parts.push("ret=" + state.ret);
    if (state.from && state.from !== DEF_FROM) parts.push("from=" + state.from);
    if (state.to && state.to !== DEF_TO) parts.push("to=" + state.to);
    applied = [];
    state.conds.forEach((c, i) => {
      const t = token(c);
      if (!t) return;
      applied.push(i);
      // `:` and `,` are the grammar's separators and stay readable; the fields
      // a reader typed are encoded one by one
      parts.push("c=" + t.split(":").map((x) => x.split(",").map(encodeURIComponent).join(",")).join(":"));
    });
    return parts.join("&");
  }

  /* ---- step 1: the condition cards ------------------------------------------------ */
  const listEl = $("x-conds");
  const opts = (pairs, v) => pairs.map(([k, l]) =>
    '<option value="' + esc(k) + '"' + (String(k) === String(v) ? " selected" : "") + ">" + esc(l) + "</option>").join("");
  const num = (f, v, attrs) => '<input type="number" class="x-num-in" data-f="' + f + '" value="' + esc(v == null ? "" : v) + '" ' + (attrs || "") + ">";
  const sel = (f, pairs, v, label, shape) => '<select data-f="' + f + '"' + (shape ? " data-shape" : "") +
    ' aria-label="' + esc(label) + '">' + opts(pairs, v) + "</select>";
  const chipRow = (all, on, label) => '<span class="x-chips" role="group" aria-label="' + esc(label) + '">' + all.map(([v, l]) =>
    '<button type="button" class="x-chip" data-item="' + esc(v) + '" aria-pressed="' + (on.includes(v) ? "true" : "false") + '">' +
    esc(l) + "</button>").join("") + "</span>";

  function indPicker(c) {
    const groups = OPT.groups.map((g) => {
      const items = OPT.indicators.filter((i) => i.group === g);
      return items.length ? '<optgroup label="' + esc(g) + '">' + opts(items.map((i) => [i.id, i.label]), c.id) + "</optgroup>" : "";
    }).join("");
    return '<select data-f="id" data-shape aria-label="Which measurement">' + groups + "</select>";
  }

  // the sentence with its blanks
  function body(c) {
    switch (c.kind) {
      case "rank": {
        let tail = "";
        if (c.mode === "top" || c.mode === "bottom") tail = num("a", c.a, 'min="1" max="1000" aria-label="How many stocks"') + '<span>stocks</span>';
        else if (c.mode === "between") tail = num("a", c.a, 'min="1" max="1000" aria-label="First rank"') + "<span>and</span>" +
          num("b", c.b, 'min="1" max="1000" aria-label="Last rank"');
        else if (c.mode !== "book") tail = num("a", c.a, 'min="0.1" max="100" step="0.1" aria-label="Percent"') + "<span>% of stocks</span>";
        const src = SOURCES.length > 1
          ? '<span class="x-line2"><span>using</span>' + sel("source", SOURCES.map((s) => [s, OPT.sources[s].label]), c.source, "Which rankings", true) + "</span>"
          : "";
        return "<span>The model ranked it</span>" + sel("mode", RANK_MODES, c.mode, "Rank test", true) + tail + src;
      }
      case "earn": {
        let s = "<span>The company</span>" + sel("mode", EARN_MODES, c.mode, "Earnings test", true);
        if (c.mode === "none") return s + num("k", c.k, 'min="1" max="20" aria-label="Trading days either side"') +
          "<span>trading days before or after day 0</span>";
        if (c.mode === "day") {
          s += sel("days", EARN_DAYS, c.days, "When", true);
          if (c.days === "custom") s += "<span>day</span>" + num("a", c.a, 'min="-20" max="20" aria-label="First day"') +
            "<span>to day</span>" + num("b", c.b, 'min="-20" max="20" aria-label="Last day"');
        }
        return s + '<span class="x-line2">' + sel("timing", TIMINGS, c.timing, "Time of day") +
          sel("surprise", SURPRISES, c.surprise, "Result") + "</span>";
      }
      case "ind": {
        const info = IND[c.id] || {};
        const unit = info.fmt === "pct" ? "<span>%</span>" : "";
        let s = "<span>Its</span>" + indPicker(c) + "<span>was</span>" + sel("band", IND_BANDS, c.band, "Which part", true);
        if (c.band === "pc") s += num("lo", c.lo, 'min="0" max="100" step="any" aria-label="Lower percentile"') + "<span>th to</span>" +
          num("hi", c.hi, 'min="0" max="100" step="any" aria-label="Upper percentile"') + "<span>th percentile</span>";
        if (c.band === "va" || c.band === "vr") s += num("lo", c.lo, 'step="any" aria-label="Lower value"') + unit;
        if (c.band === "vr") s += "<span>and</span>";
        if (c.band === "vb" || c.band === "vr") s += num("hi", c.hi, 'step="any" aria-label="Upper value"') + unit;
        return s;
      }
      case "liq":
        if (c.mode === "range") return "<span>It was</span>" + sel("mode", LIQ_MODES, c.mode, "Trading volume test", true) +
          num("lo", c.lo, 'min="1" max="' + SIZE + '" aria-label="First rank"') + "<span>and</span>" +
          num("hi", c.hi, 'min="1" max="' + SIZE + '" aria-label="Last rank"');
        return "<span>It was</span>" + sel("mode", LIQ_MODES, c.mode, "Trading volume test", true) +
          num("n", c.n, 'min="1" max="' + SIZE + '" aria-label="How many stocks"') + "<span>stocks</span>";
      case "sector":
        return "<span>The company is in</span>" + chipRow(OPT.sectors.map((s) => [s, titleCase(s)]), c.items, "Sectors") +
          '<span class="x-line2"><button type="button" class="x-mini" data-all="1">select all</button>' +
          '<button type="button" class="x-mini" data-all="0">clear</button></span>';
      case "dow": return "<span>Day 0 fell on a</span>" + chipRow(WEEKDAYS.map((d, i) => [i + 1, d]), c.items, "Weekdays");
      case "month": return "<span>Day 0 was in</span>" + chipRow(MONTHS.map((m, i) => [i + 1, m.slice(0, 3)]), c.items, "Months");
      default:
        return "<span>The stock is</span>" + '<span class="x-tokens" data-tokens>' +
          c.items.map((s, j) => '<span class="x-token">' + esc(s) + '<button type="button" data-untoken="' + j +
            '" aria-label="Remove ' + esc(s) + '">&times;</button></span>').join("") +
          '<input type="text" data-f="draft" class="x-draft" value="' + esc(c.draft) + '" placeholder="type a ticker, then Enter"' +
          ' spellcheck="false" autocapitalize="characters" aria-label="Add a ticker"></span>';
    }
  }

  // one line under the sentence saying what the choice means
  function help(c) {
    switch (c.kind) {
      case "rank": {
        const mode = c.mode === "book"
          ? "The stocks the model held that day: roughly its top tenth, kept a little longer to cut trading."
          : "Rank 1 is the model's favourite that day; about 450 stocks are ranked each day.";
        return mode + " " + OPT.sources[c.source].help;
      }
      case "earn":
        if (c.mode === "window") return "A report before the open moves that day's price; one after the close moves the next day's. " +
          "This picks whichever day the report actually moved and checks it falls inside the return you measure (step 2).";
        if (c.mode === "none") return "Only stocks whose earnings dates are on file. Use it to look at stocks away from earnings news.";
        return "Day 0 is the stock-day itself; day 1 is the next trading day. A report before the open moves that " +
          "day's price, one after the close moves the next day's — if your measured return (step 2) starts after the move, " +
          "it misses it. \"Had its earnings reaction inside the measured return\" always lines them up." +
          (c.surprise !== "any" ? " ⚠ Whether a report beat is only known once it is out — choosing on it before then is hindsight." : "");
      case "ind": {
        const info = IND[c.id];
        if (!info) return "";
        const t = info.typical;
        const typical = t ? " On the latest day, 10% of stocks read below " + indVal(c.id, t[0]) + ", half below " +
          indVal(c.id, t[1]) + " and 90% below " + indVal(c.id, t[2]) + "." : "";
        return info.help + typical;
      }
      case "liq": return "Stocks are ranked each day by their average dollar trading volume over 20 days; 1 is the most traded of " + SIZE + ".";
      case "sector": return "The sector the stock was filed under when its returns were computed.";
      case "sym": return "Only these tickers — any day they were in the universe. Separate several with commas.";
      default: return "";
    }
  }

  function cardHtml(c, i) {
    return '<li class="xc' + (c.neg ? " neg" : "") + '" data-i="' + i + '">' +
      '<div class="xc-top"><span class="x-ico x-ico-' + c.kind + '" aria-hidden="true"></span>' +
      '<span class="xc-kind">' + esc(KINDS[c.kind]) + "</span>" +
      '<span class="seg xc-keep" role="group" aria-label="Keep or leave out the matching stock-days">' +
      '<button type="button" data-keep="1" aria-pressed="' + !c.neg + '"' + (c.neg ? "" : ' class="on"') + ">Keep these</button>" +
      '<button type="button" data-keep="0" aria-pressed="' + c.neg + '"' + (c.neg ? ' class="on"' : "") + ">Leave these out</button></span>" +
      '<button type="button" class="xc-del" aria-label="Remove the ' + esc(KINDS[c.kind]) + ' condition" title="Remove">&times;</button></div>' +
      '<div class="xc-body">' + body(c) + "</div>" +
      '<p class="xc-help"></p><p class="xc-msg" role="alert"></p>' +
      '<div class="xc-count"><span class="xc-bar" aria-hidden="true"><i></i></span><span class="xc-count-text"></span></div></li>';
  }

  // the parts of a card that follow its fields without redrawing them
  function paintCard(i) {
    const li = listEl.querySelector('li[data-i="' + i + '"]');
    if (!li) return;
    const c = state.conds[i], v = check(c);
    li.classList.toggle("neg", c.neg);
    li.classList.toggle("todo", v.state === "todo");
    li.classList.toggle("bad", v.state === "bad");
    li.querySelector(".xc-help").textContent = help(c);
    const msg = li.querySelector(".xc-msg");
    msg.textContent = v.state === "ok" ? "" : v.msg + " Not applied yet.";
    msg.hidden = v.state === "ok";
    paintCount(i);
  }

  function renderConds() {
    listEl.innerHTML = state.conds.map(cardHtml).join("");
    state.conds.forEach((_, i) => paintCard(i));
    const full = state.conds.length >= OPT.max_conditions;
    $("x-add-open").disabled = full;
    $("x-limit").hidden = !full;
    $("x-examples").hidden = state.conds.length > 0;
  }

  // Replacing a card removes whatever had focus in it, and the browser answers
  // with blur and change events that can land back here mid-replace; the
  // second redraw would find its card already gone. One redraw at a time.
  let redrawing = false;
  function redrawCard(i, focusField) {
    const li = listEl.querySelector('li[data-i="' + i + '"]');
    if (!li || redrawing) return;
    const tmp = document.createElement("div");
    tmp.innerHTML = cardHtml(state.conds[i], i);
    redrawing = true;
    try { li.replaceWith(tmp.firstChild); } finally { redrawing = false; }
    paintCard(i);
    if (focusField) {
      const el = listEl.querySelector('li[data-i="' + i + '"] [data-f="' + focusField + '"]');
      if (el) el.focus();
    }
  }

  listEl.addEventListener("click", (ev) => {
    const li = ev.target.closest("li.xc");
    if (!li) return;
    const i = Number(li.dataset.i), c = state.conds[i];
    if (ev.target.closest(".xc-del")) { removeCond(i); return; }
    const keep = ev.target.closest("button[data-keep]");
    if (keep) {
      c.neg = keep.dataset.keep === "0";
      li.querySelectorAll("button[data-keep]").forEach((b) => {
        const on = b === keep;
        b.classList.toggle("on", on);
        b.setAttribute("aria-pressed", on ? "true" : "false");
      });
      paintCard(i);
      changed(0);
      return;
    }
    const chip = ev.target.closest(".x-chip");
    if (chip) {
      const v = c.kind === "sector" ? chip.dataset.item : Number(chip.dataset.item);
      const at = c.items.indexOf(v);
      if (at >= 0) c.items.splice(at, 1); else c.items.push(v);
      if (c.kind !== "sector") c.items.sort((a, b) => a - b);
      chip.setAttribute("aria-pressed", at >= 0 ? "false" : "true");
      paintCard(i);
      changed(250);
      return;
    }
    const all = ev.target.closest("button[data-all]");
    if (all) {
      c.items = all.dataset.all === "1" ? OPT.sectors.slice() : [];
      redrawCard(i);
      changed(0);
      return;
    }
    const untoken = ev.target.closest("button[data-untoken]");
    if (untoken) {
      c.items.splice(Number(untoken.dataset.untoken), 1);
      redrawCard(i, "draft");
      changed(0);
      return;
    }
    // a click anywhere in the ticker box puts the caret in it
    const box = ev.target.closest("[data-tokens]");
    if (box) { const d = box.querySelector(".x-draft"); if (d) d.focus(); }
  });

  function onField(ev) {
    const el = ev.target.closest("[data-f]");
    const li = ev.target.closest("li.xc");
    if (!el || !li || redrawing) return;
    const i = Number(li.dataset.i), c = state.conds[i];
    if (el.dataset.f === "draft") {
      // a comma, a space or Enter turns what was typed into a ticker
      const v = el.value.toUpperCase();
      if (/[,\s]/.test(v)) {
        const parts = v.split(/[,\s]+/);
        c.draft = parts.pop();
        parts.filter(Boolean).forEach((s) => { if (!c.items.includes(s)) c.items.push(s); });
        el.value = "";  // or the box's own focusout, as it is replaced, adds it again
        redrawCard(i, "draft");
        changed(250);
      } else c.draft = el.value;
      return;
    }
    c[el.dataset.f] = el.value;
    if (c.kind === "ind" && (el.dataset.f === "band" || el.dataset.f === "id") && c.band.startsWith("v")) {
      // a value band starts from the edges of the typical stock, in the
      // measurement's own units: "above" at the top tenth, "below" at the bottom
      const t = (IND[c.id] || {}).typical, pctFmt = (IND[c.id] || {}).fmt === "pct";
      const show = (v) => String(Number(clean(pctFmt ? v * 100 : v).toPrecision(3)));
      if (t) { c.lo = show(c.band === "va" ? t[2] : t[0]); c.hi = show(c.band === "vb" ? t[0] : t[2]); }
    }
    if (c.kind === "ind" && el.dataset.f === "band" && el.value === "pc") { c.lo = "25"; c.hi = "75"; }
    if (el.dataset.shape != null) redrawCard(i, el.dataset.f);
    else paintCard(i);
    changed(ev.type === "input" ? 500 : 150);
  }
  listEl.addEventListener("change", onField);
  listEl.addEventListener("input", (ev) => { if (ev.target.tagName === "INPUT") onField(ev); });
  listEl.addEventListener("keydown", (ev) => {
    const el = ev.target;
    if (!el.classList || !el.classList.contains("x-draft")) return;
    const li = el.closest("li.xc"), i = Number(li.dataset.i), c = state.conds[i];
    if (ev.key === "Enter") {
      ev.preventDefault();
      const s = el.value.trim().toUpperCase();
      if (s && !c.items.includes(s)) c.items.push(s);
      c.draft = "";
      el.value = "";
      redrawCard(i, "draft");
      changed(0);
    } else if (ev.key === "Backspace" && !el.value && c.items.length) {
      c.items.pop();
      el.value = "";
      redrawCard(i, "draft");
      changed(250);
    }
  });
  listEl.addEventListener("focusout", (ev) => {
    // a ticker left typed in the box counts once the box is left
    const el = ev.target;
    if (!el.classList || !el.classList.contains("x-draft") || !el.value.trim()) return;
    const li = el.closest("li.xc");
    if (!li) return;
    const i = Number(li.dataset.i), c = state.conds[i];
    if (redrawing) return;
    const s = el.value.trim().toUpperCase();
    if (!c.items.includes(s)) c.items.push(s);
    c.draft = "";
    setTimeout(() => { redrawCard(i); changed(0); }, 0);
  });

  /* adding and removing */
  const picker = $("x-picker"), openBtn = $("x-add-open");
  function showPicker(open) {
    picker.hidden = !open;
    openBtn.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) { const first = picker.querySelector(".x-pick"); if (first) first.focus(); }
  }
  openBtn.addEventListener("click", () => showPicker(picker.hidden));
  picker.addEventListener("keydown", (ev) => { if (ev.key === "Escape") { showPicker(false); openBtn.focus(); } });
  picker.addEventListener("click", (ev) => {
    const b = ev.target.closest(".x-pick");
    if (!b || state.conds.length >= OPT.max_conditions) return;
    state.conds.push(fresh(b.dataset.kind));
    showPicker(false);
    renderConds();
    const li = listEl.lastElementChild;
    const first = li && li.querySelector(".xc-body [data-f], .xc-body .x-chip");
    if (first) first.focus();
    li.scrollIntoView({ block: "nearest", behavior: reduced ? "auto" : "smooth" });
    changed(0);
  });

  let toastTimer = 0, undoFn = null;
  function toast(msg, undo) {
    const t = $("x-toast");
    undoFn = undo;
    t.innerHTML = esc(msg) + (undo ? ' <button type="button" id="x-undo">Undo</button>' : "");
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; undoFn = null; }, 7000);
  }
  $("x-toast").addEventListener("click", (ev) => {
    if (!ev.target.closest("#x-undo") || !undoFn) return;
    undoFn();
    undoFn = null;
    $("x-toast").hidden = true;
  });

  function removeCond(i) {
    const [gone] = state.conds.splice(i, 1);
    renderConds();
    changed(0);
    const next = listEl.querySelector('li[data-i="' + Math.min(i, state.conds.length - 1) + '"] .xc-del');
    (next || openBtn).focus();
    toast("Removed the " + KINDS[gone.kind].toLowerCase() + " condition.", () => {
      state.conds.splice(i, 0, gone);
      renderConds();
      changed(0);
    });
  }

  $("x-reset").addEventListener("click", () => {
    const before = location.search;
    readQuery("hold=1&lag=1");
    renderAll();
    changed(0);
    toast("Started over with every stock-day.", () => { readQuery(before); renderAll(); changed(0); });
  });
  $("x-copy").addEventListener("click", async () => {
    const b = $("x-copy");
    try { await navigator.clipboard.writeText(location.href); b.textContent = "Copied!"; } catch (e) { b.textContent = "Copy failed"; }
    setTimeout(() => { b.textContent = "Copy link"; }, 1600);
  });
  $("x-examples").addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-q]");
    if (!b) return;
    readQuery(b.dataset.q);
    renderAll();
    changed(0);
  });

  /* ---- step 2: what to measure ----------------------------------------------------- */
  const lagEl = $("x-lag");
  function setLag(v) {
    state.lag = Math.max(0, Math.min(OPT.max_lag, Number.isFinite(v) ? v : 1));
    renderOutcome();
    changed(250);
  }
  lagEl.addEventListener("change", () => setLag(parseInt(lagEl.value, 10)));
  lagEl.parentNode.addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-d]");
    if (b) setLag(state.lag + Number(b.dataset.d));
  });
  $("x-hold").addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-v]");
    if (!b) return;
    state.hold = Number(b.dataset.v);
    renderOutcome();
    changed(0);
  });
  form.addEventListener("change", (ev) => {
    if (ev.target.name === "ret") { state.ret = ev.target.value; renderOutcome(); changed(0); }
  });

  function renderTimeline() {
    const L = state.lag, H = state.hold, last = L + H;
    const earn = state.conds.filter((c) => c.kind === "earn" && c.mode === "day" && !c.neg && check(c).state === "ok")
      .map((c) => (c.days === "custom" ? [+c.a, +c.b] : c.days.split(":").map(Number)));
    const shown = [];
    for (let d = 0; d <= Math.max(last, 2); d++) {
      // a long lead-in folds to its ends so the window stays on screen
      if (L > 5 && d > 1 && d < L - 1) { if (d === 2) shown.push(null); continue; }
      shown.push(d);
    }
    $("x-timeline").innerHTML = shown.map((d) => {
      if (d == null) return '<span class="x-day gap">&hellip;</span>';
      const cls = ["x-day"];
      if (d === 0) cls.push("d0");
      if (d > L && d <= last) cls.push("in");
      if (d === L) cls.push("buy");
      if (d === last) cls.push("sell");
      const e = earn.some(([a, b]) => d >= a && d <= b);
      return '<span class="' + cls.join(" ") + '"><b>' + (d === 0 ? "Day 0" : "Day " + d) + "</b>" +
        (d === L ? "<i>buy at close</i>" : d === last ? "<i>sell at close</i>" : d === 0 ? "<i>the stock-day</i>" : "<i></i>") +
        (e ? '<em title="earnings reported">E</em>' : "") + "</span>";
    }).join("");
    const during = H === 1 ? "day " + (L + 1) : "days " + (L + 1) + " to " + last;
    $("x-timeline-say").innerHTML = "Buy at the close of <strong>day " + L + "</strong>, sell at the close of <strong>day " + last +
      "</strong>: the return earned during " + during + "." + (earn.length ? " <span class=\"x-e\">E</span> marks the earnings days you chose." : "");
    const uses = state.conds.some((c) => ["rank", "ind", "liq"].includes(c.kind));
    const warn = $("x-lag-warn");
    warn.hidden = !(L === 0 && uses);
    warn.textContent = "Day 0's rankings and price patterns are computed from day 0's closing price, so nobody could have bought at that same close. Start at day 1 to measure something that could actually have been traded.";
  }

  function renderOutcome() {
    lagEl.value = state.lag;
    $("x-hold").querySelectorAll("button").forEach((b) => {
      const on = Number(b.dataset.v) === state.hold;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
    form.querySelectorAll('input[name="ret"]').forEach((r) => { r.checked = r.value === state.ret; });
    form.elements.from.value = state.from || "";
    form.elements.to.value = state.to || "";
    const shift = (iso, years) => {
      const d = new Date(iso + "T00:00:00Z");
      d.setUTCFullYear(d.getUTCFullYear() - years);
      d.setUTCDate(d.getUTCDate() + 1);
      return d.toISOString().slice(0, 10);
    };
    const ranges = { model: [DEF_FROM, DEF_TO], all: [OPT.span.first, DEF_TO],
                     "5y": [shift(DEF_TO, 5), DEF_TO], "1y": [shift(DEF_TO, 1), DEF_TO] };
    $("x-years").querySelectorAll("button").forEach((b) => {
      const [f, t] = ranges[b.dataset.y];
      const on = state.from === f && state.to === t;
      b.dataset.from = f; b.dataset.to = t;
      b.setAttribute("aria-pressed", on ? "true" : "false");
      b.classList.toggle("on", on);
    });
    $("x-years-hint").hidden = !(state.conds.some((c) => c.kind === "rank" && c.source === "backtest") && state.from < DEF_FROM);
    renderTimeline();
    renderQuestion();
  }
  $("x-years").addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-y]");
    if (!b) return;
    state.from = b.dataset.from; state.to = b.dataset.to;
    renderOutcome();
    changed(0);
  });
  ["from", "to"].forEach((name) => form.elements[name].addEventListener("change", () => {
    state[name] = form.elements[name].value || (name === "from" ? DEF_FROM : DEF_TO);
    renderOutcome();
    changed(0);
  }));

  /* ---- the question, restated ------------------------------------------------------ */
  function renderQuestion() {
    const ok = state.conds.filter((c) => check(c).state === "ok");
    const keep = ok.filter((c) => !c.neg).map(phrase), drop = ok.filter((c) => c.neg).map(phrase);
    const open = state.conds.length - ok.length;
    let s = "Take <strong>every stock on every trading day from " + fmtDate(state.from) + " to " + fmtDate(state.to) + "</strong>";
    if (keep.length) s += ", keep the stock-days where <strong>" + keep.map(esc).join("</strong>, and where <strong>") + "</strong>";
    if (drop.length) s += (keep.length ? ", then" : ",") + " leave out those where <strong>" + drop.map(esc).join("</strong> or where <strong>") + "</strong>";
    s += ". For each one, measure its <strong>" + esc(RET_PHRASE[state.ret]) + "</strong> <strong>" + windowWords() + "</strong>.";
    if (open) s += ' <span class="x-open">' + open + " condition" + (open === 1 ? " isn't" : "s aren't") + " finished and " +
      (open === 1 ? "is" : "are") + " left out for now.</span>";
    $("x-question").innerHTML = s;
  }

  function renderAll() {
    renderOutcome();
    renderConds();
    renderQuestion();
  }

  /* ---- running the question ---------------------------------------------------------- */
  // `lastQ` is the question `lastRep` answers; a card's counts are shown only
  // while the question on screen is that one, so they can never belong to
  // another card or an older question
  let timer = 0, seq = 0, last = null, lastRep = null, lastQ = null, started = 0;
  function changed(wait) {
    renderQuestion();
    renderTimeline();
    state.conds.forEach((_, i) => paintCount(i));
    clearTimeout(timer);
    timer = setTimeout(run, wait == null ? 200 : wait);
  }

  async function run() {
    const q = query();
    history.replaceState(null, "", location.pathname + "?" + q + location.hash);
    if (q === last) return;
    last = q;
    const my = ++seq;
    const dist = $("x-dist");
    dist.setAttribute("aria-busy", "true");
    document.body.classList.add("x-loading");
    started = performance.now();
    $("x-status").textContent = "Updating…";
    try {
      const rep = await qe.fetch("/api/returns?" + q);
      if (my !== seq) return;
      lastRep = rep;
      lastQ = q;
      draw(rep);
      const secs = ((performance.now() - started) / 1000).toFixed(1);
      $("x-status").textContent = rep.empty ? "Nothing matches this question."
        : "Updated · " + int(rep.slice.n_rows) + " stock-days · " + secs + " s";
    } catch (err) {
      if (my !== seq) return;
      last = null;  // a failed question runs again on the next change, even an unchanged one
      let msg = err && err.message ? err.message : "request failed";
      if (/HTTP 422/.test(msg)) {
        // the server says what is wrong; show its words
        try { msg = (await (await fetch("/api/returns?" + q)).json()).error || msg; } catch (e) { /* keep msg */ }
        if (my !== seq) return;
        failed(msg, true);
      } else {
        console.error(err);
        failed("The figures did not load (" + msg + ").", false);
      }
    } finally {
      if (my === seq) { dist.setAttribute("aria-busy", "false"); document.body.classList.remove("x-loading"); }
    }
  }

  // the figures on screen belong to the last question that ran, not to this
  // one: they go, rather than sit under an error as if they answered it
  function failed(msg, isSlice) {
    lastRep = null;
    lastQ = null;
    clearResults();
    $("x-words").textContent = "No figures: this question did not run.";
    $("x-evidence").innerHTML = "";
    $("x-status").textContent = isSlice ? "This question can't run yet — see below." : "The figures did not load.";
    $("x-flags").innerHTML = '<p class="' + (isSlice ? "caveat" : "load-failed") + '">' +
      (isSlice ? "<strong>This question can't run:</strong> " : "") + esc(msg) + "</p>";
    state.conds.forEach((_, i) => paintCount(i));
  }

  /* ---- the funnel on each card ------------------------------------------------------- */
  function paintCount(i) {
    const li = listEl.querySelector('li[data-i="' + i + '"]');
    if (!li) return;
    const text = li.querySelector(".xc-count-text"), bar = li.querySelector(".xc-bar i");
    const current = lastRep && query() === lastQ;  // query() also refreshes `applied`
    const k = applied.indexOf(i), f = current && lastRep.funnel;
    if (k < 0 || !f || !f.steps[k]) {
      text.textContent = "";
      bar.style.width = "0";
      li.classList.remove("counted");
      return;
    }
    const st = f.steps[k], total = f.n_rows || 1;
    const leftShare = (100 * st.left) / total;
    li.classList.add("counted");
    bar.style.width = Math.max(leftShare > 0 ? 0.6 : 0, leftShare).toFixed(2) + "%";
    // an excluded condition's flag already marks what it keeps
    text.innerHTML = (k === 0
      ? "This keeps <strong>" + int(st.left) + "</strong> of " + int(total) + " stock-days (" + share(st.left / total) + ")"
      : "On its own this keeps " + int(st.alone) + " · after it, <strong>" + int(st.left) + "</strong> left (" +
        share(st.left / total) + ")") + " on " + int(st.left_days) + " days.";
  }

  /* ---- drawing the results ----------------------------------------------------------- */
  const EVIDENCE_BADGE = { backtest: "badge-backtest", live: "badge-live", shadow: "badge-warn" };
  let zoom = "95", logH = false;

  function draw(rep) {
    closeDrawer();
    const f = rep.funnel;
    $("x-start-n").textContent = f ? " · " + int(f.n_rows) + " stock-days" : "";
    state.conds.forEach((_, i) => paintCount(i));
    $("x-flags").innerHTML = "";
    $("x-evidence").innerHTML = rep.evidence.map((e) =>
      '<span class="badge ' + (EVIDENCE_BADGE[e.state] || "badge-info") + '" title="' + esc(e.note) + '">' +
      esc(e.state) + "</span>").join(" ");
    const words = rep.words.length ? "Stock-days " + rep.words.map((w) => '<span class="x-word">' + esc(w) + "</span>").join(" &middot; ")
      : "Every stock-day in the universe";
    const q = rep.query, win = "from the close of day " + q.lag + " to the close of day " + (q.lag + q.hold);
    $("x-words").innerHTML = words + ". Each one's " + esc(RET_PHRASE[q.ret]) + " " + win + ".";
    const sentence = (t) => esc(t.charAt(0).toUpperCase() + t.slice(1)) + (/[.!?]$/.test(t) ? "" : ".");
    const flags = [];
    if (rep.untradable) flags.push('<p class="caveat"><strong>Not a tradable window.</strong> ' + sentence(rep.untradable) + "</p>");
    rep.look_ahead.forEach((w) => flags.push('<p class="caveat"><strong>Hindsight.</strong> ' + sentence(w) + "</p>"));
    rep.evidence.forEach((e) => flags.push('<p class="note"><span class="badge ' + (EVIDENCE_BADGE[e.state] || "badge-info") +
      '">' + esc(e.state) + "</span> " + esc(e.note) + "</p>"));
    if (rep.empty) {
      flags.unshift('<p class="note"><strong>Nothing matches this question</strong> between ' + esc(fmtDate(rep.query.from)) +
        " and " + esc(fmtDate(rep.query.to)) + ". Try leaving out a condition, or loosening one.</p>");
      $("x-flags").innerHTML = flags.join("");
      clearResults();
      return;
    }
    const s = rep.slice, d = rep.diff, r = rep.rest;
    if (s.n_days < 30) flags.push('<p class="note">Only <strong>' + s.n_days + " days</strong> — far too few for an average to say anything.</p>");
    $("x-flags").innerHTML = flags.join("");

    const med = $("x-median");
    med.textContent = pct(s.median_pct);
    med.classList.toggle("pos", s.median_pct > 0);
    med.classList.toggle("neg", s.median_pct < 0);
    $("x-median-rest").textContent = r.n_rows ? pct(r.median_pct) : "—";
    $("x-card-meta").textContent = int(s.n_rows) + " stock-days";
    drawHist();

    const se = (x) => (x == null ? "?" : x.toFixed(1));
    const t = (x) => (x == null ? "t undefined" : "t = " + sign(x) + Math.abs(x).toFixed(2));
    $("x-tiles").innerHTML =
      qe.tile("Your stock-days", int(s.n_rows), { sub: "on " + int(s.n_days) + " days · " + (s.per_day == null ? "—" : s.per_day.toFixed(1)) + " a day" }) +
      qe.tile("Average per day", bps(s.mean_bps) + ' <span class="se">± ' + se(s.se_bps) + "</span>",
              { sub: t(s.t) + " · each day counts the same", cls: qe.signCls(s.mean_bps) }) +
      qe.tile("Against everyone else", d.n_days ? bps(d.mean_bps) + ' <span class="se">± ' + se(d.se_bps) + "</span>" : "—",
              { sub: d.n_days ? t(d.t) + " · everyone else averaged " + bps(r.mean_bps) : "your question is every stock",
                cls: d.n_days ? qe.signCls(d.mean_bps) : "" }) +
      qe.tile("Went up", share(s.share_positive), { sub: "of your stock-days · everyone else " + share(r.share_positive) });
    const n = countLook(s.key);
    reading(rep, n);
    drawYears(rep);
    drawCum(rep);
    showRows();
  }

  function clearResults() {
    $("x-hist").textContent = "";
    $("x-axis").textContent = "";
    $("x-tails").textContent = "";
    $("x-median").textContent = "—";
    $("x-median-rest").textContent = "—";
    $("x-card-meta").textContent = "";
    $("x-tiles").innerHTML = "";
    $("x-reading").textContent = "";
    ["x-chart-years", "x-chart-cum"].forEach((id) => {
      const c = echarts.getInstanceByDom($(id));
      if (c) c.clear();
    });
    closeDrawer();
    $("x-table").querySelector("tbody").innerHTML = '<tr><td class="muted">nothing to show</td></tr>';
  }

  /* what the numbers say, in words, and how far to trust them */
  function reading(rep, looks) {
    const d = rep.diff, el = $("x-reading");
    if (!d.n_days) { el.textContent = "Your question takes in every stock, so there is no one else to compare it with."; return; }
    const dir = d.mean_bps >= 0 ? "better" : "worse";
    let s = "On an average day your stock-days did <strong>" + Math.abs(d.mean_bps).toFixed(1) + " bps " + dir +
      "</strong> than everyone else (1 bps = 0.01%). ";
    if (d.t == null) s += "There are too few days to put a standard error on that.";
    else {
      const at = Math.abs(d.t), bar = lookBar(looks);
      if (at < 1) s += "That is less than one standard error from zero: <strong>no sign of a difference</strong>.";
      else if (at < 2) s += "That is " + at.toFixed(1) + " standard errors from zero — <strong>the size chance produces all the time</strong>.";
      else if (at < 3) s += "One look at " + at.toFixed(1) + " standard errors would stand out, but you have looked at " + looks +
        " question" + (looks === 1 ? "" : "s") + ", and the best of that many would typically reach " + bar.toFixed(1) +
        " by chance alone. <strong>Treat it as an idea, not a finding.</strong>";
      else s += "That is " + at.toFixed(1) + " standard errors from zero — large for one look. It is still an idea: the way to know is " +
        "to write the rule down first and then watch days that haven't happened yet.";
    }
    el.innerHTML = s;
  }

  /* ---- the distribution ---------------------------------------------------------------
   * The screener's card, larger: your stock-days as bars coloured by sign, the
   * rest as an outline, each scaled to its own peak, both medians. Four zoom
   * levels come in one payload, so switching is instant; log heights lift the
   * rare returns into view. */
  const SVGNS = "http://www.w3.org/2000/svg";
  const HW = 400, HH = 120;
  function level() { return lastRep && lastRep.hist.levels.find((l) => l.key === zoom); }

  function drawHist() {
    const lv = level();
    if (!lv) return;
    const svg = $("x-hist"), n = lastRep.hist.n_bins, lo = lv.lo_pct, hi = lv.hi_pct;
    const bw = HW / n, width = (hi - lo) / n;
    const mk = (tag, attrs, parent) => {
      const el = document.createElementNS(SVGNS, tag);
      Object.entries(attrs).forEach(([a, v]) => el.setAttribute(a, v));
      (parent || svg).appendChild(el);
      return el;
    };
    const xOf = (v) => ((Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * HW;
    const h = (k, peak) => (k <= 0 ? 0 : logH ? Math.log1p(k) / Math.log1p(peak) : k / peak);
    const peak = Math.max(1, ...lv.slice);
    svg.textContent = "";
    const zeroX = lo < 0 && hi > 0 ? xOf(0) : null;
    const bars = lv.slice.map((k, i) => {
      const mid = lo + (i + 0.5) * width;
      return mk("rect", { x: (i * bw + 0.5).toFixed(2), y: 0, width: Math.max(0.4, bw - 1).toFixed(2), height: HH,
                          class: (mid < 0 ? "h-neg" : "h-pos") + (selectedBar === i ? " picked" : ""), style: "transform: scaleY(0)" });
    });
    if (lv.rest) {
      const rp = Math.max(1, ...lv.rest);
      let path = "M0," + HH;
      lv.rest.forEach((k, i) => {
        const y = (HH - h(k, rp) * HH).toFixed(2);
        path += " L" + (i * bw).toFixed(2) + "," + y + " L" + ((i + 1) * bw).toFixed(2) + "," + y;
      });
      mk("path", { d: path + " L" + HW + "," + HH, class: "h-ghost" });
    }
    if (zeroX != null) mk("line", { x1: zeroX, x2: zeroX, y1: 0, y2: HH, class: "h-zero" });
    if (lastRep.rest.median_pct != null && lastRep.rest.n_rows) {
      const x = xOf(lastRep.rest.median_pct).toFixed(2);
      mk("line", { x1: x, x2: x, y1: -4, y2: HH, class: "h-med-all" });
    }
    if (lastRep.slice.median_pct != null) {
      const x = xOf(lastRep.slice.median_pct).toFixed(2);
      mk("line", { x1: x, x2: x, y1: -4, y2: HH, class: "h-med" });
    }
    lv.slice.forEach((k, i) => mk("rect", { x: (i * bw).toFixed(2), y: -4, width: bw.toFixed(2), height: HH + 4,
                                            class: "h-hit", "data-bin": i }));
    // the axis: its two ends, zero, and the halfway marks, placed where they fall
    const ends = zoom !== "all";
    const ticks = [[lo, (ends ? "≤" : "") + pct(lo, 1)], [hi, (ends ? "≥" : "") + pct(hi, 1)]];
    if (zeroX != null) ticks.push([0, "0"]);
    if (lo < 0 && hi > 0) {
      if (-lo > (hi - lo) * 0.3) ticks.push([lo / 2, pct(lo / 2, 1)]);
      if (hi > (hi - lo) * 0.3) ticks.push([hi / 2, pct(hi / 2, 1)]);
    }
    $("x-axis").innerHTML = ticks.map(([v, label]) => {
      const x = (100 * (v - lo)) / (hi - lo);
      const cls = x < 1 ? "l" : x > 99 ? "r" : "m";
      return '<span class="' + cls + '" style="left:' + x.toFixed(2) + '%">' + esc(label) + "</span>";
    }).join("");
    // what the axis does not show
    const s = lastRep.slice;
    $("x-tails").innerHTML = ends
      ? (lv.slice_below || lv.slice_above
        ? "Past the axis, gathered in the end bars: <strong>" + int(lv.slice_below) + "</strong> of yours below " + pct(lo, 1) +
          " and <strong>" + int(lv.slice_above) + "</strong> above " + pct(hi, 1) + "."
        : "None of your stock-days falls past the axis.")
      : "Every return is on the axis, from " + pct(lastRep.hist.min_pct, 1) + " to " + pct(lastRep.hist.max_pct, 1) +
        ". Yours run from " + pct(s.min_pct, 1) + " to " + pct(s.max_pct, 1) + ".";
    const grow = () => bars.forEach((el, i) => { el.style.transform = "scaleY(" + h(lv.slice[i], peak).toFixed(4) + ")"; });
    if (reduced) grow(); else requestAnimationFrame(() => requestAnimationFrame(grow));
  }

  $("x-zoom").addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-z]");
    if (!b) return;
    zoom = b.dataset.z;
    closeDrawer();
    $("x-zoom").querySelectorAll("button").forEach((x) => {
      x.classList.toggle("on", x === b);
      x.setAttribute("aria-pressed", x === b ? "true" : "false");
    });
    drawHist();
  });
  $("x-log").addEventListener("change", (ev) => { logH = ev.target.checked; drawHist(); });

  // hover: a bar's range and both counts; click: list its stock-days
  const tip = $("x-tip"), wrap = $("x-hist-wrap");
  function binText(i) {
    const lv = level(), n = lastRep.hist.n_bins, width = (lv.hi_pct - lv.lo_pct) / n;
    const lo = lv.lo_pct + i * width, hi = lo + width;
    const ends = zoom !== "all";
    return i === 0 && ends ? "below " + pct(hi, 2) : i === n - 1 && ends ? "above " + pct(lo, 2) : pct(lo, 2) + " to " + pct(hi, 2);
  }
  $("x-hist").addEventListener("mousemove", (ev) => {
    const hit = ev.target.closest("[data-bin]");
    if (!hit || !lastRep) { tip.hidden = true; return; }
    const i = Number(hit.dataset.bin), lv = level();
    const sTot = lv.slice.reduce((a, b) => a + b, 0) || 1;
    const rTot = lv.rest ? lv.rest.reduce((a, b) => a + b, 0) || 1 : 1;
    tip.innerHTML = "<strong>" + binText(i) + "</strong><br>yours: " + int(lv.slice[i]) + " (" + (100 * lv.slice[i] / sTot).toFixed(1) + "%)" +
      (lv.rest ? "<br>everyone else: " + int(lv.rest[i]) + " (" + (100 * lv.rest[i] / rTot).toFixed(1) + "%)" : "") +
      (lv.slice[i] ? '<br><span class="muted">click to list them</span>' : "");
    tip.hidden = false;
    const box = wrap.getBoundingClientRect();
    const x = ev.clientX - box.left;
    tip.style.left = Math.max(0, Math.min(box.width - tip.offsetWidth, x - tip.offsetWidth / 2)) + "px";
    tip.style.top = Math.max(0, ev.clientY - box.top - tip.offsetHeight - 14) + "px";
  });
  $("x-hist").addEventListener("mouseleave", () => { tip.hidden = true; });

  // a bar's stock-days open in a drawer under the card, beside the chart they
  // came from; a new question, a new zoom or Close puts it away
  let selectedBar = null, barSeq = 0;
  $("x-hist").addEventListener("click", async (ev) => {
    const hit = ev.target.closest("[data-bin]");
    if (!hit || !lastRep) return;
    const i = Number(hit.dataset.bin);
    if (!level().slice[i]) return;
    selectedBar = i;
    drawHist();
    const my = ++barSeq;
    $("x-drawer-title").textContent = "Loading the stock-days in this bar…";
    $("x-drawer").hidden = false;
    try {
      const rep = await qe.fetch("/api/returns?" + last + "&bar=" + zoom + ":" + i);
      if (my !== barSeq) return;
      const ends = zoom !== "all";
      const range = rep.open_lo && ends ? "below " + pct(rep.hi_pct, 2) : rep.open_hi && ends ? "above " + pct(rep.lo_pct, 2)
        : "from " + pct(rep.lo_pct, 2) + " to " + pct(rep.hi_pct, 2);
      $("x-drawer-title").innerHTML = "<strong>" + int(rep.n) + "</strong> stock-day" + (rep.n === 1 ? "" : "s") +
        " with a return " + range + (rep.n > rep.rows.length ? " — the " + rep.rows.length + " largest are listed" : ", largest first") + ".";
      fillTable($("x-drawer-table"), rep.rows, lastRep.labels);
    } catch (err) {
      console.error(err);
      if (my === barSeq) $("x-drawer-title").textContent = "The stock-days in this bar did not load.";
    }
  });
  function closeDrawer() {
    barSeq++;
    selectedBar = null;
    $("x-drawer").hidden = true;
  }
  $("x-drawer-close").addEventListener("click", () => { closeDrawer(); drawHist(); });

  /* ---- over time ------------------------------------------------------------------------ */
  function drawYears(rep) {
    const C = qe.colors();
    const ys = rep.by_year;
    const means = ys.map((y) => y.diff.mean_bps);
    const wd = ys.map((y, i) => (y.diff.mean_bps == null || y.diff.se_bps == null ? null
      : [i, y.diff.mean_bps - y.diff.se_bps, y.diff.mean_bps + y.diff.se_bps])).filter(Boolean);
    qe.chart("x-chart-years").setOption({
      animation: !reduced,
      tooltip: { formatter: (o) => {
        const y = ys[o.dataIndex];
        if (!y) return "";
        return y.year + ": <b>" + bps(y.diff.mean_bps) + "</b> ± " + (y.diff.se_bps == null ? "?" : y.diff.se_bps.toFixed(1)) +
          " against everyone else<br>yours alone " + bps(y.slice.mean_bps) + " · " + y.n_days + " days · " + int(y.n_rows) + " stock-days";
      } },
      grid: { left: 56, right: 12, top: 18, bottom: 30 },
      xAxis: { type: "category", data: ys.map((y) => String(y.year)) },
      yAxis: { type: "value", name: "bps / day", nameTextStyle: { fontSize: 10 } },
      series: [
        { type: "bar", data: qe.bars(means, (v) => (v >= 0 ? C.pos : C.neg)), barMaxWidth: 26, itemStyle: { opacity: 0.85 } },
        qe.whiskerSeries(wd, C.ink2),
      ],
    }, true);
  }

  function drawCum(rep) {
    const C = qe.colors();
    const cu = rep.cumulative;
    qe.chart("x-chart-cum").setOption({
      animation: false,
      tooltip: { trigger: "axis", valueFormatter: (v) => (v == null ? "—" : bps(v, 0)) },
      grid: { left: 64, right: 16, top: 18, bottom: 46 },
      xAxis: { type: "category", data: cu.dates, boundaryGap: false },
      yAxis: { type: "value", name: "bps, added up", nameTextStyle: { fontSize: 10 } },
      dataZoom: [{ type: "inside" }, { type: "slider", bottom: 6, height: 16 }],
      series: [{ type: "line", data: cu.diff_bps, showSymbol: false, itemStyle: { color: C.accent },
                 lineStyle: { width: 1.6, color: C.accent },
                 markLine: { silent: true, symbol: "none", lineStyle: { color: C.grey, type: "dashed" }, label: { show: false },
                             data: [{ yAxis: 0 }] } }],
    }, true);
  }

  /* ---- the stock-days ------------------------------------------------------------------ */
  const fmtX = (v, label) => (v == null ? "—" : /rank/.test(label) ? String(Math.round(v))
    : Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toPrecision(3));
  function fillTable(table, rows, labels) {
    table.querySelector("thead").innerHTML = "<tr><th>Day 0</th><th>Symbol</th><th>Sector</th><th class=\"num\">Return</th>" +
      labels.map((l) => '<th class="num">' + esc(l) + "</th>").join("") + "</tr>";
    table.querySelector("tbody").innerHTML = rows.map((r) =>
      "<tr><td class=\"mono\">" + esc(r.date) + "</td><td><a class=\"mono strong\" href=\"" + qe.symbolHref(r.symbol) + "\">" +
      esc(r.symbol) + "</a></td><td>" + esc(titleCase(r.sector || "")) +
      "</td><td class=\"mono num " + qe.signCls(r.ret_pct) + "\">" + pct(r.ret_pct) + "</td>" +
      r.x.map((v, j) => "<td class=\"mono num\">" + fmtX(v, labels[j]) + "</td>").join("") + "</tr>").join("") ||
      '<tr><td colspan="' + (4 + labels.length) + '" class="muted">none</td></tr>';
  }

  let pick = "largest";
  function showRows() {
    $("x-rows-pick").querySelectorAll("button").forEach((x) => {
      const on = x.dataset.v === pick;
      x.classList.toggle("on", on);
      x.setAttribute("aria-pressed", on ? "true" : "false");
    });
    if (!lastRep || lastRep.empty) return;
    fillTable($("x-table"), lastRep.rows[pick] || [], lastRep.labels);
  }
  $("x-rows-pick").addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-v]");
    if (!b) return;
    pick = b.dataset.v;
    showRows();
  });

  /* ---- the look counter ------------------------------------------------------------------
   * Every distinct question this tab has run. With N looks at questions that
   * carry no effect at all, the largest |t| among them has a median of
   * Φ⁻¹((1 + 0.5^(1/N)) / 2) if the looks were independent; overlapping
   * questions are correlated, so the true bar is somewhat lower, but it is
   * the right order — and it is what a |t| found here has to be read against. */
  function probit(p) {
    // Acklam's rational approximation, |error| < 1.2e-9
    const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
    const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
    const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
    const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
    const lo = 0.02425;
    if (p < lo) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    if (p > 1 - lo) return -probit(1 - p);
    const q = p - 0.5, r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  const lookBar = (n) => probit((1 + Math.pow(0.5, 1 / Math.max(1, n))) / 2);
  function countLook(key) {
    let seen = [];
    try { seen = JSON.parse(sessionStorage.getItem("qe-x-looks") || "[]"); } catch (e) { seen = []; }
    if (!Array.isArray(seen)) seen = [];
    if (key && !seen.includes(key)) {
      seen.push(key);
      try { sessionStorage.setItem("qe-x-looks", JSON.stringify(seen)); } catch (e) { /* private mode: count this page only */ }
    }
    const n = Math.max(1, seen.length);
    $("x-looks").innerHTML = "<strong>" + n + " question" + (n === 1 ? "" : "s") + "</strong> looked at in this tab. " +
      "With that many looks and nothing real anywhere, the best of them would typically sit about <strong>" +
      lookBar(n).toFixed(2) + "</strong> standard errors from zero by chance alone.";
    return n;
  }

  /* ---- start ------------------------------------------------------------------------------ */
  // an address with none of the question's own keys (a bare /returns, or
  // ?theme=dark) opens on the model's top 50 rather than on every stock-day
  const own = ["c", "hold", "lag", "ret", "from", "to"].some((k) => new URLSearchParams(location.search).has(k));
  readQuery(own ? location.search : DEFAULT_QUERY);
  renderAll();
  run();
})();
