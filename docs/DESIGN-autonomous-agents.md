# Design: autonomous trading agents for Frost Trader

Status: design, 23 Oct 2026, plus a small tested skeleton (sandbox ledger and knowledge store, see
§10). No order has been placed and no broker code was changed. Branch `autonomous-agents`, from local
`master` d6a3160. The repo has no remote.

This note builds on `docs/DESIGN-llm-automation.md` (branch `llm-automation-design`, commit 625d048),
called **the LLM note** below. The gate (`checkProposal`, 16 checks), the kill switch, automatic halts,
secrets, the hash-chained audit log and the shop gate are specified there and are not repeated. This
note changes one thing about them and adds the rest.

**What changes.** The owner's direction is that the system trades **without any per-trade input from
him**. So the LLM note's human approval steps become **configuration he sets once**:

| In the LLM note | Here |
|---|---|
| Owner arms each live account, and any halt disarms live; re-arming repeats the ceremony | **One-time live enablement** with his limits (§1.6). After that no further input is needed. Only *his* kill, or an integrity halt (§1.7), needs him again. |
| Paper clock resets when the strategy, prompt or model changes | Each **agent version** earns its own paper record and is promoted **by rule**, inside his limits (§3.5). A new version doesn't need him. |
| Owner approves stage moves | Stage moves *of the build* still need his OK (that is software, not trading). Agent promotions within a running system don't. |

**What stays, as code, not as approvals:** the deterministic gate that no agent or model can edit, the
kill switch and automatic halts, secrets handling, the audit log, and his limits. §9 says where these
cost autonomy.

Nothing in this note, the app or its reports claims or predicts a profit. Autonomous trading can lose
money (§8).

---

## 0. Words used

- **Agent**: one trading strategy instance: a strategy family (rule-based or LLM-in-the-loop), a
  parameter set, an optional prompt template, and a model id. It has an id like `momo-01`.
- **Agent version**: `sha256(strategy code hash, params, prompt template, model file hash)`. Any change
  gives a new version with an empty record.
- **Host**: the Frost Trader server process. It owns the gate, the broker connections, the keys, the
  audit log and the capital allocations. Agents never own any of those.
- **Tier**: where a version currently trades: `research` (backtests only), `paper`, `live-tiny`,
  `live`. See §3.5.
- **Finding**: a claim one agent publishes to the shared knowledge store, with evidence (§4).

---

## 1. Agent sandboxes

### 1.1 Layout

```
DATA_DIR/
  owner/                    written ONLY by authenticated owner endpoints (password + TOTP)
    live-enablement.json    his one-time live switch and limits (§1.6)
    allocations.json        capital per agent (host-managed inside his limits)
  agents/<agentId>/         one folder per agent; the agent process may write only here
    agent.json              strategy family, params, prompt hash, version, tier, createdAt
    ledger.json             cash, positions, realised P&L, fills (its own book)
    state.json              plans (stop/target), counters, last bar seen
    journal.jsonl           lessons the LLM wrote for this agent, append-only
    runs/<runId>.json       backtest and walk-forward results
  knowledge/                shared, append-only, read by all agents, written via the host (§2, §4)
  bars/                     market data, read-only to agents (§2.1)
  audit/                    hash-chained audit log, written only by the host
  KILL                      the kill file (LLM note §6.1)
```

`agentId` must match `^[a-z0-9][a-z0-9-]{0,31}$`. The host resolves every agent path with
`path.resolve` and refuses anything not strictly inside `DATA_DIR/agents/<agentId>/` (no `..`, no
absolute ids, no symlinks followed out). This is implemented and tested (§10).

### 1.2 Money: one ledger per agent

- **Sim broker**: each agent gets **its own `SimBroker` instance** (`broker/sim.mjs`, unchanged) with
  `cash = allocation`. It can't see another instance. An over-spend throws inside its own book.
- **Alpaca paper**: Alpaca lets a login hold more than one paper account (the exact number is not
  confirmed here). Where there are enough, one paper account per paper-tier agent is cleanest. Where
  there aren't, agents share one paper account through **virtual sub-ledgers** (below), exactly as in
  live.
