#!/usr/bin/env python3
"""
train_trading_model_v10.py
==========================
v8 was the best version on an honest re-test (scripts/compare_versions.py). v10 keeps
its idea (LightGBM ensemble + a written exit rule) and rebuilds it with the rules in
datasets/day-trading/techniques.json:

- i-atr:      stop and target are measured in ATR, not fixed percents.
- s-*:        label = did the trade itself win (target before stop), not "next bar up".
- ts-paper:   no look-ahead. Signal on bar i's close, enter at bar i+1's open.
              If stop and target fall in the same bar, the stop counts.
- s-preconditions / s-vwap / s-ema: skip the first 15 minutes and the last 30 minutes;
              exit by the session close, never hold overnight.
- p-volume / i-vwap / i-ma / p-levels / mt-filter: features for VWAP, EMA 9/20,
              relative volume vs the same time on prior days, the opening range,
              prior-day high/low/close, the hourly and daily trend, and the whole
              38-stock market's move this bar.
- cost-roundtrip: 2 bps per side is taken off every trade.
- rk-sample:  thresholds need >= 100 trades.

Honest split by date: train < 2026-10-01, validation 2026-10-01..09 (early stopping,
exit config, threshold), test 2026-10-12..22 (touched once, at the end).

Output: stock_ohlcv/trading_model_v10.pt, stock_ohlcv/trading_model_v10_results.json
"""
import json
import warnings
from pathlib import Path

import joblib
import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.metrics import roc_auc_score

warnings.filterwarnings("ignore")

DATA_DIR = Path(__file__).resolve().parent / "stock_ohlcv"
CSV_FILE = DATA_DIR / "ALL_STOCKS_5m.csv"
MODEL_OUT = DATA_DIR / "trading_model_v10.pt"
RESULTS_OUT = DATA_DIR / "trading_model_v10_results.json"

VAL_START = pd.Timestamp("2026-10-01", tz="UTC")
TEST_START = pd.Timestamp("2026-10-10", tz="UTC")
COST = 0.0002          # per side
SKIP_FIRST = 3         # bars: first 15 minutes
SKIP_LAST = 6          # bars: last 30 minutes
MIN_TRADES = 100
SEEDS = [42, 43, 44, 45, 46]
THRESHOLDS = [round(0.30 + i * 0.01, 2) for i in range(61)]
# (target ATR, stop ATR, max hold bars)
EXIT_CONFIGS = [(1.0, 1.0, 12), (1.0, 1.5, 12), (0.75, 1.5, 12), (1.5, 1.0, 12),
                (2.0, 1.0, 24), (1.0, 2.0, 24), (0.5, 1.0, 6)]

# --- Load ---
print("Loading data...")
df = pd.read_csv(CSV_FILE, parse_dates=["timestamp"])
df = df[(df["volume"] > 0) & (df["high"] >= df["low"]) & (df["close"] > 0)]
df = df.drop_duplicates(["ticker", "timestamp"]).sort_values(["ticker", "timestamp"]).reset_index(drop=True)
df["date"] = df["timestamp"].dt.date
print(f"  {len(df):,} bars, {df['ticker'].nunique()} tickers, {df['date'].nunique()} days")


