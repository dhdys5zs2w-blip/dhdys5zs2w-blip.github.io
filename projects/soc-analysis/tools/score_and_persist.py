#!/usr/bin/env python3
"""Score one ticker across all three horizons and persist the full frames.

Scoring is the expensive step (~4 min per ticker per horizon). Persisting the
scored frames means any further metric can be computed in seconds instead of
re-running the model. Writes /tmp/soc_frames/<TICKER>.pkl containing
{horizon_name: DataFrame} plus the consensus frame.

  PYTHONPATH=. .venv/bin/python <this> --ticker AVGO
"""
import argparse, pathlib, sys, time, warnings
warnings.filterwarnings("ignore")
import pandas as pd

import config
from data_fetcher import calculate_returns, filter_market_hours
from multi_timeframe import MultiTimeframeAnalyzer
from backtesting import SOCBacktester

OUT = pathlib.Path("/tmp/soc_frames")


def load_cached(ticker, months):
    frames = []
    cache = pathlib.Path(config.DATA_CACHE_DIR)
    for m in months:
        f = cache / f"{ticker}_1min_{m}.csv"
        if not f.exists():
            continue
        d = pd.read_csv(f, index_col=0, parse_dates=True)
        for c in ("open", "high", "low", "close", "volume"):
            if c in d.columns:
                d[c] = pd.to_numeric(d[c], errors="coerce")
        frames.append(d.dropna())
    if not frames:
        return None
    df = pd.concat(frames).sort_index()
    return df[~df.index.duplicated(keep="first")]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ticker", required=True)
    ap.add_argument("--months", type=int, default=12)
    args = ap.parse_args()

    end = pd.Timestamp("2026-09-01")
    months = [(end - pd.DateOffset(months=i)).strftime("%Y-%m") for i in range(args.months, 0, -1)]

    t0 = time.time()
    df = load_cached(args.ticker, months)
    if df is None:
        sys.exit("no cached data for %s" % args.ticker)
    df = calculate_returns(df)
    df = filter_market_hours(df)
    df = df.dropna(subset=["returns"])
    print("%s: %d bars" % (args.ticker, len(df)), flush=True)

    analyzer = MultiTimeframeAnalyzer()
    tf = analyzer.analyze_all_timeframes(df)
    if not tf:
        sys.exit("no timeframe results for %s" % args.ticker)
    consensus = analyzer.calculate_ensemble_consensus(tf)

    # forward realised volatility, the thing every test predicts against
    bt = SOCBacktester()
    fwd = bt.calculate_forward_realized_vol(pd.to_numeric(df["returns"], errors="coerce"))
    for name in tf:
        tf[name] = tf[name].copy()
        tf[name]["forward_vol"] = fwd.reindex(tf[name].index)

    OUT.mkdir(parents=True, exist_ok=True)
    dest = OUT / ("%s.pkl" % args.ticker)
    pd.to_pickle({"timeframes": tf, "consensus": consensus, "ticker": args.ticker}, dest)
    print("%s: wrote %s in %.1f min" % (args.ticker, dest, (time.time() - t0) / 60), flush=True)


if __name__ == "__main__":
    main()
