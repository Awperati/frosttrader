#!/usr/bin/env python3
"""Score the saved v11 model on a bars CSV and walk its trades, as in training.

Usage: python scripts/v11_check.py BARS.csv FROM_DATE [MODEL.pt]
Trades are counted from FROM_DATE (New York date) on; earlier rows only warm the features up.
"""
import sys
from pathlib import Path

import joblib
import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from v11_features import compute, prepare, tradable  # noqa: E402

COST = 0.0002


def walk(df, prob, thr, kind, stop, hold, skip_first=3, skip_last=6):
    tk, dt, c, bar, atr = (df[k].to_numpy() for k in ("ticker", "date", "close", "bar_of_day", "atr"))
    daylen = df.groupby(["ticker", "date"])["close"].transform("size").to_numpy()
    n, out, busy = len(df), [], {}
    for i in range(n - 1):
        if not (tk[i + 1] == tk[i] and dt[i + 1] == dt[i] and skip_first - 1 <= bar[i] < 78 - skip_last):
            continue
        if prob[i] < thr or busy.get(tk[i], -1) >= i:
            continue
        hi, j = c[i], i
        dist = stop if kind == "pct" else stop * atr[i] / c[i]
        for k in range(i + 1, min(i + 1 + hold, n)):
            if tk[k] != tk[i] or dt[k] != dt[i]:
                break
            j, hi = k, max(hi, c[k])
            if c[k] < hi * (1 - dist):
                break
        out.append(c[j] / c[i] - 1 - 2 * COST)
        busy[tk[i]] = j
    a = np.array(out)
    return dict(trades=len(a), win_rate=round(float((a > 0).mean()), 4) if len(a) else 0,
                avg_bps=round(float(a.mean() * 1e4), 2) if len(a) else 0)


def main(csv, start, model_path="stock_ohlcv/trading_model_v11.pt"):
    m = joblib.load(model_path)
    df = compute(prepare(pd.read_csv(csv, parse_dates=["timestamp"])))
    df = df[tradable(df)].reset_index(drop=True)
    df = df[df["date"] >= pd.Timestamp(start).date()].reset_index(drop=True)
    prob = np.mean([x.predict_proba(df[m["features"]])[:, 1] for x in m["models"]], axis=0)
    e = m["exit"]
    print(csv, "from", start, walk(df, prob, m["threshold"], e["kind"], e["stop"], e["max_hold"]),
          "threshold", round(m["threshold"], 4))


if __name__ == "__main__":
    main(*sys.argv[1:])
