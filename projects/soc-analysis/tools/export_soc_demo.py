#!/usr/bin/env python3
"""Export a static slice of the SOC dashboard's real output for the portfolio page.

Runs the actual model from ~/dev/SOC Analysis over the cached AVGO minute bars
(no API calls, no live feed) and writes projects/soc-analysis/data/example.json:
the fragility score and regime over time on all three horizons, plus the
backtest's own pass/fail verdicts.

Usage:
  cd ~/dev/SOC\\ Analysis
  PYTHONPATH=. python3 "$HOME/dev/Portfolio Website/projects/soc-analysis/tools/export_soc_demo.py" \
      --out "$HOME/dev/Portfolio Website/projects/soc-analysis"

Nothing from config.py is exported; the script aborts if the vendor API key
appears anywhere in the output.
"""
import argparse, json, pathlib, sys
import numpy as np
import pandas as pd

import config
from data_fetcher import calculate_returns, filter_market_hours
from multi_timeframe import MultiTimeframeAnalyzer
from backtesting import SOCBacktester

TICKER = "AVGO"
STEP_MINUTES = 10          # downsample for the chart; peaks are sampled, not averaged away


def load_cached(cache_dir: pathlib.Path) -> pd.DataFrame:
    files = sorted(cache_dir.glob(f"{TICKER}_1min_2025-*.csv"))
    files = [f for f in files if " " not in f.name]     # skip the ' 2'/' 3' iCloud duplicates
    if not files:
        sys.exit("No cached %s minute bars found in %s" % (TICKER, cache_dir))
    frames = []
    for f in files:
        d = pd.read_csv(f, index_col=0, parse_dates=True)
        for col in ("open", "high", "low", "close", "volume"):
            if col in d.columns:
                d[col] = pd.to_numeric(d[col], errors="coerce")
        frames.append(d.dropna())
        print("  loaded %-28s %6d rows" % (f.name, len(d)))
    df = pd.concat(frames).sort_index()
    df = df[~df.index.duplicated(keep="first")]
    return df


