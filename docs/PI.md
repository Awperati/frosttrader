# FrostTrader on the Pi

The paper agents run all day on the Pi (pihost, Debian 13, arm64, Docker), whatever the PC is doing.
The PC app stays as it is, with its agents switched off, so only one copy trades.

Status: 25 Oct 2026. Built and tested on Windows; the image is built on the Pi; **not started on the
Pi until the owner says so**.

## How it runs

- `Dockerfile` builds the same server the Windows app runs (`server/app.mjs`), headless, on
  `node:24-alpine`. No Python, no Electron.
- `docker-compose.pi.yml`: host network, so the server listens on the Pi's own `127.0.0.1:8787` and
  nothing else on the network or the tailnet can reach it. Restarts by itself (`unless-stopped`).
  Data in `~/frosttrader/data` on the Pi. Memory capped at 768 MB.
- To look at it from the PC: an SSH tunnel through Tailscale, then a browser on the PC.

## Moving it over (in this order)

1. **On the PC, in FrostTrader**: wait until no agent holds a position (after the US close).
   Settings → Paper agents → untick **Run the agents here** → Save.
2. **Copy the data folder to the Pi** (keys, watchlist, agents' books): from the PC,
   `scp -r "%APPDATA%\FrostTrader\data" henwy@pihost:frosttrader/` (it holds your Alpaca paper keys and
   Finviz token; they go only to the Pi, over Tailscale).
3. **On the Pi, turn "Run the agents here" back on** in its copy of the settings
   (`data/agents-settings.json`, `"runHere": true`). It was copied in the off state.
4. **Start it**: `cd ~/frosttrader && docker compose -f docker-compose.pi.yml up -d`.
5. **Check it**: `docker logs frosttrader` shows `Frost Trader … on http://127.0.0.1:8787`.

## Looking at it from the PC

```
ssh -N -L 8788:127.0.0.1:8787 henwy@pihost
```

Leave that running and open http://127.0.0.1:8788 in a browser. Settings work through the tunnel
(the server sees a local address). Port 8788 because the PC app uses 8787.

## Updating

```
cd ~/frosttrader && git pull && docker compose -f docker-compose.pi.yml up -d --build
```

The agents' books and settings stay in `data/`. An update restarts the server; mid-day, open
positions get their exit plans back at the next tick (as after any restart).

## Stopping it

`docker compose -f docker-compose.pi.yml down` stops the agents. Positions in the books stay; with
Alpaca paper orders on, positions on the paper account stay open and unmanaged until it runs again.
Before stopping it in market hours, press the kill switch first.

## Known limits

- The Pi must stay on and online in US market hours (23:30–06:00 Brisbane until 1 Nov, then
  00:30–07:00). A power cut leaves positions unmanaged until it is back.
- The PC app and the Pi app each have their own data. The PC app shows only its own copy.
- Sign-in (`server/auth.mjs`) is not wired in, which is why the server stays on 127.0.0.1 and is
  reached only through SSH.
