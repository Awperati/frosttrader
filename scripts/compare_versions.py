#!/usr/bin/env python3
"""Honest re-test of the v4-v9 training recipes on one shared, fixed harness.

What the original scripts got wrong (and this harness fixes):
- Rows were sorted by "difficulty" before the backtest, so close[i+1] was a random
  other bar (often another ticker). Here each ticker is walked in time order.
- v7-v9 split train/test by difficulty rank, not by time. Here the split is by date:
  train < 2026-10-01, validation 2026-10-01..09, test 2026-10-12..22.
- Early stopping and the threshold were picked on the test set. Here both use
  validation; test is touched once.
- Trades never cross the session close (no overnight holds).

Each recipe is otherwise reproduced as written (features, the refit on "hard" bars,
seed ensembles, hold rules), so the numbers show what each version really does.
Run from the repo root: python scripts/compare_versions.py
"""
import json
import warnings
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.metrics import roc_auc_score

warnings.filterwarnings("ignore")

ROOT = Path(__file__).resolve().parent.parent
CSV = ROOT / "stock_ohlcv" / __import__("os").environ.get("V11_CSV", "ALL_STOCKS_5m.csv")
VAL_START = pd.Timestamp("2026-10-01", tz="UTC")
TEST_START = pd.Timestamp("2026-10-10", tz="UTC")
COST = 0.0002  # 2 bps per side
THRESHOLDS = [round(0.30 + i * 0.01, 2) for i in range(41)]
MIN_TRADES = 100


def feats_v5(g):
    c, h, l, o, v = g["close"], g["high"], g["low"], g["open"], g["volume"]
    ma_20, ma_50, ma_5 = c.rolling(20).mean(), c.rolling(50).mean(), c.rolling(5).mean()
    delta = c.diff()
    gain = delta.where(delta > 0, 0).rolling(14).mean()
    loss = (-delta.where(delta < 0, 0)).rolling(14).mean()
    tod = g["timestamp"].dt.hour * 60 + g["timestamp"].dt.minute
    return pd.DataFrame({
        "return": c.pct_change(), "vol_change": v.pct_change(),
        "high_low_range": (h - l) / c, "close_position": (c - l) / (h - l + 1e-10),
        "volatility_20": c.pct_change().rolling(20).std(), "ma_dist": (c - ma_20) / ma_20,
        "rsi_14": 100 - 100 / (1 + gain / (loss + 1e-10)),
        "momentum_5": c / c.shift(5) - 1, "momentum_10": c / c.shift(10) - 1,
        "vol_spike": v / (v.rolling(20).mean() + 1e-10), "gap": o / c.shift(1) - 1,
        "time_of_day": tod, "ma_dist_50": (c - ma_50) / ma_50,
        "momentum_20": c / c.shift(20) - 1, "volatility_50": c.pct_change().rolling(50).std(),
        "ma_dist_5": (c - ma_5) / ma_5, "trend_up_50": (c > ma_50).astype(int),
        "tod_sin": np.sin(2 * np.pi * tod / 1440), "tod_cos": np.cos(2 * np.pi * tod / 1440),
    }, index=g.index)


def feats_v7(g):
    c, h, l, v = g["close"], g["high"], g["low"], g["volume"]
    delta = c.diff()
    gain = delta.where(delta > 0, 0).rolling(14).mean()
    loss = (-delta.where(delta < 0, 0)).rolling(14).mean()
    tod = g["timestamp"].dt.hour + g["timestamp"].dt.minute / 60.0
    return pd.DataFrame({
        "return": c.pct_change(), "vol_change": v / v.rolling(20).mean() - 1,
        "high_low_range": (h - l) / c, "close_position": (c - l) / (h - l + 1e-8),
        "volatility_20": c.pct_change().rolling(20).std(), "ma_dist": c / c.rolling(20).mean() - 1,
        "rsi_14": 100 - 100 / (1 + gain / (loss + 1e-8)),
        "momentum_5": c.pct_change(5), "momentum_10": c.pct_change(10),
        "vol_spike": v / v.rolling(20).std(), "gap": c / c.shift(1) - 1, "time_of_day": tod,
        "ma_dist_50": c / c.rolling(50).mean() - 1, "momentum_20": c.pct_change(20),
        "volatility_50": c.pct_change().rolling(50).std(), "ma_dist_5": c / c.rolling(5).mean() - 1,
        "trend_up_50": (c > c.rolling(50).mean()).astype(int),
        "tod_sin": np.sin(2 * np.pi * tod / 24), "tod_cos": np.cos(2 * np.pi * tod / 24),
    }, index=g.index)


V5_COLS = ["return", "vol_change", "high_low_range", "close_position", "volatility_20",
           "ma_dist", "rsi_14", "momentum_5", "momentum_10", "vol_spike", "gap",
           "time_of_day", "ma_dist_50", "momentum_20", "volatility_50", "ma_dist_5",
           "trend_up_50", "tod_sin", "tod_cos"]
V4_COLS = ["gap", "return", "close_position", "vol_change", "high_low_range"]
V9_COLS = [c for c in V5_COLS if c not in ("gap", "trend_up_50")]


def load():
    df = pd.read_csv(CSV, parse_dates=["timestamp"])
    df = df[(df["volume"] > 0) & (df["high"] >= df["low"]) & (df["close"] > 0)]
    df = df.drop_duplicates(["ticker", "timestamp"]).sort_values(["ticker", "timestamp"])
    df = df.reset_index(drop=True)
    df["date"] = df["timestamp"].dt.date
    nxt = df.groupby("ticker")["close"].shift(-1)
    df["label"] = (nxt > df["close"]).astype(float)
    df.loc[nxt.isna(), "label"] = np.nan
    return df


