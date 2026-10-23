# Design: LLM-driven automation for Frost Trader and the Frost Technology parts shop

Status: design only, 23 Oct 2026. Nothing here has been built. No order has been placed.
Branch `llm-automation-design`, based on `master` d6a3160 (the repo has no remote, so there is no
`origin/main`; `git fetch` had nothing to fetch).

The idea in one line: **the local model only writes suggestions; plain code decides, and the owner
holds every switch.** Neither the trader nor the shop can earn money or lose it because the model
said so. Every action passes a deterministic gate that the model cannot see past or change.

Nothing in this note, the app, or its reports claims or predicts a profit.

---

## 1. What exists today

### 1.1 Frost Trader (`C:\Users\User\Frost Technology\FrostTrader`)

| Part | File | What it does now |
|---|---|---|
| Risk guard | `server/engine/risk.mjs` | `RiskGuard.check(order, account)`. It enforces the kill switch (no new buys), the daily loss halt, US stocks only (regex `STOCK`, so no options or crypto), no leverage (cash only), no shorting (sells ≤ held), max position value and % of equity, max buys per day and max open positions. `cleanLimits()` clamps Settings to `HARD_LIMITS`. `positionSize()` sizes by risk. Tests in `risk.test.mjs` (14 cases). |
| Strategy | `server/engine/strategy.mjs` | `Trader.onBar()`: rule-based entries from signals; stop at 2 ATR, target at 3 ATR, max hold and flat by the close. Every order goes through `guard.check()`. |
| Engine | `server/engine/engine.mjs` | Two modes. `sim` replays CSV or synthetic bars. `alpaca` runs every minute in market hours and uses `env.WATCHLIST` plus Alpaca's screener scan. `kill()` sets `killed` and **flattens all positions**. `resume()` is logged as an override. Looser limits wait until the next trading day (`pendingLimits`). |
| Brokers | `broker/alpaca.mjs`, `broker/sim.mjs` | Alpaca is **paper only**, with `PAPER_URL` hard-coded. Keys come from `.env` and go only in headers. `flatten()` cancels orders and closes positions. |
| Data | `server/engine/data/csv.mjs`, `synthetic.mjs` | CSV loader: `DATA_DIR/bars/<SYMBOL>.csv` with `t,o,h,l,c,v`. Synthetic bars are seeded. |
| Backtest | `backtest.mjs`, `scripts/backtest.mjs`, `signals/index.mjs` | Replays bars through the real Trader and guard. Each signal's hit rate is reported next to its coin-flip base rate. |
| Store | `server/store.mjs` | `DATA_DIR/state.json`, written atomically. The tape is capped at 500 events. |
| Auth | `server/auth.mjs`, `totp.mjs` | Password (scrypt), per-device tokens, lockouts, TOTP. |
| Game | `game.mjs` | Streaks for discipline, never for profit. Loosening limits or resuming breaks the streak. |

Gaps found while reading. These are facts, not design:

- **The committed tree does not run on its own.** `.gitignore` has the line `data`, which also ignores
  `server/engine/data/`. So `csv.mjs` and `synthetic.mjs` exist only as ignored files in the main
  checkout and are missing from the `frosttrader-1ef6` worktree and from this branch. `engine.mjs`,
  `backtest.test.mjs` and `scripts/backtest.mjs` import them. Fix: change the rule to `/data`, then
  commit the two files.
- There is no `package.json`, server entry point, `Dockerfile` or compose file. `client/src/pages` and
  `desktop/` are empty and `docs/` was empty. The "client, desktop app and Docker deploy" exist only
  as folders (and `deploy/docker-entrypoint.sh`).
- `marketOpen()` has no holiday or half-day calendar.
- The kill switch flattens positions, but the rule asked for here is "cancel open orders and stop".
  See Q4.
- The watchlist is only `env.WATCHLIST`, and the engine **adds screener symbols to it**
  (`alpacaStep`: watchlist + held + scanned). Under rule (b) the scan must stop feeding orders.

### 1.2 Frost AI (the model server)

- `frostai-main/electron/lib/launcher.cjs` starts `llama-server` on **127.0.0.1:8080**. Qwen3.8-27B
  has a context of up to 262k.
- `frostai-main/electron/console/server.cjs` is the **Console gateway**: an OpenAI-compatible
  `/v1/chat/completions` on **127.0.0.1:8765**. It needs Frost AI API keys, has rate limits and
  `logContent: false` by default, and is **off by default**.
- Both run on the owner's PC. A Frost Trader deployed to the Pi could not reach them without
  Tailscale. **The LLM-driven engine therefore runs on the PC**, either in the desktop shell or in a
  local Docker container. The Pi is not involved.

### 1.3 "ticker"

There is **`ticker` 5.3.0** (achannarasappa/ticker, a terminal stock-quote watchlist) installed via
WinGet at `%LOCALAPPDATA%\Microsoft\WinGet\Packages\achannarasappa.ticker_…\ticker.exe`. There is no
`~/.ticker.yaml` yet. It is a viewer: it can't read Finviz or place orders. The most it can do here
is share the symbol list. Frost Trader can write its watchlist into `~/.ticker.yaml` so both show the
same list (optional, owner switch). See Q1.

### 1.4 Shop / eCommerce code (search of `C:\Users\User\Frost Technology\`)

The only shop is the **Frost Technology site**: `C:\Users\User\Frost Technology\FrostTechnology`, a git
repo on `main` with `origin`. (The older handoff path `C:\Users\User\FrostTechnology` now holds only
`.frostmind`.) FrostAccounts, FrostKeys and frost-site are not shops.

