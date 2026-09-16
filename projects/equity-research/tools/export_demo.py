#!/usr/bin/env python3
"""Export a static, self-contained snapshot of the qe research browser for the portfolio site.

Run from the AnalysisPlatform checkout with its virtualenv. The platform's own web layer is
imported and crawled in-process (FastAPI TestClient), so every page and every payload is exactly
what the live app serves; URLs are then rewritten for a static subpath and the per-symbol series
are trimmed to the model's out-of-sample window.

    cd ~/dev/AnalysisPlatform
    PYTHONPATH=src .venv/bin/python "$PORTFOLIO/projects/equity-research/tools/export_demo.py" \
        --out "$PORTFOLIO/projects/equity-research"

What it writes under --out (hand-written files in the folder are left alone):
    index.html, screener/, model/, research/, health/   crawled pages, URLs rewritten
    symbol/<SYM>.html                                    one page per symbol in the demo slice
    static/                                              the app's CSS/JS/vendor files, patched
    data/calendar.json, data/search.json, data/manifest.json
    data/api/...                                         model and research payloads, verbatim
    data/symbols/<SYM>.json                              per-symbol bundles decoded by static/demo-shim.js
    data/parquet/*.parquet, data/parquet/tables.json     slices for the in-browser SQL console

Options: --limit N (smoke run on N symbols), --reference DIR (also dump the un-encoded payloads so
tools/verify_shim.mjs can check the JavaScript decoder), --skip-parquet.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import shutil
import sys
import time
from datetime import date, datetime
from pathlib import Path
from typing import Any

import duckdb
import polars as pl

QE_ROOT = Path.cwd()
if not (QE_ROOT / "qe.duckdb").exists() or not (QE_ROOT / "src" / "qe").is_dir():
    sys.exit("run this from the AnalysisPlatform checkout (qe.duckdb and src/qe must be here)")
sys.path.insert(0, str(QE_ROOT / "src"))

from qe.web import analytics  # noqa: E402

DB_PATH = (QE_ROOT / "qe.duckdb").resolve()
UNIVERSE = "liquid500"
DEMO_START = date(2016, 1, 1)          # the frozen model's fit_end is 2015-12-31: everything shown is out of sample
INDICATORS_FULL = ("beta_spy_v1", "rvol20_v1")   # whole window: beta feeds the Patterns tab, rvol20 the Options tab
INDICATORS_RECENT = ("atr_pct_v1", "dist_sma200_pct_v1", "rsi_v1", "roc20_v1", "rs_sector_v1")
ANNUALISE = 252 ** 0.5
RECENT_START = date(2023, 9, 1)
SHIPPED_INDICATORS = INDICATORS_FULL + INDICATORS_RECENT

PATTERN_NOTES = {
    "seasonality": (
        "Descriptive, not predictive. SE is s/√n and assumes "
        "independent days; buckets mix regimes across the whole sample."
    ),
    "rolling_beta": (
        "Stored beta_spy_v1 (60-day). Values exist only while the "
        "symbol is in a scored universe; line breaks are membership "
        "gaps, not missing data."
    ),
}
COVERAGE_NOTE = (
    "Indicator values are computed only while the symbol is in a scored universe — sparse "
    "series are expected, not broken. Demo slice: beta since 2016 and six other indicators for "
    "the last three years; the platform stores 25 indicators back to 2005."
)


# --------------------------------------------------------------------------- encoding helpers

def rnd(x: Any, nd: int = 4) -> Any:
    if isinstance(x, float):
        if math.isnan(x) or math.isinf(x):
            return None
        return round(x, nd)
    return x


def compact(obj: Any, nd: int = 4) -> Any:
    """Round floats, stringify dates, drop NaN — recursively."""
    if isinstance(obj, dict):
        return {k: compact(v, nd) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [compact(v, nd) for v in obj]
    if isinstance(obj, float):
        return rnd(obj, nd)
    if isinstance(obj, (datetime, date)):
        return obj.isoformat()
    return obj


def enc_dates(dates: list[str], cal_index: dict[str, int]) -> list[Any]:
    """ISO dates -> runs of calendar indices ([start, count]); a date that is not a trading day
    (with_gap_breaks inserts synthetic midpoints) stays a literal string."""
    out: list[Any] = []
    run: list[int] | None = None
    for d in dates:
        i = cal_index.get(d)
        if i is None:
            if run:
                out.append(run)
                run = None
            out.append(d)
        elif run and run[0] + run[1] == i:
            run[1] += 1
        else:
            if run:
                out.append(run)
            run = [i, 1]
    if run:
        out.append(run)
    return out


def encode_dates_in(obj: Any, cal_index: dict[str, int]) -> Any:
    """Replace every {"dates": [iso...]} with {"dates_e": runs}, recursively."""
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            if k == "dates" and isinstance(v, list) and all(isinstance(d, str) for d in v):
                out["dates_e"] = enc_dates(v, cal_index)
            else:
                out[k] = encode_dates_in(v, cal_index)
        return out
    if isinstance(obj, list):
        return [encode_dates_in(v, cal_index) for v in obj]
    return obj


def _decode_adj(cents: list[int | None], seg: list[list[Any]]) -> list[float | None]:
    """Python mirror of the JS decoder, used to verify the factor segments before shipping them."""
    out: list[float | None] = []
    s = 0
    for i, c in enumerate(cents):
        while s + 1 < len(seg) and seg[s + 1][0] <= i:
            s += 1
        out.append(None if c is None else round(c / 100 * seg[s][1], 4))
    return out


def encode_prices(payload: dict[str, Any], cal_index: dict[str, int]) -> dict[str, Any]:
    """Prices as integer cents with open/high/low as deltas from the close, the adjustment as
    piecewise-constant factor segments (they change only at splits and dividends), volume as
    integers. About a fifth of the size of the verbatim payload; the shim inverts it exactly
    except for the cent rounding of the raw prices."""
    close = payload["close"]
    cents = [None if x is None else int(round(x * 100)) for x in close]

    def delta(arr: list[float | None]) -> list[int | None]:
        return [None if (a is None or ci is None) else int(round(a * 100)) - ci
                for a, ci in zip(arr, cents)]

    ohlc = payload["ohlc"]
    opn = [o[0] for o in ohlc]
    low = [o[2] for o in ohlc]
    high = [o[3] for o in ohlc]
    adj = payload["adj_close"]
    seg: list[list[Any]] = []
    cur: float | None = None
    for i, (a, cl) in enumerate(zip(adj, close)):
        if a is None or cl is None or cl <= 0:
            continue
        f = a / cl
        if cur is None or abs(f / cur - 1.0) > 1e-9:
            seg.append([i, round(f, 10)])
            cur = f
    if seg and seg[0][0] != 0:
        seg[0][0] = 0  # leading bars without an adjusted close inherit the first factor
    use_raw = not seg or len(seg) > 600
    if not use_raw:
        recon = _decode_adj(cents, seg)
        for r, a, cl in zip(recon, adj, close):
            if a is None:
                if cl is not None and r is not None:
                    use_raw = True
                    break
                continue
            if r is None or abs(r - a) / a > 2.5e-3:
                use_raw = True
                break
    adj_e = {"raw": [rnd(a, 4) for a in adj]} if use_raw else {"seg": seg}
    return {
        "symbol": payload["symbol"],
        "n_bars": payload["n_bars"],
        "dates_e": enc_dates(payload["dates"], cal_index),
        "c": cents,
        "dO": delta(opn),
        "dH": delta(high),
        "dL": delta(low),
        "adj_e": adj_e,
        "v": [None if v is None else int(round(v / 100)) for v in payload["volume"]],  # hundreds of shares
        "events": payload["events"],
        "stats": compact(payload["stats"], 6),
    }


def encode_patterns(pt: dict[str, Any], cal_index: dict[str, int], series_ids: set[str]) -> dict[str, Any]:
    """Drawdown, rolling volatility and relative strength are pure functions of the shipped price
    series, so the shim recomputes them in the browser; rolling beta is the beta indicator series
    already in the bundle. What remains is small: the monthly grid, seasonality, the drawdown
    table and the histogram."""
    enc = dict(pt)
    enc["drawdown"] = {"computed": "drawdown"}
    enc["rolling_vol"] = {"computed": "rolling_vol", "window": pt["rolling_vol"].get("window", 63)}
    enc["rel_spy"] = {"computed": "rel_spy"}
    if "beta_spy_v1" in series_ids:
        enc["rolling_beta"] = {"ref": "beta_spy_v1"}
    return encode_dates_in(compact(enc, 5), cal_index)


# --------------------------------------------------------------------------- payload builders
# These mirror qe.web.api.symbol_prices / symbol_patterns on a trimmed frame, so the stats strip,
# the monthly grid and the drawdown table all describe the window the chart shows.

PRICE_COLS = ["date", "open", "high", "low", "close", "adj_close", "volume", "dividend_amt", "split_coef"]


def prices_payload(sym: str, frame: pl.DataFrame) -> dict[str, Any]:
    if frame.is_empty():
        return {"symbol": sym, "n_bars": 0, "dates": [], "stats": {"n_bars": 0}}
    cols = analytics.frame_to_columns(frame, ["date", "open", "high", "low", "close", "adj_close", "volume"])
    return {
        "symbol": sym,
        "n_bars": frame.height,
        "dates": cols["date"],
        "ohlc": [list(t) for t in zip(cols["open"], cols["close"], cols["low"], cols["high"])],
        "close": cols["close"],
        "adj_close": cols["adj_close"],
        "volume": cols["volume"],
        "sma": {str(w): v for w, v in analytics.sma(frame).items()},
        "events": analytics.event_markers(frame),
        "stats": analytics.summary_stats(frame),
    }


def patterns_payload(sym: str, frame: pl.DataFrame, spy: pl.DataFrame,
                     beta: pl.DataFrame) -> dict[str, Any]:
    returns = analytics.daily_returns(frame)
    if beta.height:
        bc = analytics.frame_to_columns(beta, ["date", "value"])
    else:
        bc = {"date": [], "value": []}
    rel = analytics.relative_strength(frame, spy) if sym != "SPY" else {"dates": [], "ratio": []}
    return {
        "symbol": sym,
        "monthly": analytics.monthly_return_grid(returns),
        "by_month": analytics.seasonality(returns, "month"),
        "by_weekday": analytics.seasonality(returns, "weekday"),
        "drawdown": analytics.drawdown_curve(frame),
        "top_drawdowns": analytics.top_drawdowns(frame),
        "rolling_vol": analytics.rolling_ann_vol(returns),
        "rolling_beta": analytics.with_gap_breaks(bc["date"], bc["value"]),
        "histogram": analytics.return_histogram(returns),
        "rel_spy": rel,
        "notes": PATTERN_NOTES,
    }


def indicator_series_payload(sym: str, iid: str, reg: dict[str, Any],
                             series: pl.DataFrame) -> dict[str, Any]:
    cols = analytics.frame_to_columns(series, ["date", "value"]) if series.height else {"date": [], "value": []}
    broken = analytics.with_gap_breaks(cols["date"], cols["value"])
    return {
        "symbol": sym, "indicator_id": iid,
        "name": reg["name"], "kind": reg["kind"], "lookback_bars": reg["lookback_bars"],
        "n_obs": series.height,
        "dates": broken["dates"], "values": broken["values"], "n_segments": broken["n_segments"],
    }


def trim_series(series: dict[str, Any], start: date) -> dict[str, Any]:
    """Drop points before `start` from a {dates, values} pair."""
    keep = [i for i, d in enumerate(series["dates"]) if d >= start.isoformat()]
    out = dict(series)
    out["dates"] = [series["dates"][i] for i in keep]
    out["values"] = [series["values"][i] for i in keep]
    return out


# --------------------------------------------------------------------------- html rewriting

BANNER = (
    '<div class="demo-banner"><span class="demo-tag">Portfolio demo</span>'
    '<span>A static snapshot of a personal quant research platform — {universe_n} current members of a '
    '{universe} universe, daily history since {start}, exported {exported} from the live {db_gb} GB '
    'DuckDB. Every chart and table is the real tool\'s own output.</span>'
    '<a href="{prefix}about/">How this demo works &rarr;</a>'
    '<a class="demo-back" href="{prefix}../../">&larr; Ben Meyer\'s portfolio</a></div>'
)
FOOTER = (
    '<footer><span>Snapshot of the qe research browser exported {exported}. The real app is a '
    'read-only FastAPI + DuckDB service on a single Mac; it never writes, and neither does this '
    'copy. <a href="{prefix}about/">About this demo</a> &middot; '
    '<a href="{prefix}../../">Portfolio</a></span><span class="mono">qe.duckdb &middot; snapshot</span></footer>'
)


def rewrite_html(html: str, prefix: str, ctx: dict[str, Any]) -> str:
    html = html.replace('"/static/', f'"{prefix}static/')
    html = re.sub(r'href="/symbol/([A-Za-z0-9.\-+]+)(#[^"]*)?"',
                  lambda m: f'href="{prefix}symbol/{m.group(1)}.html{m.group(2) or ""}"', html)
    html = re.sub(r'href="/model/[^"#]+(#[^"]*)?"',
                  lambda m: f'href="{prefix}model/{m.group(1) or ""}"', html)
    html = re.sub(r'href="/model(#[^"]*)?"',
                  lambda m: f'href="{prefix}model/{m.group(1) or ""}"', html)
    for p in ("screener", "research", "health"):
        html = re.sub(rf'href="/{p}(#[^"]*)?"',
                      lambda m, p=p: f'href="{prefix}{p}/{m.group(1) or ""}"', html)
    html = html.replace('href="/"', f'href="{prefix}index.html"')
    html = html.replace(str(DB_PATH), "qe.duckdb")
    # the universe picker submits a query the static copy cannot serve; one universe is exported
    html = re.sub(r'<form method="get" action="/screener".*?</form>',
                  f'<p class="muted">universe <span class="mono">{UNIVERSE}</span></p>', html, flags=re.S)
    # nav: the two hand-written pages
    html = html.replace('>Health</a>',
                        f'>Health</a><a href="{prefix}sql/">SQL</a><a href="{prefix}about/">About</a>', 1)
    # scripts: the shim resolves every /api/* call to a static file; it must load before app.js
    tag = f'<script src="{prefix}static/app.js"></script>'
    assert tag in html, "app.js script tag not found"
    html = html.replace(tag, f'<script>window.QE_ROOT = {json.dumps(prefix)};</script>'
                             f'<script src="{prefix}static/demo-shim.js"></script>{tag}', 1)
    css = f'<link rel="stylesheet" href="{prefix}static/qe.css">'
    assert css in html, "qe.css link not found"
    html = html.replace(css, css + f'<link rel="stylesheet" href="{prefix}static/demo.css">', 1)
    html = re.sub(r"<footer>.*?</footer>", FOOTER.format(prefix=prefix, **ctx), html, flags=re.S)
    html = html.replace("</header>", "</header>" + BANNER.format(prefix=prefix, **ctx), 1)
    return html


def patch_static(src: Path, dst: Path) -> None:
    """Copy the app's static tree and patch the three files that assume the app's own origin."""
    if dst.exists():
        for name in ("app.js", "home.js", "model.js", "screener.js", "symbol.js", "qe.css"):
            (dst / name).unlink(missing_ok=True)
        shutil.rmtree(dst / "vendor", ignore_errors=True)
    dst.mkdir(parents=True, exist_ok=True)
    for name in ("home.js", "screener.js", "symbol.js"):
        shutil.copy2(src / name, dst / name)
    shutil.copytree(src / "vendor", dst / "vendor")

    app = (src / "app.js").read_text()
    body_re = re.compile(r"async function qeFetch\(url\) \{.*?\n  \}\n", re.S)
    app, n = body_re.subn(
        "async function qeFetch(url) {\n"
        "    // portfolio demo: every /api/* call is resolved to a static file by demo-shim.js\n"
        "    return window.QE_DEMO.fetch(url);\n  }\n", app, count=1)
    assert n == 1, "qeFetch body not patched"
    old = "'<a href=\"/symbol/' + m.symbol + '\">"
    assert app.count(old) == 1, "search link not found in app.js"
    app = app.replace(old, "'<a href=\"' + window.QE_ROOT + 'symbol/' + m.symbol + '.html\">")
    (dst / "app.js").write_text(app)

    model = (src / "model.js").read_text()
    old = "href='/symbol/\" + r.symbol + \"'"
    assert model.count(old) == 2, "symbol links not found in model.js"
    model = model.replace(old, "href='\" + window.QE_ROOT + \"symbol/\" + r.symbol + \".html'")
    (dst / "model.js").write_text(model)

    css = (src / "qe.css").read_text()
    assert css.count('url("/static/vendor/fonts/') == 4
    css = css.replace('url("/static/vendor/fonts/', 'url("vendor/fonts/')
    (dst / "qe.css").write_text(css)


# --------------------------------------------------------------------------- main

def write_json(path: Path, obj: Any) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(obj, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    path.write_text(text)
    return len(text.encode())


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--reference", default="")
    ap.add_argument("--skip-parquet", action="store_true")
    ap.add_argument("--skip-pages", action="store_true")
    args = ap.parse_args()
    out = Path(args.out).resolve()
    ref = Path(args.reference).resolve() if args.reference else None
    t0 = time.time()

    # ---- phase A: bulk reads on one connection, main thread only ----------------------------
    con = duckdb.connect(str(DB_PATH), read_only=True)
    model = con.execute(
        "SELECT model_id, kind, horizon, universe, fit_end, map_id FROM frozen_models "
        "WHERE active ORDER BY created_at LIMIT 1").fetchone()
    assert model, "no active frozen model"
    model_id = model[0]
    map_id = model[5] or model_id

    as_of = con.execute("SELECT max(date) FROM universe_membership WHERE universe_name = ?", [UNIVERSE]).fetchone()[0]
    members = [r[0] for r in con.execute(
        "SELECT symbol FROM universe_membership WHERE universe_name = ? AND date = ? ORDER BY rank",
        [UNIVERSE, as_of]).fetchall()]
    extra = {r[0] for r in con.execute(
        "SELECT DISTINCT symbol FROM live_book WHERE model_id = ? UNION "
        "SELECT DISTINCT symbol FROM predictions WHERE map_id = ?", [model_id, map_id]).fetchall()}
    symbols = list(dict.fromkeys(["SPY", *members, *sorted(extra)]))
    if args.limit:
        symbols = symbols[: args.limit]
        if "SPY" not in symbols:
            symbols.insert(0, "SPY")
    sym_list = ",".join("'" + s.replace("'", "''") + "'" for s in symbols)
    print(f"symbols: {len(symbols)} ({len(members)} members as of {as_of}, {len(extra - set(members))} book-only)")

    calendar = [r[0].isoformat() for r in con.execute(
        "SELECT date FROM prices_daily WHERE symbol = 'SPY' AND date >= ? ORDER BY date", [DEMO_START]).fetchall()]
    cal_index = {d: i for i, d in enumerate(calendar)}

    prices = con.execute(
        f"SELECT {', '.join(PRICE_COLS + ['symbol'])} FROM prices_daily WHERE date >= ? "
        f"AND symbol IN ({sym_list}) ORDER BY symbol, date", [DEMO_START]).pl()
    ind = con.execute(
        f"SELECT symbol, indicator_id, date, value FROM indicator_values WHERE symbol IN ({sym_list}) AND ("
        f"(indicator_id IN ({','.join(repr(i) for i in INDICATORS_FULL)}) AND date >= ?) OR "
        f"(indicator_id IN ({','.join(repr(i) for i in INDICATORS_RECENT)}) AND date >= ?)) "
        "ORDER BY symbol, indicator_id, date", [DEMO_START, RECENT_START]).pl()
    registry = {r[0]: {"name": r[1], "kind": r[2], "lookback_bars": r[3]} for r in con.execute(
        "SELECT indicator_id, name, kind, lookback_bars FROM indicator_registry").fetchall()}
    search_rows = con.execute(
        f"SELECT symbol, name, exchange, asset_type, status FROM symbols WHERE symbol IN ({sym_list}) "
        "ORDER BY symbol").fetchall()

    counts = {t: con.execute(f'SELECT count(*) FROM "{t}"').fetchone()[0] for t in (
        "prices_daily", "indicator_values", "universe_membership", "targets", "symbols",
        "options_daily", "predictions", "live_book", "daily_signals", "combo_cells", "bin_edges",
        "backtest_scores", "fetch_log", "runs", "research_results")}
    delisted = con.execute(
        "SELECT count(DISTINCT m.symbol), count(DISTINCT CASE WHEN s.delist_date IS NOT NULL THEN m.symbol END) "
        "FROM universe_membership m JOIN symbols s USING (symbol) WHERE m.universe_name = ?", [UNIVERSE]).fetchone()
    record = con.execute(
        "SELECT count(DISTINCT score_date) FILTER (WHERE coalesce(source,'backfill') = 'live'), "
        "count(DISTINCT score_date) FILTER (WHERE coalesce(source,'backfill') <> 'live'), "
        "count(DISTINCT score_date) FILTER (WHERE coalesce(source,'backfill') = 'live' AND scored_at::DATE <= score_date), "
        "min(score_date), max(score_date) FROM predictions WHERE map_id = ?", [map_id]).fetchone()
    price_span = con.execute("SELECT min(date), max(date), count(DISTINCT symbol) FROM prices_daily").fetchone()
    con.close()
    print(f"phase A done in {time.time() - t0:.0f}s: {prices.height:,} price rows, {ind.height:,} indicator rows")

    # ---- per-symbol bundles (pure analytics on the bulk frames) ----------------------------
    spy = prices.filter(pl.col("symbol") == "SPY").select("date", "adj_close").sort("date")
    by_sym = prices.partition_by("symbol", as_dict=True)
    ind_by = ind.partition_by(["symbol", "indicator_id"], as_dict=True)
    bundles: dict[str, dict[str, Any]] = {}
    references: dict[str, dict[str, Any]] = {}
    for sym in symbols:
        frame = by_sym.get((sym,), pl.DataFrame(schema=prices.schema)).sort("date")
        pp = prices_payload(sym, frame)
        beta = ind_by.get((sym, "beta_spy_v1"), pl.DataFrame(schema=ind.schema)).select("date", "value")
        pt = patterns_payload(sym, frame, spy, beta) if frame.height >= 2 else None
        inds = []
        series: dict[str, Any] = {}
        for iid in SHIPPED_INDICATORS:
            s = ind_by.get((sym, iid))
            if s is None or not s.height:
                continue
            s = s.select("date", "value").sort("date")
            inds.append({"indicator_id": iid, "name": registry[iid]["name"], "kind": registry[iid]["kind"],
                         "lookback_bars": registry[iid]["lookback_bars"], "n_obs": s.height,
                         "first_date": s["date"][0].isoformat(), "last_date": s["date"][-1].isoformat()})
            series[iid] = indicator_series_payload(sym, iid, registry[iid], s)
        bundles[sym] = {
            "symbol": sym,
            "prices": pp,
            "patterns": pt,
            "indicators": {"symbol": sym, "indicators": inds, "coverage_note": COVERAGE_NOTE},
            "indicator_series": series,
        }
    print(f"bundles computed in {time.time() - t0:.0f}s")

    # ---- phase B: crawl the app in-process ------------------------------------------------
    from fastapi.testclient import TestClient  # noqa: E402
    from qe.web.app import create_app  # noqa: E402

    app = create_app(db_path=DB_PATH, quiet_window=None)
    client = TestClient(app)
    exported = datetime.now().strftime("%Y-%m-%d")
    ctx = {"universe": UNIVERSE, "universe_n": len(members), "start": DEMO_START.year,
           "exported": exported, "db_gb": f"{DB_PATH.stat().st_size / 1e9:.1f}"}

    def get_json(path: str) -> dict[str, Any]:
        r = client.get(path)
        assert r.status_code == 200, f"{path}: {r.status_code}"
        return r.json()

    def get_html(path: str) -> str:
        r = client.get(path, follow_redirects=True)
        assert r.status_code == 200, f"{path}: {r.status_code}"
        return r.text

    total_bundle_bytes = 0
    for i, sym in enumerate(symbols):
        b = bundles[sym]
        b["model"] = compact(get_json(f"/api/symbol/{sym}/model"), 6)
        opts = get_json(f"/api/symbol/{sym}/options")
        rv = b["indicator_series"].get("rvol20_v1")
        if opts.get("available"):
            if rv is not None:
                # the realized-vol overlay is the shipped rvol20 series, annualised — same
                # gap breaks, same window — so the bundle carries it once
                opts["realized_vol"] = {"dates": rv["dates"],
                                        "values": [None if v is None else v * ANNUALISE for v in rv["values"]],
                                        "n_segments": rv["n_segments"]}
            else:
                opts["realized_vol"] = trim_series(opts["realized_vol"], DEMO_START)
        b["options"] = compact(opts, 5)
        if ref is not None:
            references[sym] = b
        enc_series = {k: encode_dates_in(compact(v, 6 if k == "rvol20_v1" else 4), cal_index)
                      for k, v in b["indicator_series"].items()}
        enc_opts = encode_dates_in(b["options"], cal_index)
        if opts.get("available") and rv is not None:
            enc_opts["realized_vol"] = {"ref": "rvol20_v1", "scale": ANNUALISE}
        enc = {
            "symbol": sym,
            "prices": encode_prices(b["prices"], cal_index) if b["prices"]["n_bars"] else b["prices"],
            "patterns": encode_patterns(b["patterns"], cal_index, set(enc_series)) if b["patterns"] else None,
            "indicators": b["indicators"],
            "indicator_series": enc_series,
            "model": b["model"],
            "options": enc_opts,
        }
        total_bundle_bytes += write_json(out / "data" / "symbols" / f"{sym}.json", enc)
        if not args.skip_pages:
            page = rewrite_html(get_html(f"/symbol/{sym}"), "../", ctx)
            (out / "symbol").mkdir(parents=True, exist_ok=True)
            (out / "symbol" / f"{sym}.html").write_text(page)
        if (i + 1) % 50 == 0:
            print(f"  {i + 1}/{len(symbols)} symbols, {total_bundle_bytes / 1e6:.1f} MB of bundles, {time.time() - t0:.0f}s")
    print(f"bundles written: {total_bundle_bytes / 1e6:.1f} MB for {len(symbols)} symbols")

    if ref is not None:
        for sym, b in references.items():
            write_json(ref / f"{sym}.json", compact(b, 12))
        write_json(ref / "calendar.json", calendar)

    write_json(out / "data" / "calendar.json", calendar)
    write_json(out / "data" / "search.json",
               [{"symbol": r[0], "name": r[1], "exchange": r[2], "asset_type": r[3], "status": r[4]} for r in search_rows])

    api = out / "data" / "api"
    for name in ("paper", "rank_profile", "execution", "regimes"):
        write_json(api / "model" / model_id / f"{name}.json", get_json(f"/api/model/{model_id}/{name}"))
    for source in ("live", "backfill"):
        write_json(api / "model" / model_id / f"deciles_{source}.json",
                   get_json(f"/api/model/{model_id}/deciles?source={source}"))
    write_json(api / "research.json", get_json("/api/research"))

    if not args.skip_pages:
        (out / "index.html").write_text(rewrite_html(get_html("/"), "", ctx))
        for page, path in (("screener", "/screener"), ("model", f"/model/{model_id}"),
                           ("research", "/research"), ("health", "/health")):
            (out / page).mkdir(parents=True, exist_ok=True)
            (out / page / "index.html").write_text(rewrite_html(get_html(path), "../", ctx))
        patch_static(QE_ROOT / "src" / "qe" / "web" / "static", out / "static")
    client.close()
    print(f"phase B done in {time.time() - t0:.0f}s")

    manifest = {
        "exported_at": datetime.now().isoformat(timespec="minutes"),
        "db_size_gb": round(DB_PATH.stat().st_size / 1e9, 2),
        "universe": UNIVERSE, "members": len(members), "membership_as_of": as_of.isoformat(),
        "symbols_in_demo": len(symbols), "demo_start": DEMO_START.isoformat(),
        "calendar": {"first": calendar[0], "last": calendar[-1], "n": len(calendar)},
        "model": {"model_id": model_id, "kind": model[1], "horizon": model[2], "universe": model[3],
                  "fit_end": model[4].isoformat(), "map_id": map_id},
        "record": {"live_days": record[0], "backfill_days": record[1], "committed_in_advance_days": record[2],
                   "first": record[3].isoformat() if record[3] else None,
                   "last": record[4].isoformat() if record[4] else None},
        "full_db": {**counts, "members_ever": delisted[0], "members_delisted": delisted[1],
                    "prices_first": price_span[0].isoformat(), "prices_last": price_span[1].isoformat(),
                    "prices_symbols": price_span[2]},
        "shipped_indicators": list(SHIPPED_INDICATORS),
    }
    write_json(out / "data" / "manifest.json", manifest)

    # ---- phase C: parquet slices for the SQL console (fresh connection, after the crawl) --------
    if not args.skip_parquet:
        pq = out / "data" / "parquet"
        pq.mkdir(parents=True, exist_ok=True)
        con = duckdb.connect(str(DB_PATH), read_only=True)
        tables: list[dict[str, Any]] = []

        def copy(name: str, sql: str, note: str) -> None:
            path = pq / f"{name}.parquet"
            con.execute(f"COPY ({sql}) TO '{path}' (FORMAT PARQUET, COMPRESSION ZSTD)")
            cols = con.execute(f"DESCRIBE SELECT * FROM read_parquet('{path}')").fetchall()
            n = con.execute(f"SELECT count(*) FROM read_parquet('{path}')").fetchone()[0]
            tables.append({"name": name, "rows": n, "bytes": path.stat().st_size, "note": note,
                           "columns": [{"name": c[0], "type": c[1]} for c in cols]})
            print(f"  parquet {name}: {n:,} rows, {path.stat().st_size / 1e6:.2f} MB")

        copy("symbols", "SELECT * FROM symbols",
             "Every listing the vendor reports, active and delisted (delist_date), ~23k rows.")
        copy("universe_membership",
             f"SELECT * FROM universe_membership WHERE universe_name = '{UNIVERSE}' AND (date = '{as_of}' OR date IN "
             "(SELECT min(date) FROM prices_daily WHERE symbol = 'SPY' GROUP BY year(date), month(date))) ORDER BY date, rank",
             "Point-in-time membership of the liquid500 universe: the first session of every month since 2005 plus the latest snapshot. rank is by 20-day dollar volume; close is the raw (as-traded) close.")
        copy("sector_map", "SELECT * FROM sector_map", "Vendor sector and industry labels with the date they were observed.")
        copy("prices_daily",
             f"SELECT symbol, date, open, high, low, close, adj_close, volume, dividend_amt, split_coef FROM prices_daily "
             f"WHERE date >= '2025-01-01' AND symbol IN ({sym_list}) ORDER BY symbol, date",
             "Daily OHLCV with the locally computed adjusted close, 2025 onward, for the demo symbols.")
        copy("indicator_values",
             f"SELECT * FROM indicator_values WHERE symbol IN ({sym_list}) AND date >= "
             "(SELECT date FROM prices_daily WHERE symbol = 'SPY' ORDER BY date DESC LIMIT 1 OFFSET 20) ORDER BY symbol, indicator_id, date",
             "All 25 registered indicators for the demo symbols over the last 21 sessions.")
        copy("indicator_registry", "SELECT * FROM indicator_registry", "The 25 indicators: name, kind (series or cross-sectional), lookback.")
        copy("targets",
             f"SELECT * FROM targets WHERE symbol IN ({sym_list}) AND date >= '2026-06-01' ORDER BY symbol, date, horizon",
             "Forward returns: raw, sector-excess (leave-one-out sector median, date-demeaned) and beta-residual, June 2026 onward — the scored period.")
        copy("frozen_models", "SELECT model_id, kind, horizon, universe, fit_end, buffer_pct, side, git_sha, config_note, created_at, active FROM frozen_models",
             "The frozen artifacts the daily scorer reads. fit_end is the last date the active model ever saw.")
        copy("daily_signals", f"SELECT * FROM daily_signals WHERE map_id = '{map_id}' ORDER BY score_date, rank",
             "Every scored cross-section: the model's score and rank for every member, every scored day.")
        copy("predictions", f"SELECT * FROM predictions WHERE map_id = '{map_id}' ORDER BY score_date, rank",
             "The append-only record: the held names each day with their realized next-day returns. scored_at::date > score_date marks a day scored in arrears.")
        copy("live_book", f"SELECT * FROM live_book WHERE model_id = '{model_id}' ORDER BY score_date, symbol",
             "The paper book, one row per held name per day, with the date it was entered.")
        copy("backtest_daily", f"SELECT * FROM backtest_daily WHERE model_id = '{model_id}' ORDER BY score_date",
             "The registered backtest, one row per day 2016–2026: book excess in bps under three execution legs, plus the pre-named volatility, trend and dispersion regimes.")
        copy("research_results", "SELECT * FROM research_results ORDER BY block, statistic, label",
             "Every statistic a registered research block wrote, with its SE, n and verdict (meta_json).")
        copy("runs", "SELECT run_id, stage, config_hash, config_blob_sha, git_sha, started_at, finished_at, status, config_json, metrics_json FROM runs ORDER BY started_at",
             "The forking-paths ledger: every fit, score and pre-registration with the config hash and git sha it ran under.")
        copy("edge_map", "SELECT * FROM edge_map ORDER BY created_at", "The binned-cell engine's frozen maps (the earlier approach the GBM replaced).")
        copy("options_daily",
             f"SELECT symbol, date, spot, atm_iv30, call_iv30, put_iv30, cp_iv_spread, skew25, dte_near, dte_far, n_contracts, "
             f"oi_calls, oi_puts, pc_oi_ratio FROM options_daily WHERE symbol IN ({sym_list}) AND n_contracts > 0 AND date >= '2024-01-01' ORDER BY symbol, date",
             "Weekly option-chain summaries (Phase Q), 2024 onward: ATM implied vol interpolated to 30 days, call−put spread, 25-delta skew, open interest.")
        con.close()
        write_json(pq / "tables.json", {"exported": exported, "tables": tables})
        print(f"parquet total: {sum(t['bytes'] for t in tables) / 1e6:.1f} MB")

    print(f"done in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
