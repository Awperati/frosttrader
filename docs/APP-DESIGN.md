# Frost Trader: app design

Status: 23 Oct 2026, branch `stock-numbers`. Stage 0 (read-only). Only the **Stock numbers** screen
is built. No order has been placed, and no broker key is used.

This note covers **screens and data flow** only. Two other documents cover the rest:

- [DESIGN-autonomous-agents.md](./DESIGN-autonomous-agents.md), being written by another agent, covers the
  trading-agent architecture. The owner now wants fully autonomous trading by several agents, each in
  its own sandbox. Where that file and this one disagree about agents, that file wins.
- [DESIGN-llm-automation.md](./DESIGN-llm-automation.md), on branch `llm-automation-design` until it is
  merged, covers the deterministic gate, the kill switch, the audit log and the stage exit criteria.

Paper only. Not financial advice. Nothing in the app predicts prices or claims a profit.

---

## 1. Screens

| Screen | What it shows | Built |
|---|---|---|
| **Stock numbers** | A symbol list (the dataset's indices now, the owner's watchlist later). For each symbol: the last value, change and % change, sparkline. A detail pane has the day range, open, previous close, 52-week range, volume (when the data has it), a candle or line chart with 1M / 3M / 1Y / All, returns per range, volatility, max drawdown, best and worst day, and a paged daily OHLC table. A banner shows the source, the last date, the data's age and "Paper only. Not financial advice." | Stage 0, this branch |
| **Proposals and log** | Every order intent from the trading agents, which agent sent it, the gate's verdict and the reason, and the audit chain status. Read-only. | Stage 0, second part (shadow gate) |
| **Paper portfolio** | Paper cash, positions, fills, the day's P&L and the equity curve, from the Alpaca paper account or the simulator. | Stage 1 |
| **Risk and limits** | Current limits beside `HARD_LIMITS`. Tightening takes effect at once. Loosening waits for the next trading day and breaks the discipline streak (as `engine.setLimits` does today). Shows automatic halts. | Stage 1 |
| **Settings** | Finviz Elite screeners (URLs + write-only API token, Test, last fetch), data source, sign-in and devices, and the secret-store status (whether a key is set, never its value). | Stage 0 for the watchlist; the rest later |
| **Kill switch** | Always in the top bar, on every screen. It stops new orders and cancels open ones, with an optional "and close all" (see DESIGN-llm-automation §6 and Q4). In stage 0 it is shown disabled, because nothing is trading. | Stage 1 |

The layout is a top bar (brand, stage badge, screens, kill switch), a main area, and a footer that
repeats the notice. The stage badge always shows the stage, so "read-only" or "paper" is never hidden.

## 2. Data flow

```
 sources                     store                         engine and gate                 UI
 ───────                     ─────                         ───────────────                 ──
 HF index CSV  ──download──▶ data/datasets/*.csv ──┐
 (one-off, local)            (git-ignored)         │
                                                   ├──▶ loaders ──▶ numbers.mjs ──────────▶ /api/numbers ──▶ Stock numbers
 Alpaca market data ───────▶ data/bars/<SYM>.csv ──┤     (indexes.mjs,     (quote, ranges,
 (stage 1+, own keys)        (git-ignored)         │      csv.mjs)          stats, history)
                                                   │
 Owner's watchlist ────────▶ data/watchlist.json ──┤
 (paste / Finviz CSV)                              │
                                                   └──▶ Trader + RiskGuard ──▶ broker (sim / Alpaca paper)
 Trading agents (sandboxed) ▶ order intents ───────────▶ gate (deterministic) ──▶ verdict + audit log ──▶ Proposals and log
                                                          approve / reject                              Paper portfolio
```

- **Sources** are files or APIs whose terms the owner accepts. Nothing scrapes a website.
- **Store**: everything lives under `DATA_DIR` (default `./data`, git-ignored). Downloaded data is
  never committed. App state stays in `state.json`, written atomically (`server/store.mjs`).
- **Loaders** turn each source into the engine's one bar format, `{ t, o, h, l, c, v }`.
  `indexes.mjs` reads the HF file (day-first dates, every index in one file). `csv.mjs` reads one file
  per symbol. They are kept separate on purpose: see §5.
- **Engine and gate**: the same `Trader` and `RiskGuard` run the backtest, the simulator and paper
  trading. Order intents from the agents pass the gate (DESIGN-llm-automation §5) before anything
  reaches a broker. How the agents are built and kept apart is described in DESIGN-autonomous-agents.md.
- **UI** reads only through the server's API. In stage 0 the server (`server/index.mjs`) exposes only
  the read-only `/api/numbers` routes. It listens on 127.0.0.1 and constructs no broker.

