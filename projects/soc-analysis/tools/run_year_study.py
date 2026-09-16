#!/usr/bin/env python3
"""Year-long, multi-stock test of the SOC fragility score.

Design fixed BEFORE the run (2026-09-16):
  - 8 tickers, one per sector, spanning a wide volatility range. Chosen for
    sector coverage, not for how they score.
  - Trailing 12 complete months of 1-minute bars, regular market hours.
  - The medium (256-bar) horizon, scored exactly as the dashboard scores it.
  - Question: does the fragility score predict the volatility of the next hour?
  - Pre-set bars, same as the app's own: R2 > 0.30, and early-warning
    precision / recall / F1 > 0.40 against a P90 volatility-spike definition.
  - A result counts only if it holds across tickers, not on average.

Writes data/year_study.json for the portfolio page.
"""
import argparse, json, os, pathlib, sys, time, warnings
warnings.filterwarnings("ignore")
import numpy as np
import pandas as pd

import config
from data_fetcher import AlphaVantageDataFetcher, calculate_returns, filter_market_hours
from soc_indicators import SOCIndicators
from fragility_score import FragilityScoreCalculator
from backtesting import SOCBacktester

TICKERS = [
    ("AVGO", "Information technology"),
    ("TSLA", "Consumer discretionary"),
    ("JPM",  "Financials"),
    ("XOM",  "Energy"),
    ("JNJ",  "Health care"),
    ("WMT",  "Consumer staples"),
    ("NEE",  "Utilities"),
    ("CAT",  "Industrials"),
]
WINDOW = 256
WARN = 55


def months_back(n=12, end=None):
    end = end or pd.Timestamp.today().normalize().replace(day=1)
    return [(end - pd.DateOffset(months=i)).strftime("%Y-%m") for i in range(n, 0, -1)]


def fetch_ticker(fetcher, ticker, months):
    frames = []
    for m in months:
        cache = pathlib.Path(config.DATA_CACHE_DIR) / f"{ticker}_1min_{m}.csv"
        if cache.exists():
            d = pd.read_csv(cache, index_col=0, parse_dates=True)
        else:
            d = fetcher.fetch_intraday(ticker, interval="1min", month=m, outputsize="full")
            if d is None or not len(d):
                print("    %s %s: no data" % (ticker, m)); continue
        for c in ("open", "high", "low", "close", "volume"):
            if c in d.columns:
                d[c] = pd.to_numeric(d[c], errors="coerce")
        frames.append(d.dropna())
    if not frames:
        return None
    df = pd.concat(frames).sort_index()
    return df[~df.index.duplicated(keep="first")]


def score_one(ticker, df):
    df = calculate_returns(df)
    df = filter_market_hours(df)
    df = df.dropna(subset=["returns"])
    if len(df) < WINDOW * 4:
        return None, "insufficient bars (%d)" % len(df)
    df = SOCIndicators().calculate_all_indicators(df, window=WINDOW)
    df = FragilityScoreCalculator().calculate_fragility_score(df)
    return df, None


def evaluate(df):
    bt = SOCBacktester()
    fs = pd.to_numeric(df["fragility_score"], errors="coerce")
    fv = bt.calculate_forward_realized_vol(pd.to_numeric(df["returns"], errors="coerce"))
    d = pd.concat([fs.rename("s"), fv.rename("v")], axis=1).dropna()
    r = float(d["s"].corr(d["v"])) if len(d) > 10 else float("nan")

    ew = bt.test_early_warning_effectiveness(df, warning_threshold=WARN)
    return {
        "bars": int(len(df)),
        "days": int(pd.Series(df.index.date).nunique()),
        "score_mean": round(float(fs.mean()), 1),
        "warn_rate": round(100.0 * float((fs >= WARN).mean()), 1),
        "correlation": None if np.isnan(r) else round(r, 4),
        "r_squared": None if np.isnan(r) else round(r * r, 4),
        "precision": round(float(ew.get("precision", float("nan"))), 4),
        "recall": round(float(ew.get("recall", float("nan"))), 4),
        "f1": round(float(ew.get("f1_score", float("nan"))), 4),
        "spike_base_rate": round(100.0 * float(ew.get("false_negatives", 0) + ew.get("true_positives", 0))
                                 / max(len(df), 1), 2),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--only", help="comma-separated tickers (for a smoke run)")
    ap.add_argument("--months", type=int, default=12)
    args = ap.parse_args()

    tickers = TICKERS
    if args.only:
        want = {t.strip().upper() for t in args.only.split(",")}
        tickers = [t for t in TICKERS if t[0] in want]

    months = months_back(args.months)
    print("Window: %s .. %s" % (months[0], months[-1]))
    fetcher = AlphaVantageDataFetcher(api_key=config.ALPHA_VANTAGE_API_KEY)

    results, failures = {}, {}
    for ticker, sector in tickers:
        print("\n=== %s (%s) ===" % (ticker, sector))
        t0 = time.time()
        df = fetch_ticker(fetcher, ticker, months)
        if df is None:
            failures[ticker] = "no data"; print("  no data"); continue
        print("  %d raw bars; scoring..." % len(df))
        scored, err = score_one(ticker, df)
        if err:
            failures[ticker] = err; print("  " + err); continue
        res = evaluate(scored)
        res["sector"] = sector
        results[ticker] = res
        print("  R2=%.4f prec=%.3f rec=%.3f f1=%.3f warn=%.1f%% (%.1f min)"
              % (res["r_squared"] or 0, res["precision"], res["recall"], res["f1"],
                 res["warn_rate"], (time.time() - t0) / 60))

    out = pathlib.Path(args.out) / "data"
    out.mkdir(parents=True, exist_ok=True)
    payload = {
        "generated": pd.Timestamp.now("UTC").strftime("%Y-%m-%d"),
        "design": {
            "tickers": [t for t, _ in tickers],
            "months": months, "horizon_bars": WINDOW, "warning_threshold": WARN,
            "criteria": {"r_squared": 0.30, "precision": 0.40, "recall": 0.40, "f1": 0.40},
            "note": "tickers and thresholds fixed before the run",
        },
        "per_ticker": results,
        "failures": failures,
    }
    if results:
        payload["pooled"] = {
            k: round(float(np.nanmean([r[k] for r in results.values() if r.get(k) is not None])), 4)
            for k in ("r_squared", "precision", "recall", "f1", "warn_rate", "score_mean")
        }
        payload["pooled"]["tickers_meeting_r2"] = sum(
            1 for r in results.values() if (r.get("r_squared") or 0) > 0.30)
        payload["pooled"]["tickers_meeting_f1"] = sum(
            1 for r in results.values() if (r.get("f1") or 0) > 0.40)
        payload["pooled"]["n_tickers"] = len(results)

    text = json.dumps(payload, indent=1)
    key = getattr(config, "ALPHA_VANTAGE_API_KEY", "") or ""
    if key and len(key) > 6 and key in text:
        sys.exit("ABORT: vendor API key found in payload")
    (out / "year_study.json").write_text(text)
    print("\nWrote %s" % (out / "year_study.json"))
    if "pooled" in payload:
        p = payload["pooled"]
        print("POOLED: mean R2=%.4f  f1=%.3f  warn=%.1f%%  |  %d/%d tickers met R2, %d/%d met F1"
              % (p["r_squared"], p["f1"], p["warn_rate"],
                 p["tickers_meeting_r2"], p["n_tickers"], p["tickers_meeting_f1"], p["n_tickers"]))


if __name__ == "__main__":
    main()
