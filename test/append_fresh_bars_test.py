#!/usr/bin/env python3
"""Tests for scripts/append_fresh_bars.merge_into and backup (the data-append step).

Run with the FrostTrader interpreter:  py -3.14 test/append_fresh_bars_test.py
(No network, no keys: only the pure merge/dedup/backup on synthetic bars.)
"""
import importlib
import os
import sys
import tempfile
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import append_fresh_bars as A  # noqa: E402

COLS = ["ticker", "timestamp", "open", "high", "low", "close", "volume"]


def _bars(rows):
    return pd.DataFrame(rows, columns=COLS)


def test_merge_keeps_old_adds_new_and_sorts():
    with tempfile.TemporaryDirectory() as td:
        csv = Path(td) / "bars.csv"
        _bars([
            ("AAA", "2026-10-23T13:30:00Z", 1, 1, 1, 1, 10),
            ("AAA", "2026-10-23T13:35:00Z", 1, 1, 1, 2, 10),
            ("BBB", "2026-10-23T13:30:00Z", 1, 1, 1, 3, 10),
        ]).to_csv(csv, index=False)
        new = _bars([
            ("AAA", "2026-10-24T13:30:00Z", 1, 1, 1, 9, 10),  # a new day
            ("BBB", "2026-10-24T13:30:00Z", 1, 1, 1, 8, 10),
        ])
        r = A.merge_into(csv, new)
        assert r["old"] == 3 and r["added"] == 2 and r["total"] == 5, r
        out = pd.read_csv(csv, parse_dates=["timestamp"])
        # every old row is still there
        assert len(out) == 5
        # sorted by ticker then time
        assert list(out["ticker"]) == ["AAA", "AAA", "AAA", "BBB", "BBB"]
        assert out["timestamp"].is_monotonic_increasing is False  # per-ticker, not global
        for _, g in out.groupby("ticker"):
            assert g["timestamp"].is_monotonic_increasing


def test_merge_dedups_overlap_keeping_the_new_copy():
    with tempfile.TemporaryDirectory() as td:
        csv = Path(td) / "bars.csv"
        _bars([("AAA", "2026-10-23T13:30:00Z", 1, 1, 1, 1.0, 10)]).to_csv(csv, index=False)
        # a re-fetched bar for the SAME ticker+timestamp with a corrected close
        new = _bars([("AAA", "2026-10-23T13:30:00Z", 1, 1, 1, 1.5, 11),
                     ("AAA", "2026-10-23T13:35:00Z", 1, 1, 1, 2.0, 10)])
        r = A.merge_into(csv, new)
        assert r["total"] == 2 and r["added"] == 1, r  # the overlap is not double-counted
        out = pd.read_csv(csv)
        close_at_1330 = float(out[out["timestamp"].astype(str).str.startswith("2026-10-23 13:30")]["close"].iloc[0])
        assert close_at_1330 == 1.5, f"the fresh copy should win, got {close_at_1330}"


def test_merge_empty_new_is_a_noop():
    with tempfile.TemporaryDirectory() as td:
        csv = Path(td) / "bars.csv"
        _bars([("AAA", "2026-10-23T13:30:00Z", 1, 1, 1, 1, 10)]).to_csv(csv, index=False)
        r = A.merge_into(csv, _bars([]))
        assert r["added"] == 0 and r["total"] == 1, r


def test_backup_copies_then_leaves_original():
    with tempfile.TemporaryDirectory() as td:
        csv = Path(td) / "bars.csv"
        _bars([("AAA", "2026-10-23T13:30:00Z", 1, 1, 1, 1, 10)]).to_csv(csv, index=False)
        bak = A.backup(csv)
        assert bak and bak.exists() and bak != csv
        assert csv.exists(), "the original stays"
        assert bak.read_bytes() == csv.read_bytes(), "the backup is a faithful copy"


def test_frosttrader_bars_csv_env_overrides_the_default():
    old = os.environ.get("FROSTTRADER_BARS_CSV")
    try:
        os.environ["FROSTTRADER_BARS_CSV"] = os.path.join(tempfile.gettempdir(), "custom", "bars.csv")
        importlib.reload(A)
        assert str(A.CSV).replace("\\", "/").endswith("custom/bars.csv"), A.CSV
        os.environ.pop("FROSTTRADER_BARS_CSV")
        importlib.reload(A)
        assert str(A.CSV).endswith("ALL_STOCKS_5m_iex.csv"), A.CSV  # falls back to the repo copy
    finally:
        if old is None:
            os.environ.pop("FROSTTRADER_BARS_CSV", None)
        else:
            os.environ["FROSTTRADER_BARS_CSV"] = old
        importlib.reload(A)


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print("ok", t.__name__)
    print(f"\n{len(tests)} passed")