- **Live**: an individual Alpaca account has no sub-accounts (Alpaca's Broker API is for businesses).
  So live capital per agent is a **virtual sub-ledger kept by the host** and enforced by the gate:
  - every order carries `client_order_id = ft-<agentId>-<idempotency hash>`, so each fill is
    attributed to exactly one agent;
  - **symbol lock**: in a shared real account, a symbol can be held by at most one agent at a time.
    Without it, two agents' positions in one symbol net out at the broker and attribution breaks, and
    one agent's sell could close the other's shares;
  - the gate's new check 17 (`AGENT_CAPITAL`): a buy's value ≤ that agent's free sub-ledger cash, and
    the agent's open exposure ≤ its allocation. The account-level checks 11–13 still run on top;
  - the host reconciles the sub-ledgers against the broker after every fill and at every tick:
    `sum(agent cash) + unallocated cash = broker cash` and `sum(agent positions) = broker positions`.
    A mismatch is an **integrity halt** (§1.7).

So a bug in one agent can at worst lose that agent's own allocation, and the daily-loss and drawdown
halts stop it well before that.

### 1.3 Processes

- Each agent runs as a **separate Node child process**, started by the host with Node's permission
  model (Node 24 is installed):
  `node --permission --allow-fs-read=<DATA_DIR/agents/id>,<DATA_DIR/bars>,<DATA_DIR/knowledge>,<code dir> --allow-fs-write=<DATA_DIR/agents/id> agent-runner.mjs`
  with no `--allow-child-process`, no `--allow-worker`, no `--allow-addons`. The agent's own folder is
  the only one it can write.
- Node 24's permission model does **not** restrict network access (not confirmed whether a newer Node
  adds it). The agent needs no network: bars, LLM calls and orders go through the host over the IPC
  channel. A per-program Windows Firewall rule would close this fully, but it changes his Windows
  settings, so it is optional and needs his OK.
- The child's environment is built from an allow-list (`NODE_ENV`, `TZ`, `AGENT_ID`). **No key, token
  or account id is in it.** A test starts a child with secrets loaded in the host and asserts that its
  `process.env` and argv hold none.
- IPC messages from an agent are a small closed set, each validated like the LLM note's proposal
  schema: `proposal`, `lesson`, `publishFinding`, `validationResult`, `log`. Unknown types or fields are
  rejected and counted as malformed (3 in a row halts that agent). The host never `eval`s or imports
  anything an agent sends.
- Resource limits: `--max-old-space-size=512`, a CPU watchdog (a tick that takes > 30 s kills and
  restarts the child; 3 restarts in an hour halts the agent).
- If an agent crashes, its positions stay managed: deterministic stop, target, time and session-close
  exits for every agent's positions run **in the host** (`Trader.onBar` logic), not in the agent.

### 1.4 Keys

The host holds the Alpaca keys and the Frost AI API key (LLM note §7: DPAPI `safeStorage` on the
desktop, 0600 files or Docker secrets headless). Agents get none. LLM calls are proxied by the host,
which adds the key, applies the rate limit per agent and logs the prompt hash. Optionally each agent
gets its own Frost AI Console API key (the Console gateway supports several keys with rate limits), so
usage shows per agent in Frost AI; the host still holds them.

### 1.5 Database views

Agents read three shared stores (§2) read-only, through the host's query functions or the read-only
fs permission. Agents can't read each other's folders: the fs read allow-list names only their own
folder. They see other agents' work only through the knowledge store (§4).

### 1.6 The one-time live enablement

A Settings screen, owner only, needing password, TOTP and the typed phrase
`TRADE LIVE <last 4 of account>`. It writes `owner/live-enablement.json`:

```json
{
  "enabledAt": "…", "account": "…1234",
  "totalLiveCapital": 1000,        "perAgentMax": 250,
  "perOrderMax": 100,              "perDayNotional": 500,
  "maxDailyLoss": 50,              "maxAgentDrawdownPct": 15,
  "maxLiveAgents": 2,              "liveTinyAllocation": 100,
  "scaleStepMax": 2,               "scaleEveryDays": 20
}
```

(The numbers are placeholders for Q2. All are clamped to compile-time `HARD_LIMITS` in `risk.mjs`.)

After that, promotions, demotions, allocation changes within these caps, and trading itself need no
input from him. He can lower any number at once; raising one takes effect the next trading day (the
existing tighter-now, looser-tomorrow rule in `engine.setLimits`). Only the owner endpoints write
`owner/`; no agent process has write permission there and no connector tool reaches it (§5).

### 1.7 Halts in an autonomous system

The LLM note made every halt disarm live. With no human in the loop that would stop trading at the
first network blip. Split them:

