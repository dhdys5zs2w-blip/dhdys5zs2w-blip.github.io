#!/usr/bin/env python3
"""Build the case-study page's data from the persisted scored frames.

Reads /tmp/soc_frames/<TICKER>.pkl (written by score_and_persist.py) and emits
  data/example.json    - one ticker, every minute, compactly encoded for the zoomable chart
  data/year_study.json - the eight-company results

No pass/fail thresholds. The page reports what the score actually does and
compares it against two honest yardsticks: the base rate of a volatility spike,
and how well simple trailing volatility predicts the same thing.

  python3 build_page_data.py --out <projects/soc-analysis> [--chart-ticker AVGO]
"""
import argparse, json, math, pathlib, sys
import numpy as np
import pandas as pd

FRAMES = pathlib.Path("/tmp/soc_frames")
REGIMES = ["safe", "building", "elevated", "critical"]
SECTORS = {
    "AVGO": "Information technology", "TSLA": "Consumer discretionary",
    "JPM": "Financials", "XOM": "Energy", "JNJ": "Health care",
    "WMT": "Consumer staples", "NEE": "Utilities", "CAT": "Industrials",
}
FWD_BARS = 60          # the forward window the model's own backtester uses
N_BUCKETS = 10


def j(x, nd=4):
    if x is None:
        return None
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return None if not np.isfinite(v) else round(v, nd)


def corr(a, b):
    d = pd.concat([a.rename("a"), b.rename("b")], axis=1).dropna()
    if len(d) < 30:
        return None, 0
    return float(d["a"].corr(d["b"])), len(d)