What it has:

- `server/catalog.mjs`: CSV parsing, column guessing (`FIELDS`: sku, partNo, brand, name,
  description, category, subcategory, cost, rrp, stock, image), `importRows`, `dedupe` (the in-stock,
  cheaper offer wins), and `sellPrice(cost, settings)` = cost ex GST × markup (+10 % GST only when
  `gstRegistered`).
- `server/server.mjs`: sources **Dicker Data and Leader Systems only**
  (route regex `feeds/(dicker|leader)`). An import replaces that distributor's list. A saved feed URL
  gives a daily auto-fetch (`feed-fetch.mjs`: no redirects, 64 MB download cap, 256 MB unzip cap).
- One **global markup** (Settings, 1–5, default 1.3) and `gstRegistered` (default false). There are
  **no per-product prices**. Hide and feature are per product. Manual products are supported.
- Orders are *requests* (staff confirm stock). Stripe and PayPal payments, and Stripe invoices for
  quotes, are in the code. Payment keys live in the data store (`store.read('payments')`, files 0600).
- `ingram-micro-email-draft.txt` suggests Ingram Micro is a likely next distributor.
- **Scorptec is a retailer, not a distributor.** It has no reseller price or stock feed. Its prices
  could only be a competitor reference, and scraping its site is not proposed. Any Scorptec numbers
  would be typed or pasted by staff.
- **Approval path today:** none separate. A signed-in admin (password + optional TOTP) changes
  Settings, hide and feature, and the change is live at once. Feed imports reprice everything
  automatically through the markup. "Through the existing approval path" therefore means: **an
  admin, signed in, presses Apply in `/admin`.** The design adds a Pending changes queue in front of
  that.

---

## 2. Rules (a)–(g) mapped onto the code

| Rule | Exists | Extend | New |
|---|---|---|---|
| **(a) Paper first; live separate, per account** | Alpaca adapter is paper-only by a constant. Engine reports `paper: true`. | `engine.mjs`: mode comes from the store, not from "keys present". | `server/engine/mode.mjs`: modes `off`, `shadow`, `paper`, `live`; a paper-period clock; per-account live arming. `broker/alpaca-live.mjs` (a separate file, the only one with the live URL). |
| **(b) LLM proposes, gate decides** | `RiskGuard.check`, `positionSize`, `HARD_LIMITS`, tighter-now/looser-tomorrow limits. | `risk.mjs`: new limits and `checkProposal()`; feature flags for leverage, options and short (all off, each refused by code in v1). | `llm/client.mjs`, `llm/prompt.mjs`, `llm/schema.mjs`, `watchlist.mjs`, `ratelimit.mjs`. |
| **(c) Kill switch + self-halt** | `kill()`/`resume()`, `store.killed`, `flatten()`. | `kill()` cancels open orders and stops the loop and the LLM; it watches the file flag; resume needs TOTP. | `halt.mjs`: automatic halts (errors, stale data, bad LLM output). |
| **(d) Secrets** | Keys from `.env`, only in headers; `.env` git-ignored. | Alpaca constructor takes keys from the secret store. | `server/secrets.mjs` (server), desktop `safeStorage` bridge, `redact.mjs`. |
| **(e) Audit + honesty** | Tape (500 events), days, backtest base rates, the game rewards discipline. | Tape is the live view; the audit log is the record. | `audit.mjs` (hash-chained JSONL), `report.mjs` (daily summary), fixed honesty text. |
| **(f) Data** | `env.WATCHLIST`, Alpaca bars, screener scan. | Scan is display-only and never feeds orders. | Watchlist from paste or CSV upload (Finviz Elite export). Alpaca data. No scraping, no Finviz password. |
| **(g) Shop** | `catalog.mjs` pricing, feeds, hide and feature, admin auth. | `sellPrice` honours a gated per-product override. | `server/automation/*` in the shop repo: proposals, gate, changesets with revert, Pending changes tab. |

---

## 3. Data and the watchlist (rule f)

Finviz has no public API. Its terms restrict automated access, and the watchlist
(`finviz.com/watchlist?w=5210`) is behind the owner's login. Frost Trader **does not fetch Finviz in
any way and never asks for or stores the Finviz password.**

Options, cleanest first:

1. **Paste tickers** (free, recommended to start). The owner copies the symbols from his Finviz
   watchlist and pastes them into Settings → Watchlist, separated by commas, spaces or new lines.
   One minute of work per change.
2. **CSV upload** (needs Finviz Elite). Elite's export button gives a CSV. The owner uploads it; only
   the `Ticker` column is read and everything else is dropped.
3. **Alpaca watchlist.** The owner keeps the list in Alpaca (`/v2/watchlists`) and Frost Trader
   reads it with the same keys. It is one less copy, but it means maintaining the list in Alpaca
   instead of Finviz.

**Market data is Alpaca in every case** (already in `alpaca.mjs`): the free plan gives real-time IEX
bars and full-market (SIP) bars 15 minutes old. Finviz provides only the *names*.

What the owner must provide: the ticker list (paste or Elite CSV), and an Alpaca paper key pair
(entered once into the secret store, §7).

Watchlist rules (`server/engine/watchlist.mjs`):

