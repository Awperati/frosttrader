#!/usr/bin/env python3
"""
train_trading_model_v11.py
==========================
Builds on v8, the best version on the honest re-test (scripts/compare_versions.py:
47.7% win rate after costs, +3.1 bps per trade, Oct 12-22).

v8's idea kept: LightGBM ensemble, long only, enter at the signal bar's close, exit on a
trailing stop or a max hold. Changes:
1. v8's bugs fixed: no refit on the "hard" 20% of bars (sklearn's fit started over, so
   v8 only learned from those); bagging on, so the 5 seeds are no longer 5 copies.
2. Day-trading features (datasets/day-trading): the 38-stock market move this bar,
   the stock vs the market, VWAP distance, relative volume vs the same time on prior
   days, ATR, EMA 20 slope, opening range, session high, prior close, daily trend.
3. The label can be the trade itself (does this exit rule win after costs?), not only
   "next bar up". Both are tried.
4. Exit rule searched: trailing stop in % or in ATR, and max hold.
5. Session rules: no entries in the first 15 or last 30 minutes, never overnight.
6. Settings are chosen by walk-forward on the days before the test: 4 folds, each model
   trained only on earlier days. The threshold is a quantile of the model's own
   training-set scores, so the same rule works for every fold and for the final model.
7. The test (2026-10-12..22) is touched once, at the end.

Output: stock_ohlcv/trading_model_v11.pt, stock_ohlcv/trading_model_v11_results.json
"""
import json
import os
import warnings
from pathlib import Path

import joblib
import lightgbm as lgb
import numpy as np
import pandas as pd

warnings.filterwarnings("ignore")

DATA_DIR = Path(__file__).resolve().parent / "stock_ohlcv"
# V11_CSV=ALL_STOCKS_5m_ext.csv: Apr 1 - Oct 23 (Alpaca SIP bars before and after the original file;
# they match it to the cent on the day both have)
CSV_FILE = DATA_DIR / os.environ.get("V11_CSV", "ALL_STOCKS_5m_ext.csv")
MODEL_OUT = DATA_DIR / "trading_model_v11.pt"
RESULTS_OUT = DATA_DIR / "trading_model_v11_results.json"
if os.environ.get("V11_TAG"):
    MODEL_OUT = DATA_DIR / f"trading_model_v11_{os.environ['V11_TAG']}.pt"
    RESULTS_OUT = DATA_DIR / f"trading_model_v11_{os.environ['V11_TAG']}_results.json"

TEST_START = pd.Timestamp("2026-10-10", tz="UTC")
COST = 0.0002            # per side
SKIP_FIRST, SKIP_LAST = 3, 6
SEEDS = [42, 43, 44]
N_FOLDS = 4
FOLD_SPAN_DAYS = 25      # folds cover the last 25 pre-test days; the first fold trains on all days before
MIN_TRADES = 300         # over all folds together (rk-sample: ~+-3 points)
QUANTILES = [0.80, 0.85, 0.90, 0.93, 0.95, 0.97, 0.98, 0.99]
# (kind, stop, max hold): kind "pct" = stop is a fraction; "atr" = stop is ATR multiples
EXITS = [("pct", 0.01, 20), ("pct", 0.005, 20), ("pct", 0.01, 12), ("pct", 0.0075, 20),
         ("atr", 2.0, 20), ("atr", 3.0, 20), ("atr", 2.0, 12)]
LABELS = ["next_up", "trade_win"]

from v11_features import ALL_FEATURES, MARKET_LEVEL, NEW_FEATURES, V8_FEATURES, compute, prepare, tradable

# V11_FEATURES: "all", "no_mkt" (drop the market-level features, keep stock-vs-market),
# or "v8" (v8's 19 only). V11_MKT_FILTER=1: longs only while the market is above its VWAP
# and up over the last hour (mt-filter: trade with the higher timeframe).
# The shipped model (stock_ohlcv/trading_model_v11.pt) is "all", no filter, on ALL_STOCKS_5m_ext.csv.
FEATURE_SET = os.environ.get("V11_FEATURES", "all")
MKT_FILTER = os.environ.get("V11_MKT_FILTER", "0") == "1"
FEATURES = {"all": ALL_FEATURES, "v8": V8_FEATURES,
            "no_mkt": V8_FEATURES + [f for f in NEW_FEATURES if f not in MARKET_LEVEL]}[FEATURE_SET]

