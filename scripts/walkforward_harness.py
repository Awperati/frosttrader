#!/usr/bin/env python3
"""Rolling walk-forward evaluation for the v11 recipe, honest and data-source-agnostic.

What it does (no promises, no predictions -- just measurement on past bars):
  * Split the bars by whole days at one or more cutoffs.
  * For each cutoff: train the v11 recipe on days strictly BEFORE it, then walk trades on
    the days AT/AFTER it (up to the next cutoff). The test days are never seen in training.
  * Metrics after costs: trades, win rate, avg return per trade (bps), total %, profit
    factor, max drawdown, and a per-day breakdown -- each win rate with a Wilson range and
    each average with a +-1.96 s.e. range.
  * Three yardsticks on the SAME test days: the fresh model, the CURRENT shipped v11.pt,
    and two naive baselines (buy every allowed bar; random bars, same count).

The trade walk and the entry rule match train_trading_model_v11.py exactly, so a single
cutoff at TEST_START reproduces the shipped recipe. The metric helpers are pure and are
covered by test/metrics_test.py; the per-cutoff model fit is the heavy, RAM-gated part.

  py -3.14 scripts/walkforward_harness.py --csv stock_ohlcv/ALL_STOCKS_5m_iex.csv \
      --cutoffs 2026-10-10 --test-days 30 --out /tmp/wf.json
"""
import argparse
import json
import os
import sys
import warnings
from pathlib import Path

import joblib
import numpy as np
import pandas as pd

warnings.filterwarnings("ignore")

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "stock_ohlcv"
COST = 0.0002
SKIP_FIRST, SKIP_LAST = 3, 6
SEEDS = [42, 43, 44]

sys.path.insert(0, str(ROOT))  # v11_features.py lives at the repo root, beside train_v11
from v11_features import ALL_FEATURES, compute, prepare, tradable  # noqa: E402


# ---------- pure metric helpers (covered by test/metrics_test.py) ----------

def wilson_ci(wins, n, z=1.96):
    """A Wilson score range for a win rate: steadier than +-sqrt(p(1-p)/n) at small n."""
    if n == 0:
        return (0.0, 0.0)
    p = wins / n
    d = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / d
    half = z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (float(max(0.0, centre - half)), float(min(1.0, centre + half)))


def mean_ci_bps(pnl, z=1.96):
    """A +-z*s.e. range for the average return per trade, in bps. Wide at small n; approximate."""
    n = len(pnl)
    if n == 0:
        return (0.0, 0.0)
    if n == 1:
        return (float(pnl[0] * 1e4), float(pnl[0] * 1e4))
    se = np.std(pnl, ddof=1) / np.sqrt(n)
    m = float(np.mean(pnl))
    return (float((m - z * se) * 1e4), float((m + z * se) * 1e4))


def max_drawdown_pct(pnl_time_ordered):
    """Largest peak-to-trough drop of the cumulative return, in % (trades in time order)."""
    if len(pnl_time_ordered) == 0:
        return 0.0
    eq = np.cumsum(pnl_time_ordered)
    peak = np.maximum.accumulate(eq)
    return float((peak - eq).max() * 100)


def summarize(pnl_time_ordered):
    """Every after-cost metric for one set of trades, with the win rate and average ranges."""
    a = np.asarray(pnl_time_ordered, float)
    n = len(a)
    if n == 0:
        return dict(trades=0, win_rate=0.0, win_rate_ci=[0.0, 0.0], avg_bps=0.0,
                    avg_bps_ci=[0.0, 0.0], total_pct=0.0, profit_factor=0.0, max_drawdown_pct=0.0)
    wins = int((a > 0).sum())
    return dict(
        trades=n, win_rate=wins / n, win_rate_ci=list(wilson_ci(wins, n)),
        avg_bps=float(a.mean() * 1e4), avg_bps_ci=list(mean_ci_bps(a)),
        total_pct=float(a.sum() * 100),
        profit_factor=float(a[a > 0].sum() / max(-a[a <= 0].sum(), 1e-12)),
        max_drawdown_pct=max_drawdown_pct(a))