def lgbm(seed, n):
    return lgb.LGBMClassifier(n_estimators=n, learning_rate=0.03, num_leaves=127,
                              random_state=seed, verbose=-1)


def fit(m, X, y, Xv, yv, w=None):
    m.fit(X, y, sample_weight=w, eval_set=[(Xv, yv)],
          callbacks=[lgb.early_stopping(50, verbose=False)])
    return m


def train_recipe(name, tr, va, cols):
    X, y, Xv, yv = tr[cols], tr["label"], va[cols], va["label"]
    if name in ("v4", "v5", "v6"):
        hard = tr[tr["volatility_20"].rank(pct=True) > 0.8]   # as written: rank, > 0.8
    else:
        d = tr["return"].abs().rank(pct=True)                    # v7-v9: |return| rank
        hard = tr[d > d.quantile(0.8)]
    seeds = {"v4": [42], "v5": [42, 43, 44]}.get(name, [42, 43, 44, 45, 46])
    rounds = 500 if name in ("v4", "v5") else 1000
    w = None
    if name in ("v6", "v7"):
        q = fit(lgbm(42, 100), X, y, Xv, yv).predict_proba(X)[:, 1]
        w = pd.Series(np.where((q >= 0.30) & (q <= 0.50), 2.0, 1.0), index=tr.index)
    models = []
    for s in seeds:
        m = fit(lgbm(s, rounds), X, y, Xv, yv, w)
        # The originals then call .fit() again on the hard bars; sklearn's fit starts over,
        # so the shipped model only ever saw the hardest 20% of bars.
        hw = w.loc[hard.index].values if (w is not None and name == "v6") else None
        m = fit(m, hard[cols], hard["label"], Xv, yv, hw)
        models.append(m)
    if name == "v5":
        models = models[:1]  # v5 saves models[0] only
    return models


def predict(models, d, cols):
    return np.mean([m.predict_proba(d[cols])[:, 1] for m in models], axis=0)


def backtest(d, prob, thresh, rule):
    """Per ticker, in time order, one position at a time, never past the session close."""
    pnls = []
    for _, g in d.assign(prob=prob).groupby("ticker", sort=False):
        c = g["close"].to_numpy(); p = g["prob"].to_numpy(); day = g["date"].to_numpy()
        n = len(g); i = 0
        while i < n - 1:
            if p[i] < thresh or day[i + 1] != day[i]:
                i += 1; continue
            if rule is None:                       # hold one bar
                ex = i + 1
            else:                                  # trailing stop, max hold
                stop, hold = rule
                hi = c[i]; ex = i + 1
                for j in range(i + 1, min(i + 1 + hold, n)):
                    if day[j] != day[i]:
                        break
                    ex = j; hi = max(hi, c[j])
                    if c[j] < hi * (1 - stop):
                        break
            pnls.append(c[ex] / c[i] - 1)
            i = ex + 1 if rule is not None else ex
    g = np.array(pnls)
    if not len(g):
        return dict(trades=0, win_rate=0.0, gross_win_rate=0.0, avg_bps=0.0, total_pct=0.0)
    a = g - 2 * COST
    return dict(trades=len(a), win_rate=float((a > 0).mean()), gross_win_rate=float((g > 0).mean()),
                avg_bps=float(a.mean() * 1e4), total_pct=float(a.sum() * 100))


RECIPES = {
    "v4": (V4_COLS, feats_v5, None),
    "v5": (V5_COLS, feats_v5, None),
    "v6": (V5_COLS, feats_v5, None),
    "v7": (V5_COLS, feats_v7, None),
    "v8": (V5_COLS, feats_v7, (0.01, 20)),
    "v9": (V9_COLS, feats_v7, (0.0015, 10)),
}


def main():
    raw = load()
    feats = {}
    for fn in (feats_v5, feats_v7):
        f = raw.groupby("ticker", group_keys=False).apply(fn)
        feats[fn.__name__] = pd.concat([raw, f], axis=1).dropna().reset_index(drop=True)
    out = {}
    for name, (cols, fn, rule) in RECIPES.items():
        d = feats[fn.__name__]
        tr = d[d["timestamp"] < VAL_START]
        va = d[(d["timestamp"] >= VAL_START) & (d["timestamp"] < TEST_START)]
        te = d[d["timestamp"] >= TEST_START]
        models = train_recipe(name, tr, va, cols)
        pv, pt = predict(models, va, cols), predict(models, te, cols)
        best = max(((t, backtest(va, pv, t, rule)) for t in THRESHOLDS),
                   key=lambda x: (x[1]["trades"] >= MIN_TRADES, x[1]["win_rate"]))
        res = dict(auc=float(roc_auc_score(te["label"], pt)), thresh=best[0],
                   val=best[1], test=backtest(te, pt, best[0], rule),
                   test_at_050=backtest(te, pt, 0.50, rule))
        out[name] = res
        print(f"{name}: AUC {res['auc']:.4f} thr {res['thresh']:.2f} "
              f"val win {res['val']['win_rate']:.3f} | TEST trades {res['test']['trades']} "
              f"win {res['test']['win_rate']:.3f} gross {res['test']['gross_win_rate']:.3f} avg {res['test']['avg_bps']:.2f}bps "
              f"total {res['test']['total_pct']:.2f}% | @0.50 {res['test_at_050']}", flush=True)
    d = feats["feats_v5"]; te = d[d["timestamp"] >= TEST_START]
    out["always_long_1bar"] = backtest(te, np.ones(len(te)), 0.5, None)
    print("baseline always long, 1 bar:", out["always_long_1bar"])
    (ROOT / "stock_ohlcv" / "compare_versions_result.json").write_text(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