- Stored in `DATA_DIR/watchlist.json` as `{ symbols, source: 'paste'|'csv'|'alpaca', setAt, version }`.
- Each symbol must pass `STOCK`, and Alpaca's `/v2/assets/{sym}` must report `tradable`, `us_equity`
  and `status: active`. Symbols that fail are listed as rejected with a reason.
- Edited only through the owner's authenticated Settings API. **Additions take effect at the next
  trading day** (like looser limits); removals take effect at once. Removing a held symbol stops new
  buys; the position is still managed and closed by the existing exit rules.
- At most 40 symbols (the engine's existing cap).
- The screener `scan()` stays only as a "radar" display. It never becomes an order symbol.
- Optional: write the same list to `~/.ticker.yaml` (`watchlist:` key) for the `ticker` app (Q1).

---

## 4. The LLM loop

### 4.1 Where it sits

```
every minute in market hours (engine.alpacaStep)
  bars (Alpaca) ──► signals (existing) ──► context builder ──► LLM client ──► parser/validator
                                                                                     │ proposal
  broker ◄── order ◄── RiskGuard.checkProposal ──► audit (every step) ◄──────────────┘
```

- **Client** (`server/engine/llm/client.mjs`): POST to `LLM_URL`, default
  `http://127.0.0.1:8765/v1/chat/completions` (the Console gateway, with a Frost AI API key from the
  secret store), or `http://127.0.0.1:8080` directly. It sends `temperature: 0`, a fixed `seed`,
  `max_tokens: 600`, a 20 s timeout and **no tools/functions**: the model can only return text.
  `response_format` carries the JSON schema below (llama-server turns it into a grammar). The output
  is validated again in code whatever the server did.
- **Prompt** (`llm/prompt.mjs`): built from an allow-listed object only. It has the symbol, the last
  N bars summarised, the existing signal scores, the current position and plan, the time to the
  close, and the *remaining* headroom (for example "2 buys left today"), given as information only.
  It never contains keys, account numbers, the account ID, the audit log, or settings beyond that
  headroom. Each prompt is hashed and stored, and the full text is kept in the audit log for replay.
- One call per cycle covers all watchlist symbols that have a new finished bar. It returns
  `{ proposals: [...] }`, where an empty array means "do nothing", which is a fine answer.
- The model's views are *input*. The existing stop and target exits in `Trader.onBar` stay
  deterministic and always run, even when the LLM is down.

### 4.2 Proposal JSON schema

```json
{
  "$id": "frost-trader/proposal-batch/v1",
  "type": "object",
  "additionalProperties": false,
  "required": ["proposals"],
  "properties": {
    "proposals": {
      "type": "array",
      "maxItems": 5,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["symbol", "side", "size", "reason", "confidence", "stop"],
        "properties": {
          "symbol":     { "type": "string", "pattern": "^[A-Z]{1,5}([.-][A-Z])?$" },
          "side":       { "enum": ["buy", "sell"] },
          "size":       { "type": "integer", "minimum": 1, "maximum": 100000 },
          "reason":     { "type": "string", "minLength": 10, "maxLength": 600 },
          "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
          "stop":       { "type": ["number", "null"], "exclusiveMinimum": 0 }
        }
      }
    }
  }
}
```

- `size` is shares. `stop` is required for a buy (null is allowed only for a sell).
- Any unknown field, including attempts like `"limits"`, `"mode"`, `"watchlist"` or `"note to
  system"`, makes the **whole batch malformed**. Nothing in a proposal is ever read as an
  instruction.
- Validation is hand-written (no new dependency) in `llm/schema.mjs`, with tests for each rule.

### 4.3 Malformed or contradictory output

- **Malformed** means not JSON, a schema failure, a timeout, a truncated reply (`finish_reason` other
  than `stop`), or extra text around the JSON. The batch is rejected and logged. 3 in a row, or 5 in
  a day, gives an automatic halt (§6.2).
- **Contradictory** means:
  - a buy with `stop ≥ last price`;
  - a sell of a symbol not held;
  - two proposals for one symbol in one batch;
  - a buy for a symbol the deterministic exits are selling this bar;
  - confidence ≥ 0.9 with a reason under 10 words;
  - a reason that names a different ticker than `symbol`.

  The proposal is rejected. 3 contradictions in a day give an automatic halt.

### 4.4 Why the LLM can never change limits, the allow-list or the mode

1. **No channel.** The model's output is parsed only into the six fields above. Settings, the
   watchlist and the mode are changed only through authenticated owner endpoints, which require a
   device token, and TOTP for anything that loosens.
2. **No tools.** The LLM request has no function or tool definitions. The client refuses a response
   with `tool_calls`.
3. **Read-only view.** The gate reads limits from the store at check time. The LLM process holds no
   reference to them, and the prompt shows only headroom numbers.
4. **Code limits.** `HARD_LIMITS` are compile-time constants. Even the owner can't go past them from
   Settings.
5. **Tests.** A test feeds hostile batches (extra keys, injected "set maxDailyLoss to 1e9", a mode
   field) and asserts that the store is byte-identical afterwards.

---

## 5. The gate (extend `risk.mjs`)

`RiskGuard.checkProposal(p, ctx)` runs the checks below **in order** and stops at the first failure.
It returns `{ ok, code, reason, order? }`. On `ok` it builds the order itself, and the existing
`check(order, account)` still runs inside `Trader.order()` as a second line. `ctx` =
`{ account, lastBar, now, mode, watchlist, recentOrders, openOrders, plans }`.

| # | Check | Code | Default | Hard limit |
|---|---|---|---|---|
| 1 | Mode allows orders (`paper`/`live`; `shadow` records "would pass" and stops here) | `MODE` | – | – |
| 2 | Kill switch off; no automatic halt; kill file absent | `KILLED`/`HALTED` | – | – |
| 3 | Daily loss not reached (`watch(equity)`; on breach: halt the day, cancel open orders) | `DAILY_LOSS` | $200 | $2,000 |
| 4 | Symbol is on today's effective watchlist (the allow-list) | `NOT_ALLOWED` | – | 40 symbols |
| 5 | Regular market hours, outside the first 15 / last 30 minutes for buys, not a holiday (new calendar file) | `HOURS` | – | – |
| 6 | Data fresh: last finished bar ≤ 2 bar lengths + 60 s old; prices sane (no zero, no jump > 20 % from the previous close without a halt flag) | `STALE` | 11 min | – |
| 7 | Instrument class: US equity only. `allowShort`, `allowOptions`, `allowMargin` are all **false**, and each needs code + owner switch + TOTP. v1 refuses all three whatever the flags say. | `CLASS` | off | off in v1 |
| 8 | Side rules: sell ≤ held (no short); buy needs `stop < price` and stop distance between 0.5 and 4 ATR | `SIDE`/`STOP` | – | – |
| 9 | Confidence ≥ `minConfidence` | `CONF` | 0.6 | ≥ 0.5 |
| 10 | **Size**: `qty = min(p.size, positionSize(...))`. The gate may shrink an order and never grows it. A rounded `qty = 0` is a reject. | `SIZE` | – | – |
| 11 | Per-order value ≤ `maxPositionValue` and ≤ `maxPositionPct` of equity; cash only | (existing) | $2,000 / 20 % | $25,000 / 25 % |
| 12 | **Per-day notional** of buys ≤ `maxDailyNotional` | `DAY_SIZE` | $6,000 | $50,000 |
| 13 | Buys per day ≤ `maxTradesPerDay`; open positions ≤ `maxOpenPositions` | (existing) | 10 / 3 | 30 / 8 |
| 14 | **Duplicate guard**: no open order for the symbol; no same symbol+side order in the last `dupWindowMin`; an idempotency key `sha256(day, symbol, side, barT)` is sent as Alpaca's `client_order_id`, so a retry can't double-submit | `DUP` | 15 min | – |
| 15 | **Rate limits**: orders ≤ `maxOrdersPerMin` and ≤ `maxOrdersPerHour`; LLM calls ≤ 1 per cycle and ≤ 120 per day | `RATE` | 2 / 10 | 5 / 30 |
| 16 | Live only: account armed (§8), and `liveLimits` (much smaller than paper's) apply instead | `LIVE` | see stage 3 | – |

New entries in `DEFAULT_LIMITS` and `HARD_LIMITS`: `maxDailyNotional`, `minConfidence` (where
"looser" means lower), `dupWindowMin`, `maxOrdersPerMin`, `maxOrdersPerHour`, `staleMs`. `isTighter`
learns the direction of each. Every check gets a unit test with a pass and a fail case, plus a
property test: a random proposal never yields an order outside the limits.

Exits stay deterministic. Stop, target, time and session-close sells come from `Trader`, not the LLM.
An LLM "sell" can only close early, and it still passes checks 1–2, 4, 8 and 14–15.

---

## 6. Kill switch and automatic halts (rule c)

### 6.1 The kill switch

There are two ways in, and both do the same thing:

- **The button**: a red button on every screen of the client and desktop app. It calls
  `POST /api/kill`, which works even when the session is a read-only device.
- **The file flag**: `DATA_DIR/KILL`, an empty file whose content (if any) is the reason. The engine
  checks for it at every tick and **immediately before every broker submit**. Create it by hand, from
  a script, or with `New-Item "$env:FROSTTRADER_DATA\KILL"`. The desktop tray menu has the same item.
  The Docker volume makes it reachable from the host.

Kill sequence (`engine.kill`, idempotent):

1. Set `killed`, persist it, write the `KILL` file if it is missing (so a restart stays killed), and
   write an audit `kill` entry.
2. Stop the loop timer and abort any LLM request in flight (AbortController). No more LLM calls.
3. Cancel all open orders (`DELETE /v2/orders`) and read back that none remain. Retry 3× with
   backoff. On failure, show a loud error saying "orders may still be open: check Alpaca".
4. Positions: see Q4. **Recommendation:** in paper, close them (today's behaviour). In live, offer
   "Kill" (cancel + stop) and "Kill and close all" as two buttons, so a panic press never sells into
   a bad market without meaning to.
5. Mark the engine `stopped`.

Resume needs **all of**: the `KILL` file deleted, the owner pressing Resume, a TOTP code, and a typed
reason. It is logged and breaks the streak (as today). Deleting the file alone does nothing.

### 6.2 Automatic halts (`halt.mjs`)

These do steps 1–3 of the kill sequence with `reason` set, and leave positions to the normal exits:

| Trigger | Threshold |
|---|---|
| Engine errors | 3 consecutive cycle errors, or 10 in a day |
| Broker errors | any 401/403 (key problem); 5 × 5xx in 10 minutes |
| Stale data | market open and no fresh bar for any watchlist symbol for 3 cycles |
| Clock | system clock vs. Alpaca `/v2/clock` differs > 30 s |
| Account mismatch | broker position not in `plans` and not adopted, or cash moves without a fill |
| LLM malformed | 3 in a row or 5 in a day |
| LLM contradictory | 3 in a day |
| LLM down | 5 timeouts in a row. Halts only *new* LLM-driven entries; the deterministic exits continue. |
| Daily loss | existing `watch()`, which now also cancels open orders |

A halt shows its reason in the UI, writes the audit log, and (optionally) sends an ntfy alert, the
same pattern as the shop's `NOTIFY_URL`.

---

## 7. Secrets (rule d)

- **Desktop**: the Electron main process stores the Alpaca key pair and the Frost AI API key with
  `safeStorage.encryptString` (DPAPI on Windows) in `userData/secrets.bin`. When it starts the server
  child it passes them through an inherited pipe (fd 3), **not** argv or env. The renderer never
  receives them back; it only learns `{ alpacaPaper: true, alpacaLive: false, llm: true }`.
- **Docker / headless server**: `server/secrets.mjs` reads a file in `DATA_DIR/secrets/` (mode 0600,
  folder 0700, the same as the shop's store) or a Docker secret at `/run/secrets/*`. The current
  `.env` route keeps working for paper only, with a startup warning, and is removed at stage 3. Live
  keys are refused from `.env`.
- Entry: Settings → Brokers has a write-only field. Saving checks the key against `/v2/account`, stores
  it, and clears the field. There is no "show key" button.
- **Never in prompts**: the prompt builder takes a typed object with no account or key fields. A test
  builds a prompt with the secrets loaded and asserts that no secret substring appears.
- **Never in logs or tool output**: `redact.mjs` wraps `console.*` and the audit writer. It replaces
  every loaded secret value, and patterns like `APCA-API-*`, `PK…`/`AK…` key IDs, `sk_(live|test)_…`
  and `Bearer …`, with `[redacted]`. Alpaca error bodies are reduced to `status + message`, and
  headers are never logged.
- **Never in the repo**: `.gitignore` gains `/data`, `secrets*`, `.env.*`. A pre-commit check (and a
  CI step later) greps for key patterns.
- The account number shown in the UI is masked to its last 4 characters.

---

## 8. Modes: paper first, live separate (rule a)

`mode.mjs` keeps `{ mode, paperSince, paperDaysCompleted, live: { [accountId]: { armedAt, armedBy, limits } } }`.

- Default mode is `shadow` (stage 0), then `paper`. **There is no setting that skips paper.**
- **Paper period**: live can be armed only after `paperDaysCompleted ≥ minPaperDays` (recommend 30
  trading days, Q3) *and* the stage-2 exit criteria are met. The counter resets if the strategy, the
  prompt template or the model file changes (each one's hash is stored), because the paper record no
  longer describes what would run.
- **Two switches**: `paperEnabled` and `liveEnabled` are separate settings with separate endpoints.
  Turning paper off does not touch live, and the reverse.
- **Per-account arming**: live keys are a different secret entry per Alpaca live account. Arming one
  needs the owner to type `TRADE LIVE <last 4 of account>`, a TOTP code, and the chosen live limits
  (at or below the stage-3 caps). Arming lasts until disarmed, but **any kill or halt disarms live**;
  re-arming repeats the ceremony.
- `broker/alpaca-live.mjs` is the only file that contains `https://api.alpaca.markets`. The engine
  constructs it only through `mode.liveBroker(accountId)`, which re-checks arming each time. A test
  asserts that no other file contains the live URL.
- The UI shows a permanent coloured banner: PAPER (blue) or LIVE (red) and the account's last 4.

---

## 9. Audit log and daily summary (rule e)

**Format**: `DATA_DIR/audit/YYYY-MM-DD.jsonl` (New York trading date), append-only, one JSON object
per line, `fsync` after each `order`/`fill`/`kill`. Every line carries `seq`, `at` (ISO UTC), `type`,
`mode`, `prev` (sha256 of the previous line), so editing or deleting a line breaks the chain, and
`report.mjs --verify` finds it. Files are kept for 7 years (tax records), and are never pruned
automatically.

```jsonl
{"seq":1041,"at":"2026-11-03T15:05:02.114Z","type":"cycle","mode":"paper","cycle":"c-20261103-1505","symbols":["AAPL","NVDA"],"barT":"2026-11-03T15:00:00Z","model":"Qwen3.8-27B-Q4_K_M","modelHash":"…","promptHash":"…","prev":"…"}
{"seq":1042,"at":"…","type":"proposal","cycle":"c-20261103-1505","raw":"{\"proposals\":[…]}","parsed":{"symbol":"NVDA","side":"buy","size":12,"reason":"…","confidence":0.71,"stop":131.2},"valid":true,"latencyMs":4120,"prev":"…"}
{"seq":1043,"at":"…","type":"gate","proposalSeq":1042,"ok":true,"qtyProposed":12,"qtyApproved":9,"checks":["MODE","KILLED","DAILY_LOSS","NOT_ALLOWED","HOURS","STALE","CLASS","SIDE","CONF","SIZE","DAY_SIZE","DUP","RATE"],"limitsHash":"…","prev":"…"}
{"seq":1044,"at":"…","type":"order","gateSeq":1043,"broker":"alpaca-paper","clientOrderId":"ft-…","symbol":"NVDA","side":"buy","qty":9,"orderType":"market","tif":"day","prev":"…"}
{"seq":1045,"at":"…","type":"fill","orderSeq":1044,"qty":9,"price":134.07,"status":"filled","prev":"…"}
{"seq":1046,"at":"…","type":"gate","proposalSeq":1040,"ok":false,"code":"DUP","reason":"Same symbol and side within 15 min","prev":"…"}
{"seq":1047,"at":"…","type":"halt","reason":"LLM malformed 3 in a row","cancelled":0,"prev":"…"}
```

Other types: `exit` (deterministic stop, target or time sells, with `why`), `cancel`, `kill`, `resume`,
`settings` (old → new, who, TOTP yes/no), `watchlist`, `mode`, `arm`, `disarm`, `error`. The model's
`reason` is kept verbatim in `proposal.parsed.reason`. It is shown as the model's words, never as
fact.

**Daily summary** (`report.mjs`, run at 16:15 NY): `DATA_DIR/reports/YYYY-MM-DD.json` + `.md`, shown
in the app and optionally sent by ntfy. It contains:

- cycles, proposals, valid %, malformed and contradictory counts, and gate rejects by code;
- orders, fills, average slippage versus the bar close;
- paper P&L for the day and cumulatively, worst drawdown, days halted;
- for comparison over the same days: **the existing rule-only strategy** (run in shadow) and
  **buy-and-hold of an equal-weight watchlist**. This answers "does the LLM add anything?";
- the audit chain verified: yes/no.

**Fixed honesty text**, shown on the backtest, paper and summary screens and not editable:

> These are simulated or paper results, not real trading. Backtests overstate live results: fills are
> assumed at bar prices, slippage, fees, queue position and partial fills are approximated or
> ignored, and the rules were chosen after seeing the data. Paper fills are kinder than real ones.
> Past results do not predict future results. This app makes no promise of profit.

**The LLM is not backtested.** Qwen's training data covers past market history, so replaying 2024
bars through the model would leak hindsight and flatter it. The LLM is measured only forward, in
shadow and paper. Backtests stay for the deterministic strategy and for the gate.

---

## 10. Module and file plan (Frost Trader)

```
server/engine/
  risk.mjs            EXTEND  new limits, checkProposal(), flags, isTighter directions
  risk.test.mjs       EXTEND  one pass + one fail per check, property test
  engine.mjs          EXTEND  mode from store, LLM cycle, kill file watch, scan display-only
  strategy.mjs        EXTEND  Trader.fromProposal(); exits unchanged
  mode.mjs            NEW     modes, paper clock, arming, liveBroker()
  halt.mjs            NEW     automatic halt counters and triggers
  watchlist.mjs       NEW     parse paste/CSV, validate via /v2/assets, effective-date rule
  ratelimit.mjs       NEW     token buckets for orders and LLM calls
  calendar.mjs        NEW     NYSE holidays/half days (static table, yearly update)
  audit.mjs           NEW     hash-chained JSONL writer + verify
  report.mjs          NEW     daily summary, comparison baselines, honesty text
  llm/client.mjs      NEW     OpenAI-compatible call, timeout, abort, no tools
  llm/prompt.mjs      NEW     allow-listed context -> messages
  llm/schema.mjs      NEW     validator + contradiction checks
  llm/*.test.mjs      NEW     hostile-output, injection, redaction tests (fake server)
  broker/alpaca.mjs   EXTEND  client_order_id, cancelAll() separate from flatten(), keys from secrets
  broker/alpaca-live.mjs NEW  live URL only here; constructed only by mode.liveBroker()
  data/csv.mjs, data/synthetic.mjs   COMMIT (currently git-ignored by mistake)
server/secrets.mjs    NEW     0600 secret files / Docker secrets; .env paper fallback
server/redact.mjs     NEW     log + audit redaction
desktop/              NEW     Electron shell: safeStorage, tray kill item, starts server
client/src/pages/     NEW     Dashboard, Proposals (raw + gate verdict), Audit, Report, Settings
.gitignore            FIX     `data` -> `/data`; add secrets*, .env.*
```

---

## 11. Staged plan: trading

Each stage needs the owner's go-ahead (relayed through Task Allocation) to start. The exit criteria
are measured by `report.mjs`, not judged by eye.

**Stage 0: read-only.** Watchlist, Alpaca data and LLM proposals are logged. The gate runs in
`shadow` (it records what it *would* decide). No broker order endpoint is called: the
`AlpacaBroker.submit` path is not constructed, and a test asserts that no POST to `/v2/orders` happens.
Exit criteria:

- 10 trading days with ≥ 95 % of cycles completed and audit chain valid every day;
- malformed output < 2 % of calls, 0 hostile-output test failures, 0 secret leaks (redaction test
  plus a grep of all audit files for loaded secret values);
- kill button and kill file each tested 3× in market hours, stopping within one tick;
- every automatic-halt trigger fired at least once by a fault-injection test;
- the owner has read one week of proposals and gate verdicts.

**Stage 1: paper trading.** Mode `paper` with the Alpaca paper account. The current gate checks plus
allow-list, hours, stale, duplicate and rate checks are on. Default limits. Exit criteria:

- 10 trading days with no order outside a limit (checked by replaying the audit log through the gate
  offline), no duplicate orders, every fill reconciled with Alpaca;
- 0 unexplained position or cash mismatches;
- kill tested with open orders present: all cancelled and verified.

**Stage 2: paper with the full gate and daily report.** All 16 checks, the automatic halts, and the
daily report with baselines. The paper clock (`minPaperDays`) counts from here. Exit criteria:

- `minPaperDays` (recommend 30 trading days) with an unchanged strategy, prompt and model hash;
- daily report produced and chain-verified every day;
- the owner has seen the LLM-vs-rule-only-vs-buy-and-hold comparison. Live does **not** require a
  profit: it requires that the system behaved. Whether the comparison justifies going live is his
  call, and the app states it neutrally;
- 0 gate bypasses; every automatic halt investigated and noted.

**Stage 3: live, tiny limits, only on his say-so.** The owner arms one live account (§8). Live caps,
far below paper's: `maxPositionValue $100`, `maxDailyNotional $300`, `maxDailyLoss $25`,
`maxOpenPositions 1`, `maxTradesPerDay 3`, `maxOrdersPerHour 3`. Paper keeps running alongside on
the same proposals for comparison. Exit criteria to raise any live limit:

- 20 live trading days with no gate bypass and no unreconciled fill;
- live vs. paper slippage measured and shown;
- each raise is a separate owner action (TOTP), takes effect the next trading day, is at most 2× per
  step, and stays inside `HARD_LIMITS`.

---

## 12. The shop: LLM-assisted pricing and listings (rule g)

A separate module **in the shop repo** (`FrostTechnology`). It shares no process with the trader;
the small LLM client and audit writer are copied there, with the same tests.

### 12.1 What the LLM may propose

```json
{
  "$id": "frost-shop/change-batch/v1",
  "type": "object", "additionalProperties": false, "required": ["changes"],
  "properties": { "changes": { "type": "array", "maxItems": 50, "items": {
    "type": "object", "additionalProperties": false,
    "required": ["productId", "kind", "reason", "confidence"],
    "properties": {
      "productId":  { "type": "string", "maxLength": 120 },
      "kind":       { "enum": ["price", "hide", "unhide", "feature", "unfeature", "title", "description", "category"] },
      "priceEx":    { "type": "number", "exclusiveMinimum": 0 },
      "text":       { "type": "string", "maxLength": 4000 },
      "group":      { "type": "string", "maxLength": 60 },
      "reason":     { "type": "string", "minLength": 10, "maxLength": 400 },
      "confidence": { "type": "number", "minimum": 0, "maximum": 1 }
    } } } }
}
```

Its inputs are the product (cost ex GST, RRP, stock per source, the current price and the last 30
days of cost changes), the other distributor's offer for the same part, and competitor reference
prices **that staff typed in** (Scorptec and others). It never fetches web pages.

### 12.2 The shop gate (`server/automation/gate.mjs`)

Every proposed change runs these checks, all deterministic. The thresholds live in admin Settings and
the LLM can't change them:

1. **Never below cost**: `priceEx > cost` (cost = the current import's cost ex GST).
2. **Minimum margin**: `(priceEx − cost) / priceEx ≥ minMarginPct` (default 12 %), *and*
   `priceEx − cost ≥ minMarginAbs` (default $5).
3. **Max change per run**: |new − current| / current ≤ `maxChangePct` (default 10 %) per product, at
   most `maxChangesPerRun` (default 25) products, and no product changed twice in 24 h.
4. **Ceiling**: `priceEx × (GST?1.1:1) ≤ rrp` when the supplier gives an RRP (optional, on by default).
5. **GST**: the gate works ex GST, and the shop shows `inc = round2(ex × 1.1)` only when
   `gstRegistered`. When not registered, no price or text may say "inc GST", and the gate scans text
   changes for "GST" claims. Prices are rounded to 2 decimals (optionally to .95 endings, but never
   below the margin floor).
6. **Fresh data**: the source's last import is < 36 h old, and the product's stock is known. A stale
   feed means no price changes for that source.
7. **Listing rules**: text is stripped of HTML and URLs and kept within the length limits. It must not
   mention competitors, warranties or claims missing from the supplier's description, or "best
   price". `feature` needs stock > 0. `category` must be an existing shop group.
8. **Known product**: `productId` exists and is not a manual product (manual items are staff-only).
9. **Rate limit**: one LLM run per feed import, at most 4 per day.

### 12.3 Applying and reverting

- A new `catalog.priceOverrides[id] = { ex, setAt, by, changeId }`. `sellPrice()` uses it only if it
  still passes checks 1–2 against the *current* cost. After each feed import every override is
  re-gated. If a cost rise breaks one, it is dropped (the price falls back to the markup) and logged.
  So a supplier price rise can never leave a part selling under cost.
- Changes are grouped in a **changeset** (`DATA_DIR/changes/<id>.json`) with each item's previous
  value. **Revert** restores a whole changeset or one item, and is itself logged.
- Audit: `DATA_DIR/audit/shop-YYYY-MM-DD.jsonl` with the same hash-chained format (types `run`,
  `proposal`, `gate`, `approve`, `apply`, `revert`, `drop`). Each night a summary goes in the admin
  dashboard: changes proposed, approved, rejected by rule, margin before and after.
- **Approval**: a new **Pending changes** tab in `Admin.tsx` lists gate-passed proposals with the old
  and new values, margin and the model's reason. Staff tick and press **Apply** while signed in (the
  existing approval path). Nothing is published until then. Gate rejects are shown greyed with the
  rule that failed.
- **Opt-in auto-apply** (later, a per-kind switch, TOTP to enable): only `hide`, `unhide` (stock) and
  `price` within ±5 % are applied without a click, still gated and still revertible. Text changes
  always need a click.
- **Kill switch**: an admin toggle plus `DATA_DIR/SHOP_AUTOMATION_OFF`. It stops runs, and pending
  items stay pending.

### 12.4 Files (FrostTechnology repo)

```
server/automation/llm.mjs        NEW  (copy of the trader client, same tests)
server/automation/schema.mjs     NEW  change-batch validator
server/automation/gate.mjs       NEW  checks 1–9
server/automation/changes.mjs    NEW  changesets, apply, revert, override re-gating
server/automation/audit.mjs      NEW  hash-chained JSONL
server/automation/run.mjs        NEW  after-import hook -> LLM -> gate -> pending
server/catalog.mjs               EXTEND sellPrice() honours a valid override
server/server.mjs                EXTEND /api/admin/automation/* (pending, apply, revert, settings, off)
                                 EXTEND feed sources beyond dicker|leader (Ingram later) as a list
client/src/admin/Admin.tsx       EXTEND Pending changes tab, Automation settings
server/test/automation-*.test.mjs NEW one pass + one fail per gate rule; cost-rise re-gate test
```

### 12.5 Staged plan: shop

- **Stage 0: read-only.** After each import the LLM proposes, the gate verdicts are logged, and
  nothing goes into Pending. *Exit:* 14 days of runs, malformed < 2 %, every gate rule has fired a
  reject at least once in tests, and the owner has reviewed a week of proposals.
- **Stage 1: Pending queue, manual apply** (the existing approval path). *Exit:* 30 days, every
  applied change revertible (test-revert one per week), 0 prices below the margin floor after any
  import (nightly check), and the owner is happy with the approve-rate.
- **Stage 2: auto-apply for stock hide/unhide only.** *Exit:* 30 days with 0 wrong hides (an
  in-stock item hidden) that weren't caught and reverted the same day.
- **Stage 3: auto-apply for small price moves (±5 %), only on his say-so.** Text changes stay manual
  forever unless he asks otherwise. *Exit to widen:* 60 days with no customer-visible pricing error.

The shop is not deployed yet (the handoff says built, not deployed). The automation runs wherever
the shop runs, and needs the LLM at the PC: either the shop runs on the PC, or the Pi reaches the
Frost AI Console over Tailscale with its own API key. Deploys and Pi changes need the owner's OK.

---

## 13. Historical data for backtests (the Hugging Face index dataset)

The dataset loader, its git-ignored folder (`data/datasets/`), and the screens and data flow that
use it belong to the stage-0 "Stock numbers" work (branch `stock-numbers`, `docs/APP-DESIGN.md`).
This note doesn't duplicate them. It says only how backtests and gate tests should treat that data.

`pettah/global-top-Index-exploring-trends-in-stock-Market` (`Stock_Market_Indexes.csv`), from the
dataset page: about 50.1k daily rows for 32 **indices**, with columns
`Date, Name, Symbol, Open, High, Low, Close, Adj Close, Volume`. Dates are DD-MM-YYYY, volume is text
with `-` gaps, the data ends in April 2024, and the card says it was scraped from Yahoo Finance.

How backtests should use it:

- **Not as input to the intraday strategy.** `Trader` trades 5-minute bars. A daily bar stamped at
  midnight falls outside `marketOpen()` and the entry windows. Load the data through the
  `stock-numbers` loader for display and daily-level studies only, never through
  `server/engine/data/csv.mjs`. In Node, `Date.parse('02-04-2024')` gives 4 February and
  `'25-04-2024'` gives `NaN`, so the generic CSV loader would silently mangle it.
- **Not for the gate's fault tests.** Daily-loss halts, stale-data gaps, price jumps and missing bars
  are tested with seeded `synthetic.mjs` data, where each test injects exactly the fault it checks.
  The index file can at most be a second, *daily-granularity* replay of the daily-loss halt. One fact
  from it is worth a unit test: index symbols like `^GSPC` must be rejected by the allow-list and
  `STOCK`.
- **Never as evidence about the LLM.** The model is measured only forward (shadow and paper). See §9.
- **Labelled as third-party scraped data.** Its MIT tag is the uploader's, and the numbers came from
  Yahoo, so it stays local, uncommitted, and is shown with its source and end date.

Real per-ticker history for backtests: **Alpaca market data**. It is the same source paper and live
trade on, and it is already coded in `AlpacaBroker.bars`. A `scripts/fetch-bars.mjs` would write
`DATA_DIR/bars/<SYMBOL>.csv` in the existing `t,o,h,l,c,v` format for the watchlist, git-ignored. On
the free plan that is the IEX feed, or SIP for data older than 15 minutes, back to 2016. IEX volume is
a slice of total volume, and the report names the feed. If a second source is wanted, Tiingo or the
Polygon free tier (personal-use terms, own key in the secret store) could be used. Yahoo or Finviz
scraping is not.

---

## 14. Questions for the owner (max 4)

1. **"ticker"**: is it the `ticker` terminal app (achannarasappa, v5.3.0, installed via WinGet)? If
   so, should Frost Trader write its watchlist into `~/.ticker.yaml` so both show the same list?
   (Recommend: yes, optional.)
2. **Watchlist source**: paste tickers, Finviz Elite CSV export, or an Alpaca watchlist?
   (Recommend: paste now; Elite CSV only if he already pays for Elite.)
3. **Paper period** before live can even be armed: 30 trading days? (Recommend 30; it resets if the
   model, prompt or strategy changes.)
4. **Kill switch and positions**: should the kill also close all positions (today's behaviour), or only
   cancel orders and stop? (Recommend: close all in paper; in live, two buttons, "Kill" and "Kill and
   close all".)
