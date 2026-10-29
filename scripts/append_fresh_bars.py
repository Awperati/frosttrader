#!/usr/bin/env python3
"""Append the latest IEX 5-minute bars to stock_ohlcv/ALL_STOCKS_5m_iex.csv.

Fetches only the days after the newest bar already in the file (via scripts/fetch_alpaca_bars.py,
read-only market data), backs up the old file to a dated copy, merges the new bars in (dedup on
ticker+timestamp, keep the newest copy), and sorts. Keys come from the environment, exactly as
fetch_alpaca_bars.py reads them; they are never printed, logged or written. The merge is a pure,
testable function (merge_into) so the non-network behaviour is covered without any key or network.

  python scripts/append_fresh_bars.py            # append up to now
  python scripts/append_fresh_bars.py 2026-10-23T00:00:00Z 2026-10-30T00:00:00Z  # explicit range
"""
import os
import shutil
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
# One source of truth: FROSTTRADER_BARS_CSV points at the bars file the server keeps fresh (its
# DATA_DIR copy, which the refresh_bars tool appends to). The repo's stock_ohlcv copy is the fallback.
CSV = Path(os.environ.get("FROSTTRADER_BARS_CSV") or (ROOT / "stock_ohlcv" / "ALL_STOCKS_5m_iex.csv"))
COLS = ["ticker", "timestamp", "open", "high", "low", "close", "volume"]


def latest_ts(csv_path):
    """The newest bar timestamp already in the file (so we only fetch days at or after it)."""
    ts = pd.read_csv(csv_path, usecols=["timestamp"], parse_dates=["timestamp"])["timestamp"]
    return ts.max()


def merge_into(csv_path, new_df):
    """Merge new bars into the CSV: keep every old row, add new ones, dedup on ticker+timestamp
    (the newest copy wins), sort by ticker then time. Returns counts and the resulting date range.
    Pure apart from reading/writing csv_path — no network, no keys."""
    csv_path = Path(csv_path)
    old = pd.read_csv(csv_path, parse_dates=["timestamp"]) if csv_path.exists() else pd.DataFrame(columns=COLS)
    n_old = len(old)
    nd = new_df.copy()
    if len(nd):
        nd["timestamp"] = pd.to_datetime(nd["timestamp"], utc=True)
    combined = pd.concat([old[COLS], nd[COLS]], ignore_index=True) if len(nd) else old[COLS].copy()
    combined["timestamp"] = pd.to_datetime(combined["timestamp"], utc=True)
    # keep='last': a re-fetched bar (same ticker+timestamp) overwrites the old copy with the fresh one
    combined = combined.drop_duplicates(["ticker", "timestamp"], keep="last").sort_values(["ticker", "timestamp"]).reset_index(drop=True)
    combined.to_csv(csv_path, index=False)
    rng = (str(combined["timestamp"].min()), str(combined["timestamp"].max())) if len(combined) else ("", "")
    return {"old": n_old, "total": len(combined), "added": len(combined) - n_old, "start": rng[0], "end": rng[1]}


def backup(csv_path):
    """A dated copy beside the file, kept untouched. Returns its path (or None if there's nothing yet)."""
    csv_path = Path(csv_path)
    if not csv_path.exists():
        return None
    dst = csv_path.with_name(f"{csv_path.stem}.{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}.bak.csv")
    shutil.copy2(csv_path, dst)
    return dst


def fetch(start, end, feed="iex"):
    """The latest bars as a DataFrame, via the app's own fetch path (keys from env, never printed)."""
    import fetch_alpaca_bars as fab  # same folder; importing only defines its functions
    with tempfile.TemporaryDirectory() as td:
        tmp = os.path.join(td, "new.csv")
        fab.main(start, end, tmp, feed)  # prints its own one-line summary (bars/range), no keys
        return pd.read_csv(tmp, parse_dates=["timestamp"])


def main(start=None, end=None):
    if not CSV.exists():
        raise SystemExit(f"{CSV} does not exist — nothing to append to.")
    start = start or latest_ts(CSV).strftime("%Y-%m-%dT%H:%M:%SZ")  # from the last bar; the overlap re-dedups
    end = end or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    bak = backup(CSV)
    new = fetch(start, end, "iex")
    r = merge_into(CSV, new)
    print(f"appended {r['added']:,} new bars (was {r['old']:,}, now {r['total']:,}); {r['start']} .. {r['end']}; backup {bak.name if bak else '(none)'}")


if __name__ == "__main__":
    main(*sys.argv[1:])
