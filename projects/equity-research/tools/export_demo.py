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
    index.html, screener/, model/, research/, health/,  crawled pages, URLs rewritten
    lab/, returns/
    symbol/<SYM>.html                                    one page per symbol in the demo slice (a full
                                                         run removes pages and bundles of symbols that left it)
    static/                                              the app's CSS/JS/vendor files, patched
    data/calendar.json, data/search.json, data/manifest.json
    data/api/...                                         model and research payloads, verbatim
    data/api/returns/...                                 the return explorer's example questions, answered
    data/symbols/<SYM>.json                              per-symbol bundles decoded by static/demo-shim.js
    data/parquet/*.parquet, data/parquet/tables.json     slices for the in-browser SQL console

Options: --limit N (smoke run on N symbols; the explorer's questions are still answered in full),
--reference DIR (also dump the un-encoded payloads and the explorer's keys so
tools/verify_shim.mjs can check the JavaScript decoder), --skip-parquet, --skip-pages,
--skip-explorer (for scratch and decoder-smoke runs, and the explorer adds about 75 s: with pages
it leaves the explorer out of the copy entirely, server-only as on any snapshot; with
--skip-pages it leaves whatever explorer --out already has untouched).

The explorer is checked and answered before anything is written to --out. If the platform's
page, scripts or endpoint no longer match what the copy patches, the run logs
"EXPLORER DISABLED: <reason>" and carries on as if --skip-explorer had been given (the manifest
records return_explorer_disabled), so a copy edit on one page does not stop the nightly refresh.
"""

from __future__ import annotations

import argparse
import atexit
import hashlib
import html as htmllib
import json
import math
import re
import shutil
import sys
import tempfile
import time
from datetime import date, datetime
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl

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


EXPLORER_NAV = re.compile(
    r'<li data-needs-server>(<a href="/returns"[^>]*><strong>[^<]*</strong><span>)[^<]*(</span>)')
# The platform's blurb invites any slice; this copy answers only the page's own examples. The
# menu is read on every page, so the line has to make sense without the explorer in view.
EXPLORER_BLURB = ("Example questions about what stocks did next, after a model pick, an earnings report "
                  "or a sharp fall, answered when this copy was exported.")


def explorer_nav(html: str) -> str:
    """The nav marks pages that need the live server with data-needs-server and app.js drops them
    from a snapshot. The return explorer ships with its example questions answered (see
    export_explorer), so its entry stays; any other server-only page keeps the marker. Every
    crawled page carries the nav, so a miss means the markup changed and the entry would vanish
    while the palette still offers the page."""
    html, n = EXPLORER_NAV.subn(lambda m: f"<li>{m.group(1)}{EXPLORER_BLURB}{m.group(2)}", html)
    assert n == 1, "nav: the return explorer's server-only entry not found"
    return html


def rewrite_html(html: str, prefix: str, ctx: dict[str, Any]) -> str:
    if ctx["explorer"]:
        html = explorer_nav(html)
    html = html.replace('"/static/', f'"{prefix}static/')
    html = re.sub(r'href="/symbol/([A-Za-z0-9.\-+]+)(#[^"]*)?"',
                  lambda m: f'href="{prefix}symbol/{m.group(1)}.html{m.group(2) or ""}"', html)
    html = re.sub(r'href="/model/[^"#]+(#[^"]*)?"',
                  lambda m: f'href="{prefix}model/{m.group(1) or ""}"', html)
    html = re.sub(r'href="/model(#[^"]*)?"',
                  lambda m: f'href="{prefix}model/{m.group(1) or ""}"', html)
    for p in ("screener", "research", "health", "lab", "returns"):
        html = re.sub(rf'href="/{p}(#[^"]*)?"',
                      lambda m, p=p: f'href="{prefix}{p}/{m.group(1) or ""}"', html)
    html = html.replace('href="/"', f'href="{prefix}index.html"')
    # overview anchors (/#s-map, /#s-status, …) belong to the demo's own index, not the site root
    html = html.replace('href="/#', f'href="{prefix}index.html#')
    html = html.replace(str(DB_PATH), "qe.duckdb")
    # the universe picker submits a query the static copy cannot serve; one universe is exported
    html = re.sub(r'<form method="get" action="/screener".*?</form>',
                  f'<p class="muted">universe <span class="mono">{UNIVERSE}</span></p>', html, flags=re.S)
    # nav: the demo's two hand-written pages join the "Under the hood" menu
    hood = '<ul class="hood-list">'
    assert hood in html, "hood menu not found in the nav"
    html = html.replace(hood, hood +
                        f'<li><a href="{prefix}sql/"><strong>SQL console</strong><span>Query the exported '
                        'tables in your browser.</span></a></li>'
                        f'<li><a href="{prefix}about/"><strong>About this demo</strong><span>How this static '
                        'copy of the site was made.</span></a></li>', 1)
    # scripts: the shim resolves every /api/* call to a static file; it must load before app.js
    tag = f'<script src="{prefix}static/app.js"></script>'
    assert tag in html, "app.js script tag not found"
    # QE_SNAPSHOT tells the pages they are a copy: the overview states the nightly schedule
    # instead of counting down to it, and /health judges freshness as of the export
    snap = json.dumps({"exported_at": ctx["exported_at"]})
    html = html.replace(tag, f'<script>window.QE_ROOT = {json.dumps(prefix)}; window.QE_SNAPSHOT = {snap};</script>'
                             f'<script src="{prefix}static/demo-shim.js"></script>{tag}', 1)
    css = f'<link rel="stylesheet" href="{prefix}static/qe.css">'
    assert css in html, "qe.css link not found"
    html = html.replace(css, css + f'<link rel="stylesheet" href="{prefix}static/demo.css">', 1)
    html = re.sub(r"<footer>.*?</footer>", FOOTER.format(prefix=prefix, **ctx), html, flags=re.S)
    html = html.replace("</header>", "</header>" + BANNER.format(prefix=prefix, **ctx), 1)
    return html


# Hand-written files that live in the demo's static/ beside the copied app files.
HAND_WRITTEN_STATIC = {"demo-shim.js", "demo.css"}

# app.js's two link seams (the platform's tests/test_web_seams.py pins that every link a page
# script builds goes through them), re-rooted for the static subpath.
APP_HREF = "const href = (path) => path;"
DEMO_HREF = (
    "const href = (path) => {\n"
    "    // portfolio demo: app paths -> the static copy's folders\n"
    "    const [p, hash] = path.split(\"#\");\n"
    "    const map = { \"/\": \"index.html\", \"/screener\": \"screener/\", \"/model\": \"model/\",\n"
    "                  \"/research\": \"research/\", \"/health\": \"health/\", \"/lab\": \"lab/\",\n"
    "                  \"/returns\": \"returns/\" };\n"
    "    return window.QE_ROOT + (p in map ? map[p] : p.replace(/^\\//, \"\")) + (hash ? \"#\" + hash : \"\");\n"
    "  };"
)
APP_SYMBOL_HREF = 'const symbolHref = (sym) => "/symbol/" + encodeURIComponent(sym);'
DEMO_SYMBOL_HREF = 'const symbolHref = (sym) => window.QE_ROOT + "symbol/" + encodeURIComponent(sym) + ".html";'

# fx.js leaves the explorer out of the command palette in a snapshot (and so out of "g e", which
# is built from the palette's entries), the same rule as the nav's data-needs-server. The export
# answers the explorer's examples, so the entry goes back in, unconditionally.
FX_EXPLORER = re.compile(r'\.\.\.\(qe\.snapshot \? \[\] : \[(\{ label: "Return explorer",[^\n]*?\})\]\),')
# returns.js, patched where the copy differs from the live page. Each target must occur exactly
# once, so a platform change fails the export instead of shipping a half-patched page.
RETURNS_PATCHES = (
    # On a 422 the page re-reads the answer with a raw fetch() to show the server's reason. The
    # static copy has no server to ask, so the shim supplies the reason instead.
    ('(await fetch("/api/returns?" + q)).json()', 'window.QE_DEMO.returnsError("/api/returns?" + q)'),
    # "yet" promises the question will run once something finishes; in this copy it never will
    ("\"This question can't run yet — see below.\"", "\"This question can't run in this copy — see below.\""),
    # the timing measures a static download here, not the platform working out the answer
    ('" stock-days · " + secs + " s"', '" stock-days · " + (window.QE_API_BASE ? secs + " s" : "stored answer")'),
    # A refusal clears the figures but left the median's sign colour (a lone red or green dash)
    # and the step-1 count of the previous answer. Rare on the live page, one edit away here.
    ('$("x-median").textContent = "—";', '$("x-median").textContent = "—";\n    $("x-median").classList.remove("pos", "neg");'),
    ('$("x-words").textContent = "No figures: this question did not run.";',
     '$("x-words").textContent = "No figures: this question did not run.";\n    $("x-start-n").textContent = "";'),
)


def explorer_scripts(src: Path) -> dict[str, str]:
    """fx.js and returns.js as the copy's explorer needs them, patched in memory. Only an export
    that ships the explorer uses them; without it both are copied as the platform wrote them."""
    fx, n = FX_EXPLORER.subn(r"\1,", (src / "fx.js").read_text())
    assert n == 1, "fx.js: the explorer's snapshot-only palette entry not found"
    rjs = (src / "returns.js").read_text()
    for old, new in RETURNS_PATCHES:
        assert rjs.count(old) == 1, f"returns.js: patch target not found once: {old[:60]}"
        rjs = rjs.replace(old, new)
    return {"fx.js": fx, "returns.js": rjs}


def patch_static(src: Path, dst: Path, explorer_js: dict[str, str]) -> None:
    """Copy the app's static tree (every script, every page stylesheet, the vendored files) and
    patch the places that assume the app's own origin: app.js's transport and link seams,
    qe.css's font URLs, and the explorer's scripts when it is exported (explorer_scripts).
    Every patch is made and checked before dst is touched, so a platform change cannot leave
    static/ half-copied. Hand-written demo files in dst are left alone."""
    app = (src / "app.js").read_text()
    # the transport only: qeFetch keeps announcing to the fetch bar, fetchJson reads the files
    body_re = re.compile(r"async function fetchJson\(url\) \{.*?\n  \}\n", re.S)
    app, n = body_re.subn(
        "async function fetchJson(url) {\n"
        "    // portfolio demo: every /api/* call is resolved to a static file by demo-shim.js\n"
        "    return window.QE_DEMO.fetch(url);\n  }\n", app, count=1)
    assert n == 1, "fetchJson body not patched"
    for old, new in ((APP_HREF, DEMO_HREF), (APP_SYMBOL_HREF, DEMO_SYMBOL_HREF)):
        assert app.count(old) == 1, f"link seam not found in app.js: {old}"
        app = app.replace(old, new)
    css = (src / "qe.css").read_text()
    assert css.count('url("/static/vendor/fonts/') == 4
    css = css.replace('url("/static/vendor/fonts/', 'url("vendor/fonts/')
    patched = {"app.js": app, "qe.css": css, **explorer_js}

    if dst.exists():
        for p in dst.iterdir():
            if p.name in HAND_WRITTEN_STATIC:
                continue
            if p.is_dir():
                shutil.rmtree(p)
            else:
                p.unlink()
    dst.mkdir(parents=True, exist_ok=True)
    for p in sorted(src.iterdir()):
        if p.name.startswith(".") or p.name in patched:
            continue
        if p.is_dir():
            shutil.copytree(p, dst / p.name)
        elif p.suffix in (".js", ".css"):
            shutil.copy2(p, dst / p.name)
    for name, text in patched.items():
        (dst / name).write_text(text)


# --------------------------------------------------------------------------- the return explorer
# /api/returns runs a query per question, so the static copy cannot answer an arbitrary one. It
# answers the questions the page itself offers — its opening question, every literal question
# returns.js can load (the "Start over" view) and the example buttons in the crawled page —
# through the live endpoint, with every bar's drill-down. Anything else gets the page's own 422
# path with a message saying it needs the live database.

# Every query parameter /api/returns takes. The keys below are built from these alone, so a new
# parameter would let the copy serve a stored answer for a question that differs in it; the
# export checks the route still takes exactly these (check_explorer_route), and the shim refuses
# a request carrying any other.
RETURNS_PARAMS = frozenset({"from", "to", "hold", "lag", "ret", "c", "bar"})
_DECIMAL = re.compile(r"-?[0-9]+(\.[0-9]+)?")


def _plain(v: str) -> str:
    """A plain decimal in its shortest spelling (050 -> 50, -0.10 -> -0.1, 5.0 -> 5, -0 -> 0);
    anything else as it is. The page re-serialises every number it sends (token(parse(c)) in
    returns.js) and the endpoint echoes Python's spelling, so a change in either side's number
    formatting must not split one question into two keys. demo-shim.js has the same rule."""
    if not _DECIMAL.fullmatch(v):
        return v
    whole, _, frac = v.lstrip("-").partition(".")
    s = (whole.lstrip("0") or "0") + ("." + frac.rstrip("0") if frac.rstrip("0") else "")
    return "-" + s if v.startswith("-") and s != "0" else s


def _key(one: dict[str, str], conds: list[str]) -> str:
    def esc(v: str) -> str:
        return v.replace("%", "%25").replace("&", "%26").replace("=", "%3D")

    def token(c: str) -> str:
        return ":".join(",".join(_plain(x) for x in f.split(",")) for f in c.split(":"))

    parts = [f"hold={esc(_plain(one.get('hold') or '1'))}", f"lag={esc(_plain(one.get('lag') or '1'))}",
             f"ret={esc(one.get('ret') or 'sector_excess')}"]
    parts += [f"{k}={esc(one[k])}" for k in ("from", "to") if k in one]
    parts += [f"c={esc(token(c))}" for c in conds if c.strip()]
    return "&".join(parts)


def explorer_key(qs: str) -> str:
    """One question's key. demo-shim.js computes the same string from the page's request, so the
    two must change together (tools/verify_shim.mjs checks they agree). The endpoint's defaults
    are filled in, repeated scalars keep their first value, the c tokens keep their order and
    are decoded, numbers are spelled plainly (_plain), and only `&`, `=` and `%` are escaped so
    the key stays readable."""
    one: dict[str, str] = {}
    conds: list[str] = []
    for k, v in parse_qsl(qs, keep_blank_values=True):
        if k == "c":
            conds.append(v)
        elif k not in one:
            one[k] = v
    return _key(one, conds)


def check_explorer_route() -> None:
    from qe.web import api

    found = [frozenset(p.alias for p in r.dependant.query_params)
             for r in api.router.routes if getattr(r, "path", None) == "/api/returns"]
    assert found == [RETURNS_PARAMS], (
        f"/api/returns takes {sorted(found[0]) if found else 'nothing'}, the copy's keys know "
        f"{sorted(RETURNS_PARAMS)}: a new parameter must join explorer_key and returnsKey")


def explorer_questions(page: str, script: str) -> dict[str, Any]:
    """The questions the page offers: its opening question, its example buttons and the view
    "Start over" loads. Read from the platform's own page and script, so a new example is
    exported the night it ships. The copy promises all three kinds on the page and in its
    refusal message, so a missing one disables the explorer rather than shipping a promise it
    breaks."""
    opening = re.findall(r'const DEFAULT_QUERY = "([^"]*)";', script)
    assert len(opening) == 1, "returns.js: DEFAULT_QUERY not found"
    examples = [htmllib.unescape(q) for q in re.findall(r'<button[^>]*\sdata-q="([^"]*)"', page)]
    assert examples, "returns page: no example questions (button[data-q]) found"
    # "Start over" reloads a literal question; a refactor to a constant would silently drop it
    start_over = [q for q in re.findall(r'readQuery\("([^"]*)"\)', script) if "c=" not in q]
    assert len(start_over) == 1, "returns.js: the Start over question (readQuery literal) not found"
    return {"opening": opening[0], "examples": examples, "start_over": start_over[0],
            "all": list(dict.fromkeys(opening + examples + start_over))}


NUMBER_WORDS = ("no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
                "eleven", "twelve")


def _words(n: int) -> str:
    return NUMBER_WORDS[n] if n < len(NUMBER_WORDS) else str(n)


def explorer_note(html: str, offered: dict[str, Any], stats: dict[str, Any], exported: str) -> str:
    """Make the returns page say what this copy can answer. One plain line goes at the top of the
    question builder, above the question rather than beside the examples, which the page hides
    once a question has conditions — as its opening question does. The platform's own lines that
    promise live answers (results update as you go; figures computed by the endpoint) are
    replaced, since here they hold only for the stored questions. The counts come from what the
    endpoint actually answered (export_explorer), so an example it refuses is not claimed."""
    keys = [explorer_key(q) for q in offered["examples"]]
    n = len(keys)
    opening = explorer_key(offered["opening"])
    opens = ("the first of its" if keys[0] == opening else "one of its" if opening in keys
             else "a question of its own, besides its")
    offered_keys = {opening, explorer_key(offered["start_over"]), *keys}
    answered = len(offered_keys) - len(offered_keys & set(stats["refused_keys"]))
    reset = re.search(r'id="x-reset">([^<]+)<', html)
    reset = reset.group(1).strip() if reset else "Start over"
    if stats["refused"]:
        answers = (f'It holds the platform&rsquo;s own answers, computed on {exported} when the copy was '
                   f'exported, for {_words(answered)} of the page&rsquo;s {_words(n)} example questions and the '
                   f'view with no conditions; the platform itself refuses {_words(stats["refused"])} of the '
                   f'examples, and the page shows its reason.')
    else:
        answers = (f'It holds the platform&rsquo;s own answers, computed on {exported} when the copy was '
                   f'exported, for the page&rsquo;s {_words(n)} example questions and the view with no '
                   f'conditions.')
    note = (f'<p class="note demo-x-note"><strong>Static copy.</strong> {answers} The page opens on '
            f'{opens} examples, and &ldquo;{reset}&rdquo; brings them all back. Any other question (a changed '
            'condition, holding period, start day, comparison or years) needs the live database.</p>')
    anchor = '<p class="x-question" id="x-question"'
    assert html.count(anchor) == 1, "returns page: the question line not found"
    html = html.replace(anchor, note + anchor, 1)
    # only "Results update as you go" is untrue of the copy; the note says which questions answer
    html, k = re.subn(r"Results update as you go, and the address bar holds the whole question,\s+"
                      r"so a link reopens it exactly\.",
                      "The address bar holds the whole question, so a link reopens it exactly.", html)
    assert k == 1, "returns page: the 'Results update as you go' line not found"
    html, k = re.subn(r'(<noscript><p class="note">The question builder needs JavaScript)[^<]*'
                      r'<span class="mono">/api/returns</span>[^<]*(</p></noscript>)', r"\1.\2", html)
    assert k == 1, "returns page: the noscript line not found"
    return html


def export_explorer(fetch: Any, offered: dict[str, Any], xdir: Path,
                    exported: str) -> tuple[dict[str, Any], dict[str, Any]]:
    """Answer the page's own questions through /api/returns, exactly as the live page asks them,
    with every non-empty bar's drill-down at every zoom level, into xdir (a fresh folder). A
    question's answer is one file and its drill-downs one file per zoom level, which the shim
    loads only when a bar at that level is clicked. Files are named by a hash of the key, so a
    question that does not change keeps its file from night to night. Returns the stats for the
    manifest and the checks for verify_shim.mjs."""
    t0 = time.time()
    questions, n_examples = offered["all"], len(offered["examples"])
    index: dict[str, str] = {}
    errors: dict[str, str] = {}
    checks: list[dict[str, str]] = []
    n_bytes = n_files = n_bars = 0
    for q in questions:
        key = explorer_key(q)
        if key in index or key in errors:
            continue
        r = fetch("/api/returns?" + q)
        if r.status_code == 422:
            # the live page shows the endpoint's reason in place of the figures; so does the copy
            errors[key] = r.json()["error"]
            print(f"  explorer {q}: 422 {errors[key]}")
            continue
        assert r.status_code == 200, f"/api/returns?{q}: {r.status_code}"
        answer = r.json()
        qid = hashlib.sha1(key.encode()).hexdigest()[:12]
        # The page re-serialises each condition before it asks (token(parse(c)) in returns.js), so
        # an example written in any other spelling would be asked under a key nothing stores and
        # refused on the page. The endpoint echoes its canonical tokens; an example that differs
        # from them fails here rather than on a reader's click.
        echo = answer["query"]
        asked = dict(reversed(parse_qsl(q, keep_blank_values=True)))   # first value wins, as in the key
        canon = _key({"hold": str(echo["hold"]), "lag": str(echo["lag"]), "ret": echo["ret"],
                      **{k: asked[k] for k in ("from", "to") if k in asked}}, echo["c"])
        assert key == canon, f"explorer question {q!r} is not in the endpoint's canonical form {canon!r}"
        index[key] = qid
        checks.append({"q": q, "id": qid})
        n_bytes += write_json(xdir / f"{qid}.json", answer)
        n_files += 1
        bars_here = 0
        for lv in ([] if answer.get("empty") else answer["hist"]["levels"]):
            zoom = lv["key"]
            assert re.fullmatch(r"[0-9a-z]{1,4}", zoom), f"unexpected zoom key {zoom!r}"
            bars: dict[str, Any] = {}
            for i, count in enumerate(lv["slice"]):
                if not count:
                    continue   # the page lists only bars that hold something
                br = fetch(f"/api/returns?{q}&bar={zoom}:{i}")
                assert br.status_code == 200, f"/api/returns?{q}&bar={zoom}:{i}: {br.status_code}"
                bars[str(i)] = br.json()
            n_bytes += write_json(xdir / f"{qid}.bars-{zoom}.json", bars)
            n_files += 1
            bars_here += len(bars)
        n_bars += bars_here
        print(f"  explorer {q}: {answer['slice']['n_rows'] if not answer.get('empty') else 0:,} stock-days, "
              f"{bars_here} bars, {time.time() - t0:.0f}s")
    for q in (offered["opening"], offered["start_over"]):
        # the page's note and the refusal message promise these two by name
        assert explorer_key(q) in index, f"explorer: {q!r} was not answered"
    refused_keys = sorted({explorer_key(q) for q in offered["examples"]} & set(errors))
    refused = sum(explorer_key(q) in errors for q in offered["examples"])
    n_bytes += write_json(xdir / "index.json", {"exported": exported, "examples": n_examples,
                                                "refused": refused, "questions": index, "errors": errors})
    n_files += 1
    stats = {"questions": len(set(index.values())) + len(errors), "examples": n_examples,
             "refused": refused, "refused_keys": refused_keys, "bars": n_bars,
             "files": n_files, "bytes": n_bytes, "seconds": round(time.time() - t0, 1)}
    print(f"explorer: {stats['questions']} questions, {n_bars} bars, {n_files} files, "
          f"{n_bytes / 1e6:.2f} MB in {stats['seconds']:.0f}s")
    return stats, {"checks": checks, "errors": list(errors)}


def prepare_explorer(fetch: Any, get_html: Any, src: Path, exported: str) -> dict[str, Any]:
    """Everything the copy's explorer needs, checked and answered before the export writes a
    single file to --out: the endpoint's parameters, the fx.js and returns.js patches, the nav
    entry, the questions the page offers, their answers and the page's note. A platform change
    that breaks any of it then costs the night's explorer, not the night's export (main falls
    back to the copy without it), and never leaves --out half-written. The answers wait in a
    temporary folder that install_explorer moves into place."""
    check_explorer_route()
    scripts = explorer_scripts(src)
    raw = get_html("/returns")
    explorer_nav(raw)   # every crawled page carries the same nav; checked here on one of them
    offered = explorer_questions(raw, (src / "returns.js").read_text())
    explorer_note(raw, offered, {"refused": 0, "refused_keys": []}, exported)   # its anchors, before the slow part
    tmp = Path(tempfile.mkdtemp(prefix="qe-explorer-"))
    atexit.register(shutil.rmtree, tmp, True)   # gone even if the export dies before the move
    stats, ref_keys = export_explorer(fetch, offered, tmp, exported)
    page = explorer_note(raw, offered, stats, exported)
    stats.pop("refused_keys")
    return {"page": page, "scripts": scripts, "answers": tmp, "stats": stats, "ref_keys": ref_keys}


def install_explorer(explorer: dict[str, Any], out: Path, ref: Path | None) -> None:
    xdir = out / "data" / "api" / "returns"
    shutil.rmtree(xdir, ignore_errors=True)   # an example the platform dropped must not linger
    xdir.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(explorer["answers"]), xdir)
    if ref is not None:
        # for verify_shim.mjs: the shim must reach the same answer from each question as written
        write_json(ref / "explorer" / "keys.json", explorer["ref_keys"])


# --------------------------------------------------------------------------- main

def write_json(path: Path, obj: Any) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(obj, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    path.write_text(text)
    return len(text.encode())


BUSY_ATTEMPTS = 60   # x BUSY_WAIT_S: up to two minutes per request before the export gives up
BUSY_WAIT_S = 2.0


def connect_read_only() -> duckdb.DuckDBPyConnection:
    """A read-only handle, waiting out another process's write lock (see fetch() in main)."""
    for attempt in range(BUSY_ATTEMPTS):
        try:
            return duckdb.connect(str(DB_PATH), read_only=True)
        except duckdb.IOException as exc:
            if "lock" not in str(exc).lower() or attempt == BUSY_ATTEMPTS - 1:
                raise
            print(f"  database locked by another process, retrying ({attempt + 1})")
            time.sleep(BUSY_WAIT_S)
    raise AssertionError("unreachable")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--reference", default="")
    ap.add_argument("--skip-parquet", action="store_true")
    ap.add_argument("--skip-pages", action="store_true")
    ap.add_argument("--skip-explorer", action="store_true")
    args = ap.parse_args()
    out = Path(args.out).resolve()
    ref = Path(args.reference).resolve() if args.reference else None
    t0 = time.time()

    # ---- phase A: bulk reads on one connection, main thread only ----------------------------
    con = connect_read_only()
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
    exported_at = datetime.now().astimezone()
    exported = exported_at.strftime("%Y-%m-%d")
    ctx = {"universe": UNIVERSE, "universe_n": len(members), "start": DEMO_START.year,
           "exported": exported, "exported_at": exported_at.isoformat(timespec="minutes"),
           "db_gb": f"{DB_PATH.stat().st_size / 1e9:.1f}", "explorer": False}

    def fetch(path: str, **kw: Any) -> Any:
        # The app answers 503 "database_busy" while another process holds the write lock. The
        # options backfill takes it for milliseconds per batch (and resumes at 23:20, inside the
        # nightly publish), so a busy answer is waited out, not treated as a failed export.
        for attempt in range(BUSY_ATTEMPTS):
            r = client.get(path, **kw)
            if r.status_code != 503 or attempt == BUSY_ATTEMPTS - 1:
                return r
            print(f"  {path}: database busy, retrying ({attempt + 1})")
            time.sleep(BUSY_WAIT_S)
        return r

    def get_json(path: str) -> dict[str, Any]:
        r = fetch(path)
        assert r.status_code == 200, f"{path}: {r.status_code}"
        return r.json()

    def get_html(path: str) -> str:
        r = fetch(path, follow_redirects=True)
        assert r.status_code == 200, f"{path}: {r.status_code}"
        return r.text

    # The explorer first, before anything is written: its page, scripts and endpoint are the
    # parts of the platform most likely to change under the copy's patches, and a failure there
    # should drop the explorer for the night, not the whole refresh.
    static_src = QE_ROOT / "src" / "qe" / "web" / "static"
    explorer: dict[str, Any] | None = None
    explorer_disabled = False
    if not args.skip_explorer:
        try:
            explorer = prepare_explorer(fetch, get_html, static_src, exported)
        except Exception as exc:  # noqa: BLE001 — any explorer failure has the same way out
            explorer_disabled = True
            print(f"\n{'!' * 78}\nEXPLORER DISABLED: {type(exc).__name__}: {exc}\n"
                  "The copy is exported without the return explorer, server-only as on any snapshot.\n"
                  f"{'!' * 78}\n", flush=True)
    ctx["explorer"] = explorer is not None

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
    if not args.limit:
        # A symbol that leaves the slice (a universe change, a stock the model no longer holds)
        # would keep a stale page reachable by URL, dated its last export, while the rest of the
        # copy treats it as having none. A smoke run's short list must not prune the real tree.
        keep = set(symbols)
        stale = [p for p in (out / "data" / "symbols").glob("*.json") if p.stem not in keep]
        if not args.skip_pages:
            stale += [p for p in (out / "symbol").glob("*.html") if p.stem not in keep]
        for p in stale:
            p.unlink()
        if stale:
            print(f"pruned {len(stale)} files of symbols no longer in the demo: "
                  f"{', '.join(sorted({p.stem for p in stale}))}")

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
    # the story front page (2026-09-24) and the notebook's pulse and market map (2026-09-23)
    write_json(api / "story.json", get_json("/api/story"))
    write_json(api / "model" / model_id / "pulse.json", get_json(f"/api/model/{model_id}/pulse"))
    write_json(api / "market_map.json", get_json("/api/market_map"))
    # The companion panel's payload is optional: when the platform cannot serve it the page
    # already says "did not load", which is the honest static rendering too.
    r = fetch(f"/api/model/{model_id}/companion")
    if r.status_code == 200:
        write_json(api / "model" / model_id / "companion.json", r.json())
    else:
        (api / "model" / model_id / "companion.json").unlink(missing_ok=True)
        print(f"companion payload skipped: HTTP {r.status_code}")

    if not args.skip_pages:
        (out / "index.html").write_text(rewrite_html(get_html("/"), "", ctx))
        # "/" is the story (index.html); the working overview now lives at /lab
        pages = [("screener", "/screener"), ("model", f"/model/{model_id}"), ("research", "/research"),
                 ("health", "/health"), ("lab", "/lab")]
        if explorer is None:
            # without its answers the explorer stays server-only, as on any other snapshot: the nav
            # keeps data-needs-server, the palette drops it, and no page or file of it is left behind
            shutil.rmtree(out / "returns", ignore_errors=True)
            shutil.rmtree(out / "data" / "api" / "returns", ignore_errors=True)
        for page, path in pages:
            (out / page).mkdir(parents=True, exist_ok=True)
            (out / page / "index.html").write_text(rewrite_html(get_html(path), "../", ctx))
        if explorer is not None:
            (out / "returns").mkdir(parents=True, exist_ok=True)
            (out / "returns" / "index.html").write_text(rewrite_html(explorer["page"], "../", ctx))
        patch_static(static_src, out / "static", explorer["scripts"] if explorer else {})
    # With --skip-pages the pages already in --out are left as they are, and without the explorer
    # so is whatever explorer they point at (see the manifest below).
    if explorer is not None:
        install_explorer(explorer, out, ref)
    explorer_stats = None if explorer is None else explorer["stats"]
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
    if explorer_stats is None and args.skip_pages and (out / "data" / "api" / "returns" / "index.json").exists():
        # the untouched pages still serve the previous run's explorer; its record stays with it
        old = out / "data" / "manifest.json"
        explorer_stats = json.loads(old.read_text()).get("return_explorer") if old.exists() else None
    if explorer_stats is not None:
        manifest["return_explorer"] = explorer_stats
    elif explorer_disabled and not args.skip_pages:
        # the reason is in the log; the manifest is public, and an exception can carry local paths
        manifest["return_explorer_disabled"] = True
    write_json(out / "data" / "manifest.json", manifest)

    # ---- phase C: parquet slices for the SQL console (fresh connection, after the crawl) --------
    if not args.skip_parquet:
        pq = out / "data" / "parquet"
        pq.mkdir(parents=True, exist_ok=True)
        con = connect_read_only()
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
