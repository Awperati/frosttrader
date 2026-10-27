# Live step: superseded (27 Oct 2026)

This branch's work is now built, wired and tested on master: see docs/LIVE.md. The notes below are
kept for the record.

# Live step: paused (23 Oct 2026)

The owner, after his bank quoted A$30 for each USD wire to Alpaca: "Lets keep them on paper for now
then". So this branch (`live-step`) is NOT merged into master, and live trading stays closed. Nothing
here is reachable from master's server. Nothing here has ever placed an order.

## What his answers were

- Broker: Alpaca. Cash account. Live as soon as he enables it. Limits as proposed (in AUD):
  A$10 per agent, A$40 total, A$2.50 per order, 6 buys and A$20 a day per agent, A$80 for all,
  A$0.30 daily loss per agent and A$0.80 for all, A$1 drawdown per agent (automatic, as on paper),
  A$4 total drawdown (stops all live trading until he resumes). US stocks only, from Finviz.

## What is written on this branch (first commit, not wired in, no tests yet)

| File | State |
|---|---|
| `server/auth.mjs` | `verify(ip, body)`: password + code with the sign-in lockout, no device created. Done. |
| `package.json` | `npm start` loads `.env` (`--env-file-if-exists`), for `FROST_TRADER_PASSWORD` and `FROST_TRADER_TOTP_SECRET`. Done. |
| `server/live-keys.mjs` | Live key store (`alpaca-live-keys.json`, AK keys only), `broker()`, read-only account test. Done. |
| `server/engine/broker/alpaca-live.mjs` | Live adapter: fixed host (a test server only on 127.0.0.1), account, positions, notional buys / qty sells with `client_order_id`, lookup by client id, close-all. Done, untested. |
| `server/engine/live/enablement.mjs` | Limits (proposed, hard caps), signed `owner/live-enablement.json` (HMAC keyed from his password), lower-only edits, revoke. Done, untested. |
| `server/engine/live/desk.mjs` | The live desk: AUD sub-ledgers at fill-time cost, checks L1–L5, 17, 18 (settled cash, T+1), 19 (day trades: 3 in 5 business days), pending orders by client id, exits, halts, reconciliation, stop-all, owner resume. Written, untested. |

## Not done

1. `Auth.secretFor()` (the HMAC key for the enablement) and creating `Auth` in `server/index.mjs`.
2. Wiring the desk into `AgentHost` (tick after the paper entries; kill → `stopAll`; status).
3. The API (`/api/live/*`: keys, check account, enable with password + code + typed phrase + every
   limit confirmed, lower limits, disable, resume) and the Settings "Live trading" card, including the
   one-line reminder that funding is an international USD wire whose fee is his bank's.
4. Enablement refusal unless the account is a cash account with no PDT flag: Alpaca's account
   object has `multiplier` (1, 2 or 4) and `shorting_enabled`; its docs call multiplier 1 "limited
   margin", and no field says "cash account" outright. Needs checking against his real account.
5. Tests against a fake Alpaca live server (never a real order), the reachability test extended to
   prove master's server can't reach this code until it is wired in on purpose.
6. Open question for him before any live build resumes: every entry is closed the same day, so
   every round trip is a day trade; check 19 then allows only 3 in 5 business days across all agents
   unless the account is exempt. Holding overnight instead would change the strategy.