# --- Features ---
def ticker_features(g):
    c, h, l, o, v = g["close"], g["high"], g["low"], g["open"], g["volume"]
    day = g["date"]
    out = pd.DataFrame(index=g.index)
    prev_c = c.shift(1)
    tr = pd.concat([h - l, (h - prev_c).abs(), (l - prev_c).abs()], axis=1).max(axis=1)
    atr = tr.rolling(14).mean()
    out["atr"] = atr
    out["atr_pct"] = atr / c

    # v8 core features
    out["return"] = c.pct_change()
    out["high_low_range"] = (h - l) / c
    out["close_position"] = (c - l) / (h - l + 1e-8)
    out["volatility_20"] = c.pct_change().rolling(20).std()
    out["ma_dist"] = c / c.rolling(20).mean() - 1
    delta = c.diff()
    gain = delta.where(delta > 0, 0).rolling(14).mean()
    loss = (-delta.where(delta < 0, 0)).rolling(14).mean()
    out["rsi_14"] = 100 - 100 / (1 + gain / (loss + 1e-8))
    out["momentum_5"] = c.pct_change(5)
    out["momentum_10"] = c.pct_change(10)
    out["momentum_20"] = c.pct_change(20)
    out["ma_dist_50"] = c / c.rolling(50).mean() - 1

    # Session: bar of day, VWAP, opening range, session extremes
    gb = g.groupby(day)
    bar = gb.cumcount()
    out["bar_of_day"] = bar
    tp = (h + l + c) / 3
    vwap = (tp * v).groupby(day).cumsum() / v.groupby(day).cumsum()
    out["vwap_dist"] = (c - vwap) / atr
    out["vwap_slope"] = (vwap - vwap.groupby(day).shift(6)) / atr
    or_hi = h.where(bar < 3).groupby(day).transform("max")
    or_lo = l.where(bar < 3).groupby(day).transform("min")
    out["or_pos"] = ((c - or_lo) / (or_hi - or_lo + 1e-8)).where(bar >= 3)
    out["or_width"] = (or_hi - or_lo) / atr
    day_open = o.groupby(day).transform("first")
    out["day_ret_atr"] = (c - day_open) / atr
    out["sess_hi_dist"] = (c - h.groupby(day).cummax()) / atr
    out["sess_lo_dist"] = (c - l.groupby(day).cummin()) / atr

    # Prior day levels and daily trend
    daily = g.groupby(day).agg(dh=("high", "max"), dl=("low", "min"), dc=("close", "last"))
    daily["dc5"] = daily["dc"].shift(5)
    prev = daily.shift(1)
    pdh, pdl, pdc = day.map(prev["dh"]), day.map(prev["dl"]), day.map(prev["dc"])
    out["pdh_dist"] = (c - pdh) / atr
    out["pdl_dist"] = (c - pdl) / atr
    out["pdc_dist"] = (c - pdc) / atr
    out["gap_day"] = day_open / pdc - 1
    out["daily_trend"] = pdc / day.map(prev["dc5"]) - 1

    # EMA 9/20 and the hourly trend
    e9, e20 = c.ewm(span=9, adjust=False).mean(), c.ewm(span=20, adjust=False).mean()
    out["ema9_dist"] = (c - e9) / atr
    out["ema20_dist"] = (c - e20) / atr
    out["ema_spread"] = (e9 - e20) / atr
    out["ema20_slope"] = (e20 - e20.shift(3)) / atr
    out["hourly_trend"] = c / c.shift(12) - 1

    # Volume: relative to the same bar on the prior 10 days, and the last 20 bars
    out["rvol_tod"] = v / v.groupby(bar).transform(lambda s: s.shift(1).rolling(10, min_periods=3).mean())
    out["vol_spike"] = v / v.rolling(20).mean()
    out["vol_trend"] = v.rolling(3).mean() / v.rolling(20).mean()
    out["body"] = (c - o) / atr
    return out


print("Computing features...")
f = df.groupby("ticker", group_keys=False).apply(ticker_features)
df = pd.concat([df, f], axis=1)
# Market context: the 38-stock average move at the same timestamp
df["mkt_ret"] = df.groupby("timestamp")["return"].transform("mean")
df["mkt_mom_12"] = df.groupby("timestamp")["hourly_trend"].transform("mean")
df["rel_ret"] = df["return"] - df["mkt_ret"]
df["rel_mom_12"] = df["hourly_trend"] - df["mkt_mom_12"]
df["mkt_vwap"] = df.groupby("timestamp")["vwap_dist"].transform("mean")

FEATURES = ["atr_pct", "return", "high_low_range", "close_position", "volatility_20", "ma_dist",
            "rsi_14", "momentum_5", "momentum_10", "momentum_20", "ma_dist_50", "bar_of_day",
            "vwap_dist", "vwap_slope", "or_pos", "or_width", "day_ret_atr", "sess_hi_dist",
            "sess_lo_dist", "pdh_dist", "pdl_dist", "pdc_dist", "gap_day", "daily_trend",
            "ema9_dist", "ema20_dist", "ema_spread", "ema20_slope", "hourly_trend", "rvol_tod",
            "vol_spike", "vol_trend", "body", "mkt_ret", "mkt_mom_12", "rel_ret", "rel_mom_12",
            "mkt_vwap"]