def per_day(dates, pnl):
    """One row per calendar day: trades, win rate, average bps. dates aligned with pnl."""
    df = pd.DataFrame({"date": pd.to_datetime(dates), "pnl": np.asarray(pnl, float)})
    out = []
    for d, g in df.groupby(df["date"].dt.date):
        a = g["pnl"].to_numpy()
        out.append(dict(date=str(d), trades=int(len(a)), win_rate=float((a > 0).mean()),
                        avg_bps=float(a.mean() * 1e4)))
    return out


def random_baseline(elig_pnl, n, seed=0, reps=200):
    """Pick n trades at random from all allowed bars, reps times: the mean win rate and
    average you'd get with no skill but the same trade count. Returns point + range."""
    elig_pnl = np.asarray(elig_pnl, float)
    if len(elig_pnl) == 0 or n == 0:
        return dict(win_rate=0.0, win_rate_ci=[0.0, 0.0], avg_bps=0.0, avg_bps_ci=[0.0, 0.0])
    rng = np.random.default_rng(seed)
    n = min(n, len(elig_pnl))
    wr, av = [], []
    for _ in range(reps):
        s = rng.choice(elig_pnl, size=n, replace=False)
        wr.append((s > 0).mean())
        av.append(s.mean() * 1e4)
    return dict(win_rate=float(np.mean(wr)), win_rate_ci=[float(np.quantile(wr, 0.025)), float(np.quantile(wr, 0.975))],
                avg_bps=float(np.mean(av)), avg_bps_ci=[float(np.quantile(av, 0.025)), float(np.quantile(av, 0.975))])


# ---------- the trade machinery (matches train_trading_model_v11.py) ----------

def trade_outcomes(C, ATR, TK, DT, eligible, kind, stop, hold):
    """pnl after costs and exit index for every eligible bar; the walk breaks at day/ticker."""
    n = len(C)
    pnl = np.full(n, np.nan)
    ex_i = np.full(n, -1)
    for i in np.flatnonzero(eligible):
        hi, j = C[i], i
        dist = stop if kind == "pct" else stop * ATR[i] / C[i]
        for k in range(i + 1, min(i + 1 + hold, n)):
            if TK[k] != TK[i] or DT[k] != DT[i]:
                break
            j = k
            hi = max(hi, C[k])
            if C[k] < hi * (1 - dist):
                break
        pnl[i] = C[j] / C[i] - 1 - 2 * COST
        ex_i[i] = j
    return pnl, ex_i


def select(order, score, thr, eligible, TK, ex_i, pnl):
    """One position per ticker at a time, in time order. Returns (pnl taken, entry indices)."""
    taken, idx, busy = [], [], {}
    for i, s in zip(order, score):
        if s < thr or not eligible[i]:
            continue
        if busy.get(TK[i], -1) >= i:
            continue
        taken.append(pnl[i])
        idx.append(i)
        busy[TK[i]] = ex_i[i]
    return np.array(taken), np.array(idx, int)


def train(X, y):
    import lightgbm as lgb
    ms = []
    for s in SEEDS:
        m = lgb.LGBMClassifier(n_estimators=300, learning_rate=0.03, num_leaves=31,
                               min_child_samples=300, subsample=0.8, subsample_freq=1,
                               colsample_bytree=0.8, reg_lambda=1.0, random_state=s, verbose=-1)
        m.fit(X, y)
        ms.append(m)
    return ms


def score_models(ms, X):
    return np.mean([m.predict_proba(X)[:, 1] for m in ms], axis=0)


def load_frame(csv):
    """Load bars -> features -> tradable rows, with the arrays the walk needs."""
    df = prepare(pd.read_csv(csv, parse_dates=["timestamp"]))
    df = compute(df)
    df = df[tradable(df)].reset_index(drop=True)
    days = sorted(df["date"].unique())
    dayno = df["date"].map(pd.Series(range(len(days)), index=days)).to_numpy()
    bar = df["bar_of_day"].to_numpy()
    nxt_same = np.r_[(df["ticker"].to_numpy()[1:] == df["ticker"].to_numpy()[:-1]) &
                     (df["date"].to_numpy()[1:] == df["date"].to_numpy()[:-1]), False]
    eligible = nxt_same & (bar >= SKIP_FIRST - 1) & (bar < 78 - SKIP_LAST)
    return dict(df=df, days=days, dayno=dayno, eligible=eligible,
                C=df["close"].to_numpy(), ATR=df["atr"].to_numpy(),
                TK=df["ticker"].to_numpy(), DT=df["date"].to_numpy())


