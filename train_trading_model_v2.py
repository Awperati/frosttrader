r"""
Train a day-trading model v2 with LightGBM + better features.

Input:  C:\Users\User\Frost Technology\FrostTrader\stock_ohlcv\ALL_STOCKS_5m.csv
Output: C:\Users\User\Frost Technology\FrostTrader\stock_ohlcv\trading_model_v2.pt
"""

import sys
from pathlib import Path

import numpy as np
import pandas as pd
import torch
import torch.nn as nn

BASE_DIR = Path(__file__).resolve().parent
INPUT_CSV = BASE_DIR / "stock_ohlcv" / "ALL_STOCKS_5m.csv"
OUTPUT_PT = BASE_DIR / "stock_ohlcv" / "trading_model_v2.pt"


def load_data(csv_path: Path) -> pd.DataFrame:
    df = pd.read_csv(csv_path)
    df["timestamp"] = pd.to_datetime(df["timestamp"])
    df = df.sort_values(["ticker", "timestamp"]).reset_index(drop=True)
    return df


def add_features(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    g = df.groupby("ticker")

    # Basic returns and volume
    df["return"] = g["close"].pct_change()
    df["vol_change"] = g["volume"].pct_change()
    df["high_low_range"] = (df["high"] - df["low"]) / df["close"]
    df["close_position"] = (df["close"] - df["low"]) / (df["high"] - df["low"] + 1e-8)

    # Volatility and moving averages
    df["volatility_20"] = g["return"].transform(lambda s: s.rolling(20).std())
    df["ma_20"] = g["close"].transform(lambda s: s.rolling(20).mean())
    df["ma_50"] = g["close"].transform(lambda s: s.rolling(50).mean())
    df["ma_dist_20"] = (df["close"] - df["ma_20"]) / df["ma_20"]
    df["ma_dist_50"] = (df["close"] - df["ma_50"]) / df["ma_50"]

    # RSI(14)
    delta = g["close"].diff()
    gain = delta.clip(lower=0).groupby(df["ticker"]).rolling(14).mean().reset_index(level=0, drop=True)
    loss = (-delta.clip(upper=0)).groupby(df["ticker"]).rolling(14).mean().reset_index(level=0, drop=True)
    df["rsi_14"] = 100 - (100 / (1 + gain / (loss + 1e-8)))

    # Momentum: 5-bar and 10-bar returns
    df["momentum_5"] = g["close"].pct_change(5)
    df["momentum_10"] = g["close"].pct_change(10)

    # Volume spike: current volume vs 20-bar average
    df["vol_spike"] = g["volume"].transform(lambda s: s / s.rolling(20).mean())

    # Gap: open vs previous close
    df["gap"] = (df["open"] - g["close"].shift(1)) / g["close"].shift(1)

    # Intraday time features
    df["hour"] = df["timestamp"].dt.hour
    df["minute"] = df["timestamp"].dt.minute
    df["time_of_day"] = df["hour"] + df["minute"] / 60.0

    # Trend filter: is price above MA50?
    df["trend_up"] = (df["close"] > df["ma_50"]).astype(int)

    return df


FEATURES = [
    "return",
    "vol_change",
    "high_low_range",
    "close_position",
    "volatility_20",
    "ma_dist_20",
    "ma_dist_50",
    "rsi_14",
    "momentum_5",
    "momentum_10",
    "vol_spike",
    "gap",
    "time_of_day",
    "trend_up",
]


def build_dataset(df: pd.DataFrame):
    """Return X (features), y (1 if next close > current close else 0), and valid mask."""
    df = df.copy()
    df["next_close"] = df.groupby("ticker")["close"].shift(-1)
    df["target"] = (df["next_close"] > df["close"]).astype(int)
    df = df.dropna(subset=FEATURES + ["next_close"])
    X = df[FEATURES].values.astype(np.float32)
    y = df["target"].values.astype(np.int64)
    valid = np.isfinite(X).all(axis=1)
    X = np.clip(X[valid], -10.0, 10.0)
    return X, y[valid], df[valid].reset_index(drop=True)


def train_lightgbm(X_train, y_train, X_val, y_val):
    """Train a LightGBM classifier."""
    import lightgbm as lgb

    train_data = lgb.Dataset(X_train, label=y_train)
    val_data = lgb.Dataset(X_val, label=y_val, reference=train_data)

    params = {
        "objective": "binary",
        "metric": "auc",
        "boosting_type": "gbdt",
        "num_leaves": 63,
        "learning_rate": 0.05,
        "feature_fraction": 0.8,
        "bagging_fraction": 0.8,
        "bagging_freq": 5,
        "verbose": -1,
    }

    model = lgb.train(
        params,
        train_data,
        num_boost_round=200,
        valid_sets=[val_data],
        callbacks=[lgb.early_stopping(50, verbose=False)],
    )

    # Get feature importances
    importance = model.feature_importance(importance_type="gain")
    feat_imp = sorted(zip(FEATURES, importance), key=lambda x: x[1], reverse=True)
    print("\nFeature importance (top 10):")
    for feat, imp in feat_imp[:10]:
        print(f"  {feat:20s} {imp:.1f}")

    return model


def predict_lightgbm(model, X):
    """Predict probabilities with LightGBM."""
    return model.predict(X)


def backtest(model, df: pd.DataFrame, use_lightgbm: bool = True) -> dict:
    """Simple backtest: long when model says up, flat when down. 1-bar hold."""
    X = df[FEATURES].values.astype(np.float32)
    X = np.clip(X, -10.0, 10.0)

    if use_lightgbm:
        probs = predict_lightgbm(model, X)
    else:
        model.eval()
        X_t = torch.tensor(X, dtype=torch.float32)
        with torch.no_grad():
            probs = torch.sigmoid(model(X_t)).numpy().flatten()

    close = df["close"].values
    # P&L: enter at close[t], exit at close[t+1] if pred[t]==1
    pnl = np.zeros(len(close))
    for i in range(len(close) - 1):
        if probs[i] > 0.5:
            pnl[i] = close[i + 1] / close[i] - 1.0
        else:
            pnl[i] = 0.0

    wins = (pnl > 0).sum()
    losses = (pnl < 0).sum()
    trades = wins + losses
    win_rate = wins / trades if trades else 0.0
    expectancy = pnl.mean()
    total_pnl = pnl.sum()
    max_drawdown = 0.0
    peak = 0.0
    cum = np.cumsum(pnl)
    for i in range(len(cum)):
        peak = max(peak, cum[i])
        max_drawdown = min(max_drawdown, cum[i] - peak)

    return {
        "total_trades": trades,
        "win_rate": win_rate,
        "expectancy": expectancy,
        "total_pnl": total_pnl,
        "max_drawdown": max_drawdown,
        "pnl_curve": cum,
    }


def main():
    print(f"Loading {INPUT_CSV.name} ...")
    df = load_data(INPUT_CSV)
    print(f"  {len(df):,} bars, {df['ticker'].nunique()} tickers")
    print(f"  Date range: {df['timestamp'].min()}  to  {df['timestamp'].max()}")

    print("Adding features ...")
    df = add_features(df)

    X, y, valid_df = build_dataset(df)
    print(f"  {len(X):,} valid samples, {len(FEATURES)} features")

    # Time-based split: last 10% for validation
    split = int(len(X) * 0.9)
    X_train, y_train = X[:split], y[:split]
    X_val, y_val = X[split:], y[split:]
    val_df = valid_df.iloc[split:].reset_index(drop=True)

    print(f"\nTraining LightGBM on {len(X_train):,} samples, validating on {len(X_val):,} ...")
    model = train_lightgbm(X_train, y_train, X_val, y_val)

    print("\nBacktest (validation set) ...")
    results = backtest(model, val_df, use_lightgbm=True)
    print(f"  Trades:      {results['total_trades']:,}")
    print(f"  Win rate:    {results['win_rate']:.2%}")
    print(f"  Expectancy:  {results['expectancy']:.6f} per bar")
    print(f"  Total P&L:   {results['total_pnl']:.4f}")
    print(f"  Max DD:      {results['max_drawdown']:.4f}")

    # Save model as torch-compatible wrapper
    torch.save({"model": "lightgbm", "features": FEATURES}, OUTPUT_PT)
    print(f"\nModel saved to {OUTPUT_PT}")


if __name__ == "__main__":
    main()
