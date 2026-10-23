# Connecting Frost AI to FrostTrader

Frost AI can read how the paper agents are doing, and stop, start or kill them, through FrostTrader's
MCP server at `http://127.0.0.1:8787/mcp`. Paper only. It can't resume after a kill, or change
settings, money or live.

Checked against Frost AI's code (frostmind `origin/main`, MCP key field from ecc1fc4):
- an `mcp.json` entry with a `url` is started as Streamable HTTP (`electron/lib/mcp.cjs`, `type`
  defaults to `http` when `url` is set); plain `http://127.0.0.1` is fine;
- for an HTTP server the key field defaults to `Authorization`, and the key is sent as
  `Authorization: Bearer <key>` (`electron/lib/mcpprefs.cjs` `suggestedField` and `apply`). That is
  exactly what FrostTrader expects. No bridge is needed.

## Steps

1. **FrostTrader** must be running (`npm start` in `C:\Users\User\Frost Technology\FrostTrader`).
   Open it, go to **Settings → Frost AI connector**, press **Make a token**, and copy the token. It is
   shown once; FrostTrader keeps only a fingerprint. (A new token ends the old one; **Turn off**
   removes it.)
2. **Frost AI → Settings → MCP servers → Edit mcp.json**, and add this inside `"mcpServers"` (next to
   any servers already there), then save:

   ```json
   "frosttrader": {
     "url": "http://127.0.0.1:8787/mcp",
     "autoApprove": ["frosttrader_status", "frosttrader_today", "frosttrader_stats", "frosttrader_decisions", "frosttrader_research"]
   }
   ```

   `autoApprove` lets the five read tools run without asking; stop, start and kill still ask each time.
3. Back in **Settings → MCP servers**, find **frosttrader**. Its key field says **Authorization**:
   paste the token there and save (that restarts it). Make sure it is **On**. If it doesn't appear,
   restart Frost AI once.
4. Ask Frost AI: "How did the FrostTrader agents do today?" or "Show agent-b's decisions".

## The tools

| Tool | What it does |
|---|---|
| `frosttrader_status` | kill switch, paused, market open, each agent's state, equity and today's P&L |
| `frosttrader_today` | a day's summary per agent and for all |
| `frosttrader_stats` | results by signal, symbol, half hour and exit reason |
| `frosttrader_decisions` | the plain-language decision log of a day |
| `frosttrader_research` | the last nightly research and recent setting changes |
| `frosttrader_stop` / `frosttrader_start` | stop / allow new buys (exits keep running) |
| `frosttrader_kill` | the kill switch (a reason is required); resume only on FrostTrader's own screen |

If Frost AI says "asked for sign-in (HTTP 401)", the token in its key field is missing or old: make a
new one in FrostTrader and paste it again.
