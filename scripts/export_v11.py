#!/usr/bin/env python3
"""Export the trained v11 model for the app: server/engine/models/v11.json (the LightGBM trees,
threshold, exit rule and stock list), plus test/fixtures/v11-parity.json (Python's own features and
probabilities for some bars, which test/v11-parity.test.mjs compares the app's numbers against).

Usage: python scripts/export_v11.py [MODEL.pt] [BARS.csv]
Defaults: stock_ohlcv/trading_model_v11.pt and stock_ohlcv/ALL_STOCKS_5m.csv (in git, so the
parity test can read the same bars).
"""
import json
import sys
from pathlib import Path

import joblib
import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from v11_features import compute, prepare, tradable  # noqa: E402

MISSING = {"None": 0, "Zero": 1, "NaN": 2}


def flat_tree(info):
    nodes, leaves = [], []

    def visit(n):
        if "leaf_value" in n:
            leaves.append(float(n["leaf_value"]))
            return ~(len(leaves) - 1)
        if n.get("decision_type", "<=") != "<=":
            raise SystemExit(f"unsupported split {n.get('decision_type')}")
        k = len(nodes)
        nodes.append(None)
        left, right = visit(n["left_child"]), visit(n["right_child"])
        nodes[k] = [int(n["split_feature"]), float(n["threshold"]), 1 if n["default_left"] else 0,
                    MISSING[n["missing_type"]], left, right]
        return k

    visit(info["tree_structure"])
    return {"nodes": nodes, "leaves": leaves}


def main(model_path="stock_ohlcv/trading_model_v11.pt", bars_csv="stock_ohlcv/ALL_STOCKS_5m.csv"):
    m = joblib.load(ROOT / model_path)
    results = json.loads((ROOT / model_path.replace(".pt", "_results.json")).read_text())
    models = []
    for x in m["models"]:
        dump = x.booster_.dump_model()
        if dump["feature_names"] != m["features"]:
            raise SystemExit("feature order differs from the saved list")
        models.append({"trees": [flat_tree(t) for t in dump["tree_info"]]})
    bars = prepare(pd.read_csv(ROOT / bars_csv, parse_dates=["timestamp"]))
    universe = sorted(bars["ticker"].unique().tolist())
    out = {
        "name": "v11",
        "features": m["features"],
        "threshold": m["threshold"],
        # kind "pct": sell on a close `stop` (a fraction) under the best close since the buy;
        # kind "atr": the same with the distance `stop` x ATR(14) at the buy, as a fraction of its close
        "exit": {"kind": m["exit"]["kind"], "stop": m["exit"]["stop"], "maxHold": m["exit"]["max_hold"]},
        "feed": "iex",  # trained on Alpaca IEX bars (stock_ohlcv/ALL_STOCKS_5m_iex.csv), the feed the app uses
        "entryBars": [m["skip_first_bars"] - 1, 78 - m["skip_last_bars"] - 1],
        "universe": universe,
        "test": results.get("test"),
        "testPeriod": results.get("test_period"),
        "models": models,
    }
    dest = ROOT / "server" / "engine" / "models" / "v11.json"
    dest.write_text(json.dumps(out, separators=(",", ":")))
    print(f"{dest.relative_to(ROOT)}: {sum(len(x['trees']) for x in models)} trees, threshold {m['threshold']:.4f}")

    # parity fixture: every stock at a few times on the last day of the bars file
    df = compute(bars)
    last_day = df["date"].max()
    times = sorted(df.loc[df["date"] == last_day, "timestamp"].unique())
    pick = [times[k] for k in (3, 20, 40, 60, 71)]
    rows = df[df["timestamp"].isin(pick)].copy()
    ok = tradable(rows)
    rows["prob"] = np.nan
    rows.loc[ok, "prob"] = np.mean([x.predict_proba(rows.loc[ok, m["features"]])[:, 1] for x in m["models"]], axis=0)
    keep = ["ticker", "timestamp", "atr", "bar_of_day"] + m["features"] + ["prob"]
    recs = []
    for r in rows[keep].itertuples(index=False):
        d = dict(zip(keep, r))
        d["t"] = int(pd.Timestamp(d.pop("timestamp")).value // 1_000_000)
        recs.append({k: (None if isinstance(v, float) and np.isnan(v) else (float(v) if isinstance(v, (float, np.floating, np.integer)) else v)) for k, v in d.items()})
    fx = ROOT / "test" / "fixtures" / "v11-parity.json"
    fx.parent.mkdir(parents=True, exist_ok=True)
    fx.write_text(json.dumps({"bars": bars_csv, "rows": recs}, indent=0))
    print(f"{fx.relative_to(ROOT)}: {len(recs)} rows at {len(pick)} times on {last_day}")


if __name__ == "__main__":
    main(*sys.argv[1:])
