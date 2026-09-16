/* Renders the dashboard's real output on the case-study page.
 *   data/example.json    - one ticker scored minute by minute (zoomable chart)
 *   data/year_study.json - the eight-company, one-year test
 * Regenerate both with tools/build_page_data.py. Degrades to the static notes
 * in the markup if a file is missing or JavaScript is off. */

/* ---------------------------------------------------------------- chart --- */
(function () {
  "use strict";

  var REGIMES = ["safe", "building", "elevated", "critical"];
  var LABEL = { safe: "Safe", building: "Building", elevated: "Elevated", critical: "Critical" };

  function css(name, fallback) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name);
    return (v && v.trim()) || fallback;
  }
  function isDark() {
    return matchMedia("(prefers-color-scheme: dark)").matches;
  }
  function regimeColor(r, alpha) {
    var d = isDark();
    var base = {
      safe:     d ? [58, 122, 86]  : [150, 200, 170],
      building: d ? [122, 105, 45] : [235, 215, 150],
      elevated: d ? [150, 100, 40] : [242, 196, 140],
      critical: d ? [158, 62, 62]  : [240, 160, 160]
    }[r] || (d ? [70, 70, 76] : [214, 214, 210]);
    return "rgba(" + base[0] + "," + base[1] + "," + base[2] + "," + alpha + ")";
  }

  /* ---- data ---- */
  var D = null;           // {t: [Date-ish strings], close, score, regime}
  var view = { a: 0, b: 0 };   // inclusive index range currently shown

  function decode(raw) {
    if (raw.enc) {
      // compact: minute offsets from t0, regimes as small ints
      var e = raw.enc;
      var t0 = new Date(e.t0.replace(" ", "T"));
      var names = raw.regime_names || REGIMES;
      return {
        t: e.tmin.map(function (m) { return new Date(t0.getTime() + m * 60000); }),
        close: e.close,
        score: e.score,
        regime: e.regime.map(function (i) { return names[i] || null; })
      };
    }
    var s = raw.series;   // older shape
    return {
      t: s.t.map(function (x) { return new Date(x.replace(" ", "T")); }),
      close: s.close, score: s.score, regime: s.regime
    };
  }

  function fmtTime(d, withTime) {
    var day = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    if (!withTime) return day;
    return day + " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }

  /* ---- drawing ---- */
  var geom = null;

  function draw(canvas, hoverIdx, dragPx) {
    var n = view.b - view.a + 1;
    if (!D || n < 2) return;

    var dpr = window.devicePixelRatio || 1;
    var cssW = canvas.clientWidth || 700;
    var cssH = canvas.clientHeight || 340;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    var ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    var padL = 48, padR = 44, padT = 12, padB = 46;
    var ribbonH = 12, ribbonGap = 6;
    var W = cssW - padL - padR, H = cssH - padT - padB;
    if (W <= 4 || H <= 4) return;
    var ribbonY = padT + H + ribbonGap;

    // bucket the visible range into pixel columns, keeping min/max so spikes survive
    var cols = Math.max(2, Math.min(Math.floor(W), n));
    var per = n / cols;
    var buckets = [];
    for (var c = 0; c < cols; c++) {
      var lo = view.a + Math.floor(c * per);
      var hi = view.a + Math.floor((c + 1) * per) - 1;
      if (hi < lo) hi = lo;
      var pMin = Infinity, pMax = -Infinity, sMin = Infinity, sMax = -Infinity;
      // Regime: take the most SEVERE label in the column, not the most common.
      // Price and score keep their min/max so decimation cannot hide a move; a
      // modal ribbon would quietly erase brief critical spells, which are the
      // rare label that actually matters.
      var worst = -1;
      for (var i = lo; i <= hi && i < D.close.length; i++) {
        var p = D.close[i], sv = D.score[i];
        if (p != null) { if (p < pMin) pMin = p; if (p > pMax) pMax = p; }
        if (sv != null) { if (sv < sMin) sMin = sv; if (sv > sMax) sMax = sv; }
        var ri = REGIMES.indexOf(D.regime[i]);
        if (ri > worst) worst = ri;
      }
      buckets.push({
        lo: lo, hi: hi,
        pMin: pMin === Infinity ? null : pMin, pMax: pMax === -Infinity ? null : pMax,
        sMin: sMin === Infinity ? null : sMin, sMax: sMax === -Infinity ? null : sMax,
        regime: worst >= 0 ? REGIMES[worst] : null
      });
    }

    var lowP = Infinity, highP = -Infinity;
    buckets.forEach(function (b) {
      if (b.pMin != null && b.pMin < lowP) lowP = b.pMin;
      if (b.pMax != null && b.pMax > highP) highP = b.pMax;
    });
    if (!isFinite(lowP) || !isFinite(highP)) return;
    if (lowP === highP) { lowP -= 1; highP += 1; }
    var padv = (highP - lowP) * 0.08; lowP -= padv; highP += padv;

    var x = function (c) { return padL + (cols <= 1 ? 0 : (c / (cols - 1)) * W); };
    var yP = function (v) { return padT + H - ((v - lowP) / (highP - lowP)) * H; };
    var yS = function (v) { return padT + H - (v / 100) * H; };

    // frame + score thresholds
    ctx.strokeStyle = css("--border", "#e4e4e0");
    ctx.lineWidth = 1;
    ctx.strokeRect(padL, padT, W, H);
    ctx.setLineDash([3, 3]);
    ctx.fillStyle = css("--muted", "#6b6b6b");
    ctx.font = "10px ui-monospace, Menlo, monospace";
    ctx.textAlign = "left";
    // the model's own regime cut-offs, so the ribbon's colours can be read off the line
    [[40, "building"], [55, "elevated"], [70, "critical"]].forEach(function (pair) {
      var yy = yS(pair[0]);
      ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(padL + W, yy); ctx.stroke();
      ctx.fillText(String(pair[0]), padL + W + 5, yy + 3);
    });
    ctx.setLineDash([]);

    // price: a continuous line, plus a min/max span wherever a pixel column
    // covers more than one minute so decimation can never hide a move
    ctx.strokeStyle = css("--text", "#1a1a1a");
    ctx.globalAlpha = 0.6;
    ctx.lineWidth = 1;
    ctx.beginPath();
    var startedP = false;
    buckets.forEach(function (b, c) {
      if (b.pMin == null) return;
      var xx = x(c), mid = (b.pMin + b.pMax) / 2;
      if (!startedP) { ctx.moveTo(xx, yP(mid)); startedP = true; }
      else ctx.lineTo(xx, yP(mid));
    });
    ctx.stroke();
    ctx.beginPath();
    buckets.forEach(function (b, c) {
      if (b.pMin == null || b.pMax === b.pMin) return;
      var xx = x(c);
      ctx.moveTo(xx, yP(b.pMax));
      ctx.lineTo(xx, yP(b.pMin));
    });
    ctx.stroke();
    ctx.globalAlpha = 1;

    // fragility score, same treatment
    ctx.strokeStyle = css("--accent", "#2563eb");
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    var startedS = false;
    buckets.forEach(function (b, c) {
      if (b.sMin == null) return;
      var xx = x(c), mid = (b.sMin + b.sMax) / 2;
      if (!startedS) { ctx.moveTo(xx, yS(mid)); startedS = true; }
      else ctx.lineTo(xx, yS(mid));
    });
    ctx.stroke();
    ctx.globalAlpha = 0.55;
    ctx.beginPath();
    buckets.forEach(function (b, c) {
      if (b.sMin == null || b.sMax === b.sMin) return;
      var xx = x(c);
      ctx.moveTo(xx, yS(b.sMax));
      ctx.lineTo(xx, yS(b.sMin));
    });
    ctx.stroke();
    ctx.globalAlpha = 1;

    // regime ribbon
    var i2 = 0;
    while (i2 < buckets.length) {
      var r2 = buckets[i2].regime, j = i2;
      while (j + 1 < buckets.length && buckets[j + 1].regime === r2) j++;
      if (r2 == null) { i2 = j + 1; continue; }
      ctx.fillStyle = regimeColor(r2, 0.95);
      var x0 = x(i2), x1 = x(Math.min(j + 1, buckets.length - 1));
      ctx.fillRect(x0, ribbonY, Math.max(x1 - x0, 0.6), ribbonH);
      i2 = j + 1;
    }
    ctx.strokeStyle = css("--border", "#e4e4e0");
    ctx.strokeRect(padL, ribbonY, W, ribbonH);

    // axes
    ctx.fillStyle = css("--muted", "#6b6b6b");
    ctx.textAlign = "right";
    ctx.fillText(highP.toFixed(0), padL - 6, padT + 8);
    ctx.fillText(lowP.toFixed(0), padL - 6, padT + H);
    var spanDays = (D.t[view.b] - D.t[view.a]) / 86400000;
    ctx.textAlign = "left";
    ctx.fillText(fmtTime(D.t[view.a], spanDays < 3), padL, ribbonY + ribbonH + 14);
    ctx.textAlign = "right";
    ctx.fillText(fmtTime(D.t[view.b], spanDays < 3), padL + W, ribbonY + ribbonH + 14);

    // drag selection
    if (dragPx) {
      var lo2 = Math.max(padL, Math.min(dragPx[0], dragPx[1]));
      var hi2 = Math.min(padL + W, Math.max(dragPx[0], dragPx[1]));
      if (hi2 <= lo2) { lo2 = hi2 = padL; }
      ctx.fillStyle = isDark() ? "rgba(122,162,255,.20)" : "rgba(37,99,235,.14)";
      ctx.fillRect(lo2, padT, hi2 - lo2, H);
      ctx.strokeStyle = css("--accent", "#2563eb");
      ctx.globalAlpha = .7;
      ctx.beginPath();
      ctx.moveTo(lo2, padT); ctx.lineTo(lo2, padT + H);
      ctx.moveTo(hi2, padT); ctx.lineTo(hi2, padT + H);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // hover crosshair
    if (hoverIdx != null) {
      var hc = Math.round(((hoverIdx - view.a) / Math.max(n - 1, 1)) * (cols - 1));
      var hx = x(Math.max(0, Math.min(cols - 1, hc)));
      ctx.strokeStyle = css("--muted", "#6b6b6b");
      ctx.globalAlpha = 0.55;
      ctx.beginPath(); ctx.moveTo(hx, padT); ctx.lineTo(hx, ribbonY + ribbonH); ctx.stroke();
      ctx.globalAlpha = 1;
      var hv = D.score[hoverIdx];
      if (hv != null) {
        ctx.fillStyle = css("--accent", "#2563eb");
        ctx.beginPath(); ctx.arc(hx, yS(hv), 3, 0, Math.PI * 2); ctx.fill();
      }
    }

    geom = { padL: padL, W: W, padT: padT, H: H, cols: cols, ribbonY: ribbonY, ribbonH: ribbonH };
  }

  /* ---- interaction ---- */
  function pxToIndex(px) {
    if (!geom) return view.a;
    var f = (px - geom.padL) / geom.W;
    f = Math.max(0, Math.min(1, f));
    return Math.round(view.a + f * (view.b - view.a));
  }

  function setView(a, b, canvas, readout, rangeLabel) {
    var minSpan = 30;   // never zoom past ~30 bars
    if (b - a < minSpan) {
      var mid = Math.round((a + b) / 2);
      a = mid - Math.floor(minSpan / 2);
      b = a + minSpan;
    }
    a = Math.max(0, a); b = Math.min(D.t.length - 1, b);
    if (b - a < minSpan) { a = Math.max(0, b - minSpan); }
    view.a = a; view.b = b;
    draw(canvas, null, null);
    updateRange(rangeLabel);
    setReadout(readout, null);
  }

  function updateRange(el) {
    if (!el || !D) return;
    var n = view.b - view.a + 1;
    var days = Math.max(1, Math.round((D.t[view.b] - D.t[view.a]) / 86400000));
    var zoomed = !(view.a === 0 && view.b === D.t.length - 1);
    el.innerHTML = '<b>' + fmtTime(D.t[view.a], true) + '</b> to <b>' + fmtTime(D.t[view.b], true) +
      '</b> · ' + n.toLocaleString() + ' minutes' + (days > 1 ? ' over ' + days + ' days' : '') +
      (zoomed ? ' · <span class="muted">zoomed</span>' : '');
  }

  function setReadout(el, i) {
    if (!el) return;
    if (i == null || !D) {
      el.innerHTML = '<span class="muted">Drag across the chart to zoom, double-click to reset. Hover to read a minute.</span>';
      return;
    }
    el.innerHTML = '<b>' + fmtTime(D.t[i], true) + '</b> · price <b>' +
      (D.close[i] == null ? "—" : D.close[i].toFixed(2)) + '</b> · fragility <b>' +
      (D.score[i] == null ? "—" : D.score[i].toFixed(0)) + '</b> · <span class="pill" style="background:' +
      regimeColor(D.regime[i], 0.9) + '">' + (LABEL[D.regime[i]] || D.regime[i]) + '</span>';
  }

  function render(raw) {
    var root = document.getElementById("soc-example");
    if (!root) return;
    D = decode(raw);
    if (!D.t.length) return;
    view.a = 0; view.b = D.t.length - 1;

    root.querySelector("[data-x=fallback]").hidden = true;
    root.querySelector("[data-x=live]").hidden = false;

    var mix = {};
    (raw.regime_mix || []).forEach(function (m) { mix[m.regime] = m.pct; });
    var days = new Set(D.t.map(function (d) { return d.toDateString(); })).size;
    root.querySelector("[data-x=facts]").innerHTML =
      '<div class="fact"><span class="n">' + days + '</span><span class="l">trading days scored, ' +
        fmtTime(D.t[0]) + ' to ' + fmtTime(D.t[D.t.length - 1]) + '</span></div>' +
      '<div class="fact"><span class="n">' + D.t.length.toLocaleString() + '</span><span class="l">one-minute bars, every one plotted</span></div>' +
      '<div class="fact"><span class="n">' + (mix.elevated || 0).toFixed(0) + '%</span><span class="l">of the window scored elevated</span></div>' +
      '<div class="fact"><span class="n">' + (mix.critical || 0).toFixed(0) + '%</span><span class="l">scored critical</span></div>';

    function paintLegend() {
      // name the two lines first - the regime swatches alone left the reader
      // guessing which line was the score and which was the price
      var lines =
        '<span><i class="ln" style="background:' + css("--accent", "#2563eb") + '"></i>' +
          'Fragility score <span class="ax">(right axis, 0\u2013100)</span></span>' +
        '<span><i class="ln" style="background:' + css("--text", "#1a1a1a") + ';opacity:.6"></i>' +
          'Share price <span class="ax">(left axis)</span></span>';
      var bands = '<span class="grp">Regime strip:</span>' + REGIMES.map(function (r) {
        return '<span><i style="background:' + regimeColor(r, 0.95) + '"></i>' + LABEL[r] +
               (mix[r] != null ? ' <b>' + mix[r].toFixed(0) + '%</b>' : '') + '</span>';
      }).join("");
      root.querySelector("[data-x=legend]").innerHTML = lines + bands;
    }
    paintLegend();

    var canvas = root.querySelector("canvas");
    var readout = root.querySelector("[data-x=readout]");
    var rangeLabel = root.querySelector("[data-x=range]");
    var full = function () { setView(0, D.t.length - 1, canvas, readout, rangeLabel); };

    // range buttons
    var btnWrap = root.querySelector("[data-x=zoombtns]");
    if (btnWrap) {
      var opts = [["All", null], ["3 months", 60 * 391], ["1 month", 20 * 391], ["1 week", 5 * 391], ["1 day", 391]];
      btnWrap.innerHTML = opts.map(function (o, i) {
        return '<button type="button" data-span="' + (o[1] == null ? "" : o[1]) + '">' + o[0] + '</button>';
      }).join("") + '<button type="button" data-reset="1">Reset</button>';
      btnWrap.addEventListener("click", function (e) {
        var b = e.target.closest("button"); if (!b) return;
        if (b.dataset.reset != null && b.dataset.reset !== "") return full();
        var span = b.dataset.span;
        if (!span) return full();
        var want = parseInt(span, 10);
        var end = D.t.length - 1;
        setView(Math.max(0, end - want), end, canvas, readout, rangeLabel);
      });
    }

    // drag to zoom
    var dragging = false, dragStart = null, dragNow = null;
    function localX(ev) {
      var rect = canvas.getBoundingClientRect();
      var cx = (ev.touches && ev.touches[0]) ? ev.touches[0].clientX : ev.clientX;
      return cx - rect.left;
    }
    function begin(ev) { dragging = true; dragStart = dragNow = localX(ev); draw(canvas, null, null); }
    function move(ev) {
      var px = localX(ev);
      if (dragging) { dragNow = px; draw(canvas, null, [dragStart, dragNow]); }
      else { var i = pxToIndex(px); draw(canvas, i, null); setReadout(readout, i); }
    }
    function end() {
      if (!dragging) return;
      dragging = false;
      var i1 = dragStart == null ? null : pxToIndex(Math.min(dragStart, dragNow));
      var i2 = dragStart == null ? null : pxToIndex(Math.max(dragStart, dragNow));
      // Both the pixel distance AND the resulting index span must be real.
      // pxToIndex clamps to the plot, so a drag entirely inside the axis gutter
      // maps both ends to the same index and would otherwise commit a zoom.
      if (i1 != null && Math.abs(dragNow - dragStart) > 6 && (i2 - i1) >= 5) {
        setView(i1, i2, canvas, readout, rangeLabel);
      } else {
        draw(canvas, null, null);
      }
      dragStart = dragNow = null;
    }
    canvas.addEventListener("mousedown", function (e) { e.preventDefault(); begin(e); });
    canvas.addEventListener("mousemove", move);
    window.addEventListener("mouseup", end);
    canvas.addEventListener("mouseleave", function () {
      if (!dragging) { draw(canvas, null, null); setReadout(readout, null); }
    });
    canvas.addEventListener("dblclick", full);
    // Touch: do not claim the gesture until it is clearly horizontal, otherwise a
    // vertical swipe that happens to start on the chart traps the page scroll.
    var tStart = null, tAxis = null;
    canvas.addEventListener("touchstart", function (e) {
      var tch = e.touches && e.touches[0];
      if (!tch) return;
      tStart = { x: tch.clientX, y: tch.clientY };
      tAxis = null;
    }, { passive: true });
    canvas.addEventListener("touchmove", function (e) {
      var tch = e.touches && e.touches[0];
      if (!tch || !tStart) return;
      if (tAxis === null) {
        var dx = Math.abs(tch.clientX - tStart.x), dy = Math.abs(tch.clientY - tStart.y);
        if (dx < 8 && dy < 8) return;              // not yet decided
        tAxis = dx > dy ? "x" : "y";
        if (tAxis === "x") begin(e);                // only now does it become a drag
      }
      if (tAxis !== "x") return;                    // vertical: let the page scroll
      e.preventDefault();
      move(e);
    }, { passive: false });
    function touchDone() { if (tAxis === "x") end(); tStart = null; tAxis = null; }
    canvas.addEventListener("touchend", touchDone);
    canvas.addEventListener("touchcancel", touchDone);
    window.addEventListener("blur", function () { if (dragging) { dragging = false; draw(canvas, null, null); } });

    // Wheel zoom around the cursor - ONLY with a modifier held (which is also
    // what a trackpad pinch reports). A plain wheel must scroll the page, or
    // the chart traps the reader halfway down the article.
    canvas.addEventListener("wheel", function (e) {
      if (!geom) return;
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      var pivot = pxToIndex(localX(e));
      var span = view.b - view.a;
      var factor = e.deltaY > 0 ? 1.25 : 0.8;
      var newSpan = Math.round(span * factor);
      var frac = (pivot - view.a) / Math.max(span, 1);
      setView(Math.round(pivot - frac * newSpan), Math.round(pivot + (1 - frac) * newSpan), canvas, readout, rangeLabel);
    }, { passive: false });

    // keyboard
    canvas.setAttribute("tabindex", "0");
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", "Fragility score and price over time. Use arrow keys to pan, plus and minus to zoom, 0 to reset.");
    canvas.addEventListener("keydown", function (e) {
      var span = view.b - view.a, step = Math.max(1, Math.round(span * 0.15));
      if (e.key === "ArrowLeft") { setView(view.a - step, view.b - step, canvas, readout, rangeLabel); e.preventDefault(); }
      else if (e.key === "ArrowRight") { setView(view.a + step, view.b + step, canvas, readout, rangeLabel); e.preventDefault(); }
      else if (e.key === "+" || e.key === "=") { setView(view.a + step, view.b - step, canvas, readout, rangeLabel); e.preventDefault(); }
      else if (e.key === "-" || e.key === "_") { setView(view.a - step, view.b + step, canvas, readout, rangeLabel); e.preventDefault(); }
      else if (e.key === "0") { full(); e.preventDefault(); }
    });

    full();
    var t;
    addEventListener("resize", function () { clearTimeout(t); t = setTimeout(function () { draw(canvas, null, null); }, 120); });
    if (window.matchMedia) {
      var mq = matchMedia("(prefers-color-scheme: dark)");
      var onTheme = function () {
        draw(canvas, null, null);
        paintLegend();                    // swatches are baked into innerHTML
        setReadout(readout, null);
      };
      if (mq.addEventListener) mq.addEventListener("change", onTheme); else mq.addListener(onTheme);
    }
  }

  fetch("data/example.json")
    .then(function (r) { if (!r.ok) throw new Error("http " + r.status); return r.json(); })
    .then(render)
    .catch(function (e) { if (window.console) console.warn("SOC example unavailable:", e.message); });
})();

