
import time
from pathlib import Path

import pandas as pd
import requests

# EDIT THESE SETTINGS
COINS = ["BTC", "ETH", "SOL", "XRP"]
QUOTE = "USDT"

START_DATE = "2026-01-01"  # UTC, inclusive
END_DATE = "2026-02-01"    # UTC, exclusive

INTERVAL = "5m"
OUTPUT_DIR = Path("crypto_csv")

API_URL = "https://api.binance.com/api/v3/klines"
COLUMNS = [
    "timestamp", "open", "high", "low", "close", "volume",
    "close_time", "quote_volume", "trades",
    "taker_buy_base_volume", "taker_buy_quote_volume", "ignore"
]


def download_coin(coin):
    symbol = coin.upper() + QUOTE

    start = pd.Timestamp(START_DATE, tz="UTC")
    end = pd.Timestamp(END_DATE, tz="UTC")

    start_ms = int(start.timestamp() * 1000)
    end_ms = int(end.timestamp() * 1000)

    rows = []
    session = requests.Session()

    print(f"Downloading {symbol}...")

    while start_ms < end_ms:
        response = session.get(
            API_URL,
            params={
                "symbol": symbol,
                "interval": INTERVAL,
                "startTime": start_ms,
                "endTime": end_ms - 1,
                "limit": 1000,
            },
            timeout=30,
        )
        response.raise_for_status()
        batch = response.json()

        if not batch:
            break

        rows.extend(batch)

        # Advance beyond the last returned candle
        next_start = int(batch[-1][0]) + 5 * 60 * 1000
        if next_start <= start_ms:
            break
        start_ms = next_start

        time.sleep(0.15)

    if not rows:
        print(f"No data returned for {symbol}.")
        return None

    df = pd.DataFrame(rows, columns=COLUMNS)
    df = df.drop_duplicates(subset="timestamp")
    df["timestamp"] = pd.to_datetime(
        df["timestamp"], unit="ms", utc=True
    )

    # Keep the main OHLCV fields
    df = df[[
        "timestamp", "open", "high", "low", "close", "volume"
    ]]

    # Convert prices and volume from strings to numbers
    for col in ["open", "high", "low", "close", "volume"]:
        df[col] = pd.to_numeric(df[col])

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    path = OUTPUT_DIR / f"{symbol}_5m.csv"
    df.to_csv(path, index=False)

    print(f"Saved {len(df):,} candles -> {path}")
    return df.assign(symbol=symbol)


def main():
    all_data = []

    for coin in COINS:
        try:
            df = download_coin(coin)
            if df is not None:
                all_data.append(df)
        except Exception as exc:
            print(f"ERROR for {coin}: {exc}")

    if all_data:
        combined = pd.concat(all_data, ignore_index=True)
        combined.to_csv(
            OUTPUT_DIR / "ALL_COINS_5m.csv", index=False
        )
        print(f"\nFinished. Files saved in: {OUTPUT_DIR.resolve()}")


if __name__ == "__main__":
    main()