def analyse(ticker, bundle):
    tfs = bundle["timeframes"]
    out = {"ticker": ticker, "sector": SECTORS.get(ticker, "")}

    # Test the SAME quantity the page charts and the app itself reports: the
    # consensus score blended across all three horizons. Testing one horizon
    # while plotting another would make the page describe two different models.
    cons = bundle["consensus"]
    med = tfs["medium"] if "medium" in tfs else tfs[sorted(tfs)[0]]
    idx = cons.index.intersection(med.index)
    cons = cons.loc[idx]
    med = med.loc[idx]

    score = pd.to_numeric(cons["consensus_fragility"], errors="coerce")
    fwd = pd.to_numeric(med["forward_vol"], errors="coerce")
    rets = pd.to_numeric(med["returns"], errors="coerce")
    trailing = rets.rolling(FWD_BARS).std()          # the naive baseline
    out["scored_quantity"] = "consensus across the 100, 256 and 480-bar horizons"

    out["bars"] = int(len(med))
    out["days"] = int(pd.Series(med.index.date).nunique())
    out["score_mean"] = j(score.mean(), 1)
    out["score_sd"] = j(score.std(), 1)
    # overlapping forward windows mean consecutive rows are not independent
    out["effective_n"] = int(len(med) / FWD_BARS)

    r_sf, n_sf = corr(score, fwd)
    r_tf, _ = corr(trailing, fwd)
    r_st, _ = corr(score, trailing)
    out["corr_score_fwd"] = j(r_sf)
    out["corr_trailing_fwd"] = j(r_tf)
    out["corr_score_trailing"] = j(r_st)
    out["r2_score"] = j(r_sf * r_sf) if r_sf is not None else None
    out["r2_trailing"] = j(r_tf * r_tf) if r_tf is not None else None
    # does the score add anything once you already know recent volatility?
    if None not in (r_sf, r_tf, r_st) and abs(r_st) < 1 and abs(r_tf) < 1:
        denom = math.sqrt((1 - r_st ** 2) * (1 - r_tf ** 2))
        out["partial_corr_score_fwd"] = j((r_sf - r_st * r_tf) / denom) if denom else None
    else:
        out["partial_corr_score_fwd"] = None

    # spike = top decile of the forward volatility this stock actually saw
    d = pd.concat([score.rename("s"), fwd.rename("f"), trailing.rename("t")], axis=1).dropna()
    if len(d) > 200:
        cut = d["f"].quantile(0.90)
        d["spike"] = d["f"] >= cut
        base = float(d["spike"].mean())
        out["spike_base_rate"] = j(100 * base, 2)

        # rank-based AUC: P(score is higher on a spike bar than on a calm bar).
        # 0.50 is a coin flip. Threshold-free by construction.
        def auc(x, y):
            pos = x[y].values
            neg = x[~y].values
            if len(pos) < 10 or len(neg) < 10:
                return None
            allv = np.concatenate([pos, neg])
            r = pd.Series(allv).rank().values
            return float((r[:len(pos)].sum() - len(pos) * (len(pos) + 1) / 2) / (len(pos) * len(neg)))
        out["auc_score"] = j(auc(d["s"], d["spike"]))
        out["auc_trailing"] = j(auc(d["t"], d["spike"]))

        # per-date aggregates so the pooled lift can be bootstrapped by trading day
        top_cut = d["s"].quantile(0.90)
        dd = d.assign(_top=d["s"] >= top_cut, _date=d.index.date)
        g1 = dd.groupby("_date").agg(n_all=("spike", "size"), spike_all=("spike", "sum"))
        g2 = dd[dd["_top"]].groupby("_date").agg(n_top=("spike", "size"), spike_top=("spike", "sum"))
        out["_byday"] = g1.join(g2, how="left").fillna(0.0)

        # calibration: mean forward vol and spike rate by score decile - no threshold needed
        d["bucket"] = pd.qcut(d["s"].rank(method="first"), N_BUCKETS, labels=False)
        g = d.groupby("bucket")
        overall = float(d["f"].mean())
        out["calibration"] = [
            {
                "bucket": int(b),
                "score_lo": j(grp["s"].min(), 1),
                "score_hi": j(grp["s"].max(), 1),
                "spike_rate": j(100 * float(grp["spike"].mean()), 2),
                "lift": j(float(grp["spike"].mean()) / base, 3) if base else None,
                "rel_fwd_vol": j(float(grp["f"].mean()) / overall, 3) if overall else None,
                "n": int(len(grp)),
            }
            for b, grp in g
        ]
        # same curve for the naive baseline, so the two can be compared directly
        d["tbucket"] = pd.qcut(d["t"].rank(method="first"), N_BUCKETS, labels=False)
        out["calibration_trailing"] = [
            {"bucket": int(b), "spike_rate": j(100 * float(grp["spike"].mean()), 2),
             "lift": j(float(grp["spike"].mean()) / base, 3) if base else None}
            for b, grp in d.groupby("tbucket")
        ]
        # same curve on FIXED score bins so the eight tickers share one x-axis
        edges = list(range(0, 101, 10))
        dfx = d.assign(fixed=pd.cut(d["s"], bins=edges, labels=False, include_lowest=True))
        out["calibration_fixed"] = [
            {"lo": edges[int(b)], "hi": edges[int(b) + 1],
             "spike_rate": j(100 * float(grp["spike"].mean()), 2),
             "lift": j(float(grp["spike"].mean()) / base, 3) if base else None,
             "n": int(len(grp))}
            for b, grp in dfx.groupby("fixed") if pd.notna(b)
        ]

        top = out["calibration"][-1]
        out["top_decile_lift"] = top["lift"]
        out["top_decile_lift_trailing"] = out["calibration_trailing"][-1]["lift"]

    # the model's own regime labels, against what actually followed
    if "consensus_regime" in cons.columns:
        rd = pd.concat([cons["consensus_regime"].astype(str).rename("r"), fwd.rename("f")], axis=1).dropna()
        if len(rd):
            allmean = float(rd["f"].mean())
            mix = rd["r"].value_counts(normalize=True) * 100
            out["by_regime"] = [
                {
                    "regime": r,
                    "share": j(float(mix.get(r, 0)), 1),
                    "rel_fwd_vol": j(float(rd[rd["r"] == r]["f"].mean()) / allmean, 3) if allmean else None,
                    "n": int((rd["r"] == r).sum()),
                }
                for r in REGIMES if (rd["r"] == r).any()
            ]

    # which of the seven signatures carries anything on its own
    comps = [c for c in med.columns if c.endswith("_component")]   # medium horizon
    cc = []
    for c in sorted(comps):
        r, n = corr(pd.to_numeric(med[c], errors="coerce"), fwd)
        if r is not None:
            cc.append({"component": c.replace("_score_component", "").replace("_", " "),
                       "corr_fwd": j(r), "abs": j(abs(r))})
    out["components"] = sorted(cc, key=lambda x: -(x["abs"] or 0))

    # does the horizon matter?
    hz = []
    for name, frame in tfs.items():
        s2 = pd.to_numeric(frame["fragility_score"], errors="coerce")
        f2 = pd.to_numeric(frame["forward_vol"], errors="coerce")
        r2, n2 = corr(s2, f2)
        hz.append({"horizon": name, "corr_fwd": j(r2),
                   "r2": j(r2 * r2) if r2 is not None else None,
                   "score_mean": j(s2.mean(), 1)})
    out["horizons"] = hz
    return out


