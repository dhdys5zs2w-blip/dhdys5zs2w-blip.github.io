/* Tucson Grid & Battery Model — page script.
   No build step, no external resources: parses data/tepc_2025_hourly.csv in the browser,
   draws the explorer with the site's vendored Apache ECharts 5.5.1, and runs the per-day
   peak-shaving dispatch ported from grid_model.py (shave_day = water-filling from the top,
   fill_valleys = recharge into the same day's lowest hours, apply_fleet = both, every day). */
(function () {
  'use strict';

  var FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var TOP_N = 10;
  var LDC_RANKS = [1, 10, 50, 100, 200, 400, 1000, 2000, 4000];

  var $ = function (id) { return document.getElementById(id); };
  var fmt0 = function (n) { return Math.round(n).toLocaleString('en-US'); };
  var fmt1 = function (n) { return n.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }); };
  var fmt2 = function (n) { return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  var hourTick = function (h) { return h === 0 ? '12am' : h === 12 ? 'noon' : h < 12 ? h + 'am' : (h - 12) + 'pm'; };
  var hourEnding = function (h) { return 'hour ending ' + (h === 0 ? '12 am' : h === 12 ? '12 pm' : h < 12 ? h + ' am' : (h - 12) + ' pm'); };
  var dayLabel = function (iso) { return MON[+iso.slice(5, 7) - 1] + ' ' + (+iso.slice(8, 10)); };
  var utc = function (ms) { var d = new Date(ms); return { m: d.getUTCMonth(), d: d.getUTCDate(), h: d.getUTCHours(), w: d.getUTCDay() }; };
  var tsLabel = function (ms) { var u = utc(ms); return DOW[u.w] + ', ' + MON[u.m] + ' ' + u.d + ', 2025 · ' + hourEnding(u.h); };
  var signed = function (n, unit) { return (n < 0 ? '−' : '+') + fmt0(Math.abs(n)) + unit; };

  // ---------------------------------------------------------------- theme
  var darkMQ = window.matchMedia('(prefers-color-scheme: dark)');
  function theme() {
    var cs = getComputedStyle(document.documentElement);
    var dark = darkMQ.matches;
    var v = function (name, fb) { var x = cs.getPropertyValue(name).trim(); return x || fb; };
    return {
      dark: dark,
      text: v('--text', dark ? '#ececec' : '#1a1a1a'),
      muted: v('--muted', dark ? '#9a9aa2' : '#6b6b6b'),
      border: v('--border', dark ? '#2a2a2e' : '#e4e4e0'),
      surface: v('--surface', dark ? '#1c1c1f' : '#ffffff'),
      grid: dark ? '#2a2a2e' : '#ececea',
      ghost: dark ? '#4b4b53' : '#cfcfca',
      // categorical slots, validated for each surface (dark steps are not a flip of the light ones)
      blue: dark ? '#3987e5' : '#2a78d6',
      orange: dark ? '#d95926' : '#eb6834',
      aqua: dark ? '#199e70' : '#1baf7a'
    };
  }
  function axisY(t, extra) {
    var a = {
      type: 'value', axisLine: { show: false }, axisTick: { show: false },
      axisLabel: { color: t.muted, fontSize: 11, formatter: function (x) { return fmt0(x); } },
      splitLine: { lineStyle: { color: t.grid, width: 1 } }
    };
    for (var k in extra) a[k] = extra[k];
    return a;
  }
  function tooltip(t, extra) {
    var o = {
      backgroundColor: t.surface, borderColor: t.border, borderWidth: 1, padding: [8, 10],
      textStyle: { color: t.text, fontSize: 12, fontFamily: FONT },
      extraCssText: 'box-shadow:0 4px 16px rgba(0,0,0,.14);border-radius:8px;',
      axisPointer: { lineStyle: { color: t.muted, width: 1 }, shadowStyle: { color: t.dark ? 'rgba(255,255,255,.06)' : 'rgba(0,0,0,.05)' } }
    };
    for (var k in extra) o[k] = extra[k];
    return o;
  }
  function tipHead(t, text) { return '<div style="color:' + t.muted + ';margin-bottom:4px">' + text + '</div>'; }
  function tipRow(t, color, value, name) {
    return '<div style="display:flex;align-items:center;gap:8px;margin:2px 0">' +
      '<span style="display:inline-block;width:12px;height:3px;border-radius:2px;background:' + color + '"></span>' +
      '<strong style="font-variant-numeric:tabular-nums">' + value + '</strong>' +
      '<span style="color:' + t.muted + '">' + name + '</span></div>';
  }
  function legend(t, data, extra) {
    // right-aligned so it never collides with the y-axis name at the top-left
    var o = { data: data, top: 0, right: 8, itemGap: 14, itemWidth: 14, itemHeight: 3, icon: 'roundRect', textStyle: { color: t.muted, fontSize: 12 } };
    for (var k in extra) o[k] = extra[k];
    return o;
  }

  // ---------------------------------------------------------------- data
  var D = null;           // parsed data and derived structures
  var sim = null;         // last simulation result
  var state = { month: 7, day: 0, top: [], ldcZoom: 'all', mode: 'daily', dur: 4 };
  var charts = {};

  function parseCSV(text) {
    var lines = text.split(/\r?\n/);
    var head = lines[0].split(',');
    var iT = head.indexOf('ts_az'), iV = head.indexOf('demand_mw');
    if (iT < 0 || iV < 0) throw new Error('unexpected CSV columns: ' + lines[0]);
    var ts = [], mw = [];
    for (var i = 1; i < lines.length; i++) {
      if (!lines[i]) continue;
      var p = lines[i].split(',');
      var v = parseFloat(p[iV]);
      if (!isFinite(v)) continue;
      ts.push(p[iT]); mw.push(v);
    }
    return { ts: ts, mw: mw };
  }

  function derive(raw) {
    var n = raw.mw.length, i, m, h;
    var ms = new Array(n), hour = new Array(n), month = new Array(n), days = [];
    var last = '';
    for (i = 0; i < n; i++) {
      var s = raw.ts[i];
      var y = +s.slice(0, 4), mo = +s.slice(5, 7), d = +s.slice(8, 10), hh = +s.slice(11, 13);
      ms[i] = Date.UTC(y, mo - 1, d, hh);
      hour[i] = hh; month[i] = mo - 1;
      var key = s.slice(0, 10);
      if (key !== last) { days.push({ date: key, start: i, len: 0 }); last = key; }
      days[days.length - 1].len++;
    }
    // stats
    var peak = -Infinity, ip = 0, mn = Infinity, im = 0, sum = 0;
    for (i = 0; i < n; i++) {
      var v = raw.mw[i]; sum += v;
      if (v > peak) { peak = v; ip = i; }
      if (v < mn) { mn = v; im = i; }
    }
    var thr90 = 0.9 * peak, h90 = 0, h3000 = 0;
    for (i = 0; i < n; i++) { if (raw.mw[i] >= thr90) h90++; if (raw.mw[i] >= 3000) h3000++; }
    // average day by month, monthly summary
    var prof = [], monthly = [];
    for (m = 0; m < 12; m++) {
      var acc = [], cnt = [];
      for (h = 0; h < 24; h++) { acc.push(0); cnt.push(0); }
      var mg = 0, mp = -Infinity, mpi = 0, mmn = Infinity;
      for (i = 0; i < n; i++) {
        if (month[i] !== m) continue;
        acc[hour[i]] += raw.mw[i]; cnt[hour[i]]++; mg += raw.mw[i];
        if (raw.mw[i] > mp) { mp = raw.mw[i]; mpi = i; }
        if (raw.mw[i] < mmn) mmn = raw.mw[i];
      }
      prof.push(acc.map(function (a, k) { return cnt[k] ? a / cnt[k] : null; }));
      monthly.push({ gwh: mg / 1000, peak: mp, peakIdx: mpi, min: mmn });
    }
    var sorted = raw.mw.slice().sort(function (a, b) { return b - a; });
    // top-N days by their own (as-metered) peak
    var dayPeaks = days.map(function (dd, k) {
      var p = -Infinity; for (i = dd.start; i < dd.start + dd.len; i++) if (raw.mw[i] > p) p = raw.mw[i];
      return { k: k, peak: p };
    });
    dayPeaks.sort(function (a, b) { return b.peak - a.peak; });
    return {
      n: n, ts: raw.ts, mw: raw.mw, ms: ms, hour: hour, month: month, days: days, prof: prof, monthly: monthly, sorted: sorted,
      stats: { peak: peak, peakIdx: ip, min: mn, minIdx: im, energyGWh: sum / 1000, mean: sum / n, ratio: peak / (sum / n), thr90: thr90, h90: h90, h3000: h3000 },
      top: dayPeaks.slice(0, TOP_N).map(function (x) { return x.k; }),
      dayPeak: dayPeaks.slice().sort(function (a, b) { return a.k - b.k; }).map(function (x) { return x.peak; })
    };
  }

  // ---------------------------------------------------------------- dispatch (ported from grid_model.py)
  // Discharge schedule for one day: min(max(v - T, 0), P) per hour, with T chosen by bisection so the
  // day's discharge equals E (energy limit). floorT = 0 is grid_model.py's rule; a higher floor is the
  // "only above a target" rule (the battery never pulls the day below the target).
  function shaveDay(vals, E, P, floorT) {
    var n = vals.length, i, mx = -Infinity;
    for (i = 0; i < n; i++) if (vals[i] > mx) mx = vals[i];
    function energy(T) { var s = 0; for (var k = 0; k < n; k++) { var x = vals[k] - T; if (x > 0) s += x < P ? x : P; } return s; }
    var T;
    if (energy(floorT) <= E) T = floorT;
    else {
      var lo = floorT, hi = mx;
      for (i = 0; i < 60; i++) { var mid = (lo + hi) / 2; if (energy(mid) > E) lo = mid; else hi = mid; }
      T = hi;
    }
    var out = new Array(n);
    for (i = 0; i < n; i++) { var x = vals[i] - T; out[i] = x > 0 ? (x < P ? x : P) : 0; }
    return out;
  }
  // Recharge schedule: add E MWh into the lowest-load hours (valley filling), at most P MW per hour.
  function fillValleys(vals, E, P) {
    var n = vals.length, i, mx = -Infinity;
    for (i = 0; i < n; i++) if (vals[i] > mx) mx = vals[i];
    function energy(T) { var s = 0; for (var k = 0; k < n; k++) { var x = T - vals[k]; if (x > 0) s += x < P ? x : P; } return s; }
    var lo = 0, hi = mx + P, T;          // at T = mx + P every hour of the day draws the full P
    if (energy(hi) <= E) T = hi;
    else {
      for (i = 0; i < 60; i++) { var mid = (lo + hi) / 2; if (energy(mid) < E) lo = mid; else hi = mid; }
      T = hi;
    }
    var out = new Array(n);
    for (i = 0; i < n; i++) { var x = T - vals[i]; out[i] = x > 0 ? (x < P ? x : P) : 0; }
    return out;
  }
  // Energy has to come from somewhere. Discharging D MWh means drawing D/rte MWh back off the grid,
  // and the charger cannot pull more than P MW in any of the day's hours, so D/rte <= hours x P. The
  // day's dispatch is the largest D <= E that satisfies it. At rte = 0 nothing comes back and nothing
  // can be dispatched, which is the honest answer: without the recharge there is no discharge.
  function dayEnergyLimit(vals, E, P, rte) {
    var room = vals.length * P * rte;    // the most the battery can return over one day, after losses
    return room < E ? room : E;
  }
  function simulate(P, E, rte, floorT) {
    var n = D.n, after = new Float64Array(n), flow = new Float64Array(n);
    var dis = 0, chg = 0, ndays = 0, perDay = [], capped = 0;
    for (var k = 0; k < D.days.length; k++) {
      var dd = D.days[k], vals = D.mw.slice(dd.start, dd.start + dd.len), i;
      var lim = (P > 0 && E > 0) ? dayEnergyLimit(vals, E, P, rte) : 0;
      if (lim < E - 1e-6) capped++;
      var s = lim > 0 ? shaveDay(vals, lim, P, floorT) : vals.map(function () { return 0; });
      var used = 0;
      for (i = 0; i < s.length; i++) used += s[i];
      var sh = vals.map(function (v, j) { return v - s[j]; });
      var c = used > 0 ? fillValleys(sh, used / rte, P) : sh.map(function () { return 0; });
      var pk = -Infinity, cc = 0;
      for (i = 0; i < vals.length; i++) {
        var a = sh[i] + c[i];
        after[dd.start + i] = a; flow[dd.start + i] = s[i] - c[i];
        if (a > pk) pk = a; cc += c[i];
      }
      dis += used; chg += cc; if (used > 0) ndays++;
      perDay.push({ before: D.dayPeak[k], after: pk, used: used });
    }
    var peak = -Infinity, h90 = 0;
    for (var j = 0; j < n; j++) { if (after[j] > peak) peak = after[j]; if (after[j] >= D.stats.thr90) h90++; }
    var sorted = Array.prototype.slice.call(after).sort(function (a, b) { return b - a; });
    return { P: P, E: E, rte: rte, floorT: floorT, after: after, flow: flow, perDay: perDay, peak: peak, discharged: dis, charged: chg, days: ndays, h90: h90, capped: capped, sorted: sorted };
  }

  // ---------------------------------------------------------------- tables (the table-view twin of each chart)
  function buildTable(id, headers, rows) {
    var tbl = $(id); if (!tbl) return;
    while (tbl.firstChild) tbl.removeChild(tbl.firstChild);
    var thead = document.createElement('thead'), tr = document.createElement('tr');
    headers.forEach(function (h) { var th = document.createElement('th'); th.textContent = h; tr.appendChild(th); });
    thead.appendChild(tr); tbl.appendChild(thead);
    var tbody = document.createElement('tbody');
    rows.forEach(function (r) {
      var trr = document.createElement('tr');
      r.forEach(function (c, i) { var td = document.createElement('td'); td.textContent = c; if (i > 0) td.className = 'num'; trr.appendChild(td); });
      tbody.appendChild(trr);
    });
    tbl.appendChild(tbody);
  }

  // ---------------------------------------------------------------- facts
  function fillFacts() {
    var s = D.stats;
    $('f-peak').textContent = fmt0(s.peak);
    $('f-peak-l').textContent = 'annual peak · ' + dayLabel(D.ts[s.peakIdx]) + ', 2025, ' + hourEnding(D.hour[s.peakIdx]);
    $('f-energy').textContent = fmt0(s.energyGWh);
    $('f-energy-l').textContent = 'GWh of demand over the ' + fmt0(D.n) + ' metered hours';
    $('f-ratio').textContent = fmt2(s.ratio);
    $('f-ratio-l').textContent = 'peak-to-average ratio (average ' + fmt0(s.mean) + ' MW)';
    $('f-h90').textContent = fmt0(s.h90);
    $('f-h90-l').textContent = 'hours at or above 90% of the peak (≥ ' + fmt0(s.thr90) + ' MW)';
    $('f-min').textContent = fmt0(s.min);
    $('f-min-l').textContent = 'lowest hour · ' + dayLabel(D.ts[s.minIdx]) + ', ' + hourEnding(D.hour[s.minIdx]) + ' (' + fmt1(s.peak / s.min) + '× below the peak)';
    $('r-peak-before').textContent = fmt0(s.peak);
    $('r-peak-before-l').textContent = 'MW peak as metered · ' + dayLabel(D.ts[s.peakIdx]) + ', ' + hourEnding(D.hour[s.peakIdx]);
    var note = $('year-note');
    if (note) note.textContent = 'Drag the slider to zoom. Demand passed 3,000 MW in ' + fmt0(s.h3000) + ' hours, all in summer; the floor of the year is ' + fmt0(s.min) + ' MW in March.';
    buildTable('tbl-months', ['Month', 'Energy (GWh)', 'Peak (MW)', 'Peak hour', 'Lowest hour (MW)'], D.monthly.map(function (m, i) {
      return [MONTH[i], fmt1(m.gwh), fmt0(m.peak), dayLabel(D.ts[m.peakIdx]) + ', ' + hourEnding(D.hour[m.peakIdx]), fmt0(m.min)];
    }));
    var profRows = [];
    for (var h = 0; h < 24; h++) profRows.push([hourEnding(h).replace('hour ending ', '')].concat(D.prof.map(function (p) { return fmt0(p[h]); })));
    buildTable('tbl-prof', ['Hour ending'].concat(MON), profRows);
  }

  // ---------------------------------------------------------------- chart a: the whole year
  function renderYear() {
    var t = theme(), data = new Array(D.n);
    for (var i = 0; i < D.n; i++) data[i] = [D.ms[i], D.mw[i]];
    charts.year.setOption({
      useUTC: true, animation: false, textStyle: { fontFamily: FONT },
      grid: { left: 54, right: 18, top: 30, bottom: 70 },
      tooltip: tooltip(t, {
        trigger: 'axis',
        formatter: function (ps) { var p = ps[0]; return tipHead(t, tsLabel(p.value[0])) + tipRow(t, t.blue, fmt0(p.value[1]) + ' MW', 'demand'); }
      }),
      xAxis: {
        type: 'time', axisLine: { lineStyle: { color: t.border } }, axisTick: { show: false }, splitLine: { show: false },
        axisLabel: { color: t.muted, fontSize: 11, hideOverlap: true, formatter: { year: '{yyyy}', month: '{MMM}', day: '{MMM} {d}', hour: '{MMM} {d} {HH}:00', minute: '{HH}:{mm}', second: '{HH}:{mm}:{ss}', millisecond: '{HH}:{mm}:{ss}' } }
      },
      yAxis: axisY(t, { min: 0, name: 'MW', nameTextStyle: { color: t.muted, align: 'right' } }),
      dataZoom: [
        { type: 'inside', filterMode: 'none' },
        { type: 'slider', height: 26, bottom: 14, filterMode: 'none', borderColor: t.border, backgroundColor: 'transparent',
          fillerColor: t.dark ? 'rgba(57,135,229,.16)' : 'rgba(42,120,214,.12)',
          dataBackground: { lineStyle: { color: t.ghost }, areaStyle: { color: t.grid, opacity: 1 } },
          selectedDataBackground: { lineStyle: { color: t.blue }, areaStyle: { color: t.blue, opacity: .18 } },
          handleStyle: { color: t.surface, borderColor: t.muted }, moveHandleStyle: { color: t.ghost }, emphasis: { moveHandleStyle: { color: t.muted } },
          textStyle: { color: t.muted, fontSize: 11 }, labelFormatter: function (v) { var u = utc(v); return MON[u.m] + ' ' + u.d; } }
      ],
      series: [{ name: 'Demand', type: 'line', data: data, sampling: 'lttb', showSymbol: false, lineStyle: { width: 1.5, color: t.blue }, itemStyle: { color: t.blue }, areaStyle: { color: t.blue, opacity: 0.08 } }]
    }, true);
  }

  // ---------------------------------------------------------------- chart b: average day by month (emphasis form)
  function renderMonthly() {
    var t = theme(), cats = [], series = [];
    for (var h = 0; h < 24; h++) cats.push(String(h));
    for (var m = 0; m < 12; m++) {
      var sel = m === state.month;
      var s = {
        name: MONTH[m], type: 'line', data: D.prof[m], showSymbol: false, symbolSize: 8, z: sel ? 5 : 2,
        lineStyle: { width: sel ? 2.5 : 1.5, color: sel ? t.blue : t.ghost },
        itemStyle: { color: sel ? t.blue : t.ghost, borderColor: t.surface, borderWidth: 2 },
        emphasis: { focus: 'series', lineStyle: { width: 2.5 } }, blur: { lineStyle: { opacity: 0.35 } }
      };
      if (sel) s.markArea = {
        silent: true, itemStyle: { color: t.orange, opacity: 0.08 },
        label: { show: true, position: 'insideBottom', color: t.muted, fontSize: 11, formatter: 'TEP summer\non-peak 3–7 pm' },
        data: [[{ xAxis: '15' }, { xAxis: '19' }]]
      };
      series.push(s);
    }
    charts.monthly.setOption({
      animation: false, textStyle: { fontFamily: FONT },
      grid: { left: 54, right: 18, top: 30, bottom: 44 },
      tooltip: tooltip(t, {
        trigger: 'axis',
        formatter: function (ps) {
          var h = +ps[0].axisValue, rows = ps.slice().sort(function (a, b) { return b.value - a.value; });
          return tipHead(t, hourEnding(h) + ' · average of the month') + rows.map(function (p) {
            var selp = p.seriesName === MONTH[state.month];
            return tipRow(t, selp ? t.blue : t.ghost, fmt0(p.value) + ' MW', selp ? '<b>' + p.seriesName + '</b>' : p.seriesName);
          }).join('');
        }
      }),
      xAxis: {
        type: 'category', data: cats, boundaryGap: false, axisLine: { lineStyle: { color: t.border } }, axisTick: { show: false },
        axisLabel: { color: t.muted, fontSize: 11, interval: 2, formatter: function (v) { return hourTick(+v); } },
        name: 'hour ending (Arizona time)', nameLocation: 'middle', nameGap: 28, nameTextStyle: { color: t.muted, fontSize: 11 }
      },
      yAxis: axisY(t, { min: 0, name: 'MW', nameTextStyle: { color: t.muted, align: 'right' } }),
      series: series
    }, true);
    // readout + button state
    var p = D.prof[state.month], mx = -Infinity, mi = 0, mn = Infinity, ni = 0;
    for (var k = 0; k < 24; k++) { if (p[k] > mx) { mx = p[k]; mi = k; } if (p[k] < mn) { mn = p[k]; ni = k; } }
    var mo = D.monthly[state.month];
    $('month-readout').textContent = MONTH[state.month] + ': the average day runs from ' + fmt0(mn) + ' MW (' + hourEnding(ni) + ') to ' + fmt0(mx) + ' MW (' + hourEnding(mi) + '). The month’s single highest hour was ' + fmt0(mo.peak) + ' MW on ' + dayLabel(D.ts[mo.peakIdx]) + ', and it delivered ' + fmt0(mo.gwh) + ' GWh.';
    var btns = $('month-btns').querySelectorAll('button');
    for (var b = 0; b < btns.length; b++) btns[b].setAttribute('aria-pressed', String(+btns[b].getAttribute('data-m') === state.month));
  }

  // ---------------------------------------------------------------- chart c: load-duration curve
  function renderLDC() {
    var t = theme(), base = D.sorted.map(function (v, i) { return [i + 1, v]; });
    var afterData = sim ? sim.sorted.map(function (v, i) { return [i + 1, v]; }) : [];
    charts.ldc.setOption({
      animation: false, textStyle: { fontFamily: FONT },
      legend: legend(t, ['As metered', 'After battery']),
      grid: { left: 54, right: 18, top: 34, bottom: 70 },
      tooltip: tooltip(t, {
        trigger: 'axis',
        formatter: function (ps) {
          var rank = ps[0].value[0];
          return tipHead(t, 'hour ' + fmt0(rank) + ' of ' + fmt0(D.n) + ', ranked by demand') +
            ps.map(function (p) { return tipRow(t, p.color, fmt0(p.value[1]) + ' MW', p.seriesName); }).join('');
        }
      }),
      xAxis: {
        type: 'value', min: 1, max: D.n, axisLine: { lineStyle: { color: t.border } }, axisTick: { show: false }, splitLine: { show: false },
        axisLabel: { color: t.muted, fontSize: 11, formatter: function (v) { return fmt0(v); } },
        name: 'hours of the year, ranked highest to lowest', nameLocation: 'middle', nameGap: 26, nameTextStyle: { color: t.muted, fontSize: 11 }
      },
      yAxis: axisY(t, { scale: true, name: 'MW', nameTextStyle: { color: t.muted, align: 'right' } }),
      dataZoom: [
        { type: 'inside', filterMode: 'filter' },
        { type: 'slider', height: 20, bottom: 40, filterMode: 'filter', borderColor: t.border, backgroundColor: 'transparent', showDataShadow: false,
          fillerColor: t.dark ? 'rgba(57,135,229,.16)' : 'rgba(42,120,214,.12)', handleStyle: { color: t.surface, borderColor: t.muted },
          moveHandleStyle: { color: t.ghost }, textStyle: { color: t.muted, fontSize: 11 }, labelFormatter: function (v) { return fmt0(v); } }
      ],
      series: [
        { name: 'As metered', type: 'line', data: base, sampling: 'lttb', showSymbol: false, lineStyle: { width: 2, color: t.blue }, itemStyle: { color: t.blue },
          markLine: { silent: true, symbol: 'none', lineStyle: { color: t.muted, type: 'dashed', width: 1 },
            label: { color: t.muted, fontSize: 11, position: 'insideEndTop', formatter: '90% of peak (' + fmt0(D.stats.thr90) + ' MW) · ' + fmt0(D.stats.h90) + ' hours above' },
            data: [{ yAxis: D.stats.thr90 }] } },
        { name: 'After battery', type: 'line', data: afterData, sampling: 'lttb', showSymbol: false, lineStyle: { width: 2, color: t.orange }, itemStyle: { color: t.orange } }
      ]
    }, true);
    applyLdcZoom();
  }
  function applyLdcZoom() {
    var end = state.ldcZoom === 'top400' ? 400 : state.ldcZoom === 'top100' ? 100 : D.n;
    charts.ldc.dispatchAction({ type: 'dataZoom', startValue: 1, endValue: end });
    var btns = $('ldc-btns').querySelectorAll('button');
    for (var b = 0; b < btns.length; b++) btns[b].setAttribute('aria-pressed', String(btns[b].getAttribute('data-z') === state.ldcZoom));
  }
  function ldcTable() {
    var ranks = LDC_RANKS.concat([D.n]);
    buildTable('tbl-ldc', ['Rank (hour of the year)', 'As metered (MW)', 'After battery (MW)'], ranks.map(function (r) {
      return [fmt0(r), fmt0(D.sorted[r - 1]), sim ? fmt0(sim.sorted[r - 1]) : '—'];
    }));
  }

  // ---------------------------------------------------------------- simulator
  function readControls() {
    var P = +$('p-mw').value, eSlider = $('e-mwh');
    // A duration of 4 or 8 hours ties energy to power; "Custom" (0) lets the energy slider float free.
    if (state.dur > 0) {
      var want = Math.min(P * state.dur, +eSlider.max);
      if (+eSlider.value !== want) eSlider.value = String(want);
    }
    var E = +eSlider.value, rte = +$('rte').value / 100, target = +$('target').value;
    $('p-mw-v').textContent = fmt0(P) + ' MW';
    $('e-mwh-v').textContent = fmt0(E) + ' MWh' + (P > 0 ? ' (' + fmt1(E / P) + ' h at full power)' : '');
    $('rte-v').textContent = fmt0(rte * 100) + '%';
    $('target-v').textContent = fmt0(target) + ' MW';
    $('target').disabled = state.mode !== 'target';
    $('target-wrap').classList.toggle('off', state.mode !== 'target');
    var btns = $('mode-btns').querySelectorAll('button'), b;
    for (b = 0; b < btns.length; b++) btns[b].setAttribute('aria-pressed', String(btns[b].getAttribute('data-mode') === state.mode));
    var dbtns = $('dur-btns').querySelectorAll('button');
    for (b = 0; b < dbtns.length; b++) dbtns[b].setAttribute('aria-pressed', String(+dbtns[b].getAttribute('data-dur') === state.dur));
    return { P: P, E: E, rte: rte, floorT: state.mode === 'target' ? target : 0 };
  }
  function runSim() {
    var c = readControls();
    sim = simulate(c.P, c.E, c.rte, c.floorT);
    var s = D.stats, cut = s.peak - sim.peak, pct = cut / s.peak * 100;
    $('r-peak-after').textContent = fmt0(sim.peak);
    var delta = $('r-cut');
    delta.textContent = Math.abs(cut) < 0.5 ? 'no change'
      : (cut > 0 ? '−' : '+') + fmt0(Math.abs(cut)) + ' MW (' + (cut > 0 ? '−' : '+') + fmt1(Math.abs(pct)) + '%)';
    delta.className = 'delta ' + (cut > 0.5 ? 'good' : cut < -0.5 ? 'bad' : '');
    $('r-mwh').textContent = fmt0(sim.discharged);
    $('r-mwh-l').textContent = 'MWh discharged over the year · ' + fmt0(sim.charged) + ' MWh drawn to recharge';
    $('r-cycles').textContent = c.E > 0 ? fmt1(sim.discharged / c.E) : '—';
    $('r-days').textContent = fmt0(sim.days);
    $('r-h90').textContent = fmt0(sim.h90);
    $('r-h90-l').textContent = 'hours at or above 90% of the as-metered peak (' + fmt0(s.h90) + ' before the battery)';
    var notes = [];
    if (c.P <= 0 || c.E <= 0) notes.push('Set both power and energy above zero to dispatch the battery.');
    if (c.P > 0 && c.E > 24 * c.P) notes.push('At ' + fmt0(c.P) + ' MW the battery can discharge at most ' + fmt0(24 * c.P) + ' MWh in a day, so energy above that is never used.');
    if (c.P > 0 && c.E > 0 && c.rte <= 0) notes.push('At zero round-trip efficiency nothing the battery takes in comes back out, so it cannot discharge at all and the peak is unchanged.');
    else if (c.P > 0 && c.E > 0 && c.E <= 24 * c.P && sim.capped > 0) notes.push('At ' + fmt0(c.rte * 100) + '% efficiency every MWh the battery returns costs ' + fmt1(1 / c.rte) + ' MWh drawn back, and at ' + fmt0(c.P) + ' MW it cannot pull that much in a day. The recharge, not the ' + fmt0(c.E) + ' MWh rating, is what limits the dispatch.');
    if (state.mode === 'target' && c.floorT >= s.peak) notes.push('The target is above the year’s peak, so the battery never runs.');
    if (state.mode === 'target' && c.floorT < s.peak && sim.peak > c.floorT + 0.5) notes.push('The battery cannot hold every day at ' + fmt0(c.floorT) + ' MW: on the worst days it runs out of energy or power and the day is flattened as far as it can be.');
    if (cut < -0.5) notes.push('The recharge lifts the overnight valley above the shaved plateau, so the annual peak rises. The Python run hit the same limit beyond about 900 MW of added 4-hour storage.');
    $('sim-note').textContent = notes.join(' ');
    renderTop(); renderDay();
    charts.ldc.setOption({ series: [{ name: 'As metered' }, { name: 'After battery', data: sim.sorted.map(function (v, i) { return [i + 1, v]; }) }] });
    ldcTable();
    buildTable('tbl-top', ['Day', 'Peak as metered (MW)', 'Peak after battery (MW)', 'Cut (MW)', 'MWh discharged that day'], D.top.map(function (k) {
      var pd = sim.perDay[k]; return [dayLabel(D.days[k].date) + ', 2025', fmt0(pd.before), fmt0(pd.after), fmt0(pd.before - pd.after), fmt0(pd.used)];
    }));
  }

  // ---------------------------------------------------------------- simulator charts
  function renderTop() {
    var t = theme(), labels = D.top.map(function (k) { return dayLabel(D.days[k].date); });
    var before = D.top.map(function (k) { return sim.perDay[k].before; }), after = D.top.map(function (k) { return sim.perDay[k].after; });
    var series = D.top.map(function (k, i) {
      return { name: 'c' + i, type: 'line', data: [[labels[i], before[i]], [labels[i], after[i]]], lineStyle: { color: t.ghost, width: 2 }, showSymbol: false, silent: true, z: 1, tooltip: { show: false } };
    });
    series.push({ name: 'As metered', type: 'scatter', data: before, symbolSize: 11, itemStyle: { color: t.blue, borderColor: t.surface, borderWidth: 2 }, z: 3 });
    series.push({ name: 'After battery', type: 'scatter', data: after, symbolSize: 11, itemStyle: { color: t.orange, borderColor: t.surface, borderWidth: 2 }, z: 4 });
    charts.top.setOption({
      animation: false, textStyle: { fontFamily: FONT },
      legend: legend(t, ['As metered', 'After battery'], { icon: 'circle', itemWidth: 10, itemHeight: 10 }),
      grid: { left: 54, right: 18, top: 34, bottom: 40 },
      tooltip: tooltip(t, {
        trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: t.dark ? 'rgba(255,255,255,.06)' : 'rgba(0,0,0,.05)' } },
        formatter: function (ps) {
          var i = ps[0].dataIndex, k = D.top[i], pd = sim.perDay[k];
          return tipHead(t, dayLabel(D.days[k].date) + ', 2025 · daily peak') + tipRow(t, t.blue, fmt0(pd.before) + ' MW', 'as metered') +
            tipRow(t, t.orange, fmt0(pd.after) + ' MW', 'after battery') + tipRow(t, t.ghost, signed(pd.after - pd.before, ' MW'), 'change') +
            '<div style="color:' + t.muted + ';margin-top:4px">click to see this day hour by hour</div>';
        }
      }),
      xAxis: { type: 'category', data: labels, axisLine: { lineStyle: { color: t.border } }, axisTick: { show: false }, axisLabel: { color: t.muted, fontSize: 11, interval: 0, rotate: labels.length > 6 ? 40 : 0 } },
      yAxis: axisY(t, { scale: true, name: 'MW', nameTextStyle: { color: t.muted, align: 'right' },
        min: function (v) { return Math.floor((v.min - 120) / 100) * 100; }, max: function (v) { return Math.ceil((v.max + 60) / 100) * 100; } }),
      series: series
    }, true);
  }
  function renderDay() {
    var t = theme(), dd = D.days[state.day], cats = [], before = [], after = [], base = [], disc = [], rech = [], i;
    for (i = 0; i < dd.len; i++) {
      var b = D.mw[dd.start + i], a = sim.after[dd.start + i];
      cats.push(String(D.hour[dd.start + i])); before.push(b); after.push(a);
      base.push(Math.min(a, b)); disc.push(Math.max(b - a, 0)); rech.push(Math.max(a - b, 0));
    }
    var pb = Math.max.apply(null, before), pa = Math.max.apply(null, after);
    $('day-readout').textContent = dayLabel(dd.date) + ', 2025: peak ' + fmt0(pb) + ' MW as metered, ' + fmt0(pa) + ' MW after the battery (' + signed(pa - pb, ' MW') + '). The bands are the energy the battery removed from the top and put back in the valley.';
    var sel = $('day-select'); if (sel && +sel.value !== state.day) sel.value = String(state.day);
    charts.day.setOption({
      animation: false, textStyle: { fontFamily: FONT },
      legend: legend(t, [{ name: 'As metered', icon: 'path://M0,3h14v3H0z' }, { name: 'After battery', icon: 'path://M0,3h14v3H0z' }, { name: 'Discharge', icon: 'rect' }, { name: 'Recharge', icon: 'rect' }], { itemWidth: 14, itemHeight: 9, left: 60, right: 8 }),
      // four legend items wrap to two lines on narrow screens; leave room above the plot
      grid: { left: 54, right: 18, top: $('chart-day').clientWidth < 520 ? 56 : 34, bottom: 44 },
      tooltip: tooltip(t, {
        trigger: 'axis',
        formatter: function (ps) {
          var i = ps[0].dataIndex, f = sim.flow[dd.start + i];
          return tipHead(t, dayLabel(dd.date) + ' · ' + hourEnding(+cats[i])) + tipRow(t, t.blue, fmt0(before[i]) + ' MW', 'as metered') +
            tipRow(t, t.orange, fmt0(after[i]) + ' MW', 'after battery') +
            tipRow(t, f >= 0 ? t.orange : t.aqua, fmt0(Math.abs(f)) + ' MW', f > 0.5 ? 'battery discharging' : f < -0.5 ? 'battery recharging' : 'battery idle');
        }
      }),
      xAxis: {
        type: 'category', data: cats, boundaryGap: false, axisLine: { lineStyle: { color: t.border } }, axisTick: { show: false },
        axisLabel: { color: t.muted, fontSize: 11, interval: 2, formatter: function (v) { return hourTick(+v); } },
        name: 'hour ending (Arizona time)', nameLocation: 'middle', nameGap: 28, nameTextStyle: { color: t.muted, fontSize: 11 }
      },
      yAxis: axisY(t, { scale: true, name: 'MW', nameTextStyle: { color: t.muted, align: 'right' } }),
      series: [
        { name: 'band', type: 'line', stack: 'band', data: base, showSymbol: false, silent: true, lineStyle: { opacity: 0 }, areaStyle: { opacity: 0 }, itemStyle: { opacity: 0 }, tooltip: { show: false }, z: 0 },
        { name: 'Discharge', type: 'line', stack: 'band', data: disc, showSymbol: false, silent: true, lineStyle: { opacity: 0 }, areaStyle: { color: t.orange, opacity: 0.22 }, itemStyle: { color: t.orange }, z: 0 },
        { name: 'Recharge', type: 'line', stack: 'band', data: rech, showSymbol: false, silent: true, lineStyle: { opacity: 0 }, areaStyle: { color: t.aqua, opacity: 0.28 }, itemStyle: { color: t.aqua }, z: 0 },
        { name: 'As metered', type: 'line', data: before, showSymbol: false, lineStyle: { width: 2, color: t.blue }, itemStyle: { color: t.blue }, z: 3 },
        { name: 'After battery', type: 'line', data: after, showSymbol: false, lineStyle: { width: 2, color: t.orange }, itemStyle: { color: t.orange }, z: 4 }
      ]
    }, true);
    buildTable('tbl-day', ['Hour ending', 'As metered (MW)', 'After battery (MW)', 'Battery (MW, + discharge / − recharge)'], cats.map(function (c, i) {
      var f = sim.flow[dd.start + i];
      return [hourEnding(+c).replace('hour ending ', ''), fmt0(before[i]), fmt0(after[i]), Math.abs(f) < 0.5 ? '0' : signed(f, '')];
    }));
  }

  // ---------------------------------------------------------------- wiring
  function renderAll() { renderYear(); renderMonthly(); renderLDC(); if (sim) { renderTop(); renderDay(); } }
  function resizeAll() { for (var k in charts) charts[k].resize(); }
  var raf = null;
  function scheduleSim() { if (raf) return; raf = requestAnimationFrame(function () { raf = null; runSim(); }); }

  function wire() {
    var mb = $('month-btns');
    for (var m = 0; m < 12; m++) {
      var b = document.createElement('button'); b.type = 'button'; b.textContent = MON[m]; b.setAttribute('data-m', String(m));
      b.setAttribute('aria-pressed', String(m === state.month)); mb.appendChild(b);
    }
    mb.addEventListener('click', function (e) { var b = e.target.closest('button'); if (!b) return; state.month = +b.getAttribute('data-m'); renderMonthly(); });
    $('ldc-btns').addEventListener('click', function (e) { var b = e.target.closest('button'); if (!b) return; state.ldcZoom = b.getAttribute('data-z'); applyLdcZoom(); });
    ['p-mw', 'e-mwh', 'rte', 'target'].forEach(function (id) { $(id).addEventListener('input', scheduleSim); });
    $('e-mwh').addEventListener('input', function () { state.dur = 0; });   // moving energy by hand means "Custom"
    $('dur-btns').addEventListener('click', function (e) { var b = e.target.closest('button'); if (!b) return; state.dur = +b.getAttribute('data-dur'); scheduleSim(); });
    $('mode-btns').addEventListener('click', function (e) { var b = e.target.closest('button'); if (!b) return; state.mode = b.getAttribute('data-mode'); scheduleSim(); });
    $('presets').addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      $('p-mw').value = b.getAttribute('data-p'); $('e-mwh').value = b.getAttribute('data-e'); $('rte').value = b.getAttribute('data-rte');
      state.dur = +(b.getAttribute('data-dur') || 0);
      state.mode = b.getAttribute('data-mode') || 'daily';
      if (b.getAttribute('data-target')) $('target').value = b.getAttribute('data-target');
      scheduleSim();
    });
    var sel = $('day-select');
    D.top.forEach(function (k) { var o = document.createElement('option'); o.value = String(k); o.textContent = dayLabel(D.days[k].date) + ', 2025'; sel.appendChild(o); });
    sel.addEventListener('change', function () { state.day = +sel.value; renderDay(); });
    charts.top.on('click', function (p) { if (p.componentType === 'series' && p.dataIndex != null) { state.day = D.top[p.dataIndex]; renderDay(); } });
    var rt = null;
    window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(resizeAll, 120); });
    if (darkMQ.addEventListener) darkMQ.addEventListener('change', renderAll); else if (darkMQ.addListener) darkMQ.addListener(renderAll);
  }

  function fail(msg) {
    var el = $('load-error'); if (!el) return;
    el.hidden = false; el.textContent = msg;
  }

  function init() {
    if (typeof echarts === 'undefined') { fail('The chart library (assets/vendor/echarts.min.js) did not load, so the charts cannot be drawn.'); return; }
    fetch('data/tepc_2025_hourly.csv').then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    }).then(function (text) {
      D = derive(parseCSV(text));
      state.day = D.top[0];
      fillFacts();
      ['year', 'monthly', 'ldc', 'top', 'day'].forEach(function (k) { charts[k] = echarts.init($('chart-' + k), null, { renderer: 'canvas' }); });
      wire();
      renderYear(); renderMonthly(); renderLDC();
      runSim();
    }).catch(function (err) {
      fail('Could not load data/tepc_2025_hourly.csv (' + err.message + '). The page needs to be served over HTTP; opening the file directly blocks the fetch.');
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
