// Stage 4: the agents' orders on the owner's Alpaca PAPER account. The client against a fake Alpaca
// on this computer (paper only, idempotent retries, unfilled orders cancelled, keys never shown), and
// the host with a fake client (fills booked at Alpaca's price, books checked against the account,
// integrity halt, exits, the kill switch, the switch itself). No request leaves this computer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { AlpacaPaperOrders, PAPER_HOST } from '../server/engine/broker/alpaca-paper-orders.mjs';
import { AgentHost } from '../server/engine/agents/host.mjs';
import { DEFAULT_SETTINGS, cleanSettings } from '../server/engine/agents/profile.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ft-paper-'));
const MIN = 60_000;
const T0 = Date.parse('2026-10-21T15:00:00Z'); // Wednesday 11:00 New York
const KEY = 'PKTESTKEY1234567890AB';
const SECRET = 'secretsecretsecretsecret1234';

/** A fake Alpaca paper API on 127.0.0.1. `script` can change how it answers. */
async function fakeAlpaca(script = {}) {
  const orders = [];
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      const send = (status, obj) => (res.writeHead(status, { 'content-type': 'application/json' }), res.end(JSON.stringify(obj)));
      const u = new URL(req.url, 'http://x');
      if (u.pathname === '/v2/account') return send(200, { account_number: script.account ?? 'PA1234567', status: 'ACTIVE' });
      if (u.pathname === '/v2/positions') return send(200, script.positions ?? []);
      if (req.method === 'POST' && u.pathname === '/v2/orders') {
        const o = JSON.parse(body);
        const order = { id: `o${orders.length + 1}`, client_order_id: o.client_order_id, symbol: o.symbol, side: o.side, qty: o.qty, status: 'new', filled_qty: '0', filled_avg_price: null, polls: 0 };
        orders.push(order);
        if (script.failFirstPost && orders.length === 1) return send(500, { message: 'internal' });
        return send(200, order);
      }
      if (u.pathname === '/v2/orders:by_client_order_id') {
        const o = orders.find((x) => x.client_order_id === u.searchParams.get('client_order_id'));
        return o ? send(200, o) : send(404, { message: 'not found' });
      }
      const m = /^\/v2\/orders\/(o\d+)$/.exec(u.pathname);
      if (m) {
        const o = orders.find((x) => x.id === m[1]);
        if (req.method === 'DELETE') {
          o.status = 'canceled';
          return send(204, {});
        }
        o.polls++;
        if (!script.neverFill && o.status === 'new' && o.polls >= 1) Object.assign(o, { status: 'filled', filled_qty: o.qty, filled_avg_price: String(script.price ?? 100.5) });
        return send(200, o);
      }
      if (u.pathname === '/v2/orders' && req.method === 'GET') return send(200, orders.filter((o) => o.status === 'new'));
      send(404, { message: 'no route' });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, orders, seen, close: () => new Promise((r) => server.close(r)) };
}

const client = (base) => new AlpacaPaperOrders({ keyId: KEY, secret: SECRET, base, sleep: async () => {} });

test('paper orders client: paper host only, live keys refused', () => {
  assert.equal(PAPER_HOST, 'https://paper-api.alpaca.markets');
  assert.throws(() => new AlpacaPaperOrders({ keyId: 'AKLIVE1234567890ABCD', secret: SECRET }), /live-trading key/);
  assert.throws(() => new AlpacaPaperOrders({ keyId: KEY, secret: SECRET, base: 'https://api.alpaca.markets' }), /paper host/);
  const src = fs.readFileSync(path.join(here, '..', 'server', 'engine', 'broker', 'alpaca-paper-orders.mjs'), 'utf8');
  assert.ok(!/https:\/\/api\.alpaca\.markets/.test(src), 'the live trading host appears nowhere');
});

test('paper orders client: refuses an account that is not paper, before any order', async () => {
  const fa = await fakeAlpaca({ account: '123456789' });
  try {
    await assert.rejects(client(fa.base).submit({ agentId: 'agent-a', symbol: 'AAPL', side: 'buy', qty: 0.01, key: 'k' }), /not a paper account/);
    assert.equal(fa.seen.filter((r) => r.method === 'POST').length, 0);
  } finally {
    await fa.close();
  }
});

