/* Drossel–Schwabl forest-fire model — a JavaScript port of components/forest_fire_sim.py
 * from the SOC Analysis project (class ForestFireSimulation.step).
 *
 * Every rule is evaluated on the grid as it stood at the start of the step, then all
 * changes are applied at once (synchronous update), exactly as the NumPy version does:
 *   1. burning (2)  -> empty (0)
 *   2. tree (1) with a burning 4-neighbour (up / down / left / right, no wrap-around) -> burning
 *   3. otherwise a tree -> burning with probability f            (lightning)
 *   4. otherwise a tree stays a tree
 *   5. empty -> tree with probability p, else stays empty         (growth)
 * A "fire event" is the number of cells that ignited in one step (rules 2 + 3) and is
 * recorded whenever it is > 0, matching `fire_sizes` in the Python class.
 * Initial grid: each cell is a tree with probability 0.4.
 * Defaults: 150 x 150 cells, p = 0.003, f = 0.00001.
 *
 * Vanilla JS, no dependencies. Works in the browser (UI wiring below) and in Node
 * (module.exports) so the port can be tested against the Python original.
 */
(function (root) {
  'use strict';

  var EMPTY = 0, TREE = 1, BURNING = 2;
  var LOG_BINS = 30;           // np.logspace(0, log10(max + 1), 30) -> 30 edges, 29 bins

  function ForestFire(size, p, f, rand) {
    this.p = p;
    this.f = f;
    this.rand = rand || Math.random;
    this.reset(size);
  }

  ForestFire.prototype.reset = function (size) {
    var n = this.size = size | 0, N = n * n, rand = this.rand, trees = 0;
    this.grid = new Uint8Array(N);
    this.next = new Uint8Array(N);
    for (var i = 0; i < N; i++) {
      if (rand() < 0.4) { this.grid[i] = TREE; trees++; }
    }
    this.timestep = 0;
    this.treeCount = trees;
    this.burningCount = 0;
    this.lastFireSize = 0;
    this.fireEvents = 0;      // number of steps with at least one ignition (len(fire_sizes))
    this.fireSum = 0;         // sum of fire sizes, for the mean
    this.fireMax = 0;
    this.sizeCounts = new Int32Array(N + 1);   // sizeCounts[s] = how many events of size s
  };

  ForestFire.prototype.step = function () {
    var n = this.size, g = this.grid, ng = this.next, p = this.p, f = this.f, rand = this.rand;
    var ignited = 0, trees = 0, i = 0;
    for (var y = 0; y < n; y++) {
      for (var x = 0; x < n; x++, i++) {
        var s = g[i];
        if (s === BURNING) {
          ng[i] = EMPTY;                                            // rule 1
        } else if (s === TREE) {
          if ((y > 0 && g[i - n] === BURNING) || (y < n - 1 && g[i + n] === BURNING) ||
              (x > 0 && g[i - 1] === BURNING) || (x < n - 1 && g[i + 1] === BURNING)) {
            ng[i] = BURNING; ignited++;                             // rule 2 (spread)
          } else if (rand() < f) {
            ng[i] = BURNING; ignited++;                             // rule 3 (lightning)
          } else {
            ng[i] = TREE; trees++;                                  // rule 4
          }
        } else if (rand() < p) {
          ng[i] = TREE; trees++;                                    // rule 5 (growth)
        } else {
          ng[i] = EMPTY;
        }
      }
    }
    this.grid = ng; this.next = g;
    this.timestep++;
    this.treeCount = trees;
    this.burningCount = ignited;
    this.lastFireSize = ignited;
    if (ignited > 0) {
      this.sizeCounts[ignited]++;
      this.fireEvents++;
      this.fireSum += ignited;
      if (ignited > this.fireMax) this.fireMax = ignited;
    }
  };

  ForestFire.prototype.steps = function (k) { for (var i = 0; i < k; i++) this.step(); };
  ForestFire.prototype.density = function () { return this.treeCount / (this.size * this.size); };
  ForestFire.prototype.meanFire = function () { return this.fireEvents ? this.fireSum / this.fireEvents : 0; };

  /* Log-binned histogram of fire sizes, the same binning as create_fire_distribution_chart():
   * edges = logspace(0, log10(max + 1), 30); bin centres are the arithmetic mid-points;
   * only non-empty bins are returned. */
  ForestFire.prototype.logBins = function () {
    var max = this.fireMax, out = { centers: [], counts: [] };
    if (max < 1) return out;
    var nb = LOG_BINS - 1, top = Math.log10(max + 1), counts = new Float64Array(nb), edges = new Float64Array(LOG_BINS);
    for (var j = 0; j < LOG_BINS; j++) edges[j] = Math.pow(10, top * j / nb);
    var sc = this.sizeCounts;
    for (var s = 1; s <= max; s++) {
      var c = sc[s];
      if (!c) continue;
      var b = Math.floor(Math.log10(s) / top * nb);
      if (b >= nb) b = nb - 1;
      counts[b] += c;
    }
    for (var k = 0; k < nb; k++) {
      if (counts[k] > 0) { out.centers.push((edges[k] + edges[k + 1]) / 2); out.counts.push(counts[k]); }
    }
    return out;
  };

  /* Ordinary least squares slope of log10(count) on log10(size) over the non-empty bins. */
  function logLogSlope(bins) {
    var n = bins.centers.length;
    if (n < 5) return null;
    var sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (var i = 0; i < n; i++) {
      var x = Math.log10(bins.centers[i]), y = Math.log10(bins.counts[i]);
      sx += x; sy += y; sxx += x * x; sxy += x * y;
    }
    var d = n * sxx - sx * sx;
    if (d === 0) return null;
    var slope = (n * sxy - sx * sy) / d;
    return { slope: slope, intercept: (sy - slope * sx) / n };
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { ForestFire: ForestFire, logLogSlope: logLogSlope };
  }
  root.ForestFire = ForestFire;

  /* ----------------------------------------------------------------------------------
   * Browser UI. Everything below only runs when the page's controls exist.
   * -------------------------------------------------------------------------------- */
  if (typeof document === 'undefined') return;

  function init() {
    var $ = function (id) { return document.getElementById(id); };
    var gridCanvas = $('ff-grid'), plotCanvas = $('ff-plot');
    if (!gridCanvas || !plotCanvas) return;

    var el = {
      size: $('ff-size'), p: $('ff-p'), f: $('ff-f'), speed: $('ff-speed'),
      run: $('ff-run'), step500: $('ff-step500'), step5000: $('ff-step5000'), reset: $('ff-reset'),
      pOut: $('ff-p-out'), fOut: $('ff-f-out'), ratio: $('ff-ratio'),
      t: $('ff-t'), trees: $('ff-trees'), burning: $('ff-burning'), events: $('ff-events'),
      mean: $('ff-mean'), max: $('ff-max'), slope: $('ff-slope'), status: $('ff-status')
    };

    var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var sim = new ForestFire(parseInt(el.size.value, 10), parseFloat(el.p.value), parseFloat(el.f.value));

    // Cell colours: fixed, drawn on the canvas's own dark ground so they read on light and dark pages.
    var PALETTE = [[36, 28, 20], [52, 168, 83], [255, 96, 32]];   // empty (dark soil), tree, burning
    var off = document.createElement('canvas'), offCtx = off.getContext('2d'), img = null;
    var ctx = gridCanvas.getContext('2d', { alpha: false });
    var pctx = plotCanvas.getContext('2d');

    var wantRun = !reduceMotion;      // the visitor's intent (Run / Pause button)
    var inView = true, pending = 0, frame = 0, rafId = 0, slowTick = 0;
    var SPEEDS = { slow: { every: 4, steps: 1 }, medium: { every: 1, steps: 1 }, fast: { every: 1, steps: 10 }, turbo: { every: 1, steps: 50 } };

    function fmt(n) { return n.toLocaleString('en-US'); }

    function syncOffscreen() {
      if (off.width !== sim.size) {
        off.width = off.height = sim.size;
        img = offCtx.createImageData(sim.size, sim.size);
      }
    }

    function fitCanvas(c, cssH) {
      var dpr = window.devicePixelRatio || 1, w = c.clientWidth || 300, h = cssH || w;
      var W = Math.round(w * dpr), H = Math.round(h * dpr);
      if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    }

    function drawGrid() {
      syncOffscreen();
      var d = img.data, g = sim.grid, N = g.length, k = 0;
      for (var i = 0; i < N; i++, k += 4) {
        var c = PALETTE[g[i]];
        d[k] = c[0]; d[k + 1] = c[1]; d[k + 2] = c[2]; d[k + 3] = 255;
      }
      offCtx.putImageData(img, 0, 0);
      fitCanvas(gridCanvas);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(off, 0, 0, gridCanvas.width, gridCanvas.height);
    }

    function updateStats() {
      el.t.textContent = fmt(sim.timestep);
      el.trees.textContent = (sim.density() * 100).toFixed(1) + '%';
      el.burning.textContent = fmt(sim.burningCount);
      el.events.textContent = fmt(sim.fireEvents);
      el.mean.textContent = sim.fireEvents ? sim.meanFire().toFixed(1) : '–';
      el.max.textContent = sim.fireEvents ? fmt(sim.fireMax) : '–';
    }

    var themeCache = null;
    function theme() {
      if (themeCache) return themeCache;
      var cs = getComputedStyle(document.documentElement);
      var get = function (name, fallback) { var v = cs.getPropertyValue(name).trim(); return v || fallback; };
      themeCache = { text: get('--text', '#1a1a1a'), muted: get('--muted', '#6b6b6b'), border: get('--border', '#e4e4e0'),
                     accent: get('--accent', '#2563eb'), surface: get('--surface-2', '#f0f1ee') };
      return themeCache;
    }
    if (window.matchMedia) {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () { themeCache = null; drawPlot(); });
    }

    function tickLabel(e) { return e >= 3 ? (Math.pow(10, e - 3)) + 'k' : String(Math.pow(10, e)); }

    function drawPlot() {
      fitCanvas(plotCanvas, 240);
      var dpr = window.devicePixelRatio || 1, W = plotCanvas.width / dpr, H = plotCanvas.height / dpr, T = theme();
      pctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      pctx.clearRect(0, 0, W, H);
      var m = { l: 46, r: 14, t: 14, b: 30 }, pw = W - m.l - m.r, ph = H - m.t - m.b;
      var bins = sim.logBins();
      var fit = logLogSlope(bins);
      var xMaxE = Math.max(1, Math.ceil(Math.log10(Math.max(sim.fireMax, 1) + 1)));
      var yMaxC = 1;
      for (var i = 0; i < bins.counts.length; i++) if (bins.counts[i] > yMaxC) yMaxC = bins.counts[i];
      var yMaxE = Math.max(1, Math.ceil(Math.log10(yMaxC) + 1e-9));
      var X = function (v) { return m.l + Math.log10(v) / xMaxE * pw; };
      var Y = function (v) { return m.t + ph - Math.log10(v) / yMaxE * ph; };

      pctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
      pctx.lineWidth = 1;
      // grid lines + ticks at powers of ten
      for (var e = 0; e <= xMaxE; e++) {
        var gx = X(Math.pow(10, e));
        pctx.strokeStyle = T.border; pctx.beginPath(); pctx.moveTo(gx, m.t); pctx.lineTo(gx, m.t + ph); pctx.stroke();
        pctx.fillStyle = T.muted; pctx.textAlign = 'center'; pctx.textBaseline = 'top'; pctx.fillText(tickLabel(e), gx, m.t + ph + 6);
      }
      for (var e2 = 0; e2 <= yMaxE; e2++) {
        var gy = Y(Math.pow(10, e2));
        pctx.strokeStyle = T.border; pctx.beginPath(); pctx.moveTo(m.l, gy); pctx.lineTo(m.l + pw, gy); pctx.stroke();
        pctx.fillStyle = T.muted; pctx.textAlign = 'right'; pctx.textBaseline = 'middle'; pctx.fillText(tickLabel(e2), m.l - 6, gy);
      }
      pctx.strokeStyle = T.muted;
      pctx.beginPath(); pctx.moveTo(m.l, m.t); pctx.lineTo(m.l, m.t + ph); pctx.lineTo(m.l + pw, m.t + ph); pctx.stroke();
      pctx.fillStyle = T.muted; pctx.textAlign = 'center'; pctx.textBaseline = 'alphabetic';
      pctx.fillText('fire size (cells ignited in one step)', m.l + pw / 2, H - 4);
      pctx.save(); pctx.translate(11, m.t + ph / 2); pctx.rotate(-Math.PI / 2); pctx.fillText('frequency', 0, 0); pctx.restore();

      if (sim.fireEvents <= 10) {
        pctx.fillStyle = T.muted; pctx.textAlign = 'center'; pctx.textBaseline = 'middle';
        pctx.fillText('Collecting fire events (' + sim.fireEvents + ' of 10 needed)…', m.l + pw / 2, m.t + ph / 2);
        el.slope.textContent = '–';
        return;
      }
      if (fit) {
        var x0 = bins.centers[0], x1 = bins.centers[bins.centers.length - 1];
        var y0 = Math.pow(10, fit.intercept + fit.slope * Math.log10(x0)), y1 = Math.pow(10, fit.intercept + fit.slope * Math.log10(x1));
        pctx.save(); pctx.setLineDash([4, 4]); pctx.strokeStyle = T.muted; pctx.lineWidth = 1.2;
        pctx.beginPath(); pctx.moveTo(X(x0), Y(Math.max(y0, 1e-9))); pctx.lineTo(X(x1), Y(Math.max(y1, 1e-9))); pctx.stroke(); pctx.restore();
        el.slope.textContent = fit.slope.toFixed(2);
      } else {
        el.slope.textContent = '–';
      }
      pctx.fillStyle = T.accent;
      for (var j = 0; j < bins.centers.length; j++) {
        pctx.beginPath(); pctx.arc(X(bins.centers[j]), Y(bins.counts[j]), 3.5, 0, Math.PI * 2); pctx.fill();
      }
    }

    function setRunLabel() {
      var running = wantRun;
      el.run.textContent = running ? 'Pause' : 'Run';
      el.run.setAttribute('aria-pressed', running ? 'true' : 'false');
      el.status.textContent = running ? (inView && !document.hidden ? 'running' : 'paused while off-screen') : 'paused';
    }

    function loop() {
      rafId = 0;
      var active = wantRun && inView && !document.hidden, did = false;
      if (active) {
        var sp = SPEEDS[el.speed.value] || SPEEDS.medium;
        if (++slowTick >= sp.every) { slowTick = 0; sim.steps(sp.steps); did = true; }
      }
      if (pending > 0) {                       // drain "+500 / +5000 steps" in chunks so the page never blocks
        var chunk = Math.min(pending, 250); sim.steps(chunk); pending -= chunk; did = true;
      }
      if (did || frame === 0) {
        drawGrid(); updateStats();
        if (frame % 12 === 0 || pending === 0 && !active) drawPlot();
      }
      frame++;
      if (active || pending > 0) rafId = requestAnimationFrame(loop);
    }
    function kick() { if (!rafId) rafId = requestAnimationFrame(loop); }

    function showParams() {
      var p = parseFloat(el.p.value), f = parseFloat(el.f.value);
      el.pOut.textContent = p.toFixed(4);
      el.fOut.textContent = f.toFixed(6);
      var ratio = f > 0 ? p / f : Infinity;
      el.ratio.textContent = isFinite(ratio) ? Math.round(ratio).toLocaleString('en-US') : '∞';
      el.ratio.className = (ratio >= 100 && ratio <= 1000) ? 'ok' : 'warn';
    }

    el.p.addEventListener('input', function () { sim.p = parseFloat(el.p.value); showParams(); });
    el.f.addEventListener('input', function () { sim.f = parseFloat(el.f.value); showParams(); });
    el.size.addEventListener('change', function () { sim.reset(parseInt(el.size.value, 10)); pending = 0; frame = 0; drawGrid(); updateStats(); drawPlot(); kick(); });
    el.reset.addEventListener('click', function () { sim.reset(sim.size); pending = 0; frame = 0; drawGrid(); updateStats(); drawPlot(); kick(); });
    el.run.addEventListener('click', function () { wantRun = !wantRun; setRunLabel(); kick(); });
    el.step500.addEventListener('click', function () { pending += 500; kick(); });
    el.step5000.addEventListener('click', function () { pending += 5000; kick(); });

    document.addEventListener('visibilitychange', function () { setRunLabel(); kick(); });
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        inView = entries[0].isIntersecting; setRunLabel(); kick();
      }, { threshold: 0.05 }).observe(gridCanvas);
    }
    if ('ResizeObserver' in window) {
      new ResizeObserver(function () { drawGrid(); drawPlot(); }).observe(gridCanvas.parentNode);
    } else {
      window.addEventListener('resize', function () { drawGrid(); drawPlot(); });
    }

    showParams(); setRunLabel(); drawGrid(); updateStats(); drawPlot(); kick();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})(typeof window !== 'undefined' ? window : globalThis);
