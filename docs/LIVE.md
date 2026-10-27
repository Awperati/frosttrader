# Live trading (real money)

Built 27 Oct 2026 after the owner's "connect agents and frost trader to this account" (relayed by Top
Dog). **Off until you switch it on.** Claude never enters your keys, never moves money and never places
a trade. Nothing here is advice.

## How it works

- Your paper agents keep trading on paper. An agent you switch to **live** also sends its buys to your
  Alpaca live account, by dollar amount (fractional), inside your limits. Exits, halts and the kill
  switch work as on paper; v11 agents use v11's own exit.
- Every live buy passes, in order: your signed switch-on (L1), a fresh AUD→USD rate (L2), the account
  still being a cash account (L3: multiplier 1, no pattern-day-trader flag, no shorting, not blocked,
  USD, the same account), the stock list and one live agent per stock (17), **settled cash** (18: sale
  money counts from the next business day), **day trades** (19: at most 3 in 5 business days, the
  rule for accounts under US$25,000), your limits (L4) and the halts (L5).
- Every order has its own id written down before it is sent, so a retry never buys twice.
- Every minute the agents' live books are checked against the account. A difference, a margin or
  PDT flag, the total drawdown limit or the kill switch **closes every live position and stops live**
  until you resume with your password and code.
- Everything goes into the same hash-chained audit log as paper. Keys never do.

## Your limits (Australian dollars, from your "proposed limit is great"; re-confirm each when switching on)

| Limit | Value |
|---|---|
| Live money per agent | A$10 |
| Total live money | A$40 |
| Largest order | A$2.50 (about US$1.75; Alpaca's minimum is US$1) |
| Buys per agent per day | 6 |
| Bought per agent / by all per day | A$20 / A$80 |
| Daily loss per agent / all agents | A$0.30 / A$0.80 |
| Drawdown per agent | A$1 (sits out a day, back at half size) |
| Total drawdown | A$4 (live stops until you resume) |

You can lower any limit at once. Raising one means switching live on again.

## Switching it on (you, in this order)

1. **Fund the account yourself**: an international USD wire from your bank, per Alpaca's funding page.
   Your bank charges its own fee per wire (A$30 per transfer at your bank).
2. **Update the Pi and set your FrostTrader sign-in** (once):
   `ssh henwy@pihost`, then `cd ~/frosttrader && git pull && sh scripts/pi-live-setup.sh`.
   It asks you to choose a FrostTrader password, prints a 6-digit-code secret once for KeePassXC,
   and restarts FrostTrader. Live stays off.
3. **Open FrostTrader through the tunnel** on your PC: `ssh -N -L 8788:127.0.0.1:8795 henwy@pihost`,
   then http://127.0.0.1:8788 → Settings → Live trading.
4. **Save your LIVE key pair** (Alpaca → your live account → API keys; the key ID starts with AK).
   Then "Check the account (no order)".
5. **Confirm each limit**, type `TRADE LIVE` and the last 4 digits of your live account number, your
   FrostTrader password and the 6-digit code, then "Switch live trading on". It refuses a margin or
   PDT-flagged account.
6. **Choose which agents trade live** (start with one).

To stop: the kill switch (everything, paper and live), or "Switch live off" (closes live positions).

## Known limits

- Every v11 trade is opened and closed the same day, so each is a day trade. Check 19 allows 3 in any
  5 business days unless the account is exempt; Alpaca's own protection may refuse the 4th as well.
- Cash from a sale is usable the next business day (check 18), so each dollar trades once a day.
- The Pi must be on and online in US market hours (00:30–07:00 Brisbane from 1 Nov).
- Tested only against a fake Alpaca on this computer (`test/live.test.mjs`). The first real order
  will be the first time the live account's replies are seen.
