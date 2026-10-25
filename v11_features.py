"""The v11 model's features, shared by training (train_trading_model_v11.py), the export to the
app (scripts/export_v11.py) and the checks. The app computes the same numbers in JavaScript
(server/engine/models/v11.mjs); test/v11-parity.test.mjs holds the two together.

Input: one DataFrame of 5-minute regular-session bars with columns
ticker, timestamp (UTC), open, high, low, close, volume, for every stock of the market average.

time_of_day is New York clock time + 4 hours: the UTC hour while New York is on daylight time,
which is all the training data covers (Apr 1 - Oct 23 2026). After the clocks change the feature
keeps meaning the same time of the trading day.
"""
import numpy as np
import pandas as pd

V8_FEATURES = ["return", "vol_change", "high_low_range", "close_position", "volatility_20",
               "ma_dist", "rsi_14", "momentum_5", "momentum_10", "vol_spike", "gap",
               "time_of_day", "ma_dist_50", "momentum_20", "volatility_50", "ma_dist_5",
               "trend_up_50", "tod_sin", "tod_cos"]
NEW_FEATURES = ["atr_pct", "bar_of_day", "vwap_dist", "rvol_tod", "ema20_slope", "or_pos",
                "sess_hi_dist", "pdc_dist", "gap_day", "daily_trend", "hourly_trend",
                "mkt_ret", "mkt_mom_12", "mkt_vwap", "rel_ret", "rel_mom_12"]
MARKET_LEVEL = ["mkt_ret", "mkt_mom_12", "mkt_vwap"]
ALL_FEATURES = V8_FEATURES + NEW_FEATURES


def prepare(df):
    """Clean, sort, and add the New York date and clock the features use."""
    df = df[(df["volume"] > 0) & (df["high"] >= df["low"]) & (df["close"] > 0)]
    df = df.drop_duplicates(["ticker", "timestamp"]).sort_values(["ticker", "timestamp"]).reset_index(drop=True)
    ny = df["timestamp"].dt.tz_convert("America/New_York")
    df["date"] = ny.dt.date
    df["ny_minute"] = ny.dt.hour * 60 + ny.dt.minute
    return df


def ticker_features(g):
    c, h, l, o, v = g["close"], g["high"], g["low"], g["open"], g["volume"]
    day = g["date"]
    out = pd.DataFrame(index=g.index)
    delta = c.diff()
    gain = delta.where(delta > 0, 0).rolling(14).mean()
    loss = (-delta.where(delta < 0, 0)).rolling(14).mean()
    tod = (g["ny_minute"] + 240) / 60.0
    out["return"] = c.pct_change()
    out["vol_change"] = v / v.rolling(20).mean() - 1
    out["high_low_range"] = (h - l) / c
    out["close_position"] = (c - l) / (h - l + 1e-8)
    out["volatility_20"] = c.pct_change().rolling(20).std()
    out["ma_dist"] = c / c.rolling(20).mean() - 1
    out["rsi_14"] = 100 - 100 / (1 + gain / (loss + 1e-8))
    out["momentum_5"] = c.pct_change(5)
    out["momentum_10"] = c.pct_change(10)
    out["vol_spike"] = v / v.rolling(20).std()
    out["gap"] = c / c.shift(1) - 1
    out["time_of_day"] = tod
    out["ma_dist_50"] = c / c.rolling(50).mean() - 1
    out["momentum_20"] = c.pct_change(20)
    out["volatility_50"] = c.pct_change().rolling(50).std()
    out["ma_dist_5"] = c / c.rolling(5).mean() - 1
    out["trend_up_50"] = (c > c.rolling(50).mean()).astype(int)
    out["tod_sin"] = np.sin(2 * np.pi * tod / 24)
    out["tod_cos"] = np.cos(2 * np.pi * tod / 24)
    prev_c = c.shift(1)
    tr = pd.concat([h - l, (h - prev_c).abs(), (l - prev_c).abs()], axis=1).max(axis=1)
    atr = tr.rolling(14).mean()
    out["atr"] = atr
    out["atr_pct"] = atr / c
    # bar of the day from the clock (09:30 = 0), so a missing IEX bar does not shift the rest
    bar = (g["ny_minute"] - 570) // 5
    out["bar_of_day"] = bar
    vwap = ((h + l + c) / 3 * v).groupby(day).cumsum() / v.groupby(day).cumsum()
    out["vwap_dist"] = (c - vwap) / atr
    out["rvol_tod"] = v / v.groupby(bar).transform(lambda s: s.shift(1).rolling(10, min_periods=3).mean())
    e20 = c.ewm(span=20, adjust=False).mean()
    out["ema20_slope"] = (e20 - e20.shift(3)) / atr
    or_hi = h.where(bar < 3).groupby(day).transform("max")
    or_lo = l.where(bar < 3).groupby(day).transform("min")
    out["or_pos"] = ((c - or_lo) / (or_hi - or_lo + 1e-8)).where(bar >= 3)
    out["sess_hi_dist"] = (c - h.groupby(day).cummax()) / atr
    daily = g.groupby(day).agg(dc=("close", "last"))
    daily["dc5"] = daily["dc"].shift(5)
    prev = daily.shift(1)
    pdc = day.map(prev["dc"])
    out["pdc_dist"] = (c - pdc) / atr
    out["gap_day"] = o.groupby(day).transform("first") / pdc - 1
    out["daily_trend"] = pdc / day.map(prev["dc5"]) - 1
    out["hourly_trend"] = c / c.shift(12) - 1
    return out


def compute(df):
    """prepare() output -> the same frame with every feature, the market ones included."""
    df = pd.concat([df, df.groupby("ticker", group_keys=False).apply(ticker_features)], axis=1)
    by_ts = df.groupby("timestamp")
    df["mkt_ret"] = by_ts["return"].transform("mean")
    df["mkt_mom_12"] = by_ts["hourly_trend"].transform("mean")
    df["mkt_vwap"] = by_ts["vwap_dist"].transform("mean")
    df["rel_ret"] = df["return"] - df["mkt_ret"]
    df["rel_mom_12"] = df["hourly_trend"] - df["mkt_mom_12"]
    return df


def tradable(df):
    """Rows the model may score: v8's 19 features and the ATR all present (as in training)."""
    return df[V8_FEATURES + ["atr"]].notna().all(axis=1)
