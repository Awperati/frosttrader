# FrostTrader on the Pi

The paper agents run all day on the Pi (pihost, Debian 13, arm64, Docker), whatever the PC is doing.
The PC app stays as it is, with its agents switched off, so only one copy trades.

Status: 25 Oct 2026. Built and tested on Windows. The code is cloned to `~/frosttrader` on the Pi.
**Not built or started on the Pi**: Docker there needs sudo, which needs the owner's password.

## Docker on the Pi needs sudo

`henwy` is not in the `docker` group, so every `docker` command below needs `sudo` (the owner types
his password). Or, once: `sudo usermod -aG docker henwy` and log in again. The `docker` group is as
powerful as root.

## How it runs

- `Dockerfile` builds the same server the Windows app runs (`server/app.mjs`), headless, on
  `node:24-alpine`. No Python, no Electron.
- `docker-compose.pi.yml`: host network, so the server listens on the Pi's own `127.0.0.1:8795` (8787 is taken there by another service) and
  nothing else on the network or the tailnet can reach it. Restarts by itself (`unless-stopped`).
  Data in `~/frosttrader/data` on the Pi. Memory capped at 768 MB.
- To look at it from the PC: an SSH tunnel through Tailscale, then a browser on the PC.

## Moving it over (in this order)

| # | Step | Who |
|---|---|---|
| 1 | In FrostTrader on the PC, when no agent holds a position: Settings → Paper agents → untick **Run the agents here** → Save | Owner |
| 2 | Copy `%APPDATA%\FrostTrader\data` to `~/frosttrader/data` on the Pi over Tailscale SSH (it holds the Alpaca paper keys and the Finviz token; they go only to the Pi), and set `"runHere": true` in the Pi's copy of `agents-settings.json` | Claude |
| 3 | On the Pi: `cd ~/frosttrader && sudo docker compose -f docker-compose.pi.yml up -d --build` (or give Claude Docker access once: `sudo usermod -aG docker henwy`) | Owner (sudo password) |
| 4 | Check: `docker logs frosttrader` shows `Frost Trader … on http://127.0.0.1:8795`; the agents page answers through the tunnel | Claude |

## Looking at it from the PC

```
ssh -N -L 8788:127.0.0.1:8795 henwy@pihost
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