# --- Load ---
print("Loading data...")
df = prepare(pd.read_csv(CSV_FILE, parse_dates=["timestamp"]))
days = sorted(df["date"].unique())
print(f"  {len(df):,} bars, {df['ticker'].nunique()} tickers, {len(days)} days")


print("Computing features...")
df = compute(df)
# v8's dropna covered its 19 features; the new ones may be NaN (LightGBM handles that)
df = df[tradable(df)].reset_index(drop=True)
print(f"  {len(df):,} bars with features, {len(FEATURES)} features")

TK = df["ticker"].to_numpy()
DT = df["date"].to_numpy()
C = df["close"].to_numpy()
ATR = df["atr"].to_numpy()
BAR = df["bar_of_day"].to_numpy()
DAYLEN = df.groupby(["ticker", "date"])["close"].transform("size").to_numpy()
N = len(df)
nxt_same = np.r_[(TK[1:] == TK[:-1]) & (DT[1:] == DT[:-1]), False]
next_up = np.r_[C[1:] > C[:-1], False].astype(float)
day_idx = pd.Series(range(len(days)), index=days)
DAYNO = df["date"].map(day_idx).to_numpy()
ELIGIBLE = nxt_same & (BAR >= SKIP_FIRST - 1) & (BAR < 78 - SKIP_LAST)  # 78 bars in a full day
if MKT_FILTER:
    ELIGIBLE &= (df["mkt_vwap"].to_numpy() > 0) & (df["mkt_mom_12"].to_numpy() > 0)
print(f"  Feature set {FEATURE_SET} ({len(FEATURES)}), market filter {MKT_FILTER}, eligible bars {ELIGIBLE.sum():,}")


def trade_outcomes(kind, stop, hold):
    """For every eligible bar: pnl after costs and exit index of v8's trailing-stop trade."""
    pnl = np.full(N, np.nan)
    ex_i = np.full(N, -1)
    for i in np.flatnonzero(ELIGIBLE):
        hi, j = C[i], i
        dist = stop if kind == "pct" else stop * ATR[i] / C[i]
        for k in range(i + 1, min(i + 1 + hold, N)):
            if TK[k] != TK[i] or DT[k] != DT[i]:
                break
            j = k
            hi = max(hi, C[k])
            if C[k] < hi * (1 - dist):
                break
        pnl[i] = C[j] / C[i] - 1 - 2 * COST
        ex_i[i] = j
    return pnl, ex_i


def select(idx, score, thr, pnl, ex_i):
    """v8's walk: per ticker, one position at a time, in time order."""
    taken, busy = [], {}
    for i, s in zip(idx, score):
        if s < thr or not ELIGIBLE[i]:
            continue
        if busy.get(TK[i], -1) >= i:
            continue
        taken.append(pnl[i])
        busy[TK[i]] = ex_i[i]
    return np.array(taken)


def stats(a):
    if not len(a):
        return dict(trades=0, win_rate=0.0, avg_bps=0.0, total_pct=0.0, profit_factor=0.0)
    return dict(trades=int(len(a)), win_rate=float((a > 0).mean()), avg_bps=float(a.mean() * 1e4),
                total_pct=float(a.sum() * 100),
                profit_factor=float(a[a > 0].sum() / max(-a[a <= 0].sum(), 1e-12)))


def train(rows, y):
    ms = []
    for s in SEEDS:
        m = lgb.LGBMClassifier(n_estimators=300, learning_rate=0.03, num_leaves=31,
                               min_child_samples=300, subsample=0.8, subsample_freq=1,
                               colsample_bytree=0.8, reg_lambda=1.0, random_state=s, verbose=-1)
        m.fit(df.loc[rows, FEATURES], y[rows])
        ms.append(m)
    return ms


def score(ms, rows):
    return np.mean([m.predict_proba(df.loc[rows, FEATURES])[:, 1] for m in ms], axis=0)


pre_days = [d for d in days if pd.Timestamp(d, tz="UTC") < TEST_START]
n_pre = len(pre_days)
edges = np.linspace(max(n_pre - int(os.environ.get("V11_FOLD_DAYS", FOLD_SPAN_DAYS)), 20), n_pre, N_FOLDS + 1).astype(int)
folds = [(edges[k], edges[k + 1]) for k in range(N_FOLDS)]
print(f"  Pre-test days: {n_pre}; walk-forward folds (day numbers): {folds}")

print("\nPrecomputing trade outcomes for each exit rule...")
outcomes = {e: trade_outcomes(*e) for e in EXITS}