def build_chart(ticker, bundle, out_dir):
    tfs = bundle["timeframes"]
    cons = bundle["consensus"]
    med = tfs["medium"] if "medium" in tfs else tfs[sorted(tfs)[0]]
    idx = cons.index.intersection(med.index)
    cons = cons.loc[idx]; med = med.loc[idx]

    # ship a readable slice at full 1-minute resolution so zoom reveals real detail
    keep = cons.index >= (cons.index[-1] - pd.Timedelta(days=120))
    cons = cons[keep]; med = med[keep]

    t0 = cons.index[0]
    tmin = ((cons.index - t0).total_seconds() // 60).astype(int).tolist()
    reg = cons["consensus_regime"].astype(str)
    regi = [REGIMES.index(r) if r in REGIMES else 0 for r in reg]
    close = [None if pd.isna(v) else round(float(v), 2) for v in med["close"]]
    score = [None if pd.isna(v) else round(float(v), 1) for v in cons["consensus_fragility"]]

    mix = reg.value_counts(normalize=True) * 100
    payload = {
        "ticker": ticker,
        "source": "cached 1-minute bars, regular market hours, scored offline",
        "window": {"start": str(cons.index[0]), "end": str(cons.index[-1]), "bars": int(len(cons))},
        "regime_names": REGIMES,
        "regime_mix": [{"regime": r, "pct": j(float(mix.get(r, 0)), 1)} for r in REGIMES if r in mix.index],
        "enc": {"t0": t0.strftime("%Y-%m-%d %H:%M"), "tmin": tmin,
                "close": close, "score": score, "regime": regi},
    }
    dest = out_dir / "data" / "example.json"
    dest.parent.mkdir(parents=True, exist_ok=True)
    txt = json.dumps(payload, separators=(",", ":"))
    dest.write_text(txt)
    print("example.json: %d minutes, %.1f KB" % (len(tmin), len(txt) / 1024))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--chart-ticker", default="AVGO")
    args = ap.parse_args()
    out_dir = pathlib.Path(args.out).expanduser()

    files = sorted(FRAMES.glob("*.pkl"))
    if not files:
        sys.exit("no frames in %s - run score_and_persist.py first" % FRAMES)

    per, chart_bundle = {}, None
    for f in files:
        b = pd.read_pickle(f)
        t = b["ticker"]
        print("analysing %s..." % t, flush=True)
        per[t] = analyse(t, b)
        if t == args.chart_ticker:
            chart_bundle = b

    # pooled, weighted by how much independent data each name contributes
    def wmean(field):
        vals = [(p[field], p["effective_n"]) for p in per.values() if p.get(field) is not None]
        if not vals:
            return None
        tot = sum(w for _, w in vals)
        return j(sum(v * w for v, w in vals) / tot) if tot else None

    pooled = {
        "n_tickers": len(per),
        "bars": sum(p["bars"] for p in per.values()),
        "days": sum(p["days"] for p in per.values()),
        "effective_n": sum(p["effective_n"] for p in per.values()),
        "corr_score_fwd": wmean("corr_score_fwd"),
        "corr_trailing_fwd": wmean("corr_trailing_fwd"),
        "partial_corr_score_fwd": wmean("partial_corr_score_fwd"),
        # squared from the pooled correlations so the two table rows agree with
        # each other; averaging r2 separately made R2 != r^2 on the page
        "r2_score": None,
        "r2_trailing": None,
        "top_decile_lift": wmean("top_decile_lift"),
        "top_decile_lift_trailing": wmean("top_decile_lift_trailing"),
    }
    # pooled calibration curve, averaged bucket by bucket
    curves = [p["calibration"] for p in per.values() if p.get("calibration")]
    if curves:
        pooled["calibration"] = [
            {"bucket": i,
             "lift": j(float(np.mean([c[i]["lift"] for c in curves if c[i]["lift"] is not None])), 3),
             "rel_fwd_vol": j(float(np.mean([c[i]["rel_fwd_vol"] for c in curves if c[i]["rel_fwd_vol"] is not None])), 3)}
            for i in range(len(curves[0]))
        ]
    tcurves = [p["calibration_trailing"] for p in per.values() if p.get("calibration_trailing")]
    if tcurves:
        pooled["calibration_trailing"] = [
            {"bucket": i, "lift": j(float(np.mean([c[i]["lift"] for c in tcurves if c[i]["lift"] is not None])), 3)}
            for i in range(len(tcurves[0]))
        ]

    if pooled["corr_score_fwd"] is not None:
        pooled["r2_score"] = j(pooled["corr_score_fwd"] ** 2)
    if pooled["corr_trailing_fwd"] is not None:
        pooled["r2_trailing"] = j(pooled["corr_trailing_fwd"] ** 2)
    pooled["auc_score"] = wmean("auc_score")
    pooled["auc_trailing"] = wmean("auc_trailing")

    # Day-block bootstrap on the pooled top-decile lift. Resample trading DATES
    # with replacement, keeping all eight tickers together on each drawn date,
    # because the names share trading days and a large common market factor.
    # A plain binomial interval would be far too narrow: consecutive bars overlap
    # in both the 256-bar score window and the 60-bar label window.
    days_tbl = [p.pop("_byday") for p in per.values() if "_byday" in p]
    if days_tbl:
        allday = pd.concat(days_tbl).groupby(level=0)[["n_all", "spike_all", "n_top", "spike_top"]].sum()
        arr = allday.to_numpy(dtype=float)
        pooled["days_unique"] = int(len(allday))
        rng = np.random.default_rng(12345)
        lifts = []
        for _ in range(1000):
            s = arr[rng.integers(0, len(arr), len(arr))].sum(axis=0)
            n_all, sp_all, n_top, sp_top = s
            if n_all > 0 and n_top > 0 and sp_all > 0:
                lifts.append((sp_top / n_top) / (sp_all / n_all))
        if lifts:
            lo, hi = np.percentile(lifts, [2.5, 97.5])
            pooled["lift_ci"] = [j(lo, 3), j(hi, 3)]
            obs = arr.sum(axis=0)
            pooled["top_decile_lift_observed"] = j((obs[3] / obs[2]) / (obs[1] / obs[0]), 3)
            pr = obs[3] / obs[2]
            se = math.sqrt(pr * (1 - pr) / obs[2])
            baserate = obs[1] / obs[0]
            pooled["lift_ci_naive"] = [j((pr - 1.96 * se) / baserate, 3),
                                       j((pr + 1.96 * se) / baserate, 3)]

    payload = {
        "design": {
            "tickers": sorted(per), "sectors": SECTORS,
            "period": "Sept 2025 - Aug 2026", "scored_quantity": "consensus of the 100, 256 and 480-bar horizons - the same score the chart plots",
            "horizon_bars": [100, 256, 480],
            "forward_window_bars": FWD_BARS,
            "spike_definition": "forward realised volatility in the stock's own top decile",
            "note": "tickers fixed before the run, one per sector, chosen for coverage not for how they score",
            "base_rate_note": "a spike is defined as that stock's own top decile of forward volatility, so the 10% base rate is definitional, not measured",
        },
        "per_ticker": per,
        "pooled": pooled,
    }
    dest = out_dir / "data" / "year_study.json"
    dest.parent.mkdir(parents=True, exist_ok=True)
    txt = json.dumps(payload, separators=(",", ":"))
    dest.write_text(txt)
    print("year_study.json: %.1f KB" % (len(txt) / 1024))

    if chart_bundle is not None:
        build_chart(args.chart_ticker, chart_bundle, out_dir)

    p = pooled
    print("\nPOOLED  score r=%s (R2=%s) | trailing-vol baseline r=%s (R2=%s) | partial r=%s"
          % (p["corr_score_fwd"], p["r2_score"], p["corr_trailing_fwd"], p["r2_trailing"],
             p["partial_corr_score_fwd"]))
    print("        top-decile spike lift: score %sx vs trailing-vol %sx"
          % (p["top_decile_lift"], p["top_decile_lift_trailing"]))
    print("        pooled lift %s, day-block 95%% CI %s (naive binomial would claim %s)"
          % (p.get("top_decile_lift_observed"), p.get("lift_ci"), p.get("lift_ci_naive")))
    print("        AUC: score %s vs trailing-vol %s  (0.50 = coin flip)"
          % (p.get("auc_score"), p.get("auc_trailing")))
    print("        independent-ish blocks: %s   unique trading days: %s"
          % (p.get("effective_n"), p.get("days_unique")))


if __name__ == "__main__":
    main()
