# The v11 model in FrostTrader

Status: 25 Oct 2026. Paper only, like every agent. Past test results, not a forecast.

## What it is

A LightGBM model (3 seeds averaged) that scores every 5-minute bar of 38 large US tech stocks with
the probability that a buy at that bar's close would win after costs. It was built on v8, the best of
v4–v9 on an honest re-test (`scripts/compare_versions.py`).

- **Buy** at a bar's close when the probability is at least the threshold (0.571, the 95th percentile
  of the model's scores on its training days). Not in the first 15 or last 30 minutes.
- **Sell** on a close 3 × ATR(14) (measured at the buy) under the best close since the buy, after 20
  bars, or at the session close. Never overnight.
- **Features** (35): v8's 19, plus VWAP distance, relative volume against the same time on the last 10
  days, ATR, EMA 20 slope, opening range, session high, prior close, daily and hourly trend, and the
  38 stocks' average move, trend and VWAP position at the same bar. Rules from
  `datasets/day-trading/techniques.json`.

## How it was tested

| | |
|---|---|
| Data | Alpaca IEX 5-minute bars, 1 Apr – 23 Oct 2026 (`stock_ohlcv/ALL_STOCKS_5m_iex.csv`) |
| Settings chosen on | walk-forward over the 60 days before 10 Oct: 4 folds, each model trained on earlier days only |
| Test, touched once | 12–23 Oct 2026: **142 trades, 55.6 % won, +26 bps a trade after 2 bps a side, profit factor 1.68** |
| Same exit, no model | 41.1 % won, −6.9 bps a trade |

142 trades give a margin of about ±4 points on the win rate. Ten test days in one falling, choppy
market are not enough to trust it. The paper record decides.

IEX, not SIP: the app reads IEX bars (the free plan's real-time feed), so the model is trained on IEX.
A SIP-trained copy scored 54.8 % on 73 trades and fell to 46 % when fed IEX bars.

## In the app

- Settings → Paper agents → **Strategy**: "signals" or "v11 model", per agent. agent-d runs v11 by
  default. A v11 agent's entry score, stop, target and max hold are not used, and the nightly test
  does not tune it.
- `server/engine/models/v11.mjs` computes the features and walks the exported trees in JavaScript, so
  no Python runs in the app. `test/v11-parity.test.mjs` checks it against Python's own numbers.
- The host fetches about two weeks of bars for all 38 stocks each tick (the market features need them)
  and sends them to the v11 agent. The v11 agent may buy any of its 38 stocks, on the watchlist or
  not (the owner, 25 Oct 2026: "let the v11 agent trade all 38 of its own stocks even if they are not
  on my watchlist"). Gate check 17 still applies to it with that list; signal agents keep the
  watchlist only.
- Exits run in the host, as for every agent.

## Rebuilding it

```
python scripts/fetch_alpaca_bars.py 2026-04-01T00:00:00Z <end> stock_ohlcv/ALL_STOCKS_5m_iex.csv iex
V11_CSV=ALL_STOCKS_5m_iex.csv V11_FOLD_DAYS=60 python train_trading_model_v11.py
python scripts/export_v11.py
node --test test/v11-parity.test.mjs
```

The fetch reads the keys from `APCA_API_KEY_ID` and `APCA_API_SECRET_KEY` and never prints them.

## Known limits

- time_of_day is New York time + 4 h, so it keeps its meaning after the clocks change on 1 Nov.
  The model has never seen November or a half day.
- The 38 stocks are one sector. A tech-wide fall hits every position at once.