print("\nWalk-forward search...")
results = []
oof_cache = {}
for label in LABELS:
    for e in EXITS:
        pnl, ex_i = outcomes[e]
        y = next_up if label == "next_up" else (pnl > 0).astype(float)
        key = label if label == "next_up" else (label, e)
        if key not in oof_cache:
            fold_scores = []
            for a, b in folds:
                tr = np.flatnonzero((DAYNO < a) & ELIGIBLE)
                te = np.flatnonzero((DAYNO >= a) & (DAYNO < b))
                ms = train(tr, y)
                fold_scores.append((te, score(ms, te), score(ms, tr)))
            oof_cache[key] = fold_scores
        for q in QUANTILES:
            per_fold = []
            for te, s_te, s_tr in oof_cache[key]:
                per_fold.append(select(te, s_te, np.quantile(s_tr, q), pnl, ex_i))
            allp = np.concatenate(per_fold)
            st = stats(allp)
            st["folds_positive"] = int(sum(1 for p in per_fold if len(p) and p.mean() > 0))
            st["fold_win_rates"] = [round(float((p > 0).mean()), 3) if len(p) else None for p in per_fold]
            results.append(dict(label=label, exit=e, q=q, **st))
        best_here = max((r for r in results if r["label"] == label and r["exit"] == e),
                        key=lambda r: r["win_rate"] if r["trades"] >= MIN_TRADES else -1)
        print(f"  {label:9s} exit {e}: best q {best_here['q']} trades {best_here['trades']} "
              f"win {best_here['win_rate']:.3f} avg {best_here['avg_bps']:.1f}bps "
              f"folds+ {best_here['folds_positive']}/4 {best_here['fold_win_rates']}", flush=True)

# v8 itself on the same folds, for reference: next_up label, v8's exit, v8's 0.50 threshold
ok = [r for r in results if r["trades"] >= MIN_TRADES and r["avg_bps"] > 0 and r["folds_positive"] >= 3]
if not ok:
    raise SystemExit("No setting was profitable in 3 of 4 folds; nothing to ship.")
chosen = max(ok, key=lambda r: r["win_rate"])
label, e, q = chosen["label"], chosen["exit"], chosen["q"]
print(f"\nChosen on walk-forward: label {label}, exit {e}, quantile {q} -> "
      f"win {chosen['win_rate']:.3f}, {chosen['trades']} trades, avg {chosen['avg_bps']:.1f} bps")

# --- Final model on all pre-test days, then the test, once ---
pnl, ex_i = outcomes[e]
y = next_up if label == "next_up" else (pnl > 0).astype(float)
tr = np.flatnonzero((DAYNO < n_pre) & ELIGIBLE)
te = np.flatnonzero(DAYNO >= n_pre)
ms = train(tr, y)
thr = float(np.quantile(score(ms, tr), q))
test = stats(select(te, score(ms, te), thr, pnl, ex_i))
se = np.sqrt(test["win_rate"] * (1 - test["win_rate"]) / max(test["trades"], 1))
nomodel = stats(select(te, np.ones(len(te)), 0.5, pnl, ex_i))
print(f"\nTEST (Oct 12 onward): {test['trades']} trades, win rate {test['win_rate']:.4f} (+-{se:.3f}), "
      f"avg {test['avg_bps']:.2f} bps, total {test['total_pct']:.2f}%, PF {test['profit_factor']:.2f}")
print(f"TEST, same exit, every allowed bar (no model): win {nomodel['win_rate']:.4f}, avg {nomodel['avg_bps']:.2f} bps")

imp = pd.Series(np.mean([m.feature_importances_ for m in ms], axis=0), index=FEATURES).sort_values(ascending=False)
print("Top features:", ", ".join(f"{k} {v:.0f}" for k, v in imp.head(10).items()))

joblib.dump({"models": ms, "features": FEATURES, "threshold": thr, "label": label,
             "exit": {"kind": e[0], "stop": e[1], "max_hold": e[2]},
             "skip_first_bars": SKIP_FIRST, "skip_last_bars": SKIP_LAST}, MODEL_OUT)
RESULTS_OUT.write_text(json.dumps({
    "test_period": "2026-10-12 to the end of the data", "chosen": chosen, "threshold": thr, "test": test,
    "test_win_rate_std_error": float(se), "test_no_model": nomodel,
    "walk_forward": results, "feature_importance": {k: float(v) for k, v in imp.items()},
}, indent=2, default=str))
print(f"\nSaved {MODEL_OUT.name} and {RESULTS_OUT.name}")