## 3. Where the agents and the gate sit

This section is only a pointer. The agent architecture (how many agents, their sandboxes, and what
each one may do) is in [DESIGN-autonomous-agents.md](./DESIGN-autonomous-agents.md).

What the screens assume from it:

- No agent reaches a broker directly. Every order intent passes a **deterministic gate** (plain code
  that extends `risk.mjs`). The gate's verdict and reason go into the audit log.
- **Proposals and log** reads that log.
- **Risk and limits** and the **Kill switch** act on the gate and the brokers, never through an agent.
  The owner holds the kill switch and every limit.

No agent plays any part in the Stock numbers screen. The numbers there are computed by code from the
data, and they only describe the past.

## 4. Stages

This summary is taken from DESIGN-llm-automation §11. If DESIGN-autonomous-agents.md changes the
stages for autonomous agents, that file wins.

| Stage | What runs | Orders | Leaves the stage when |
|---|---|---|---|
| **0: read-only** | Stock numbers on the historical dataset (this branch). Then the watchlist, Alpaca *market data*, agent order intents and the gate in shadow mode (it records what it *would* decide). | None. No order endpoint is constructed. | DESIGN-llm-automation §11 exit criteria, and the owner's go-ahead |
| **1: paper** | Alpaca paper account, current gate checks on, default limits, kill switch live. | Paper only | §11 criteria, and the owner's go-ahead |
| **2: paper, full gate** | All gate checks, automatic halts, daily report, comparison with rule-only and buy-and-hold. | Paper only | `minPaperDays` and the §11 criteria. A profit is never the criterion. |
| **3: live, tiny limits** | Only on the owner's explicit say-so, with very small caps. Paper keeps running alongside. | Live, tiny | Each raise is a separate owner action |

## 5. The index dataset (stage 0 data)

`pettah/global-top-Index-exploring-trends-in-stock-Market`, file `Stock_Market_Indexes.csv`,
downloaded once to `data/datasets/` (`npm run fetch:indexes`). It is never committed.

- **Columns**: `Date, Name, Symbol, Open, High, Low, Close, Adj Close, Volume`. Dates are
  **DD-MM-YYYY**. Rows are newest first, with all indices mixed together.
- **Coverage**: 50,132 rows, 32 indices, from **1 Jan 2018 to 5 Apr 2024**. Most indices end on
  5 Apr 2024. The Shenzhen, SSE and TWII indices end on 3 Apr, and TA-125 on 4 Apr. It doesn't run
  to the end of April.
- **Units**: index points in each index's own currency, which the file doesn't state. `Adj Close`
  equals `Close` except for 223 Shenzhen rows, where it differs in the second decimal place.
- **Volume** is Yahoo's index volume, which isn't comparable between indices. It is `-` for every
  row of MERVAL, Cboe UK 100, NYSE AMEX Composite, VIX, MOEX, JSE Top 40 USD and IPSA, and for
  scattered days elsewhere. The view says "not in the data" instead of showing 0.
- **Rows the loader drops, and reports**:
  - 1,410 "no prices" rows, where every field is `-` (holidays the scrape kept);
  - one spike: MERVAL on 14 Jul 2022 has a close of 5,184 between two days near 104,000;
  - no duplicates and no bad dates in this file. The loader still checks for them, and the
    fixture tests them.
- **Gaps**: the longest are exchange closures. MOEX had 27 days (25 Feb to 24 Mar 2022), TWII and
  the Chinese indices about 11–13 days at Lunar New Year, and the Nikkei 11 days in 2019. **IPSA has
  prices only until 14 Jun 2019.** After that its rows are all `-`.
- **Symbols**: the file drops Yahoo's caret (`GSPC`, `DJI`, `VIX`). Spelled like that, several pass
  the risk guard's `STOCK` pattern. The loader gives every index a `^` prefix (`^GSPC`), so none can
  pass as a tradable stock. A test checks this.
- **Provenance**: the MIT licence is the uploader's. The card says the numbers were scraped from
  Yahoo Finance, whose terms don't grant redistribution. So the data stays local, isn't committed, and
  is shown with its source, end date and age.

**Backtests**: `scripts/backtest.mjs --indexes [--range 1Y]` runs `indexStudy()`, a daily-level
summary per index (return, volatility, max drawdown, worst day). It does **not** feed the intraday
`Trader`, which trades 5-minute bars. Indices can't be traded, and a daily bar stamped at midnight
falls outside market hours. The gate's fault tests use the seeded `synthetic.mjs` data
(DESIGN-llm-automation §13).

