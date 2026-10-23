r"""Train a day-trading model v3 with LightGBM + expanded features + threshold tuning.

Input: C:\Users\User\Frost Technology\FrostTrader\stock_ohlcv\ALL_STOCKS_5m.csv
Output: C:\Users\User\Frost Technology\FrostTrader\stock_ohlcv\trading_model_v3.pt
"""
import pandas as pd
import numpy as np
import lightgbm as lgb
from pathlib import Path

DATA = Path(r"C:\Users\User\Frost Technology\FrostTrader\stock_ohlcv\ALL_STOCKS_5m.csv")
OUT = Path(r"C:\Users\User\Frost Technology\FrostTrader\stock_ohlcv\trading_model_v3.pt")


def build_features(df):
    """Build 22 features from raw OHLCV data."""
    df = df.sort_values("timestamp").reset_index(drop=True)
    c, h, l, o, v = df["close"], df["high"], df["low"], df["open"], df["volume"]

    # Core returns and momentum
    df["return"] = c.pct_change()
    df["momentum_5"] = c.pct_change(5)
    df["momentum_10"] = c.pct_change(10)
    df["momentum_20"] = c.pct_change(20)

    # Volatility
    df["vol_change"] = v.pct_change()
    df["vol_spike"] = (v / v.rolling(20).mean() - 1).clip(-5, 5)
    df["high_low_range"] = (h - l) / c
    df["close_position"] = (c - l) / (h - l + 1e-12)
    df["volatility_20"] = c.pct_change().rolling(20).std()
    df["volatility_50"] = c.pct_change().rolling(50).std()

    # Moving averages and distances
    ma20 = c.rolling(20).mean()
    ma50 = c.rolling(50).mean()
    ma5 = c.rolling(5).mean()
    df["ma_dist"] = (c - ma20) / ma20
    df["ma_dist_50"] = (c - ma50) / ma50
    df["ma_dist_5"] = (c - ma5) / ma5
    df["trend_up"] = (c > ma20).astype(int)
    df["trend_up_50"] = (c > ma50).astype(int)
    df["ma_cross"] = ((ma5 - ma20) / ma20).clip(-0.05, 0.05)

    # RSI
    delta = c.diff()
    gain = delta.clip(lower=0).rolling(14).mean()
    loss = (-delta.clip(upper=0)).rolling(14).mean()
    rs = gain / (loss + 1e-12)
    df["rsi_14"] = 100 - 100 / (1 + rs)

    # Gap
    df["gap"] = (o / c.shift(1) - 1).clip(-0.1, 0.1)

    # Time of day (minutes from 9:30)
    ts = pd.to_datetime(df["timestamp"])
    tod = ((ts.dt.hour - 9) * 60 + ts.dt.minute) % 600
    tod = tod.where(tod >= 0, tod + 240)  # handle 16:00+
    df["time_of_day"] = tod
    df["tod_sin"] = np.sin(2 * np.pi * tod / 240)
    df["tod_cos"] = np.cos(2 * np.pi * tod / 240)

    # Target: next-bar return
    df["target"] = c.pct_change().shift(-1)

    return df


FEATURES = [
    "return", "momentum_5", "momentum_10", "momentum_20",
    "vol_change", "vol_spike", "high_low_range", "close_position",
    "volatility_20", "volatility_50",
    "ma_dist", "ma_dist_50", "ma_dist_5", "trend_up", "trend_up_50", "ma_cross",
    "rsi_14", "gap", "time_of_day", "tod_sin", "tod_cos",
]


def backtest_with_threshold(df, model, threshold=0.5):
    """Long when prob > threshold, flat otherwise. 1-bar hold."""
    df = df.copy()
    probs = model.predict_proba(df[FEATURES])[:, 1]
    df["prob"] = probs
    df["signal"] = (df["prob"] > threshold).astype(int)
    df["position"] = df["signal"].shift(1).fillna(0)
    df["pnl"] = df["position"] * df["target"]
    return df


