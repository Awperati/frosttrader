#!/usr/bin/env python3
"""Tests for the walk-forward metric helpers (scripts/walkforward_harness.py).

Run with the FrostTrader interpreter:  py -3.14 test/metrics_test.py
No network, no keys, no model fits: hand-built trade arrays with known answers.
"""
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT))
import walkforward_harness as H  # noqa: E402


def test_summarize_known_numbers():
    # 3 wins of +100 bps, 1 loss of -100 bps: 75% win, +50 bps avg, +2% total, PF 3.0
    pnl = np.array([0.01, 0.01, -0.01, 0.01])
    s = H.summarize(pnl)
    assert s["trades"] == 4
    assert abs(s["win_rate"] - 0.75) < 1e-9
    assert abs(s["avg_bps"] - 50.0) < 1e-6
    assert abs(s["total_pct"] - 2.0) < 1e-9
    assert abs(s["profit_factor"] - 3.0) < 1e-9
    assert s["win_rate_ci"][0] <= 0.75 <= s["win_rate_ci"][1]
    assert s["avg_bps_ci"][0] <= 50.0 <= s["avg_bps_ci"][1]


def test_empty_is_all_zero():
    s = H.summarize([])
    assert s["trades"] == 0 and s["win_rate"] == 0.0 and s["max_drawdown_pct"] == 0.0


def test_max_drawdown():
    # equity: +2, +1, +3, 0 (cum of these) -> peak 3 at idx2, trough 0 at idx3 -> dd 3% (0.03 sum)
    pnl = np.array([0.02, -0.01, 0.02, -0.03])
    assert abs(H.max_drawdown_pct(pnl) - 3.0) < 1e-9
    # a monotonically rising curve never draws down
    assert H.max_drawdown_pct(np.array([0.01, 0.01, 0.01])) == 0.0


def test_wilson_brackets_and_shrinks():
    lo1, hi1 = H.wilson_ci(60, 100)
    assert lo1 < 0.60 < hi1
    lo2, hi2 = H.wilson_ci(600, 1000)       # same rate, 10x data
    assert (hi2 - lo2) < (hi1 - lo1), "more trades -> a tighter range"
    assert H.wilson_ci(0, 0) == (0.0, 0.0)


def test_mean_ci_shrinks_with_n():
    rng = np.random.default_rng(1)
    small = rng.normal(0.001, 0.01, 30)
    big = rng.normal(0.001, 0.01, 3000)
    ws = H.mean_ci_bps(small)
    wb = H.mean_ci_bps(big)
    assert (ws[1] - ws[0]) > (wb[1] - wb[0])


def test_per_day_splits_by_date():
    dates = ["2026-10-12", "2026-10-12", "2026-10-13"]
    pnl = [0.01, -0.01, 0.02]
    rows = H.per_day(dates, pnl)
    assert len(rows) == 2
    d12 = next(r for r in rows if r["date"] == "2026-10-12")
    assert d12["trades"] == 2 and abs(d12["win_rate"] - 0.5) < 1e-9


def test_random_baseline_is_seed_stable_and_ranged():
    elig = np.array([0.01, -0.01, 0.02, -0.02, 0.0, 0.015, -0.005] * 20, float)
    a = H.random_baseline(elig, n=10, seed=7, reps=100)
    b = H.random_baseline(elig, n=10, seed=7, reps=100)
    assert a == b, "same seed -> same baseline"
    assert a["win_rate_ci"][0] <= a["win_rate"] <= a["win_rate_ci"][1]


def test_trade_walk_breaks_at_day_boundary():
    # two bars same ticker+day, then a bar on the next day: a trade from bar0 can reach bar1, not bar2
    C = np.array([100.0, 101.0, 500.0])
    ATR = np.array([1.0, 1.0, 1.0])
    TK = np.array(["AAA", "AAA", "AAA"])
    DT = np.array(["2026-10-12", "2026-10-12", "2026-10-13"])
    elig = np.array([True, False, False])
    pnl, ex_i = H.trade_outcomes(C, ATR, TK, DT, elig, "atr", 3.0, 20)
    assert ex_i[0] == 1, "exit stays inside the entry's day"
    # pnl = 101/100 - 1 - 2*cost
    assert abs(pnl[0] - (101 / 100 - 1 - 2 * H.COST)) < 1e-12


def test_select_one_position_per_ticker_at_a_time():
    # bar0 opens a trade on AAA that exits at bar2; bar1 (AAA) must be skipped while busy
    order = np.array([0, 1, 2, 3])
    score = np.array([1.0, 1.0, 1.0, 1.0])
    elig = np.array([True, True, True, True])
    TK = np.array(["AAA", "AAA", "AAA", "AAA"])
    ex_i = np.array([2, 2, 3, 3])
    pnl = np.array([0.01, 0.02, 0.03, 0.04])
    taken, idx = H.select(order, score, 0.5, elig, TK, ex_i, pnl)
    assert list(idx) == [0, 3], f"bars 1 and 2 are busy until bar0's exit, got {list(idx)}"


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print("ok", t.__name__)
    print(f"\n{len(tests)} passed")
