# Phone alerts (ntfy)

Built 27 Oct 2026 after the owner's "a. NTFY" (relayed by Top Dog). **Off until you set a topic.**

FrostTrader posts short messages to your private ntfy topic; the free ntfy app on your phone shows
them. The topic name is the only secret: whoever knows it can read the alerts. It is made on the Pi,
shown once, kept in `data/notify.json` (readable only by you), never shown by FrostTrader, never
logged, never in git.

## What you get

| Alert | Default priority |
|---|---|
| Kill switch used | urgent |
| Live trading stopped (books differ from the account, total drawdown, account changed, switch-off) | urgent |
| An agent halted live (daily loss, drawdown, all agents' daily loss) | high |
| Watchdog restart (FrostTrader was stuck and restarted itself) | high |
| Live trading switched on or off | high |
| Website sign-in from a new place (country and the end of the address) | high |
| Each live order filled: agent, bought or sold, stock, amount in A$ | default |
| Summary after each US close: each agent's paper trades and result, live results | low |

You can change each priority in Settings → Phone alerts. Messages never contain keys, account numbers
or the topic. A failed alert never stops or slows trading. At most 20 alerts in 10 minutes, and the same
message at most once a minute, so a fault can't flood your phone.

## Setting it up (you)

1. **On the Pi**: `ssh henwy@pihost`, then `cd ~/frosttrader && git pull && sh scripts/pi-alerts-setup.sh`.
   It updates FrostTrader, prints your topic once (like `frosttrader-k3j9…`) and restarts it.
2. **On your phone**: install **ntfy** (Google Play, F-Droid or the App Store). Tap **+**, type the
   topic exactly, keep the server `ntfy.sh`, and Subscribe. On iPhone, allow notifications when asked.
   On Android, for alerts while the phone sleeps: ntfy → Settings → "Instant delivery" for this topic.
3. **Test**: FrostTrader → Settings → Phone alerts → **Send a test**. Your phone should buzz.

A new topic: run the script again (the old topic stops getting alerts; unsubscribe it in the app).
Alerts off: Settings → Phone alerts → Switch alerts off.

## Tested

`test/notify.test.mjs` and `test/live.test.mjs`, against a fake ntfy on this computer: off until a topic
is set, the topic never returned, no account numbers or keys in a message, the rate limits, failures
never thrown, the kill switch, live fills and stops, a new website sign-in. Not tested against the real
ntfy.sh (that happens with your test button).