print(f"  Features: {len(FEATURES)}")

# --- Trade outcomes for every bar (entry at next open, ATR stop/target, session exit) ---
ticker_arr = df["ticker"].to_numpy()
date_arr = df["date"].to_numpy()
O, H, L, C = (df[k].to_numpy() for k in ("open", "high", "low", "close"))
ATR = df["atr"].to_numpy()
BAR = df["bar_of_day"].to_numpy()
day_len = df.groupby(["ticker", "date"])["close"].transform("size").to_numpy()
N = len(df)


def outcomes(tgt, stp, hold):
    """pnl (after costs) and exit index of the trade signalled on each bar; NaN if not tradable."""
    pnl = np.full(N, np.nan)
    exit_i = np.full(N, -1)
    for i in range(N - 1):
        if (BAR[i] < SKIP_FIRST - 1 or BAR[i] >= day_len[i] - SKIP_LAST or np.isnan(ATR[i])
                or ticker_arr[i + 1] != ticker_arr[i] or date_arr[i + 1] != date_arr[i]):
            continue
        e = O[i + 1]
        stop, target = e - stp * ATR[i], e + tgt * ATR[i]
        j, ex = i + 1, None
        last = min(i + hold, N - 1)
        while j <= last and ticker_arr[j] == ticker_arr[i] and date_arr[j] == date_arr[i]:
            if L[j] <= stop:
                ex = min(stop, O[j]) if j > i + 1 else stop
                break
            if H[j] >= target:
                ex = max(target, O[j]) if j > i + 1 else target
                break
            j += 1
        if ex is None:
            j -= 1
            ex = C[j]
        pnl[i] = ex / e - 1 - 2 * COST
        exit_i[i] = j
    return pnl, exit_i


def backtest(idx, prob, thresh, pnl, exit_i):
    """Non-overlapping trades per ticker over the rows in idx (time order kept)."""
    taken = []
    busy_until = {}
    for k, i in enumerate(idx):
        if prob[k] < thresh or np.isnan(pnl[i]):
            continue
        t = ticker_arr[i]
        if busy_until.get(t, -1) >= i:
            continue
        taken.append(pnl[i])
        busy_until[t] = exit_i[i]
    a = np.array(taken)
    if not len(a):
        return dict(trades=0, win_rate=0.0, avg_bps=0.0, total_pct=0.0, profit_factor=0.0)
    pf = a[a > 0].sum() / max(-a[a <= 0].sum(), 1e-12)
    return dict(trades=int(len(a)), win_rate=float((a > 0).mean()), avg_bps=float(a.mean() * 1e4),
                total_pct=float(a.sum() * 100), profit_factor=float(pf))


def train(tr, va, label):
    models = []
    for s in SEEDS:
        m = lgb.LGBMClassifier(n_estimators=2000, learning_rate=0.02, num_leaves=31,
                               min_child_samples=200, subsample=0.8, subsample_freq=1,
                               colsample_bytree=0.8, reg_lambda=1.0, random_state=s, verbose=-1)
        m.fit(tr[FEATURES], label[tr.index], eval_set=[(va[FEATURES], label[va.index])],
              eval_metric="auc", callbacks=[lgb.early_stopping(100, verbose=False)])
        models.append(m)
    return models


def predict(models, d):
    return np.mean([m.predict_proba(d[FEATURES])[:, 1] for m in models], axis=0)


def pick_threshold(idx, prob, pnl, exit_i):
    best = None
    for t in THRESHOLDS:
        r = backtest(idx, prob, t, pnl, exit_i)
        if r["trades"] >= MIN_TRADES and r["avg_bps"] > 0 and (best is None or r["win_rate"] > best[1]["win_rate"]):
            best = (t, r)
    return best


ts = df["timestamp"]
in_tr, in_va, in_te = ts < VAL_START, (ts >= VAL_START) & (ts < TEST_START), ts >= TEST_START