test('paper orders client: a market order with its own id, waited for and filled; keys only in headers', async () => {
  const fa = await fakeAlpaca({ price: 201.25 });
  try {
    const r = await client(fa.base).submit({ agentId: 'agent-a', symbol: 'AAPL', side: 'buy', qty: 0.0123, key: 'agent-a|AAPL|buy|1' });
    assert.deepEqual([r.status, r.filledQty, r.avgPrice], ['filled', 0.0123, 201.25]);
    const post = fa.seen.find((x) => x.method === 'POST');
    const body = JSON.parse(post.body);
    assert.deepEqual([body.type, body.time_in_force, body.side, body.qty], ['market', 'day', 'buy', '0.0123']);
    assert.equal(body.client_order_id, AlpacaPaperOrders.clientId('agent-a', 'agent-a|AAPL|buy|1'));
    assert.match(body.client_order_id, /^ft-agent-a-[0-9a-f]{24}$/);
    assert.equal(post.headers['apca-api-key-id'], KEY);
    for (const x of fa.seen) assert.ok(!x.url.includes(KEY) && !x.url.includes(SECRET), 'no key in a URL');
  } finally {
    await fa.close();
  }
});

test('paper orders client: a retry after a failed send finds the first order instead of sending a second', async () => {
  const fa = await fakeAlpaca({ failFirstPost: true });
  try {
    const r = await client(fa.base).submit({ agentId: 'agent-b', symbol: 'MSFT', side: 'buy', qty: 0.01, key: 'same' });
    assert.equal(r.status, 'filled');
    assert.equal(fa.orders.length, 1, 'one order on the account');
    assert.equal(fa.seen.filter((x) => x.method === 'POST').length, 1);
  } finally {
    await fa.close();
  }
});

test('paper orders client: an order not filled in time is cancelled and reported as unfilled', async () => {
  const fa = await fakeAlpaca({ neverFill: true });
  try {
    const r = await client(fa.base).submit({ agentId: 'agent-c', symbol: 'NVDA', side: 'buy', qty: 0.01, key: 'k2' });
    assert.equal(r.filledQty, 0);
    assert.equal(r.status, 'canceled');
    assert.ok(fa.seen.some((x) => x.method === 'DELETE'));
  } finally {
    await fa.close();
  }
});

