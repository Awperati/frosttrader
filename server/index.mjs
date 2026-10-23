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
// exposed beyond this machine.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError } from './store.mjs';
import { createNumbersApi } from './numbers-api.mjs';
import { createFinvizApi } from './finviz-api.mjs';
import { FinvizSource } from './engine/finviz.mjs';
import { TickerMirror } from './engine/ticker-mirror.mjs';
import { AgentHost } from './engine/agents/host.mjs';
import { AlpacaKeys } from './alpaca-keys.mjs';
import { createAgentsApi } from './agents-api.mjs';
import { FxRate } from './engine/data/fx.mjs';
import { Research } from './engine/research/nightly.mjs';
import { ModelIdeas } from './engine/research/hypotheses.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));
const DIST = path.join(root, 'client', 'dist');
const PORT = Number(process.env.PORT || 8787);
const HOST = '127.0.0.1';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2' };

// The owner's Finviz Elite screeners: the only outside call stage 0 makes (names only, no orders).
// Mirror the watchlist and paper positions into ~/.ticker.yaml for the `ticker` app (TICKER_MIRROR=0: off).
let mirror = null;
const finvizSource = new FinvizSource({ dataDir: DATA_DIR, onChange: () => mirror?.sync() });
if (process.env.TICKER_MIRROR !== '0') mirror = new TickerMirror({ dataDir: DATA_DIR, list: () => finvizSource.listInfo() }).start();
finvizSource.start();
const finviz = createFinvizApi({ source: finvizSource, mirror });
// The paper agents (AGENTS=0: off). They trade only the Finviz watchlist, on paper.
const alpacaKeys = new AlpacaKeys({ dataDir: DATA_DIR });
// the owner sets the agents' money in AUD; the books are in US dollars at the day's ECB rate
const fx = new FxRate({ dataDir: DATA_DIR });
const host = new AgentHost({ dataDir: DATA_DIR, getUniverse: () => finvizSource.symbols(), getData: () => alpacaKeys.client(), getFx: () => fx.current(), refreshFx: () => fx.refresh() });
if (process.env.AGENTS !== '0') host.start();
// the nightly research loop: after each close, walk-forward of every agent's settings (paper only)
// his local model's research ideas (Frost AI on this computer): OFF until he switches it on in Settings
const ideas = new ModelIdeas({ dataDir: DATA_DIR });
const research = new Research({ dataDir: DATA_DIR, host, getData: () => alpacaKeys.client(), ideas });
host.onDayEnd = (day) => research.run(day, finvizSource.symbols());
const agents = createAgentsApi({ host, keys: alpacaKeys, research, ideas });
const numbers = createNumbersApi({ dataDir: DATA_DIR, watchlist: () => ({ ...finvizSource.status(), holders: host.holders() }) });

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readJson(req, limit = 128 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'Request too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new HttpError(400, 'Body is not JSON'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(res, pathname) {
  const rel = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
  let file = path.resolve(DIST, rel);
  if (!file.startsWith(DIST + path.sep)) return send(res, 404, { error: 'Not found' });
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  if (!fs.existsSync(file)) return send(res, 503, 'The client is not built yet. Run "npm run build".', 'text/plain; charset=utf-8');
  send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)] || 'application/octet-stream');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}`);
  try {
    if (url.pathname === '/api/numbers' || url.pathname.startsWith('/api/numbers/')) {
      const body = req.method === 'POST' ? await readJson(req) : null;
      const out = await numbers.handle(req.method, url.pathname, url.searchParams, body);
      return send(res, out.status, out.body);
    }
    if (url.pathname === '/api/finviz' || url.pathname.startsWith('/api/finviz/')) {
      const body = req.method === 'PUT' ? await readJson(req, 16 * 1024) : null;
      const out = await finviz.handle(req.method, url.pathname, req.headers, body);
      return send(res, out.status, out.body);
    }
    if (/^\/api\/(agents|alpaca|research|llm)(\/|$)/.test(url.pathname)) {
      const body = req.method === 'PUT' || req.method === 'POST' ? await readJson(req, 32 * 1024) : null;
      const out = await agents.handle(req.method, url.pathname, req.headers, body, url.searchParams);
      if (out.download) {
        res.writeHead(out.status, { 'content-type': out.type, 'content-disposition': `attachment; filename="${out.download}"`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        return res.end(out.body);
      }
      return send(res, out.status, out.body);
    }
    if (url.pathname.startsWith('/api/')) throw new HttpError(404, 'Not found');
    if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
    serveStatic(res, url.pathname);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(e);
    send(res, status, { error: status === 500 ? 'Server error' : e.message });
  }
});

server.listen(PORT, HOST, () => console.log(`Frost Trader (stage 0, read-only) on http://${HOST}:${PORT}  data: ${DATA_DIR}`));