/* ------------------------------------------- the eight-company year test --- */
(function () {
  "use strict";

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function num(v, nd) { return v == null ? "—" : Number(v).toFixed(nd); }
  function regimeTint(r) {
    var d = matchMedia("(prefers-color-scheme: dark)").matches;
    var c = {
      safe:     d ? [58, 122, 86]  : [150, 200, 170],
      building: d ? [122, 105, 45] : [235, 215, 150],
      elevated: d ? [150, 100, 40] : [242, 196, 140],
      critical: d ? [158, 62, 62]  : [240, 160, 160]
    }[r] || [200, 200, 200];
    return "rgba(" + c[0] + "," + c[1] + "," + c[2] + ",0.9)";
  }
  function css(n, f) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(n);
    return (v && v.trim()) || f;
  }

  /* Calibration: for each tenth of the score, how often did a volatility spike
     actually follow? Drawn as a ratio to the base rate, so 1.0 means "told you
     nothing". The same curve for plain trailing volatility sits underneath it,
     because that is the thing the score has to beat. */
  function drawCalibration(canvas, pooled) {
    var a = (pooled.calibration || []).map(function (d) { return d.lift; });
    var b = (pooled.calibration_trailing || []).map(function (d) { return d.lift; });
    if (!a.length) return;

    var dpr = window.devicePixelRatio || 1;
    var cssW = canvas.clientWidth || 640, cssH = canvas.clientHeight || 260;
    canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
    var ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    var padL = 44, padR = 14, padT = 14, padB = 34;
    var W = cssW - padL - padR, H = cssH - padT - padB;
    if (W <= 4 || H <= 4) return;

    var vals = a.concat(b).filter(function (v) { return v != null; });
    var hi = Math.max(1.6, Math.ceil(Math.max.apply(null, vals) * 10) / 10 + 0.1);
    var lo = Math.min(0.4, Math.floor(Math.min.apply(null, vals) * 10) / 10 - 0.1);

    var x = function (i, n) { return padL + (n <= 1 ? W / 2 : (i / (n - 1)) * W); };
    var y = function (v) { return padT + H - ((v - lo) / (hi - lo)) * H; };

    ctx.strokeStyle = css("--border", "#e4e4e0"); ctx.lineWidth = 1;
    ctx.strokeRect(padL, padT, W, H);

    // the "tells you nothing" line
    ctx.strokeStyle = css("--muted", "#6b6b6b");
    ctx.setLineDash([4, 3]); ctx.globalAlpha = .8;
    ctx.beginPath(); ctx.moveTo(padL, y(1)); ctx.lineTo(padL + W, y(1)); ctx.stroke();
    ctx.setLineDash([]); ctx.globalAlpha = 1;
    ctx.fillStyle = css("--muted", "#6b6b6b");
    ctx.font = "10px ui-monospace, Menlo, monospace";
    ctx.textAlign = "left";
    ctx.fillText("1.0 · no information", padL + 6, y(1) - 5);

    function series(arr, color, width, dash) {
      ctx.strokeStyle = color; ctx.lineWidth = width;
      ctx.setLineDash(dash || []);
      ctx.beginPath();
      var started = false;
      arr.forEach(function (v, i) {
        if (v == null) return;
        var xx = x(i, arr.length);
        if (!started) { ctx.moveTo(xx, y(v)); started = true; } else ctx.lineTo(xx, y(v));
      });
      ctx.stroke();
      ctx.setLineDash([]);
      arr.forEach(function (v, i) {
        if (v == null) return;
        ctx.fillStyle = color;
        ctx.beginPath(); ctx.arc(x(i, arr.length), y(v), 2.6, 0, Math.PI * 2); ctx.fill();
      });
    }
    series(b, css("--muted", "#6b6b6b"), 1.4, [5, 3]);
    series(a, css("--accent", "#2563eb"), 2, null);

    ctx.fillStyle = css("--muted", "#6b6b6b");
    ctx.textAlign = "right";
    ctx.fillText(hi.toFixed(1) + "×", padL - 6, padT + 9);
    ctx.fillText(lo.toFixed(1) + "×", padL - 6, padT + H);
    ctx.textAlign = "left";
    ctx.fillText("lowest tenth of the score", padL, cssH - 10);
    ctx.textAlign = "right";
    ctx.fillText("highest tenth", padL + W, cssH - 10);
  }

  function render(d) {
    var root = document.getElementById("soc-study");
    if (!root || !d || !d.per_ticker) return;
    var per = d.per_ticker, keys = Object.keys(per), p = d.pooled || {};
    if (!keys.length) return;

    root.querySelector("[data-x=fallback]").hidden = true;
    root.querySelector("[data-x=live]").hidden = false;

    root.querySelector("[data-x=facts]").innerHTML =
      '<div class="fact"><span class="n">' + keys.length + '</span><span class="l">companies, one per sector, fixed before the run</span></div>' +
      '<div class="fact"><span class="n">' + ((p.bars || 0) / 1e6).toFixed(1) + 'M</span><span class="l">one-minute bars scored</span></div>' +
      '<div class="fact"><span class="n">' + (p.effective_n || 0).toLocaleString() + '</span><span class="l">non-overlapping forward hours, across ' + (p.days_unique || 0) + ' shared trading days</span></div>' +
      '<div class="fact"><span class="n">' + num(p.auc_score, 3) + '</span><span class="l">AUC of the score (0.500 is a coin flip)</span></div>';

    var canvas = root.querySelector("#soc-calib");
    if (canvas) {
      drawCalibration(canvas, p);
      var t;
      addEventListener("resize", function () { clearTimeout(t); t = setTimeout(function () { drawCalibration(canvas, p); }, 120); });
      if (window.matchMedia) {
        var mq = matchMedia("(prefers-color-scheme: dark)");
        var f = function () { drawCalibration(canvas, p); };
        if (mq.addEventListener) mq.addEventListener("change", f); else mq.addListener(f);
      }
    }

    var leg = root.querySelector("[data-x=calib-legend]");
    if (leg) {
      var mut = css("--muted", "#6b6b6b");
      leg.innerHTML =
        '<span><i class="ln" style="background:' + css("--accent", "#2563eb") + '"></i>Fragility score</span>' +
        '<span><i class="ln" style="background:repeating-linear-gradient(90deg,' + mut +
          ' 0 5px,transparent 5px 8px)"></i>Last hour’s volatility <span class="ax">(no model)</span></span>' +
        '<span><i class="ln" style="background:' + mut + ';opacity:.5"></i>1.0 \u00b7 <span class="ax">told you nothing</span></span>';
    }

    // the model's own regime labels, pooled across the eight companies
    var rt = root.querySelector("[data-x=regimes]");
    if (rt) {
      var ORDER = ["safe", "building", "elevated", "critical"];
      var NAME = { safe: "Safe", building: "Building", elevated: "Elevated", critical: "Critical" };
      var agg = {};
      keys.forEach(function (k) {
        (per[k].by_regime || []).forEach(function (r) {
          (agg[r.regime] = agg[r.regime] || []).push(r);
        });
      });
      // a company counts as "in order" when its four labels rise monotonically
      var inOrder = keys.filter(function (k) {
        var m = {};
        (per[k].by_regime || []).forEach(function (r) { m[r.regime] = r.rel_fwd_vol; });
        var seq = ORDER.map(function (r) { return m[r]; }).filter(function (v) { return v != null; });
        if (seq.length !== 4) return false;
        for (var i = 1; i < seq.length; i++) if (seq[i] < seq[i - 1]) return false;
        return true;
      }).length;
      rt.innerHTML = ORDER.filter(function (r) { return agg[r]; }).map(function (r) {
        var rows = agg[r];
        var share = rows.reduce(function (a, x) { return a + (x.share || 0); }, 0) / rows.length;
        var rel = rows.reduce(function (a, x) { return a + (x.rel_fwd_vol || 0); }, 0) / rows.length;
        return '<tr><td><span class="pill" style="background:' + regimeTint(r) + '">' + NAME[r] + '</span></td>' +
          '<td class="num">' + share.toFixed(0) + '%</td>' +
          '<td class="num">' + rel.toFixed(2) + '\u00d7</td>' +
          '<td class="num">' + (r === "critical" ? inOrder + " of " + keys.length : "") + '</td></tr>';
      }).join("");
    }

    root.querySelector("[data-x=rows]").innerHTML = keys.map(function (k) {
      var r = per[k];
      return '<tr><td><b>' + esc(k) + '</b></td><td>' + esc(r.sector || "") + '</td>' +
        '<td class="num">' + (r.days || 0) + '</td>' +
        '<td class="num">' + num(r.corr_score_fwd, 3) + '</td>' +
        '<td class="num">' + num(r.auc_score, 3) + '</td>' +
        '<td class="num">' + num(r.auc_trailing, 3) + '</td>' +
        '<td class="num">' + num(r.partial_corr_score_fwd, 3) + '</td></tr>';
    }).join("");

    var head = root.querySelector("[data-x=pooled]");
    if (head) {
      var ci = p.lift_ci ? (num(p.lift_ci[0], 2) + " to " + num(p.lift_ci[1], 2)) : "—";
      head.innerHTML =
        '<tr><td>Correlation with the next hour’s volatility</td><td class="num">' + num(p.corr_score_fwd, 3) +
          '</td><td class="num">' + num(p.corr_trailing_fwd, 3) + '</td></tr>' +
        '<tr><td>Share of that volatility explained (R²)</td><td class="num">' + num(p.r2_score, 4) +
          '</td><td class="num">' + num(p.r2_trailing, 4) + '</td></tr>' +
        '<tr><td>AUC — ranking a violent hour above a calm one (0.500 = chance)</td><td class="num">' + num(p.auc_score, 3) +
          '</td><td class="num">' + num(p.auc_trailing, 3) + '</td></tr>' +
        '<tr><td>Big-move rate in the top tenth, against the ordinary rate</td><td class="num">' + num(p.top_decile_lift, 2) +
          '×</td><td class="num">' + num(p.top_decile_lift_trailing, 2) + '×</td></tr>' +
        '<tr><td>Correlation left once the last hour’s volatility is allowed for</td><td class="num">' +
          num(p.partial_corr_score_fwd, 3) + '</td><td class="num">—</td></tr>';
      var note = root.querySelector("[data-x=ci-note]");
      if (note) {
        note.innerHTML = 'Top-tenth lift <b>' + num(p.top_decile_lift_observed, 2) + '×</b>, 95% interval <b>' +
          ci + '</b> &mdash; resampled by whole trading days, because consecutive minutes are not independent observations. ' +
          'A textbook interval computed as if they were would have claimed ' +
          (p.lift_ci_naive ? num(p.lift_ci_naive[0], 2) + ' to ' + num(p.lift_ci_naive[1], 2) : "—") + ', which would be wrong.';
      }
    }
  }

  fetch("data/year_study.json")
    .then(function (r) { if (!r.ok) throw new Error("http " + r.status); return r.json(); })
    .then(render)
    .catch(function (e) { if (window.console) console.warn("year study unavailable:", e.message); });
})();
