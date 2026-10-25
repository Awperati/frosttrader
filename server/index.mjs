// Frost Trader's HTTP server: stage 0 views plus the stage 1 PAPER agents.
//
//   npm run build && npm start      then open http://127.0.0.1:8787
//
// It serves the built client (client/dist) and the read-only /api/numbers routes. It also runs the
// Finviz Elite screener source (server/engine/finviz.mjs), which fetches ticker names only, and the
// paper agents (server/engine/agents/host.mjs): up to 4 sandboxed agents trading paper money on their
// own simulated books, with market data from Alpaca (the owner's paper keys, data only). No broker is
// constructed and no order is ever sent to Alpaca; live trading stays closed.
// It listens on 127.0.0.1 only. Sign-in (server/auth.mjs) must be wired in before it is ever
// exposed beyond this machine. The server itself is server/app.mjs (the Windows app runs the same one).
//   DATA_DIR (default ./data), PORT (default 8787), AGENTS=0 (agents off), TICKER_MIRROR=0 (no ~/.ticker.yaml)
import path from 'node:path';
import { startServer, ROOT, DEFAULT_PORT } from './app.mjs';

const s = await startServer({
  dataDir: path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data')),
  ports: [Number(process.env.PORT || DEFAULT_PORT)],
  agents: process.env.AGENTS !== '0',
  tickerMirror: process.env.TICKER_MIRROR !== '0',
});
console.log(`Frost Trader (stage 0, read-only) on ${s.url}  data: ${s.dataDir}`);