## 6. What was learnt from PyStockwatch

`C:\Users\User\Frost Technology\PyStockwatch-main` (MoeR3za/PyStockwatch) is a Python/Tk app,
used here as a reference only.

- **Licence: none.** The folder has no LICENSE file, and neither the README nor the sources state
  a licence. Without one, the author keeps all rights. **No code was copied.** Only ideas and the
  feature list were taken, and everything here is written fresh in this repo's stack.
- **Ideas taken:**
  - **A window or pane per symbol**, holding the price, change, previous close, open, day range,
    52-week range and volume. It became the detail pane's fact tiles.
  - **Preset periods plus "max"** (1M, 3M, 6M, 1Y, 3Y, max), and **line / candle** chart types. It
    became the range and type toggles. Ranges count back from the last bar, because the data is
    historical.
  - **A local price database, filled incrementally.** It keeps one table per symbol and fetches only
    the missing days. Frost Trader keeps one CSV per symbol under `DATA_DIR` for the same purpose.
    The planned `scripts/fetch-bars.mjs` should append only the missing days.
  - **A symbol directory with autocomplete.** It became the filter box over the symbol list. A real
    directory of tradable symbols should come from the broker's asset list (`/v2/assets`).
  - **A single central clock that pauses fetching outside market hours.** The engine already does this
    (`marketOpen`, `nyClock`). A holiday calendar is still missing.
  - **Price flashes green or red on change.** Worth adding once live paper prices exist. Not useful on
    a static dataset.
- **Not taken:**
  - the moving-average overlay: it can read as a signal, and the view stays descriptive;
  - bid/ask: there is no quote feed in stage 0;
  - debug printing to the terminal.
- **Data-source caveat:** PyStockwatch gets its prices through **yfinance**, which scrapes Yahoo
  Finance. It is not a licensed feed, can break without notice, and Yahoo's terms don't allow this
  kind of use. It gets its symbol list from `pandas_datareader.get_nasdaq_symbols`. Frost Trader
  must not use yfinance or any scraper.

## 7. Data sources and caveats

| Use | Source | Caveat |
|---|---|---|
| Stage 0 display, daily studies | HF index CSV (local) | Scraped from Yahoo; ends 5 Apr 2024; indices only; local use, labelled |
| Live and historical prices for the watchlist (stage 0 shadow onward) | **Alpaca market data** with the owner's paper keys | Free plan: IEX real-time (a slice of total volume), SIP 15 minutes delayed, history to 2016. The report names the feed. |
| Second opinion (optional) | Tiingo, or the Polygon free tier | Personal-use terms, with the owner's own key in the secret store |
| Symbol names | The owner's Finviz Elite screeners via the Screener API export (`server/engine/finviz.mjs`), or a paste | Token-based export only: never his password, never page scraping. Only the `Ticker` column is read. |
| Never | yfinance, Yahoo or Finviz page scraping | Not licensed for this use |

## 8. Code map (this branch)

| File | Role |
|---|---|
| `server/engine/data/indexes.mjs` | Loader for the HF index CSV: parsing, quality report, `^` symbols, `indexBars()` |
| `server/engine/numbers.mjs` | `quote`, `sliceRange`, `compress`, `seriesStats` (built on `stats.mjs`), `historyPage` |
| `server/engine/watchlist-input.mjs` | `parseTickers()`: a paste or Finviz CSV export, checked against `STOCK`, at most 40. Not stored. |
| `server/engine/finviz.mjs` | Finviz Elite screener source: export URLs, rate limit, backoff, redaction, last good list in `DATA_DIR/watchlist.json`. |
| `server/numbers-api.mjs` | Read-only `/api/numbers` routes, as plain functions for tests |
| `server/index.mjs` | HTTP server on 127.0.0.1: serves `client/dist` and `/api/numbers`. No engine or broker. |
| `server/engine/backtest.mjs` | `indexStudy()`, the daily study for the harness |
| `scripts/fetch-indexes.mjs` | The one-off download (a single HTTPS GET) |
| `client/` | Vite + React + TypeScript. `pages/StockNumbers.tsx` and `components/PriceChart.tsx` (SVG, no chart library) |
| `test/stock-numbers.test.mjs` | Tests on `test/fixtures/indexes-mini.csv`, with `fetch` stubbed to fail |

Run: `npm install`, `npm run fetch:indexes`, `npm run build`, `npm start`, then open
`http://127.0.0.1:8787`. Check with `npm run check`, which runs the typecheck, the build and the tests.

Before the server is reachable from anywhere but this PC, sign-in (`server/auth.mjs`) must be
wired in front of `/api`.
