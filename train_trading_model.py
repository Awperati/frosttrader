r"""
Train a day-trading model on 5-minute OHLCV bars.

Input:  C:\Users\User\Frost Technology\FrostTrader\stock_ohlcv\ALL_STOCKS_5m.csv
Output: C:\Users\User\Frost Technology\FrostTrader\stock_ohlcv\trading_model.pt

Model: small MLP that predicts direction (up/down) for the next 5-minute bar.
Features: returns, volume change, volatility, RSI, moving-average distance.
"""

import sys
from pathlib import Path

import numpy as np
import pandas as pd
import torch
import torch.nn as nn
from sklearn.model_selection import TimeSeriesSplit

BASE_DIR = Path(__file__).resolve().parent
INPUT_CSV = BASE_DIR / "stock_ohlcv" / "ALL_STOCKS_5m.csv"
OUTPUT_PT = BASE_DIR / "stock_ohlcv" / "trading_model.pt"


def load_data(csv_path: Path) -> pd.DataFrame:
    df = pd.read_csv(csv_path)
    df["timestamp"] = pd.to_datetime(df["timestamp"])
    df = df.sort_values(["ticker", "timestamp"]).reset_index(drop=True)
    return df


def add_features(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df["return"] = df.groupby("ticker")["close"].pct_change()
    df["vol_change"] = df.groupby("ticker")["volume"].pct_change()
    df["high_low_range"] = (df["high"] - df["low"]) / df["close"]
    df["close_position"] = (df["close"] - df["low"]) / (df["high"] - df["low"] + 1e-8)
    df["volatility_20"] = (
        df.groupby("ticker")["return"].rolling(20).std().reset_index(level=0, drop=True)
    )
    df["ma_20"] = df.groupby("ticker")["close"].transform(lambda s: s.rolling(20).mean())
    df["ma_dist"] = (df["close"] - df["ma_20"]) / df["ma_20"]
    # RSI(14)
    delta = df.groupby("ticker")["close"].diff()
    gain = delta.clip(lower=0).groupby(df["ticker"]).rolling(14).mean().reset_index(level=0, drop=True)
    loss = (-delta.clip(upper=0)).groupby(df["ticker"]).rolling(14).mean().reset_index(level=0, drop=True)
    df["rsi_14"] = 100 - (100 / (1 + gain / (loss + 1e-8)))
    return df


FEATURES = [
    "return",
    "vol_change",
    "high_low_range",
    "close_position",
    "volatility_20",
    "ma_dist",
    "rsi_14",
]


def build_dataset(df: pd.DataFrame):
    """Return X (features), y (1 if next close > current close else 0), and valid mask."""
    df = df.copy()
    # Target: does close go up in the next bar?
    df["next_close"] = df.groupby("ticker")["close"].shift(-1)
    df["target"] = (df["next_close"] > df["close"]).astype(int)
    df = df.dropna(subset=FEATURES + ["next_close"])
    X = df[FEATURES].values.astype(np.float32)
    y = df["target"].values.astype(np.int64)
    valid = np.isfinite(X).all(axis=1)
    X = np.clip(X[valid], -10.0, 10.0)
    return X, y[valid], df[valid].reset_index(drop=True)


def train(X_train, y_train, X_val, y_val, epochs=20, batch_size=2048, lr=1e-3):
    model = nn.Sequential(
        nn.Linear(len(FEATURES), 64),
        nn.ReLU(),
        nn.Dropout(0.2),
        nn.Linear(64, 32),
        nn.ReLU(),
        nn.Linear(32, 1),
    )
    optimizer = torch.optim.Adam(model.parameters(), lr=lr)
    criterion = nn.BCEWithLogitsLoss()

    X_train_t = torch.tensor(X_train, dtype=torch.float32)
    y_train_t = torch.tensor(y_train, dtype=torch.float32).unsqueeze(1)
    X_val_t = torch.tensor(X_val, dtype=torch.float32)
    y_val_t = torch.tensor(y_val, dtype=torch.float32).unsqueeze(1)

    best_val_acc = 0.0
    best_state = None

    for epoch in range(epochs):
        model.train()
        perm = torch.randperm(len(X_train_t))
        total_loss = 0.0
        for i in range(0, len(X_train_t), batch_size):
            idx = perm[i : i + batch_size]
            batch_x = X_train_t[idx]
            batch_y = y_train_t[idx]
            optimizer.zero_grad()
            out = model(batch_x)
            loss = criterion(out, batch_y)
            loss.backward()
            optimizer.step()
            total_loss += loss.item()

        model.eval()
        with torch.no_grad():
            val_out = model(X_val_t)
            val_loss = criterion(val_out, y_val_t).item()
            val_pred = (torch.sigmoid(val_out) > 0.5).float()
            val_acc = (val_pred == y_val_t).float().mean().item()

        if val_acc > best_val_acc:
            best_val_acc = val_acc
            best_state = {k: v.clone() for k, v in model.state_dict().items()}

        if (epoch + 1) % 5 == 0 or epoch == 0:
            print(f"Epoch {epoch+1:3d}  train_loss={total_loss/len(X_train_t):.4f}  val_acc={val_acc:.4f}")

    if best_state:
        model.load_state_dict(best_state)
    return model


def backtest(model, df: pd.DataFrame) -> dict:
    """Simple backtest: long when model says up, flat when down. 1-bar hold."""
    model.eval()
    X = df[FEATURES].values.astype(np.float32)
    X_t = torch.tensor(X, dtype=torch.float32)
    with torch.no_grad():
        preds = (torch.sigmoid(model(X_t)) > 0.5).numpy().flatten()

    close = df["close"].values
    ret = df["return"].values
    # P&L: enter at close[t], exit at close[t+1] if pred[t]==1
    pnl = np.zeros(len(close))
    for i in range(len(close) - 1):
        if preds[i] == 1:
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
    val_df = valid_df.iloc[split:]

    print(f"\nTraining on {len(X_train):,} samples, validating on {len(X_val):,} ...")
    model = train(X_train, y_train, X_val, y_val)

    print("\nBacktest (validation set) ...")
    results = backtest(model, val_df)
    print(f"  Trades:      {results['total_trades']:,}")
    print(f"  Win rate:    {results['win_rate']:.2%}")
    print(f"  Expectancy:  {results['expectancy']:.6f} per bar")
    print(f"  Total P&L:   {results['total_pnl']:.4f}")
    print(f"  Max DD:      {results['max_drawdown']:.4f}")

    torch.save(model.state_dict(), OUTPUT_PT)
    print(f"\nModel saved to {OUTPUT_PT}")


if __name__ == "__main__":
    main()
