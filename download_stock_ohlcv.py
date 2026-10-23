"""
Download 5-minute stock OHLCV candles for tickers in finviz.csv.

Requirements:
    py -m pip install yfinance pandas

Put this script in the same folder as finviz.csv, then run:
    py .\download_stock_ohlcv.py

Yahoo Finance's 5-minute intraday history is limited to approximately the
most recent 60 days. This script downloads regular-session data only.
"""

from pathlib import Path
import time
import pandas as pd
import yfinance as yf

BASE_DIR = Path(__file__).resolve().parent
INPUT_CSV = BASE_DIR / "finviz.csv"
OUTPUT_DIR = BASE_DIR / "stock_ohlcv"
PERIOD = "60d"
INTERVAL = "5m"


def main():
    if not INPUT_CSV.exists():
        raise FileNotFoundError(
            f"Could not find {INPUT_CSV}\n"
            "Put finviz.csv in the same folder as this script."
        )

    source = pd.read_csv(INPUT_CSV)
    ticker_column = next(
        (col for col in source.columns if str(col).strip().lower() == "ticker"),
        None,
    )
    if ticker_column is None:
        raise ValueError(
            "Could not find a 'Ticker' column in finviz.csv. "
            f"Columns found: {list(source.columns)}"
        )

    tickers = (
        source[ticker_column]
        .dropna()
        .astype(str)
        .str.strip()
        .str.upper()
    )
    tickers = list(dict.fromkeys(t for t in tickers if t and t != "NAN"))

    if not tickers:
        raise ValueError("No ticker symbols found in finviz.csv.")

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    all_frames = []
    failures = []

    print(f"Found {len(tickers)} tickers in {INPUT_CSV.name}.")
    print(f"Downloading {INTERVAL} candles for up to {PERIOD} of history.")
    print("Source: Yahoo Finance; regular trading session only.\n")

    for ticker in tickers:
        print(f"[{ticker}] downloading...", flush=True)
        try:
            df = yf.download(
                ticker,
                period=PERIOD,
                interval=INTERVAL,
                auto_adjust=False,
                prepost=False,
                actions=False,
                progress=False,
                threads=False,
                multi_level_index=False,
                timeout=30,
            )

            if df is None or df.empty:
                print(f"  NO DATA returned for {ticker}")
                failures.append({"Ticker": ticker, "Reason": "No data returned"})
                time.sleep(0.5)
                continue

            # Normalize column names and retain the standard OHLCV fields.
            df.columns = [str(c).strip().lower().replace(" ", "_") for c in df.columns]
            required = ["open", "high", "low", "close", "volume"]
            missing = [c for c in required if c not in df.columns]
            if missing:
                print(f"  Missing columns for {ticker}: {missing}")
                failures.append({
                    "Ticker": ticker,
                    "Reason": f"Missing columns: {', '.join(missing)}",
                })
                time.sleep(0.5)
                continue

            df = df[required].copy()
            df.index.name = "timestamp"
            df = df.reset_index()
            df.insert(0, "ticker", ticker)
            df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True)
            df = df.dropna(subset=["open", "high", "low", "close"])
            df = df.sort_values("timestamp").drop_duplicates(
                subset=["ticker", "timestamp"]
            )

            out_file = OUTPUT_DIR / f"{ticker}_5m.csv"
            df.to_csv(out_file, index=False)
            all_frames.append(df)
            print(f"  Saved {len(df):,} candles -> {out_file.name}")
        except Exception as exc:
            print(f"  ERROR for {ticker}: {exc}")
            failures.append({"Ticker": ticker, "Reason": str(exc)})

        time.sleep(0.5)

    if all_frames:
        combined = pd.concat(all_frames, ignore_index=True)
        combined = combined.sort_values(["ticker", "timestamp"])
        combined.to_csv(OUTPUT_DIR / "ALL_STOCKS_5m.csv", index=False)
        print(f"\nCombined file: {OUTPUT_DIR / 'ALL_STOCKS_5m.csv'}")
        print(f"Total rows saved: {len(combined):,}")
    else:
        print("\nNo stock data was saved.")

    if failures:
        pd.DataFrame(failures).to_csv(
            OUTPUT_DIR / "DOWNLOAD_ERRORS.csv", index=False
        )
        print(f"Some tickers failed. See {OUTPUT_DIR / 'DOWNLOAD_ERRORS.csv'}")

    print(f"\nFinished. Output folder: {OUTPUT_DIR}")


if __name__ == "__main__":
    main()