test('paper orders client: refused keys give a plain error without the keys', async () => {
  const server = http.createServer((req, res) => (res.writeHead(401, { 'content-type': 'application/json' }), res.end(JSON.stringify({ message: `bad ${KEY}` }))));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    await assert.rejects(client(`http://127.0.0.1:${server.address().port}`).positions(), (e) => /refused the paper keys/.test(e.message) && !e.message.includes(KEY));
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// ── the host with a fake order client ──

function bars(end, price, n = 40, last = {}) {
  const out = [];
  for (let i = n; i >= 1; i--) {
    const c = price * (1 + 0.002 * Math.sin(i));
    out.push({ t: end - i * 5 * MIN, o: c, h: c * 1.002, l: c * 0.998, c, v: 1000 });
  }
  Object.assign(out[out.length - 1], last);
  return out;
}

/** A fake AlpacaPaperOrders: fills at `fillPrice`, keeps positions, can be told to not fill. */
function fakeOrders() {
  const f = { positions: {}, sent: [], fill: true, fillPrice: null, cancelled: 0 };
  f.client = {
    async submit({ agentId, symbol, side, qty, key }) {
      f.sent.push({ agentId, symbol, side, qty, key });
      if (!f.fill) return { status: 'canceled', filledQty: 0, avgPrice: 0, clientId: 'ft-x' };
      f.positions[symbol] = Math.round(((f.positions[symbol] || 0) + (side === 'buy' ? qty : -qty)) * 1e9) / 1e9;
      if (!f.positions[symbol]) delete f.positions[symbol];
      return { status: 'filled', filledQty: qty, avgPrice: f.fillPrice ?? 200.1, clientId: AlpacaPaperOrders.clientId(agentId, key) };
    },
    async positions() {
      return { ...f.positions };
    },
    async cancelOpen() {
      f.cancelled++;
    },
  };
  return f;
}

function makeHost(script, { orders = 'alpaca-paper', withClient = true } = {}) {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'agents-settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, orders, strategies: { 'agent-a': 'signals', 'agent-b': 'signals', 'agent-c': 'signals', 'agent-d': 'signals' } }));
  const clock = { t: T0 };
  const market = { prices: { AAPL: 200, MSFT: 400 }, last: {} };
  const data = { bars: async (symbols) => Object.fromEntries(symbols.filter((s) => market.prices[s]).map((s) => [s, bars(clock.t, market.prices[s], 40, market.last[s] || {})])) };
  const fo = fakeOrders();
  const spawn = () => {
    const p = new EventEmitter();
    p.send = (m) => setImmediate(() => p.emit('message', { type: 'proposals', t: m.t, items: script(p.id, m) }));
    p.kill = () => {};
    return p;
  };
  const host = new AgentHost({
    dataDir: dir,
    getUniverse: () => ['AAPL', 'MSFT'],
    getData: () => data,
    getOrders: () => (withClient ? fo.client : null),
    getFx: () => ({ rate: 1, date: '2026-10-21', source: 'test' }),
    now: () => clock.t,
    spawn: (id) => Object.assign(spawn(), { id }),
    log: { warn() {} },
  });
  return { host, clock, market, fo };
}
const buy = (symbol) => ({ symbol, action: 'buy', signal: 'stop_run', score: 0.9 });

test('settings: orders are "sim" unless the owner picks the Alpaca paper account; nothing else is accepted', () => {
  assert.equal(DEFAULT_SETTINGS.orders, 'sim');
  assert.equal(cleanSettings({ orders: 'alpaca-paper' }).orders, 'alpaca-paper');
  assert.equal(cleanSettings({ orders: 'alpaca-live' }).orders, 'sim');
  assert.equal(cleanSettings({}).orders, 'sim', 'old settings files stay simulated');
});

test('host: with Alpaca paper orders a buy goes to the account and is booked at its real fill', async () => {
  const { host, fo } = makeHost((id, m) => (id === 'agent-a' && m.t === T0 ? [buy('AAPL')] : []));
  host.manager.sandboxes.get('agent-a'); // opened
  const st = await host.tick();
  assert.equal(st.lastError, '');
  assert.equal(fo.sent.length, 1);
  assert.equal(fo.sent[0].side, 'buy');
  const a = st.agents.find((x) => x.id === 'agent-a');
  assert.equal(a.positions.length, 1);
  const fill = host.sandbox('agent-a').broker.fills.at(-1);
  assert.equal(fill.price, 200.1, 'Alpaca\'s price, no simulated slippage');
  assert.match(fill.why, /Alpaca paper ft-agent-a-/);
  assert.ok(host.audit.tail(20).some((e) => e.type === 'fill' && e.reason === 'filled on the Alpaca paper account'));
  assert.equal(st.integrity, null, 'books and account agree');
  assert.equal(st.orders, 'alpaca-paper');
  host.stop();
});

test('host: an unfilled buy books nothing; the books still match the account', async () => {
  const { host, fo } = makeHost((id, m) => (id === 'agent-a' && m.t === T0 ? [buy('AAPL')] : []));
  fo.fill = false;
  const st = await host.tick();
  assert.equal(st.agents[0].positions.length, 0);
  assert.ok(host.audit.tail(20).some((e) => e.type === 'refused' && /did not fill/.test(e.reason)));
  assert.equal(st.integrity, null);
  host.stop();
});

test('host: when the account and the books differ, everything stops, open orders are cancelled and nothing is sold', async () => {
  const { host, clock, fo } = makeHost((id, m) => (id === 'agent-a' && m.t === T0 ? [buy('AAPL')] : []));
  await host.tick();
  fo.positions.AAPL += 1; // someone bought AAPL on the account by hand
  clock.t += 5 * MIN;
  const st = await host.tick();
  assert.match(st.integrity.reason, /paper account holds .* AAPL/);
  assert.equal(fo.cancelled, 1);
  assert.equal(fo.sent.filter((o) => o.side === 'sell').length, 0, 'the books are not trusted to sell from');
  assert.equal(st.agents[0].positions.length, 1);
  host.stop();
});

test('host: a stock already on the account outside the agents is locked', async () => {
  const { host, fo } = makeHost((id, m) => (id === 'agent-a' && m.t === T0 ? [buy('MSFT')] : []));
  fo.positions.MSFT = 3;
  const st = await host.tick();
  assert.equal(st.agents[0].positions.length, 0);
  assert.ok(host.audit.tail(20).some((e) => e.type === 'refused' && e.symbol === 'MSFT' && /paper account \(not an agent\)/.test(e.reason)));
  assert.deepEqual(st.account.foreign, ['MSFT']);
  assert.equal(st.integrity, null);
  host.stop();
});

test('host: exits sell on the account; an unfilled sell keeps the position for the next tick', async () => {
  const { host, clock, market, fo } = makeHost((id, m) => (id === 'agent-a' && m.t === T0 ? [buy('AAPL')] : []));
  await host.tick();
  const plan = host.state.agents['agent-a'].plans.AAPL;
  fo.fill = false;
  clock.t += 5 * MIN;
  market.last.AAPL = { l: plan.stop - 0.5, o: 200 };
  let st = await host.tick();
  assert.equal(st.agents[0].positions.length, 1, 'not filled: still held');
  assert.ok(host.state.agents['agent-a'].plans.AAPL, 'its plan stays');
  fo.fill = true;
  fo.fillPrice = plan.stop - 0.4;
  clock.t += 5 * MIN;
  market.last.AAPL = { l: plan.stop - 0.5, o: 199 };
  st = await host.tick();
  assert.equal(st.agents[0].positions.length, 0);
  assert.equal(host.sandbox('agent-a').broker.fills.at(-1).price, plan.stop - 0.4);
  assert.deepEqual(fo.positions, {});
  assert.equal(st.integrity, null);
  host.stop();
});

test('host: the kill switch sells every agent position on the account', async () => {
  const { host, fo } = makeHost((id, m) => (id === 'agent-a' && m.t === T0 ? [buy('AAPL')] : id === 'agent-b' && m.t === T0 ? [buy('MSFT')] : []));
  await host.tick();
  host.kill('test');
  await host.settle();
  assert.deepEqual(fo.positions, {});
  assert.equal(fo.sent.filter((o) => o.side === 'sell').length, 2);
  assert.equal(host.status().agents.every((a) => a.positions.length === 0), true);
  host.stop();
});

test('host: the kill switch before any tick still sells on the account, not just in the books', async () => {
  const { host, fo } = makeHost((id, m) => (id === 'agent-a' && m.t === T0 ? [buy('AAPL')] : []));
  await host.tick();
  host.orders = null; // as after a restart, before the first tick
  host.kill('test');
  await host.settle();
  assert.deepEqual(fo.positions, {});
  assert.equal(host.status().agents[0].positions.length, 0);
  host.stop();
});

test('host: where orders go can only change while no agent holds a position; no paper keys means no trading', async () => {
  const { host } = makeHost((id, m) => (id === 'agent-a' && m.t === T0 ? [buy('AAPL')] : []));
  await host.tick();
  assert.throws(() => host.updateSettings({ orders: 'sim' }), /no agent holds a position/);
  assert.equal(host.settings.orders, 'alpaca-paper');
  host.stop();
  const b = makeHost(() => [buy('AAPL')], { withClient: false });
  const st = await b.host.tick();
  assert.match(st.lastError, /no paper keys/);
  assert.equal(st.agents.every((a) => a.positions.length === 0), true);
  b.host.stop();
});

test('host: with simulated orders nothing reaches the order client', async () => {
  const { host, fo } = makeHost((id, m) => (id === 'agent-a' && m.t === T0 ? [buy('AAPL')] : []), { orders: 'sim' });
  const st = await host.tick();
  assert.equal(st.agents[0].positions.length, 1);
  assert.equal(fo.sent.length, 0);
  host.stop();
});
