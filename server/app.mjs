// Frost Trader's HTTP server as a function, so both ways of running it share one copy:
//   server/index.mjs     `npm start`: the plain server on http://127.0.0.1:8787, data in ./data (DATA_DIR)
//   electron/main.mjs    the Windows app: the same server inside the app, data in %APPDATA%\FrostTrader
// Nothing starts on import: startServer() builds the parts, starts the timers and listens, in that order.
// It listens on 127.0.0.1 only. Sign-in (server/auth.mjs) must be wired in before it is ever exposed beyond
// this machine. No broker is constructed and no order is ever sent to Alpaca; live trading stays closed.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError } from './store.mjs';
import { createNumbersApi } from './numbers-api.mjs';
import { createFinvizApi } from './finviz-api.mjs';
import { FinvizSource } from './engine/finviz.mjs';
import { TickerMirror } from './engine/ticker-mirror.mjs';
import { AgentHost, PAPER_DAYS_BEFORE_LIVE } from './engine/agents/host.mjs';
import { AlpacaKeys } from './alpaca-keys.mjs';
import { AlpacaPaperOrders } from './engine/broker/alpaca-paper-orders.mjs';
import { LiveKeys } from './live-keys.mjs';
import { Enablement } from './engine/live/enablement.mjs';
import { LiveDesk } from './engine/live/desk.mjs';
import { createLiveApi } from './live-api.mjs';
import { WebGate, SESSION, clientIp, isRemote, securityHeaders } from './web-gate.mjs';
import { Notifier } from './notify.mjs';
import { checkLocal } from './finviz-api.mjs';
import { Auth } from './auth.mjs';
import { createTotp } from './totp.mjs';
import { loadModel } from './engine/models/v11.mjs';
import { createAgentsApi } from './agents-api.mjs';
import { FxRate } from './engine/data/fx.mjs';
import { Research } from './engine/research/nightly.mjs';
import { ModelIdeas } from './engine/research/hypotheses.mjs';
import { ConnectorToken, createConnector } from './connector.mjs';
import { BarsRefresher } from './engine/data/refresh-bars.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const HOST = '127.0.0.1';
export const DEFAULT_PORT = 8787;

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2' };

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(status, { ...securityHeaders(res.ftRemote), 'content-type': type, 'cache-control': 'no-store', ...extra });
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