def evaluate(fr, score_vec, thr, pnl, ex_i, test_mask):
    """Full metric block for one scored model on the test rows."""
    order = np.flatnonzero(test_mask)
    taken, idx = select(order, score_vec[order], thr, fr["eligible"], fr["TK"], ex_i, pnl)
    s = summarize(taken)
    s["per_day"] = per_day(fr["DT"][idx], taken) if len(idx) else []
    return s


def run(csv, cutoffs, test_days, q, label, exit_rule, saved_model, out_path):
    fr = load_frame(csv)
    df, days, dayno, eligible = fr["df"], fr["days"], fr["dayno"], fr["eligible"]
    kind, stop, hold = exit_rule
    pnl, ex_i = trade_outcomes(fr["C"], fr["ATR"], fr["TK"], fr["DT"], eligible, kind, stop, hold)
    y = (pnl > 0).astype(float) if label == "trade_win" else \
        np.r_[fr["C"][1:] > fr["C"][:-1], False].astype(float)
    day_no_of = pd.Series(range(len(days)), index=[str(d) for d in days])
    saved = joblib.load(saved_model) if saved_model and Path(saved_model).exists() else None

    report = {"csv": str(csv), "cutoffs": [], "cost_bps_per_side": COST * 1e4,
              "note": "past-bar measurement only; not advice, not a prediction"}
    for ci, cut in enumerate(cutoffs):
        a = int(day_no_of[cut]) if cut in day_no_of.index else \
            int(np.searchsorted([str(d) for d in days], cut))
        b = len(days) if ci + 1 >= len(cutoffs) and not test_days else \
            min(a + test_days, len(days)) if test_days else \
            int(day_no_of.get(cutoffs[ci + 1], len(days)))
        tr = np.flatnonzero((dayno < a) & eligible)
        test_mask = (dayno >= a) & (dayno < b)
        if not len(tr) or not test_mask.any():
            report["cutoffs"].append({"cutoff": cut, "skipped": "no train or no test rows"})
            continue
        ms = train(df.loc[tr, ALL_FEATURES], y[tr])
        thr = float(np.quantile(score_models(ms, df.loc[tr, ALL_FEATURES]), q))
        fresh = evaluate(fr, _score_all(ms, df), thr, pnl, ex_i, test_mask)

        order = np.flatnonzero(test_mask)
        elig_test_pnl = pnl[order][eligible[order]]
        buy_all, _ = select(order, np.ones(len(order)), 0.5, eligible, fr["TK"], ex_i, pnl)
        block = {"cutoff": cut, "test_day_range": [str(days[a]), str(days[min(b, len(days)) - 1])],
                 "test_days": int(b - a), "fresh_model": fresh,
                 "buy_every_allowed_bar": summarize(buy_all),
                 "random_same_count": random_baseline(elig_test_pnl, fresh["trades"], seed=ci)}
        if saved is not None:
            sv = _score_all(saved["models"], df, saved["features"])
            block["current_v11"] = evaluate(fr, sv, saved["threshold"], pnl, ex_i, test_mask)
        report["cutoffs"].append(block)

    if out_path:
        Path(out_path).write_text(json.dumps(report, indent=2, default=str))
    print(json.dumps(report, indent=2, default=str))
    return report


def _score_all(ms, df, features=ALL_FEATURES):
    return score_models(ms, df.loc[:, features])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", default=str(DATA_DIR / os.environ.get("V11_CSV", "ALL_STOCKS_5m_iex.csv")))
    ap.add_argument("--cutoffs", nargs="+", default=["2026-10-10"], help="YYYY-MM-DD day(s)")
    ap.add_argument("--test-days", type=int, default=0, help="days per cutoff window (0 = to next cutoff/end)")
    ap.add_argument("--q", type=float, default=0.95)
    ap.add_argument("--label", default="trade_win")
    ap.add_argument("--exit", nargs=3, default=["atr", "3.0", "20"], help="kind stop hold")
    ap.add_argument("--current", default=str(DATA_DIR / "trading_model_v11.pt"))
    ap.add_argument("--out", default="")
    args = ap.parse_args()
    exit_rule = (args.exit[0], float(args.exit[1]), int(args.exit[2]))
    run(args.csv, args.cutoffs, args.test_days, args.q, args.label, exit_rule, args.current, args.out)


if __name__ == "__main__":
    main()