| Class | Examples | What happens |
|---|---|---|
| **Owner kill** | button, `KILL` file, Frost AI `frosttrader_kill` | Everything stops. Only the owner resumes (TOTP), as today. |
| **Integrity halt** (global) | sub-ledger/broker mismatch, broker 401/403, audit chain broken, gate threw an exception, clock skew > 30 s, total live daily loss ≥ `maxDailyLoss` | All live trading stops; open orders cancelled; positions left to the deterministic exits (Q4 of the LLM note). Needs the owner. |
| **Agent halt** | that agent's daily loss, 3 malformed LLM outputs in a row, 3 contradictions in a day, crash loop, drawdown ≥ `maxAgentDrawdownPct` | Only that agent stops. Daily-loss halts clear next trading day; drawdown demotes it (§3.5); the rest clear after a cool-down and a clean health check. |
| **Transient pause** (global) | stale data for 3 cycles, LLM down, Alpaca 5xx burst | New entries pause; exits continue. Clears automatically after the condition is gone for 2 clean cycles, with backoff. Logged. |

Whether transient pauses should auto-clear in live is Q3.

---

## 2. Market knowledge databases

Storage matches the repo: **CSV for bars** (the existing `t,o,h,l,c,v` loader in `data/csv.mjs`),
**JSONL for append-only records**, **JSON for small state**, all written atomically or appended, no new
dependency. Node 24 ships `node:sqlite`; it can later hold a **derived, rebuildable index** over the
JSONL (fast queries by signal and date) but is never the source of truth. Nothing here is committed to
git (`DATA_DIR` is ignored; the LLM note's `/data` fix applies).

### 2.1 Price history

```
DATA_DIR/bars/<feed>/<timeframe>/<SYMBOL>.csv     t,o,h,l,c,v   (t = epoch ms, bar start)
DATA_DIR/bars/<feed>/<timeframe>/manifest.json
```

```json
{ "feed": "alpaca-iex", "timeframe": "5Min", "licence": "Alpaca market data, owner's account terms",
  "fetchedAt": "…", "symbols": { "AAPL": { "from": "2020-01-02", "to": "2026-10-22", "rows": 101234, "sha256": "…" } } }
```

- **Real per-ticker history: Alpaca bars** (`AlpacaBroker.bars`, already coded), fetched by a
  `scripts/fetch-bars.mjs` with the owner's key. Free plan: IEX real time, SIP older than 15 minutes,
  back to 2016. The feed name travels with every result, because IEX volume is a slice of the
  market. Daily (`1Day`) and 5-minute bars both.
- **The April 2024 index dataset** (`pettah/global-top-Index-exploring-trends-in-stock-Market`, the
  `stock-numbers` branch owns its loader): 32 indices, daily, ends April 2024, scraped from Yahoo. It
  is a **local fixture**, not committed, used for (a) daily-level **market-regime** features (for
  example "S&P 500 above its 200-day average") in research only, (b) a daily replay test of the
  daily-loss halt, (c) a test that index symbols like `^GSPC` are refused by the gate. It is never
  traded, never the evidence for promoting an agent, and tests that need it skip when it is absent.
  Its dates are DD-MM-YYYY, so it never goes through the generic CSV loader (LLM note §13).
- Not used: Finviz or Yahoo scraping.

### 2.2 Pattern and flag definitions

The existing `server/engine/signals/*` **is** the definition store. `SIGNALS` plus `describe()` gives
id, name, kind, tell, needs and horizon. Add a `version` per signal = sha256 of its module source,
computed at startup, so every outcome row says which code produced it. New signals are code, written
and reviewed like any other code (§3.2 explains why agents can't add them).

### 2.3 Labelled outcomes

```
DATA_DIR/knowledge/outcomes/<signalId>.jsonl
DATA_DIR/knowledge/splits.json
```

One row per signal call (`|score| ≥ 0.5`):

```json
{ "signalId": "stop_run", "signalVersion": "9f2c…", "symbol": "AMD", "feed": "alpaca-iex",
  "timeframe": "5Min", "t": 1761226500000, "score": 0.72, "price": 151.2,
  "fwd": { "1": 0.0012, "3": -0.0031, "6": 0.0042, "12": 0.0051 },
  "mfe": 0.0068, "mae": -0.0035, "atr": 0.84, "regime": "spx_above_200d",
  "split": "train", "labelledAt": "…" }
```

- `fwd[h]` = close `h` bars later / close at the call − 1. `mfe`/`mae` = best and worst move inside the
  signal's horizon. The labeller only runs on bars whose horizon has closed, so a label never needs a
  future bar that wasn't there when the call was made; the call itself is computed from
  `bars[0..i]` only, as `evaluateAll` already does.
- **Splits** are fixed by date in `splits.json`, written once and never moved:

  ```json
  { "train": ["2016-01-01", "2023-12-31"], "validate": ["2024-01-01", "2025-06-30"],
    "holdout": ["2025-07-01", "2026-06-30"], "forward": "2026-07-01..", "createdAt": "…" }
  ```

  `train` is for search, `validate` for walk-forward checks, `holdout` is opened **once per hypothesis
  family** and every opening is counted (§3.4), and `forward` is what paper trading produces. The
  model's training cutoff matters too: see §3.3.
- Per-signal summaries (the existing `backtestSignal` numbers: hit rate, base rate, edge) are computed
  per split and stored in `knowledge/signal-stats.json`, so an in-sample edge is never shown without
  its out-of-sample one next to it.

---

## 3. Self-improvement, stated realistically

### 3.1 What "training itself" means here

It means **choosing better parameters and better combinations of existing signals, and keeping notes,
by a fixed experimental procedure**. It does **not** mean changing the model's weights.
**Fine-tuning Qwen3.8-27B is out of scope**: it would need a labelled dataset of good decisions (which
we don't have), much more GPU time than a single desktop card gives at 27B, and it would make the model
better at sounding right about the past rather than at the future. The model stays a fixed file; its
hash is part of every agent version.

### 3.2 The loop (runs after the close, never in the trading hot path)

```
hypothesis ─► encode as params/DSL ─► backtest on train ─► walk-forward on validate
     ▲                                                          │ passes rules?
     │                                                          ▼
 lessons (journal) ◄─ compare to baseline ◄─ paper (forward) ◄─ new agent version (tier: paper)
```

1. **Hypothesis**. The local LLM (Qwen3.8-27B through Frost AI: Console gateway
   `127.0.0.1:8765/v1/chat/completions` with a Frost AI API key, or llama-server on `127.0.0.1:8080`;
   both OpenAI-compatible) reads an allow-listed summary: per-signal stats by split and regime, the
   agent's recent round trips, its journal, and validated findings from other agents. It returns
   JSON only (schema-checked like the LLM note §4.2), for example:

   ```json
   { "hypothesis": "stop_run entries work better when spx_above_200d",
     "change": { "filters": { "regime": "spx_above_200d" }, "params": { "entryScore": 0.7 } },
     "searchSpace": { "stopAtr": [1.5, 3], "targetAtr": [2, 4] },
     "reason": "…" }
   ```

   The DSL can only reference **existing signals, existing regime features and the parameters defined
   in code** (`STRATEGY` keys, signal thresholds), each with code-defined bounds. It can't name a
   ticker or a date, which keeps the model's memory of specific past moves out (§3.3), and it can't
   express code. New signals or features are a code change by a Builder, reviewed and tested. That is
   a real limit on "revelations", and a deliberate one.
2. **Parameter search** is classical and deterministic: a grid or random search (seeded) over the
   `searchSpace`, inside bounds, capped at N trials per hypothesis (default 50). It runs the existing
   `runBacktest` (the real `Trader`, `RiskGuard` and `SimBroker`), so what is measured is what would
   run.
3. **Walk-forward**: rolling windows (for example 12 months fit, 3 months test, stepping 3 months)
   across `train ∪ validate`; the parameters are chosen on each fit window and scored only on the next
   test window. The reported result is the concatenation of test windows.
4. **Promotion rules** (§3.4) decide, not the model. A pass creates a **new agent version** in tier
   `paper`. The old version keeps running until the new one has its own record.
5. **Baseline comparison**, every day, over the same days: (a) the agent's parent version, (b) the
   rule-only strategy at default params, (c) equal-weight buy-and-hold of the agent's universe, (d) cash.
6. **Lessons**: after the close the LLM writes 1–5 short notes into the agent's `journal.jsonl`
   ("stop_run entries in the first hour lost 7 of 9 times this week"). They are input to the next
   hypothesis, are labelled as the model's words, and **never** change params, limits or tier on their
   own.

LLM-in-the-loop agents (the LLM note's per-cycle proposals) can't be backtested honestly, because the
model has seen market history. They start in `paper` and are judged only on forward results. Rule
agents tuned by the loop above can be backtested and are the recommended first live candidates.

### 3.3 Overfitting guards (all enforced in code)

- **No look-ahead**: signals see `bars[0..i]` only (existing contract, with a test that shuffling bars
  after `i` changes nothing); labels only for closed horizons; regime features use only data up to the
  bar; walk-forward fits never see their test window; fills at the *next* bar's open in research (a
  stricter fill than the current same-bar close, an option on `runBacktest`).
- **Out of sample**: promotion needs the walk-forward test windows **and** the holdout to pass.
- **Minimum trades**: ≥ 100 round trips in walk-forward test windows and ≥ 30 in holdout, or no
  promotion, whatever the return.
- **Costs and slippage**: every research run uses `slippageBps ≥ 5` (more for low-priced or thin
  stocks: `max(5, 10_000 × spread estimate)`), commission as Alpaca charges (currently $0 on US stocks,
  plus the SEC/FINRA fees on sells), and a stress run at 2× slippage that must still pass.
- **Multiple testing**: every trial is counted per hypothesis family and per agent in
  `knowledge/trials.jsonl`. The required edge rises with the trial count (a Bonferroni-style
  threshold on the walk-forward t-statistic, or the deflated Sharpe ratio). The holdout may be opened
  once per family; a second look is recorded and halves the family's remaining budget.
- **Model memory**: the DSL bars tickers and dates; the `forward` split (after the model's training
  data ends, which for a 2026 model means only data from the last months) is the only evidence that
  can't have leaked into the model, which is why paper and live-tiny are mandatory tiers.
- **Stability**: a result must hold with each parameter moved ±1 grid step (no knife-edge optimum) and
  in at least 2 of 3 regimes it was tested in.

### 3.4 Promotion rules (fixed in code; the bounds come from §1.6)

| From → to | Rule (all must hold) |
|---|---|
| research → paper | walk-forward: ≥ 100 trades, expectancy after costs > 0 with t-stat above the multiple-testing threshold, max drawdown ≤ 15 %, beats parent and rule-only baselines; holdout: ≥ 30 trades, expectancy > 0; 2× slippage stress still > 0; stability check |
| paper → live-tiny | live enablement exists; ≥ 20 trading days and ≥ 30 trades in paper on the *same version*; paper expectancy > 0 and within the walk-forward's 90 % band (if paper is much worse, the backtest was wrong); 0 gate bypasses, 0 integrity issues; fewer than `maxLiveAgents` already live; allocation = `liveTinyAllocation` |
| live-tiny → live, and each scale-up | ≥ `scaleEveryDays` trading days and ≥ 20 trades since the last change; live slippage measured and ≤ 2× the research assumption; live expectancy > 0; allocation × ≤ `scaleStepMax`, never above `perAgentMax`, and the sum never above `totalLiveCapital` |

### 3.5 Demotion (automatic)

- Drawdown from the agent's own peak ≥ `maxAgentDrawdownPct` of its allocation → back to `paper`,
  allocation returned to the pool.
- Live expectancy over its last 30 trades < 0 and below the walk-forward's 90 % band → halve the
  allocation; a second time → `paper`.
- 2 demotions in 60 trading days → `retired` (kept for the record, no longer runs).
- Any gate bypass attempt or integrity issue attributed to an agent → `retired` and an alert.

---

## 4. Information exchange between agents

### 4.1 The knowledge store

`DATA_DIR/knowledge/findings.jsonl`, append-only, hash-chained like the audit log (each line carries
`prev`). Written only by the host, on an agent's IPC `publishFinding` message. Implemented in
`server/engine/agents/knowledge.mjs` (§10).

```json
{ "type": "finding", "id": "f-3a9c…", "agentId": "momo-01", "agentVersion": "b71e…",
  "kind": "params", "claim": "stop_run with entryScore 0.7 when spx_above_200d",
  "params": { "entryScore": 0.7, "stopAtr": 2.5 },
  "evidence": { "dataset": "alpaca-iex/5Min", "split": "validate", "from": "2024-01-01", "to": "2025-06-30",
                "trades": 142, "expectancy": 1.8, "baselineExpectancy": 0.4, "costBps": 5, "trials": 37 },
  "provenance": { "parentFindings": ["f-11d0…"], "model": "Qwen3.8-27B", "promptHash": "…", "runId": "…" },
  "at": "…", "prev": "…" }
```

Other line types: `validation` (an agent's re-test of a finding on its own data, with the result and
pass/fail by the code rule) and `adoption` (an agent took the finding into a **candidate** version).

### 4.2 Rules

- **Adopt only after validating on your own sandbox data.** An agent may adopt a finding only if a
  `validation` line exists for *that agent* and *that finding* with `pass: true` by the code rule
  (enough trades, beats its own baseline after costs, on its own universe and splits). The finder's
  own evidence never counts for someone else. Tested (§10).
- **Adoption creates a candidate, never a live change.** The adopted params go into a new version of
  the adopting agent at tier `paper`, through the same promotion rules as anything else.
- **No agent can push parameters into another agent's config.** There is no IPC message that names
  another agent, and the host's `setCandidateParams(agentId, …)` takes the id from the authenticated
  IPC channel, not from the message body. An agent's write permission covers only its own folder.
- Validations count toward the adopting agent's multiple-testing budget, so "try every finding" is
  not free.
- Findings carry provenance chains (`parentFindings`), so a revelation that turns out wrong can be
  traced and every version that adopted it flagged.
- Negative results are findings too (`kind: "refuted"`), so agents stop re-testing the same idea.

---

## 5. Link to Frost AI

### 5.1 Frost Trader's API

- A small HTTP API on the host, bound to `127.0.0.1` by default, or to the PC's Tailscale address when
  he chooses (never `0.0.0.0`). It refuses requests whose source isn't loopback or in `100.64.0.0/10`.
- Auth: a **Frost AI integration token**, separate from his device tokens, created in Frost Trader's
  Settings, shown once, stored hashed (scrypt, like `auth.mjs` device tokens), revocable. Scopes:
  `read` and `control`. There is **no scope** that writes `owner/`, limits, allocations, tiers or
  live enablement; those routes exist only behind his device token plus TOTP and reject integration
  tokens outright.
- Routes: `GET /api/ext/status`, `/positions`, `/pnl`, `/agents`, `/findings`, `/halts`;
  `POST /api/ext/agents/:id/stop`, `/agents/:id/start`, `/kill`. Every call goes into the audit log
  with the token id.

### 5.2 The connector in Frost AI

In Frost AI's repo (`frostmind-main`), following the GitHub, Topaz Video and Gigapixel connectors:
`electron/lib/frosttrader.cjs` holds the connection (URL and token encrypted with `safeStorage` in
`<data folder>\frosttrader-token.bin`; the token is scrubbed from every tool result), and
`electron/tools/frosttrader.cjs` defines the tools in the same `{ name, group, description,
parameters, plan(), run() }` shape:

| Tool | `plan()` | Notes |
|---|---|---|
| `frosttrader_status` | `readOnly: true` | mode, running, halts, kill state, tiers |
| `frosttrader_positions` | `readOnly: true` | per agent, masked account |
| `frosttrader_pnl` | `readOnly: true` | per agent and total, with the fixed honesty text |
| `frosttrader_findings` | `readOnly: true` | findings, validations, refutations |
| `frosttrader_agent_stop` | `readOnly: false` (approval card) | stops one agent; positions go to the deterministic exits |
| `frosttrader_agent_start` | `readOnly: false` (approval card) | restarts a stopped agent **in its current tier only** |
| `frosttrader_kill` | `readOnly: false`, card but one click | the safe direction; works with `read` scope too |

There is **no** tool that resumes from a kill, changes a limit, an allocation or a tier, enables live,
or places an order. The connector cannot do these even if the model asks, because the API has no
route for them under an integration token.

### 5.3 Agent-to-agent talk

The trading agents are Frost Trader processes, not Frost AI chats, and their exchange of evidence is
the knowledge store (§4), because it is versioned, validated and auditable. Frost AI's chat-to-chat
channels fit the human-readable layer on top:

- A Frost AI "Trading desk" chat with the connector reads `frosttrader_findings` and the daily report,
  and can use `send_to_session` (`electron/lib/sessions.cjs`) or the coordinator/peers channel
  (`electron/lib/peers.cjs`) to brief other chats, for example the owner's main chat.
- Optional, off by default: a `frosttrader_submit_hypothesis` tool that lets a Frost AI chat drop a
  hypothesis into the knowledge store as an unvalidated finding (`provenance.source = "frostai:<chatId>"`).
  It goes through exactly the same validation and promotion. Strictly it is a write tool, so it stays
  off unless he wants it.
- The model is shared: one 27B model on one GPU. The host queues LLM calls (research after the close,
  in-loop calls rate-limited per agent), and Frost AI chats compete for the same model. Deterministic
  exits never wait on it.

---

## 6. eCommerce: the parts shop

Same pattern, in the shop repo (`C:\Users\User\Frost Technology\FrostTechnology`), sharing no process
with the trader. The LLM note §12 has the gate (never below cost, minimum margin, max change, RRP
ceiling, GST, fresh data, listing rules, known product, rate limit), changesets with revert, the
hash-chained `shop-*.jsonl` audit and the kill toggle. What autonomy changes:

- **Sandbox**: an automation agent works on a **shadow catalog** (`DATA_DIR/automation/shadow.json`, a
  copy of the Dicker and Leader import with the 1.3× markup applied). It proposes changes against the
  shadow; the gate checks them; a passing change set is applied to the real catalog **by rule**
  instead of by a click, inside the owner's one-time shop automation settings (per-kind switches,
  `maxChangePct`, `maxChangesPerRun`, `minMarginPct`, `minMarginAbs`).
- **Baseline**: the 1.3× markup stays the default price; an override must pass the gate against the
  current cost after every feed import or it is dropped back to the markup.
- **Order of autonomy**: stock hide/unhide first (deterministic, low risk), then small price moves
  (±5 %), then category fixes. Titles and descriptions stay manual unless he says otherwise.
- **Honest limit**: the shop isn't deployed and has no sales history, so there is nothing to "learn"
  from yet. Until there are orders, the agent can only apply rules (stock, margin, cost changes); it
  can't tell whether a price change sold more.

---

## 7. Staged build plan

Each **build** stage needs his go-ahead through Task Allocation. Inside a running stage, the system
needs no per-trade input. Exit criteria are measured by `report.mjs` and the tests, not by eye.

**Stage 0: read-only (now).** The `stock-numbers` view (other branch) and research tools. No broker
order endpoint is constructed. **It stays read-only until the gate, the kill switch and the sandbox
ledger are built and tested** (stage 1).

**Stage 1: safety core, offline.** Gate extension (LLM note §5 plus check 17 `AGENT_CAPITAL` and the
symbol lock), halts by class (§1.7), kill file, audit log, secrets module, sandbox ledger and
allocator, knowledge store. Exit: every gate check has a pass and a fail test; a property test shows
random proposals from random agents never produce an order outside the agent's or the account's
limits; a fault-injection test fires every halt; the sub-ledger reconciliation catches an injected
mismatch; an agent child process can't read another's folder or see a secret (test).

**Stage 2: research loop, offline.** Bars fetcher, labeller and splits, walk-forward, trial counting,
LLM hypothesis and lesson client, promotion rules. Exit: a look-ahead test (future bars shuffled →
identical results); a planted overfit (pure noise data) is **rejected** by the rules in ≥ 95 % of
seeded runs; promotion decisions replay identically from the logs.

**Stage 3: paper, forward, sim broker on live Alpaca data** (data key only, no order calls). Several
agents, each with its own ledger. Exit: 20 trading days, ≥ 95 % cycles completed, audit chain valid
daily, 0 cross-agent ledger errors, kill tested in market hours.

**Stage 4: Alpaca paper.** Same, on the paper account(s), with virtual sub-ledgers. Exit: 20 trading
days, every fill reconciled and attributed, 0 symbol-lock violations, idempotency tested (retry never
double-submits).

**Stage 5: his one-time live enablement.** The first real order is possible **only after** he
completes §1.6. From then on agents that meet the paper → live-tiny rule start at
`liveTinyAllocation` with no further input. Exit to scaling: 20 live days with 0 gate bypasses, 0
unreconciled fills, live slippage measured.

**Stage 6: scale by rule** inside his caps (§3.4). He can lower caps at any time.

---

## 8. Risks, stated honestly

- **Autonomous trading can lose money**, including all of the capital he allocates to it. The limits
  bound how fast; they don't make losses unlikely.
- **Backtests overstate results.** Fills, slippage, queue position and partial fills are approximated;
  choosing rules after seeing data flatters them, even with the guards in §3.3. Paper is kinder than
  live. Expect live results to be worse than paper, and paper worse than the backtest.
- **Most hypotheses will fail**, and a well-built loop will mostly say "no". That is the loop working.
  Simple intraday strategies on free IEX data compete with professional firms; a lasting edge may not
  exist at all.
- **The LLM can be confidently wrong.** Its hypotheses and lessons read well whether or not they are
  true, and it has seen market history, so its "insights" about the past may be memory. Only the
  code rules and forward results decide.
- **Self-improvement can drift**: many small promoted changes can add up to an overfit system. The
  trial counting, the holdout budget and the demotion rules are there for this; they reduce the risk,
  they don't remove it.
- **Shared-account effects**: in live, agents share one real account; the symbol lock and
  reconciliation handle attribution, but a broker-side problem (outage, rejected orders, a halted
  stock) hits all agents at once.
- **Operational**: the PC must be on and awake in market hours; a Windows update reboot mid-session
  leaves positions to Alpaca with no stops (Alpaca server-side stop orders as a backstop is a
  stage-4 item); the GPU is shared with his other work.
- **Tax and records**: frequent trades create many tax lots; the audit log is kept 7 years. This is
  not tax advice; he should check with his accountant.
- No result from this system is a forecast, and nothing in it is investment advice.

---

## 9. Where the controls cost autonomy (and why they stay)

- **Integrity halts need him.** A ledger mismatch or a broker key error stops live until he looks.
  Auto-resuming from those would mean trading on books we know are wrong. Kept.
- **His kill needs him to resume.** Kept, by definition.
- **Per-version paper records** slow every improvement by ≥ 20 trading days before real money. That
  is the price of evidence the model can't have memorised. Kept.
- **The DSL can't express new signals.** Agents can't invent new kinds of pattern, only combine and
  tune the coded ones; new ones need a Builder. Kept: generated code in the trading path is not
  something the gate can bound.
- **Transient pauses** could also need him; this note recommends they auto-clear (Q3).

None of these needs him per trade.

---

## 10. Skeleton on this branch

| File | What |
|---|---|
| `server/engine/agents/sandbox.mjs` | `SandboxManager` (capital pool, per-agent allocation, path-safe agent folders) and `Sandbox` (one `SimBroker` per agent, its own ledger file, `submit()` through a `RiskGuard` plus the allocation check). `handle()` gives an agent a capability object bound to its own sandbox only. |
| `server/engine/agents/knowledge.mjs` | `KnowledgeStore`: hash-chained `findings.jsonl`; `publish`, `recordValidation` (pass decided by `passesValidation` rules in code), `adopt` (only after the adopter's own passing validation), `verify` (chain check). |
| `server/engine/agents/*.test.mjs` | Isolation and validation tests (no network, no keys, temp folders). |

Not built: agent child processes, IPC, the gate's check 17 inside `risk.mjs`, live sub-ledgers,
research loop, API and connector. No broker file was changed.

Run: `node --test server/engine/agents/*.test.mjs` (Node 24): 13 tests. They use temp folders only,
no network and no keys. (The older `sim.test.mjs` and `backtest.test.mjs` fail to import in a clean
checkout because `server/engine/data/` is git-ignored, LLM note §1.1; the new tests don't depend on it.)

---

## 11. Questions for the owner (max 4)

1. **"ticker"**: is it the `ticker` terminal app (achannarasappa, v5.3.0, installed via WinGet)? If so,
   should Frost Trader write the agents' universe and live positions into `~/.ticker.yaml`
   (`watchlist:` and `lots:`) so it shows what the agents hold? (Recommend: yes, optional, read-only
   mirror.)
2. **Your live limits** for the one-time enablement: total live capital, per-agent max, per-order max,
   per-day notional, max daily loss, max agent drawdown. (Recommend to start: $1,000 / $250 / $100 /
   $500 / $50 / 15 %.)
3. **Transient pauses in live** (stale data, LLM down, broker 5xx): clear automatically once the
   problem is gone, or wait for you? (Recommend: automatic; integrity halts and your kill always wait
   for you.)
4. **What may agents trade?** Only your watchlist (paste or Finviz Elite CSV, LLM note §3), or any US
   stock passing code filters (price ≥ $5, average daily dollar volume ≥ $20 M)? (Recommend: your
   watchlist for live; the wider filtered universe for research and paper only.)

## 12. Built: stage 1 on paper (23 Oct 2026)

The owner's answers: "$250 per. however $10 to start with for testing reasons", Alpaca keys yes, agent
differences "By settings", halts "completely automated". What runs now (server/engine/agents/host.mjs):

- Up to 4 agents (Settings → Paper agents → agents at once), each a child process started with Node's
  permission model (reads only server/engine, writes nothing, no child processes, no keys in its
  environment), answering each tick with buy proposals (ipc.mjs checks every message).
- Paper money per agent: one setting, $10 now, up to $250; a change applies at the next trading day.
  Fractional shares (4 decimals, $1 minimum) on each agent's own SimBroker book.
- Risk preset "Medium" (profile.mjs), all dollar figures as shares of the allocation. Gate check 17
  AGENT_CAPITAL (risk.mjs agentCapital): watchlist only, symbol lock, own cash and allocation.
- Exits (stop, target, time, session close) run in the host. Halts are automatic: daily loss (back next
  day), drawdown (sits out the next trading day, back at half size, full size after 5 clean days), pool
  daily loss, malformed messages, crash loops. The owner's KILL (button, API, DATA_DIR/KILL) and an
  integrity halt stay on until he resumes.
- Hash-chained audit log (audit.mjs), per-signal day notes to the knowledge store (adoption off).
- Market data: Alpaca IEX bars with his paper key pair (server/alpaca-keys.mjs, write-only; a live
  "AK" key is refused). No order is ever sent to Alpaca. Live stays closed.
- Deferred: the research loop (stage 2), adoption of findings, the live sub-ledgers and enablement.
