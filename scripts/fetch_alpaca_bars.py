#!/usr/bin/env python3
"""Fetch regular-session 5-min bars from Alpaca market data for the 38 tickers.

Keys come from the environment (APCA_API_KEY_ID, APCA_API_SECRET_KEY); they are never
printed or written. Usage: python scripts/fetch_alpaca_bars.py START END OUT.csv [feed]
Pages through next_page_token, keeps 13:30-19:55 UTC bars (US regular session in EDT).
"""
import os
import sys

import pandas as pd
import requests

TICKERS = ["ADBE", "ADI", "ADP", "ADSK", "AKAM", "AMAT", "CDNS", "CDW", "CRWD", "CTSH", "DDOG",
           "FFIV", "FISV", "FLEX", "FSLR", "FTNT", "GEN", "INTU", "JKHY", "LITE", "LRCX", "MCHP",
           "MPWR", "NTAP", "PANW", "PAYX", "PTC", "ROP", "SNPS", "STX", "SWKS", "TER", "TRMB",
           "TXN", "VRSN", "WDAY", "WDC", "ZBRA"]


def main(start, end, out, feed="sip"):
    s = requests.Session()
    s.headers.update({"APCA-API-KEY-ID": os.environ["APCA_API_KEY_ID"],
                      "APCA-API-SECRET-KEY": os.environ["APCA_API_SECRET_KEY"]})
    rows, token = [], None
    while True:
        params = {"symbols": ",".join(TICKERS), "timeframe": "5Min", "start": start, "end": end,
                  "feed": feed, "limit": 10000, "adjustment": "raw"}
        if token:
            params["page_token"] = token
        r = s.get("https://data.alpaca.markets/v2/stocks/bars", params=params, timeout=60)
        if r.status_code != 200:
            raise SystemExit(f"HTTP {r.status_code}: {r.text[:200]}")
        d = r.json()
        for sym, bars in (d.get("bars") or {}).items():
            for b in bars:
                rows.append((sym, b["t"], b["o"], b["h"], b["l"], b["c"], b["v"]))
        token = d.get("next_page_token")
        if not token:
            break
    df = pd.DataFrame(rows, columns=["ticker", "timestamp", "open", "high", "low", "close", "volume"])
    df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True)
    hm = df["timestamp"].dt.hour * 60 + df["timestamp"].dt.minute
    df = df[(hm >= 13 * 60 + 30) & (hm <= 19 * 60 + 55)].sort_values(["ticker", "timestamp"])
    df.to_csv(out, index=False)
    print(f"{len(df):,} bars, {df['ticker'].nunique()} tickers, "
          f"{df['timestamp'].min()} .. {df['timestamp'].max()} -> {out}")


if __name__ == "__main__":
    main(*sys.argv[1:])
