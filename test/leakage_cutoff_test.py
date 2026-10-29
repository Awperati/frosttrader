#!/usr/bin/env python3
"""Leakage tests for the v11 recipe: features look only at the past, and a whole-day
train/test split cannot leak a label.

Run with the FrostTrader interpreter:  py -3.14 test/leakage_cutoff_test.py
No network, no keys, no model fits: synthetic bars through the real v11_features code.

Two guarantees, matching what the owner asked for:
  A. "features from past bars only" -- tested against the real v11_features.compute.
  B. "labels not leaking across split" -- the day split is disjoint, and the label walk
     (train_trading_model_v11.py:102-118) never leaves the entry bar's ticker+day, so a
     split on whole days cannot put a label's future into the other side. The walk is
     re-stated here as a spec check (that training script runs end to end on import, so it
     cannot be imported in isolation); keep it in step with those lines.
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from v11_features import (ALL_FEATURES, MARKET_LEVEL, compute, prepare,  # noqa: E402
                          tradable)

MKT_DERIVED = MARKET_LEVEL + ["rel_ret", "rel_mom_12"]  # the only features that look sideways
OWN_FEATURES = [f for f in ALL_FEATURES if f not in MKT_DERIVED]


def synth(tickers=("AAA", "BBB", "CCC"), days=2, nbars=60, seed=0):
    """A clean 5-minute frame on one shared timestamp grid, so the market average lines up."""
    rng = np.random.default_rng(seed)
    rows = []
    for di in range(days):
        day0 = pd.Timestamp("2026-10-05", tz="UTC") + pd.Timedelta(days=di) + pd.Timedelta(hours=13, minutes=30)
        for t in tickers:
            price = 100.0 + 10 * (hash(t) % 7)
            for b in range(nbars):
                ts = day0 + pd.Timedelta(minutes=5 * b)
                step = rng.normal(0, 0.2)
                o = price
                c = max(price + step, 0.01)
                hi = max(o, c) + abs(rng.normal(0, 0.05))
                lo = min(o, c) - abs(rng.normal(0, 0.05))
                rows.append((t, ts, o, hi, lo, c, 1000 + rng.integers(0, 500)))
                price = c
    df = pd.DataFrame(rows, columns=["ticker", "timestamp", "open", "high", "low", "close", "volume"])
    return prepare(df)


def _row(df, ticker, ts):
    m = (df["ticker"] == ticker) & (df["timestamp"] == ts)
    assert m.sum() == 1, f"{ticker} {ts}: {m.sum()} rows"
    return df.loc[m, ALL_FEATURES].iloc[0]


def _same(a, b):
    """Row-for-row equal, treating NaN == NaN as equal (an unchanged NaN still counts)."""
    diff = []
    for k in a.index:
        x, y = a[k], b[k]
        if pd.isna(x) and pd.isna(y):
            continue
        if x != y:
            diff.append(k)
    return diff


def test_features_ignore_the_future():
    """Altering any bar AFTER the probe (any ticker) leaves every feature at the probe bar."""
    base = synth()
    ts = sorted(base["timestamp"].unique())
    probe_ts = ts[len(ts) // 2]           # a bar with plenty of history
    before = _row(compute(base.copy()), "AAA", probe_ts)
    for who in ("AAA", "BBB"):            # a future bar of the same stock, and of another stock
        f = base.copy()
        future = (f["ticker"] == who) & (f["timestamp"] > probe_ts)
        assert future.sum() > 0
        f.loc[future, ["open", "high", "low", "close"]] *= 1.5
        after = _row(compute(f), "AAA", probe_ts)
        assert _same(before, after) == [], f"future {who} changed the probe: {_same(before, after)}"


def test_own_features_ignore_other_stocks():
    """A probe stock's own features depend only on itself; only the market ones look sideways."""
    base = synth()
    ts = sorted(base["timestamp"].unique())
    probe_ts = ts[len(ts) // 2]
    before = _row(compute(base.copy()), "AAA", probe_ts)
    f = base.copy()
    # bump another stock at the SAME timestamp -- AAA's own bars untouched. An additive bump (not a
    # scale) moves BBB's return, so the market average at that bar moves; a uniform scale would not.
    f.loc[(f["ticker"] == "BBB") & (f["timestamp"] == probe_ts), "close"] += 5.0
    after = _row(compute(f), "AAA", probe_ts)
    changed = _same(before, after)
    assert set(changed) <= set(MKT_DERIVED), f"own features moved with another stock: {changed}"
    assert set(changed) & set(MARKET_LEVEL), "the market average should have moved"


def test_changing_the_past_does_change_the_probe():
    """Sanity: the features are not frozen -- the immediately prior bar feeds 'return'."""
    base = synth()
    ts = sorted(base["timestamp"].unique())
    probe_ts = ts[len(ts) // 2]
    before = _row(compute(base.copy()), "AAA", probe_ts)
    f = base.copy()
    prior = ts[len(ts) // 2 - 1]
    f.loc[(f["ticker"] == "AAA") & (f["timestamp"] == prior), "close"] *= 1.2
    after = _row(compute(f), "AAA", probe_ts)
    assert "return" in _same(before, after), "a past change must move a trailing feature"


# --- B. the cutoff split ---

def _exit_index(C, TK, DT, i, kind, stop, hold, N, ATR):
    """The v11 trailing-stop exit walk, re-stated from train_trading_model_v11.py:102-118.
    Returns the exit bar index. Breaks at the ticker/day boundary, so it never leaves the day."""
    hi, j = C[i], i
    dist = stop if kind == "pct" else stop * ATR[i] / C[i]
    for k in range(i + 1, min(i + 1 + hold, N)):
        if TK[k] != TK[i] or DT[k] != DT[i]:
            break
        j = k
        hi = max(hi, C[k])
        if C[k] < hi * (1 - dist):
            break
    return j


def test_label_walk_never_leaves_the_day():
    """Every entry's exit is on the same ticker and the same day -> a whole-day split is safe."""
    df = compute(synth(days=3, nbars=40))
    df = df[tradable(df)].reset_index(drop=True)
    TK, DT, C = df["ticker"].to_numpy(), df["date"].to_numpy(), df["close"].to_numpy()
    ATR = df["atr"].to_numpy()
    N = len(df)
    for i in range(N):
        j = _exit_index(C, TK, DT, i, "atr", 3.0, 20, N, ATR)
        assert TK[j] == TK[i] and DT[j] == DT[i], f"trade {i} exited on another ticker/day"


def test_day_split_is_disjoint():
    """train = days before the cutoff, test = days at/after it: no bar is in both (DAYNO<a vs >=a)."""
    df = prepare(synth(days=5, nbars=20))
    days = sorted(df["date"].unique())
    dayno = df["date"].map(pd.Series(range(len(days)), index=days)).to_numpy()
    a = 3                                   # a cutoff day number, as the walk-forward folds use
    train = np.flatnonzero(dayno < a)
    test = np.flatnonzero(dayno >= a)
    assert len(train) and len(test)
    assert set(train).isdisjoint(set(test))
    assert max(dayno[train]) < min(dayno[test]), "every train day is strictly before every test day"


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print("ok", t.__name__)
    print(f"\n{len(tests)} passed")
