// Frost Trader's HTTP server, stage 0: read-only.
//
//   npm run build && npm start      then open http://127.0.0.1:8787
//
// It serves the built client (client/dist) and the read-only /api/numbers routes. It also runs the
// Finviz Elite screener source (server/engine/finviz.mjs), which fetches ticker names only. It does not
// start the trading engine, construct a broker, or read broker keys: stage 0 places no orders.
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
const numbers = createNumbersApi({ dataDir: DATA_DIR, watchlist: () => finvizSource.status() });

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