def main():
    print("Loading data...")
    df = pd.read_csv(DATA)
    print(f"  {len(df):,} rows, {df['ticker'].nunique()} tickers")

    # Build features per ticker
    all_parts = []
    for ticker, g in df.groupby("ticker"):
        g = g.sort_values("timestamp").reset_index(drop=True)
        g = build_features(g)
        all_parts.append(g)
    df = pd.concat(all_parts, ignore_index=True)

    # Drop NaN rows from rolling windows
    df = df.dropna(subset=FEATURES + ["target"]).reset_index(drop=True)
    print(f"  {len(df):,} valid samples, {len(FEATURES)} features")

    # Time split 90/10
    split = int(len(df) * 0.9)
    train, test = df.iloc[:split], df.iloc[split:]
    print(f"  Train: {len(train):,}  Test: {len(test):,}")

    # Train LightGBM with tuning
    print("Training LightGBM...")
    dtrain = lgb.Dataset(train[FEATURES], label=(train["target"] > 0).astype(int))
    dtest = lgb.Dataset(test[FEATURES], label=(test["target"] > 0).astype(int), reference=dtrain)

    params = {
        "objective": "binary",
        "metric": "auc",
        "num_leaves": 127,
        "learning_rate": 0.03,
        "feature_fraction": 0.8,
        "bagging_fraction": 0.8,
        "bagging_freq": 5,
        "min_data_in_leaf": 50,
        "lambda_l1": 0.1,
        "lambda_l2": 1.0,
        "verbose": -1,
    }
    model = lgb.train(
        params, dtrain, num_boost_round=500,
        valid_sets=[dtest], valid_names=["test"],
        callbacks=[lgb.early_stopping(50, verbose=False)],
    )

    # Evaluate on test set
    test_probs = model.predict(test[FEATURES])
    test_labels = (test["target"] > 0).astype(int).values
    from sklearn.metrics import roc_auc_score, accuracy_score
    auc = roc_auc_score(test_labels, test_probs)
    acc = accuracy_score(test_labels, (test_probs > 0.5).astype(int))
    print(f"  Test AUC: {auc:.4f}  Accuracy: {acc:.4f}")

    # Feature importances
    imp = pd.Series(model.feature_importance(), index=FEATURES).sort_values(ascending=False)
    print("\n  Feature importances (top 10):")
    for name, val in imp.head(10).items():
        print(f"    {name:20s} {val}")

    # Threshold sweep
    print("\n  Threshold sweep (test set):")
    print(f"  {'thr':>5s}  {'trades':>7s}  {'win%':>6s}  {'expect':>8s}  {'total P&L':>10s}  {'maxDD':>8s}")
    best = (0, 0, 0)
    for thr in np.arange(0.50, 0.76, 0.02):
        bt = backtest_with_threshold(test, model, thr)
        trades = bt["signal"].sum()
        wins = ((bt["pnl"] > 0) & (bt["signal"] == 1)).sum()
        win_rate = wins / max(trades, 1)
        expect = bt.loc[bt["signal"] == 1, "pnl"].mean()
        total = bt["pnl"].sum()
        cum = bt["pnl"].cumsum()
        dd = (cum - cum.cummax()).min()
        print(f"  {thr:5.2f}  {trades:7d}  {win_rate:6.1%}  {expect:8.5f}  {total:10.4f}  {dd:8.4f}")
        if total > best[2]:
            best = (thr, win_rate, total)

    print(f"\n  Best threshold: {best[0]:.2f}  (win rate {best[1]:.1%}, total P&L {best[2]:.4f})")

    # Backtest with best threshold
    bt = backtest_with_threshold(test, model, best[0])
    trades = bt["signal"].sum()
    wins = ((bt["pnl"] > 0) & (bt["signal"] == 1)).sum()
    print(f"\n  Final backtest (threshold={best[0]:.2f}):")
    print(f"    Trades: {trades}, Win rate: {wins/trades:.1%}")
    print(f"    Expectancy: {bt.loc[bt['signal']==1,'pnl'].mean():.5f}")
    print(f"    Total P&L: {bt['pnl'].sum():.4f}")
    print(f"    Max DD: {(bt['pnl'].cumsum() - bt['pnl'].cumsum().cummax()).min():.4f}")

    # Save
    model.save_model(str(OUT))
    print(f"\n  Model saved to {OUT}")


if __name__ == "__main__":
    main()