print("\nSearching exit configs on validation...")
runs = []
for tgt, stp, hold in EXIT_CONFIGS:
    pnl, exit_i = outcomes(tgt, stp, hold)
    label = pd.Series((pnl > 0).astype(float), index=df.index)
    ok = ~np.isnan(pnl)
    tr, va = df[in_tr & ok], df[in_va & ok]
    models = train(tr, va, label)
    pv = predict(models, va)
    base = backtest(va.index.to_numpy(), np.ones(len(va)), 0.5, pnl, exit_i)
    best = pick_threshold(va.index.to_numpy(), pv, pnl, exit_i)
    print(f"  target {tgt} ATR, stop {stp} ATR, hold {hold}: base win {base['win_rate']:.3f} | "
          + (f"thr {best[0]:.2f} val win {best[1]['win_rate']:.3f} trades {best[1]['trades']} "
             f"avg {best[1]['avg_bps']:.1f}bps" if best else "no threshold with >=100 trades and avg > 0"),
          flush=True)
    if best:
        runs.append(dict(cfg=(tgt, stp, hold), thresh=best[0], val=best[1], base_val=base,
                         models=models, pnl=pnl, exit_i=exit_i, lift=best[1]["win_rate"] - base["win_rate"]))

# Choose on validation only: highest win rate that is profitable after costs
chosen = max(runs, key=lambda r: r["val"]["win_rate"])
tgt, stp, hold = chosen["cfg"]
print(f"\nChosen on validation: target {tgt} ATR, stop {stp} ATR, hold {hold} bars, threshold {chosen['thresh']:.2f}")

# --- Test, touched once ---
te = df[in_te & ~np.isnan(chosen["pnl"])]
pt = predict(chosen["models"], te)
test = backtest(te.index.to_numpy(), pt, chosen["thresh"], chosen["pnl"], chosen["exit_i"])
base_test = backtest(te.index.to_numpy(), np.ones(len(te)), 0.5, chosen["pnl"], chosen["exit_i"])
auc = roc_auc_score((chosen["pnl"][te.index] > 0).astype(int), pt)
se = np.sqrt(test["win_rate"] * (1 - test["win_rate"]) / max(test["trades"], 1))
print(f"\nTEST: trades {test['trades']}, win rate {test['win_rate']:.4f} (+-{se:.3f}), "
      f"avg {test['avg_bps']:.2f} bps, total {test['total_pct']:.2f}%, PF {test['profit_factor']:.2f}, AUC {auc:.4f}")
print(f"TEST, same exit rule, every allowed bar (no model): win rate {base_test['win_rate']:.4f}, "
      f"avg {base_test['avg_bps']:.2f} bps")

imp = pd.Series(chosen["models"][0].feature_importances_, index=FEATURES).sort_values(ascending=False)
print("\nTop features:", ", ".join(f"{k} {v}" for k, v in imp.head(10).items()))

joblib.dump({"models": chosen["models"], "features": FEATURES, "threshold": chosen["thresh"],
             "target_atr": tgt, "stop_atr": stp, "max_hold": hold,
             "skip_first_bars": SKIP_FIRST, "skip_last_bars": SKIP_LAST}, MODEL_OUT)
results = {
    "split": {"train": "< 2026-10-01", "validation": "2026-10-01..09", "test": "2026-10-12..22"},
    "exit": {"target_atr": tgt, "stop_atr": stp, "max_hold_bars": hold, "entry": "next bar open",
             "cost_per_side": COST},
    "threshold": chosen["thresh"], "auc": float(auc),
    "validation": chosen["val"], "test": test, "test_no_model": base_test,
    "win_rate_std_error": float(se),
    "all_configs": [{"cfg": r["cfg"], "thresh": r["thresh"], "val": r["val"], "base_val": r["base_val"]}
                    for r in runs],
    "feature_importance": {k: int(v) for k, v in imp.items()},
}
RESULTS_OUT.write_text(json.dumps(results, indent=2))
print(f"\nSaved {MODEL_OUT.name} and {RESULTS_OUT.name}")