def jnum(x, nd=2):
    """JSON-safe rounded float (NaN/inf -> None)."""
    if x is None:
        return None
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return None if not np.isfinite(v) else round(v, nd)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True, help="projects/soc-analysis directory")
    ap.add_argument("--cache", default="/tmp/soc_export_frames.pkl",
                    help="reuse the expensive indicator pass between runs")
    ap.add_argument("--recompute", action="store_true", help="ignore the cache")
    args = ap.parse_args()
    out_dir = pathlib.Path(args.out).expanduser()
    cache_path = pathlib.Path(args.cache)

    tf_results = consensus = None
    if cache_path.exists() and not args.recompute:
        import pickle
        print("Reusing cached indicator pass: %s" % cache_path)
        with cache_path.open("rb") as fh:
            tf_results, consensus = pickle.load(fh)

    if tf_results is None:
        print("Loading cached bars...")
        df = load_cached(pathlib.Path(config.DATA_CACHE_DIR))
        print("  %d bars, %s to %s" % (len(df), df.index[0].date(), df.index[-1].date()))

        df = calculate_returns(df)
        df = filter_market_hours(df)
        df = df.dropna(subset=["returns"])
        print("  %d bars after filtering to regular market hours" % len(df))

        print("\nRunning the model on all three horizons (this takes 10-30 minutes)...")
        analyzer = MultiTimeframeAnalyzer()
        tf_results = analyzer.analyze_all_timeframes(df)
        if not tf_results:
            sys.exit("Model produced no timeframe results")
        consensus = analyzer.calculate_ensemble_consensus(tf_results)

        import pickle
        with cache_path.open("wb") as fh:
            pickle.dump((tf_results, consensus), fh)
        print("Cached the indicator pass to %s" % cache_path)

    # --- the series for the chart -------------------------------------------------
    med_name = "medium" if "medium" in tf_results else sorted(tf_results)[0]
    med = tf_results[med_name]
    idx = consensus.index.intersection(med.index)
    consensus = consensus.loc[idx]
    med = med.loc[idx]

    sampled = consensus.iloc[::STEP_MINUTES]
    med_s = med.loc[sampled.index]

    series = {
        "t":     [ts.strftime("%Y-%m-%d %H:%M") for ts in sampled.index],
        "close": [jnum(v, 2) for v in med_s["close"]],
        "score": [jnum(v, 1) for v in sampled["consensus_fragility"]],
        "regime": list(sampled["consensus_regime"].astype(str)),
        "confidence": [jnum(v, 1) for v in sampled["confidence"]],
    }
    for name in tf_results:
        col = f"{name}_fragility"
        if col in sampled.columns:
            series[f"score_{name}"] = [jnum(v, 1) for v in sampled[col]]

    # --- the backtest's own verdicts ----------------------------------------------
    print("\nRunning the backtest...")
    bt = SOCBacktester()
    try:
        res = bt.run_full_backtest(med)
    except Exception as exc:                      # keep whatever did run
        print("  backtest suite raised: %s" % exc)
        res = {}
        for key, fn in (("regime_test", bt.test_regime_vol_relationship),
                        ("correlation_test", bt.test_fragility_score_correlation),
                        ("early_warning_test", bt.test_early_warning_effectiveness),
                        ("lead_time", bt.calculate_lead_time)):
            try:
                res[key] = fn(med)
            except Exception as e2:
                print("  %s unavailable: %s" % (key, e2))

    corr = res.get("correlation_test", {}) or {}
    ew = res.get("early_warning_test", {}) or {}
    lead = res.get("lead_time", {}) or {}

    backtest = {
        "r_squared":  jnum(corr.get("r_squared"), 3),
        "correlation": jnum(corr.get("correlation"), 3),
        "precision":  jnum(ew.get("precision"), 3),
        "recall":     jnum(ew.get("recall"), 3),
        "f1":         jnum(ew.get("f1_score"), 3),
        "warning_threshold": 55,
        "criteria": [
            {"name": "Fragility vs. following volatility, R²", "target": "> 0.30",
             "value": jnum(corr.get("r_squared"), 3),
             "pass": bool((corr.get("r_squared") or 0) > 0.3)},
            {"name": "Early-warning F1", "target": "> 0.40",
             "value": jnum(ew.get("f1_score"), 3),
             "pass": bool((ew.get("f1_score") or 0) > 0.4)},
            {"name": "Early-warning precision", "target": "> 0.40",
             "value": jnum(ew.get("precision"), 3),
             "pass": bool((ew.get("precision") or 0) > 0.4)},
            {"name": "Early-warning recall", "target": "> 0.40",
             "value": jnum(ew.get("recall"), 3),
             "pass": bool((ew.get("recall") or 0) > 0.4)},
        ],
    }
    for k in ("mean_lead_time", "median_lead_time"):
        if k in lead:
            backtest[k] = jnum(lead.get(k), 1)

    # regime mix over the window
    mix = consensus["consensus_regime"].astype(str).value_counts()
    total = int(mix.sum())
    regime_mix = [{"regime": r, "pct": jnum(100.0 * c / total, 1)} for r, c in mix.items()]

    payload = {
        "ticker": TICKER,
        "generated": pd.Timestamp.now("UTC").strftime("%Y-%m-%d"),
        "source": "cached 1-minute bars, regular market hours only; no live feed",
        "window": {"start": str(consensus.index[0]), "end": str(consensus.index[-1]),
                   "bars": int(len(consensus)), "sampled_every_min": STEP_MINUTES},
        "horizons": {k: int(v) for k, v in config.ROLLING_WINDOWS.items()},
        "thresholds": {k: list(v) for k, v in config.REGIME_THRESHOLDS.items()},
        "series": series,
        "regime_mix": regime_mix,
        "backtest": backtest,
    }

    text = json.dumps(payload, separators=(",", ":"))

    # never let the vendor key reach the site
    key = getattr(config, "ALPHA_VANTAGE_API_KEY", "") or ""
    if key and len(key) > 6 and key in text:
        sys.exit("ABORT: vendor API key found in export payload")

    data_dir = out_dir / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    dest = data_dir / "example.json"
    dest.write_text(text)
    print("\nWrote %s (%.1f KB, %d sampled points)" % (dest, len(text) / 1024, len(series["t"])))
    for c in backtest["criteria"]:
        print("  %-42s %-8s %s" % (c["name"], c["value"], "PASS" if c["pass"] else "FAIL"))


if __name__ == "__main__":
    main()