/** Listen on the first port that is free (0: any free one). Resolves the port it got. */
export function listenOn(server, ports, host = HOST) {
  return new Promise((resolve, reject) => {
    const left = [...ports];
    const next = () => {
      const port = left.shift();
      const onError = (e) => {
        server.off('listening', onListening);
        if (e.code === 'EADDRINUSE' && left.length) next();
        else reject(e);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve(server.address().port);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    };
    next();
  });
}

/**
 * Build the server's parts and start them, then listen.
 *   dataDir   where everything is kept (alpaca-keys.json, agents/, watchlist.json, …)
 *   ports     tried in order; the app passes [8787, 0] so the Frost AI connector keeps its address when it can
 *   agents    start the paper agents (AGENTS=0: off)
 *   finviz    start the Finviz screener schedule (its only outside call: ticker names)
 *   tickerMirror  mirror the watchlist into ~/.ticker.yaml (TICKER_MIRROR=0: off)
 * Resolves { server, port, url, dataDir, stop() }.
 */
/**
 * The owner's sign-in, used only as the step-up for live trading: set when the server's environment has
 * FROST_TRADER_PASSWORD (and FROST_TRADER_TOTP_SECRET for the 6-digit code). null otherwise: live then
 * can't be switched on.
 */
export function ownerAuth(dataDir, env = process.env) {
  const password = env.FROST_TRADER_PASSWORD;
  if (!password) return null;
  const secret = env.FROST_TRADER_TOTP_SECRET || '';
  const totp = secret ? createTotp(secret) : { enabled: false, check: () => false };
  fs.mkdirSync(path.join(dataDir, 'owner'), { recursive: true });
  // sessions are for the private website only: 30 minutes idle, 12 hours at most
  return new Auth(path.join(dataDir, 'owner'), password, totp, { limits: { idleMs: SESSION.idleMs, maxAgeMs: SESSION.maxAgeMs } });
}

export async function startServer({ dataDir, ports = [DEFAULT_PORT], distDir = path.join(ROOT, 'client', 'dist'), agents: runAgents = true, finviz: runFinviz = true, tickerMirror = true, log = console } = {}) {
  if (!dataDir) throw new Error('startServer needs a dataDir');
  const DATA_DIR = path.resolve(dataDir);
  const DIST = path.resolve(distDir);
  let port = 0;

  // The owner's Finviz Elite screeners: the only outside call stage 0 makes (names only, no orders).
  // Mirror the watchlist and paper positions into ~/.ticker.yaml for the `ticker` app.
  let mirror = null;
  const finvizSource = new FinvizSource({ dataDir: DATA_DIR, onChange: () => mirror?.sync() });
  if (tickerMirror) mirror = new TickerMirror({ dataDir: DATA_DIR, list: () => finvizSource.listInfo() }).start();
  if (runFinviz) finvizSource.start();
  const finviz = createFinvizApi({ source: finvizSource, mirror });
  // The paper agents. They trade only the Finviz watchlist, on paper.
  const alpacaKeys = new AlpacaKeys({ dataDir: DATA_DIR });
  // the owner sets the agents' money in AUD; the books are in US dollars at the day's ECB rate
  const fx = new FxRate({ dataDir: DATA_DIR });
  // orders on his Alpaca PAPER account, only while Settings → Paper agents → Orders says so
  let paperOrders = null;
  const getOrders = () => {
    if (!alpacaKeys.set) return null;
    if (paperOrders?.keyId !== alpacaKeys.keys.keyId) paperOrders = new AlpacaPaperOrders(alpacaKeys.keys);
    return paperOrders;
  };
  // LIVE (real money): off until the owner saves his live keys and signs the enablement with his
  // password and code (Settings → Live trading); then only the agents he switches to live trade there
  const auth = ownerAuth(DATA_DIR);
  // phone alerts (ntfy): off until his topic is set (scripts/pi-alerts-setup.sh or Settings)
  const notifier = new Notifier({ dataDir: DATA_DIR });
  const notify = (event, msg) => void notifier.send(event, msg);
  const liveKeys = new LiveKeys({ dataDir: DATA_DIR });
  const enablement = new Enablement({ dataDir: DATA_DIR, keyFor: () => auth?.secretFor('live-enablement') ?? null });
  let host = null;
  const desk = new LiveDesk({
    dataDir: DATA_DIR,
    enablement,
    broker: () => liveKeys.broker(),
    getFx: () => fx.current(),
    audit: { write: (e) => host.audit.write(e) }, // the host's hash-chained log (one writer)
    params: (id) => host.settings.params[id],
    // only agents he switched to live, and only after their 10 paper days (also when a settings file says live)
    running: (id) => host.running().includes(id) && host.settings.live?.[id] === true && host.paperDays(id).length >= PAPER_DAYS_BEFORE_LIVE,
    strategy: (id) => host.strategyOf(id),
    allowed: (id, universe) => (host.strategyOf(id) === 'v11' ? new Set([...universe, ...loadModel().universe]) : universe),
    notify,
  });
  host = new AgentHost({ dataDir: DATA_DIR, getUniverse: () => finvizSource.symbols(), getData: () => alpacaKeys.client(), getOrders, getFx: () => fx.current(), refreshFx: () => fx.refresh(), live: desk, notify });
  const live = createLiveApi({ desk, keys: liveKeys, enablement, auth, getFx: () => fx.current(), notify });
  // the private website (docs/WEBSITE.md): off unless FROST_TRADER_PUBLIC_HOST is set (and his sign-in with a code)
  const env = process.env;
  const gate = new WebGate({
    publicHost: env.FROST_TRADER_PUBLIC_HOST || '',
    auth,
    access: env.FROST_TRADER_CF_TEAM && env.FROST_TRADER_CF_AUD ? { team: env.FROST_TRADER_CF_TEAM, aud: env.FROST_TRADER_CF_AUD } : null,
    audit: { write: (e) => host.audit.write(e) },
  });
  // the nightly research loop: after each close, walk-forward of every agent's settings (paper only)
  // his local model's research ideas (Frost AI on this computer): OFF until he switches it on in Settings
  const ideas = new ModelIdeas({ dataDir: DATA_DIR });
  const research = new Research({ dataDir: DATA_DIR, host, getData: () => alpacaKeys.client(), ideas });
  host.onDayEnd = (day) => research.run(day, finvizSource.symbols());
  // the Frost AI connector (MCP at /mcp): read tools plus stop/start/kill, behind a token made in Settings
  const connectorToken = new ConnectorToken({ dataDir: DATA_DIR });
  const refresher = new BarsRefresher({ dataDir: DATA_DIR, getData: () => alpacaKeys.client() });
  const connector = createConnector({ host, research, refresher, token: connectorToken });
  const agents = createAgentsApi({ host, keys: alpacaKeys, research, ideas, connectorToken, port: () => port });
  const numbers = createNumbersApi({ dataDir: DATA_DIR, watchlist: () => ({ ...finvizSource.status(), holders: host.holders() }) });

  function serveStatic(res, pathname) {
    const rel = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
    let file = path.resolve(DIST, rel);
    if (!file.startsWith(DIST + path.sep)) return send(res, 404, { error: 'Not found' });
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
    if (!fs.existsSync(file)) return send(res, 503, 'The client is not built yet. Run "npm run build".', 'text/plain; charset=utf-8');
    send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)] || 'application/octet-stream', { 'cache-control': path.basename(file) === 'index.html' ? 'no-store' : 'public, max-age=3600' });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${HOST}`);
    res.ftRemote = isRemote(req);
    try {
      const { headers, device } = await gate.admit(req, url.pathname);
      if (url.pathname === '/api/auth/status' && req.method === 'GET') return send(res, 200, { ...gate.status(req), signedIn: !!device });
      if (url.pathname === '/api/auth/login' && req.method === 'POST') {
        if (!res.ftRemote) throw new HttpError(400, 'Sign-in is for the website. On this computer FrostTrader needs none.');
        const body = await readJson(req, 4 * 1024);
        const ip = clientIp(req);
        try {
          const out = await auth.login(ip, { password: body?.password, code: body?.code, device: 'Website' });
          host.audit.write({ type: 'login', ok: true, ip, device: out.deviceId });
          if (notifier.firstTimeFrom(ip)) {
            const country = String(req.headers['cf-ipcountry'] || '').replace(/[^A-Z]/g, '').slice(0, 2) || 'an unknown country';
            notify('newSignIn', { message: `New sign-in to the FrostTrader website from ${country} (address ending ${ip.slice(-4)}). Not you? Press the kill switch and change your password.` });
          }
          return send(res, 200, { token: out.token });
        } catch (e) {
          host.audit.write({ type: 'login', ok: false, ip, reason: String(e.message).slice(0, 100) });
          throw e;
        }
      }
      if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
        if (device) {
          auth.revoke(device.id);
          host.audit.write({ type: 'logout', device: device.id });
        }
        return send(res, 200, { ok: true });
      }
      if (res.ftRemote && device) req.ftDevice = device.id;
      if (url.pathname === '/api/numbers' || url.pathname.startsWith('/api/numbers/')) {
        const body = req.method === 'POST' ? await readJson(req) : null;
        const out = await numbers.handle(req.method, url.pathname, url.searchParams, body, headers);
        return send(res, out.status, out.body);
      }
      if (url.pathname === '/api/finviz' || url.pathname.startsWith('/api/finviz/')) {
        const body = req.method === 'PUT' ? await readJson(req, 16 * 1024) : null;
        const out = await finviz.handle(req.method, url.pathname, headers, body);
        return send(res, out.status, out.body);
      }
      if (url.pathname === '/mcp') {
        const body = req.method === 'POST' ? await readJson(req, 64 * 1024) : null;
        const out = await connector.handle(req.method, req.headers, body);
        if (out.body === null) {
          res.writeHead(out.status, { 'cache-control': 'no-store' });
          return res.end();
        }
        return send(res, out.status, out.body);
      }
      if (url.pathname === '/api/notify' || url.pathname.startsWith('/api/notify/')) {
        if (req.method === 'GET' && url.pathname === '/api/notify') return send(res, 200, notifier.status());
        checkLocal(headers);
        const body = await readJson(req, 4 * 1024);
        if (req.method === 'PUT' && url.pathname === '/api/notify') {
          try {
            return send(res, 200, notifier.update(body || {}));
          } catch (e) {
            throw new HttpError(400, e.message);
          }
        }
        if (req.method === 'POST' && url.pathname === '/api/notify/test') {
          if (!notifier.on) throw new HttpError(400, 'Set a topic first.');
          const ok = await notifier.send('test', { title: 'FrostTrader test', message: 'Alerts from FrostTrader reach this phone.' });
          return send(res, ok ? 200 : 502, ok ? notifier.status() : { error: notifier.lastError || 'Not sent (too many in a short time?)' });
        }
        throw new HttpError(404, 'Not found');
      }
      if (url.pathname === '/api/live' || url.pathname.startsWith('/api/live/')) {
        const body = req.method === 'PUT' || req.method === 'POST' ? await readJson(req, 16 * 1024) : null;
        const out = await live.handle(req.method, url.pathname, headers, body, clientIp(req));
        if (req.method !== 'GET') host.audit.write({ type: 'live-request', route: `${req.method} ${url.pathname}`, status: out.status, via: res.ftRemote ? `website ${req.ftDevice}` : 'this computer' });
        return send(res, out.status, out.body);
      }
      if (/^\/api\/(agents|alpaca|research|llm|connector)(\/|$)/.test(url.pathname)) {
        const body = req.method === 'PUT' || req.method === 'POST' ? await readJson(req, 32 * 1024) : null;
        const out = await agents.handle(req.method, url.pathname, headers, body, url.searchParams);
        if (res.ftRemote && req.method !== 'GET') host.audit.write({ type: 'website-action', route: `${req.method} ${url.pathname}`, device: req.ftDevice });
        if (out.download) {
          res.writeHead(out.status, { ...securityHeaders(res.ftRemote), 'content-type': out.type, 'content-disposition': `attachment; filename="${out.download}"`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
          return res.end(out.body);
        }
        return send(res, out.status, out.body);
      }
      if (url.pathname.startsWith('/api/')) throw new HttpError(404, 'Not found');
      if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
      serveStatic(res, url.pathname);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) log.error(e);
      send(res, status, { error: status === 500 ? 'Server error' : e.message });
    }
  });

  const stopParts = () => {
    host.stop();
    finvizSource.stop();
    mirror?.stop();
  };
  try {
    port = await listenOn(server, ports);
  } catch (e) {
    stopParts();
    throw e;
  }
  // the agents start once the server has its address (they report through it)
  if (runAgents) host.start();
  return {
    server,
    port,
    url: `http://${HOST}:${port}`,
    dataDir: DATA_DIR,
    host,
    notifier,
    stop: () =>
      new Promise((resolve) => {
        stopParts();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
