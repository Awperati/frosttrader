// LIVE trading (real money), tested only against a fake Alpaca on 127.0.0.1: no request leaves this
// computer and no test can place a real order. The live key store, the live adapter, the owner's signed
// enablement, the API's step-up and checks, and the live desk inside the host (only agents switched to
// live, v11's spread and exits, reconciliation, the kill switch).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { LiveKeys } from '../server/live-keys.mjs';
import { AlpacaLive, LIVE_HOST } from '../server/engine/broker/alpaca-live.mjs';
import { Enablement, LIVE_PROPOSED, LIVE_HARD, phraseFor } from '../server/engine/live/enablement.mjs';
import { LiveDesk, accountProblem } from '../server/engine/live/desk.mjs';
import { createLiveApi } from '../server/live-api.mjs';
import { Auth } from '../server/auth.mjs';
import { AgentHost } from '../server/engine/agents/host.mjs';
import { DEFAULT_SETTINGS } from '../server/engine/agents/profile.mjs';
import { AlpacaKeys } from '../server/alpaca-keys.mjs';
import { loadModel } from '../server/engine/models/v11.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ft-live-'));
const MIN = 60_000;
const T0 = Date.parse('2026-10-21T15:00:00Z'); // Wednesday 11:00 New York
const KEY = 'AKTESTLIVEKEY1234567';
const SECRET = 'livesecretlivesecret1234';
const local = { host: '127.0.0.1:8787', 'content-type': 'application/json' };
const ALL_CONFIRMED = Object.keys(LIVE_HARD);

/** A fake Alpaca LIVE API on 127.0.0.1. Orders fill at once at `fillPrice` (or stay open with neverFill). */
async function fakeLive(opts = {}) {
  const st = { orders: [], positions: {}, seen: [], account: { account_number: '987654321', status: 'ACTIVE', currency: 'USD', multiplier: '1', cash: '100', non_marginable_buying_power: '100', pattern_day_trader: false, shorting_enabled: false, daytrade_count: 0, ...(opts.account || {}) }, fillPrice: opts.fillPrice ?? 60, neverFill: false };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      st.seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      const send = (s, o) => (res.writeHead(s, { 'content-type': 'application/json' }), res.end(JSON.stringify(o)));
      const u = new URL(req.url, 'http://x');
      if (u.pathname === '/v2/account') return send(200, st.account);
      if (u.pathname === '/v2/positions' && req.method === 'GET') return send(200, Object.entries(st.positions).map(([symbol, qty]) => ({ symbol, qty: String(qty), avg_entry_price: String(st.fillPrice), side: 'long' })));
      if (u.pathname === '/v2/positions' && req.method === 'DELETE') {
        st.positions = {};
        st.closedAll = (st.closedAll || 0) + 1;
        return send(207, []);
      }
      if (u.pathname === '/v2/orders' && req.method === 'DELETE') return send(207, []);
      if (u.pathname === '/v2/orders' && req.method === 'POST') {
        const o = JSON.parse(body);
        if (st.orders.some((x) => x.client_order_id === o.client_order_id)) return send(422, { message: 'client_order_id must be unique' });
        const qty = o.side === 'buy' ? Math.floor((Number(o.notional) / st.fillPrice) * 1e9) / 1e9 : Number(o.qty);
        const order = { id: `o${st.orders.length + 1}`, client_order_id: o.client_order_id, symbol: o.symbol, side: o.side, notional: o.notional, status: st.neverFill ? 'new' : 'filled', filled_qty: st.neverFill ? '0' : String(qty), filled_avg_price: st.neverFill ? null : String(st.fillPrice) };
        st.orders.push(order);
        if (!st.neverFill) st.positions[o.symbol] = Math.round(((st.positions[o.symbol] || 0) + (o.side === 'buy' ? qty : -qty)) * 1e9) / 1e9;
        if (!st.positions[o.symbol]) delete st.positions[o.symbol];
        return send(200, order);
      }
      if (u.pathname === '/v2/orders:by_client_order_id') {
        const o = st.orders.find((x) => x.client_order_id === u.searchParams.get('client_order_id'));
        return o ? send(200, o) : send(404, { message: 'not found' });
      }
      send(404, { message: 'no route' });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  st.base = `http://127.0.0.1:${server.address().port}`;
  st.close = () => new Promise((r) => server.close(r));
  return st;
}

function liveKeysFor(dir, base) {
  const k = new LiveKeys({ dataDir: dir, brokerOpts: { base } });
  k.update({ keyId: KEY, secret: SECRET });
  return k;
}

// ── keys, adapter, enablement ──

test('live keys: only AK keys, kept in their own file, never shown; the paper store refuses them', () => {
  const dir = tmp();
  const k = new LiveKeys({ dataDir: dir });
  assert.throws(() => k.update({ keyId: 'PKPAPERKEY1234567890', secret: SECRET }), /not a live key/);
  k.update({ keyId: KEY, secret: SECRET });
  assert.ok(fs.existsSync(path.join(dir, 'alpaca-live-keys.json')));
  assert.ok(!JSON.stringify(k.status()).includes(KEY) && !JSON.stringify(k.status()).includes(SECRET));
  const paper = new AlpacaKeys({ dataDir: dir });
  assert.throws(() => paper.update({ keyId: KEY, secret: SECRET }), /live-trading key/);
});

test('live adapter: the real host is fixed; only 127.0.0.1 is accepted for tests', () => {
  assert.equal(LIVE_HOST, 'api.alpaca.markets');
  assert.throws(() => new AlpacaLive({ keyId: KEY, secret: SECRET, base: 'https://paper-api.alpaca.markets' }), /fixed/);
  assert.throws(() => new AlpacaLive({ keyId: KEY, secret: SECRET, base: 'http://192.168.1.5:80' }), /fixed/);
});

test('enablement: signed with a key from his password; an edit, another password or none at all means off; lower only', () => {
  const dir = tmp();
  const key = Buffer.from('a'.repeat(32));
  const en = new Enablement({ dataDir: dir, keyFor: () => key });
  assert.equal(en.read(), null, 'off by default');
  en.write({ account: '987654321', limits: LIVE_PROPOSED, confirmed: ALL_CONFIRMED, rate: null });
  assert.equal(en.read().account, '4321');
  assert.deepEqual(en.read().limits, LIVE_PROPOSED);
  assert.throws(() => en.lower({ perAgentAud: 200 }), /only be lowered/);
  assert.equal(en.lower({ perAgentAud: 50 }).limits.perAgentAud, 50);
  const file = path.join(dir, 'owner', 'live-enablement.json');
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...rec, limits: { ...rec.limits, perAgentAud: 250 } }));
  assert.equal(en.read(), null, 'a hand edit voids it');
  fs.writeFileSync(file, JSON.stringify(rec));
  assert.equal(new Enablement({ dataDir: dir, keyFor: () => Buffer.from('b'.repeat(32)) }).read(), null, 'another password voids it');
  assert.equal(new Enablement({ dataDir: dir }).read(), null, 'no sign-in: off');
  en.revoke('test');
  assert.equal(en.read(), null);
});

test('account checks: a margin, PDT, blocked, non-USD or different account keeps live off', () => {
  const ok = { number: '987654321', currency: 'USD', blocked: false, pdt: false, multiplier: '1', shorting: false };
  assert.equal(accountProblem(ok, '4321'), '');
  assert.match(accountProblem({ ...ok, multiplier: '2' }, '4321'), /margin/);
  assert.match(accountProblem({ ...ok, pdt: true }, '4321'), /pattern day trader/);
  assert.match(accountProblem({ ...ok, blocked: true }, '4321'), /blocked/);
  assert.match(accountProblem({ ...ok, currency: 'AUD' }, '4321'), /currency/);
  assert.match(accountProblem(ok, '1111'), /different account/);
});

// ── the API ──

async function apiSetup({ account } = {}) {
  const dir = tmp();
  const fl = await fakeLive({ account });
  const keys = liveKeysFor(dir, fl.base);
  fs.mkdirSync(path.join(dir, 'owner'), { recursive: true });
  const auth = new Auth(path.join(dir, 'owner'), 'owner-password', { enabled: false, check: () => false });
  const enablement = new Enablement({ dataDir: dir, keyFor: () => auth.secretFor('live-enablement') });
  const writes = [];
  const desk = new LiveDesk({ dataDir: dir, enablement, broker: () => keys.broker(), getFx: () => ({ rate: 0.7, date: '2026-10-21' }), audit: { write: (e) => writes.push(e) }, params: () => DEFAULT_SETTINGS.params['agent-a'], running: () => true });
  const api = createLiveApi({ desk, keys, enablement, auth, getFx: () => ({ rate: 0.7, date: '2026-10-21' }) });
  return { dir, fl, keys, auth, enablement, desk, api, writes };
}

test('API: switching live on needs this computer, his password, the right phrase and every limit confirmed', async () => {
  const s = await apiSetup();
  try {
    const call = (route, body, headers = local) => s.api.handle(route.split(' ')[0], route.split(' ')[1], headers, body, '127.0.0.1');
    await assert.rejects(call('POST /api/live/enable', { password: 'owner-password', phrase: 'TRADE LIVE 4321', confirmed: ALL_CONFIRMED }, { host: 'evil.example', 'content-type': 'application/json' }), (e) => e.status === 403);
    await assert.rejects(call('POST /api/live/enable', { password: 'wrong', phrase: 'TRADE LIVE 4321', confirmed: ALL_CONFIRMED }), (e) => e.status === 401 || /Wrong password/.test(e.message));
    await assert.rejects(call('POST /api/live/enable', { password: 'owner-password', phrase: 'TRADE LIVE 0000', confirmed: ALL_CONFIRMED }), /phrase does not match/);
    await assert.rejects(call('POST /api/live/enable', { password: 'owner-password', phrase: 'TRADE LIVE 4321', confirmed: ['perAgentAud'] }), /Confirm every limit/);
    assert.equal(s.enablement.read(), null);
    assert.equal(phraseFor('987654321'), 'TRADE LIVE 4321');
    await assert.rejects(call('POST /api/live/enable', { password: 'owner-password', phrase: 'TRADE LIVE 4321', confirmed: ALL_CONFIRMED, limits: LIVE_PROPOSED }), /CASH account/);
    const out = await call('POST /api/live/enable', { password: 'owner-password', phrase: 'TRADE LIVE 4321', confirmed: ALL_CONFIRMED, limits: LIVE_PROPOSED, cashAccount: true });
    assert.equal(out.body.enabled, true);
    assert.deepEqual(out.body.limits, LIVE_PROPOSED);
    assert.ok(!JSON.stringify(out.body).includes(KEY) && !JSON.stringify(out.body).includes(SECRET), 'no key in the answer');
    assert.equal(s.fl.seen.filter((r) => r.method === 'POST').length, 0, 'switching on placed no order');
    // switching off closes everything and voids the enablement
    const off = await call('POST /api/live/disable', {});
    assert.equal(off.body.enabled, false);
    assert.ok(s.fl.closedAll >= 1);
  } finally {
    await s.fl.close();
  }
});

test('API: a margin account, or a server without his sign-in, keeps live off', async () => {
  const s = await apiSetup({ account: { multiplier: '2' } });
  try {
    await assert.rejects(s.api.handle('POST', '/api/live/enable', local, { password: 'owner-password', phrase: 'TRADE LIVE 4321', confirmed: ALL_CONFIRMED, cashAccount: true }, '127.0.0.1'), /margin account/);
    const noAuth = createLiveApi({ desk: s.desk, keys: s.keys, enablement: s.enablement, auth: null });
    await assert.rejects(noAuth.handle('POST', '/api/live/enable', local, { password: 'x' }, '127.0.0.1'), (e) => e.status === 403 && /sign-in is not set up/.test(e.message));
  } finally {
    await s.fl.close();
  }
});

// ── the desk inside the host ──

function bars(end, price, n = 40, last = {}) {
  const out = [];
  for (let i = n; i >= 1; i--) {
    const c = price * (1 + 0.002 * Math.sin(i));
    out.push({ t: end - i * 5 * MIN, o: c, h: c * 1.002, l: c * 0.998, c, v: 1000 });
  }
  Object.assign(out[out.length - 1], last);
  return out;
}

/** Ten weekdays of paper decision logs for every agent (the 10-paper-day rule before live). */
function seedPaperDays(dir, n = 10) {
  const days = [];
  for (let d = new Date('2026-10-20T12:00:00Z'); days.length < n; d.setUTCDate(d.getUTCDate() - 1)) if (d.getUTCDay() % 6) days.push(d.toISOString().slice(0, 10));
  for (const id of ['agent-a', 'agent-b', 'agent-c', 'agent-d']) {
    fs.mkdirSync(path.join(dir, 'agents', id), { recursive: true });
    for (const day of days) fs.writeFileSync(path.join(dir, 'agents', id, `decisions-${day}.jsonl`), '{}\n');
  }
}

async function liveHost({ live = { 'agent-a': true }, script, enable = true, account, paperDays = 10 } = {}) {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'agents-settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, strategies: { 'agent-a': 'v11', 'agent-b': 'v11', 'agent-c': 'v11', 'agent-d': 'v11' } }));
  const fl = await fakeLive({ account });
  const keys = liveKeysFor(dir, fl.base);
  const enablement = new Enablement({ dataDir: dir, keyFor: () => Buffer.from('k'.repeat(32)) });
  if (enable) enablement.write({ account: '987654321', limits: LIVE_PROPOSED, confirmed: ALL_CONFIRMED, rate: null, cashAccount: true });
  const clock = { t: T0 };
  const market = { prices: { FLEX: 60, ADI: 250 }, last: {} };
  const data = { bars: async (symbols) => Object.fromEntries(symbols.filter((s) => market.prices[s]).map((s) => [s, bars(clock.t, market.prices[s], 40, market.last[s] || {})])) };
  const spawn = () => {
    const p = new EventEmitter();
    p.send = (m) => setImmediate(() => p.emit('message', { type: 'proposals', t: m.t, items: script(m) }));
    p.kill = () => {};
    return p;
  };
  const fx = { rate: 0.7, date: '2026-10-21', source: 'test' };
  let host = null;
  const desk = new LiveDesk({
    dataDir: dir,
    enablement,
    broker: () => keys.broker(),
    getFx: () => fx,
    audit: { write: (e) => host.audit.write(e) },
    now: () => clock.t,
    params: (id) => host.settings.params[id],
    running: (id) => host.running().includes(id) && host.settings.live?.[id] === true,
    strategy: (id) => host.strategyOf(id),
    allowed: (id, universe) => new Set([...universe, ...loadModel().universe]),
  });
  host = new AgentHost({ dataDir: dir, getUniverse: () => ['ADI'], getData: () => data, getFx: () => fx, now: () => clock.t, spawn, live: desk, log: { warn() {} } });
  seedPaperDays(dir, paperDays); // after the host opened the sandboxes (it sets aside unknown agent folders)
  try {
    if (enable && live) host.updateSettings({ live });
  } catch (e) {
    host.stop();
    await fl.close();
    throw e;
  }
  return { host, desk, fl, clock, market, dir };
}
const v11buy = (symbol, score) => ({ symbol, action: 'buy', signal: 'model_v11', score });

test('host + desk: only agents switched to live buy live, by dollar amount within his limits', async () => {
  const s = await liveHost({ script: (m) => (m.t === T0 ? [v11buy('FLEX', 0.65)] : []) });
  try {
    const st = await s.host.tick();
    const posts = s.fl.seen.filter((r) => r.method === 'POST').map((r) => JSON.parse(r.body));
    assert.equal(posts.length, 1, 'one live order');
    assert.equal(posts[0].side, 'buy');
    assert.equal(posts[0].symbol, 'FLEX');
    assert.ok(Number(posts[0].notional) <= LIVE_PROPOSED.perOrderAud * 0.7 + 1e-9, `notional ${posts[0].notional} within A$${LIVE_PROPOSED.perOrderAud}`);
    assert.match(posts[0].client_order_id, /^ft-agent-a-2026-10-21-\d+$/);
    assert.ok(st.live.agents.find((a) => a.id === 'agent-a').positions.some((p) => p.symbol === 'FLEX'), 'booked in agent-a\'s live sub-ledger');
    assert.equal(st.live.stopped, null);
    // paper still traded too (live is on top of paper)
    assert.ok(st.agents.some((a) => a.positions.some((p) => p.symbol === 'FLEX')));
    const audit = fs.readFileSync(path.join(s.dir, 'audit.jsonl'), 'utf8');
    assert.ok(!audit.includes(KEY) && !audit.includes(SECRET), 'no key in the audit log');
    assert.equal(s.host.audit.verify().ok, true, 'one hash chain for paper and live');
  } finally {
    s.host.stop();
    await s.fl.close();
  }
});

test('host + desk: nothing goes live without the enablement, and no agent can be switched to live before it', async () => {
  const s = await liveHost({ enable: false, script: () => [v11buy('FLEX', 0.65)] });
  try {
    assert.throws(() => s.host.updateSettings({ live: { 'agent-a': true } }), /Switch live trading on first/);
    await s.host.tick();
    assert.equal(s.fl.seen.filter((r) => r.method === 'POST').length, 0);
  } finally {
    s.host.stop();
    await s.fl.close();
  }
});

test('host + desk: v11\'s trailing exit sells live; the kill switch closes everything and stops live', async () => {
  const s = await liveHost({ script: (m) => (m.t === T0 ? [v11buy('FLEX', 0.65)] : []) });
  try {
    await s.host.tick();
    const plan = s.desk.state.agents['agent-a'].plans.FLEX;
    assert.ok(plan.trailPct > 0 && plan.target === null, 'v11 plan');
    s.clock.t += 5 * MIN;
    s.market.last.FLEX = { o: 60, h: 60, l: 50, c: 50 }; // a close far under the trail
    s.fl.fillPrice = 50;
    await s.host.tick();
    const sells = s.fl.seen.filter((r) => r.method === 'POST').map((r) => JSON.parse(r.body)).filter((o) => o.side === 'sell');
    assert.equal(sells.length, 1, 'one live sell');
    assert.equal(Object.keys(s.desk.state.agents['agent-a'].positions).length, 0);
    // buy again, then the kill switch
    s.clock.t += 5 * MIN;
    s.desk.state.agents['agent-a'].day.buys = 0;
    s.fl.fillPrice = 60;
    const again = await liveHost({ script: (m) => [v11buy('FLEX', 0.65)] });
    try {
      await again.host.tick();
      assert.ok(Object.keys(again.fl.positions).length, 'holds FLEX live');
      again.host.kill('test');
      await again.host.settle();
      assert.ok(again.fl.closedAll >= 1, 'close-all sent to the live account');
      assert.match(again.desk.state.stopped.reason, /kill switch/);
    } finally {
      again.host.stop();
      await again.fl.close();
    }
  } finally {
    s.host.stop();
    await s.fl.close();
  }
});

test('host + desk: a live account that differs from the books stops live at once', async () => {
  const s = await liveHost({ script: (m) => (m.t === T0 ? [v11buy('FLEX', 0.65)] : []) });
  try {
    await s.host.tick();
    s.fl.positions.ADI = 3; // bought by hand on the live account
    s.clock.t += 5 * MIN;
    const st = await s.host.tick();
    assert.match(st.live.stopped.reason, /integrity: ADI/);
    assert.ok(s.fl.closedAll >= 1);
  } finally {
    s.host.stop();
    await s.fl.close();
  }
});

test('host + desk: settled cash (check 18) and day trades (check 19) refuse buys', async () => {
  const s = await liveHost({ account: { cash: '0.50', non_marginable_buying_power: '0.50' }, script: () => [v11buy('FLEX', 0.65)] });
  try {
    await s.host.tick();
    assert.equal(s.fl.seen.filter((r) => r.method === 'POST').length, 0);
    assert.ok(s.host.audit.tail(40).some((e) => e.type === 'live-refused' && e.check === '18'));
  } finally {
    s.host.stop();
    await s.fl.close();
  }
  const d = await liveHost({ account: { daytrade_count: 3 }, script: () => [v11buy('FLEX', 0.65)] });
  try {
    // a confirmed CASH account: the day-trade rule (margin only) does not stop it
    await d.host.tick();
    assert.equal(d.fl.seen.filter((r) => r.method === 'POST').length, 1);
    // without that confirmation: 3 day trades in 5 days refuse the next buy
    const en = new Enablement({ dataDir: d.dir, keyFor: () => Buffer.from('k'.repeat(32)) });
    en.write({ account: '987654321', limits: LIVE_PROPOSED, confirmed: ALL_CONFIRMED, rate: null, cashAccount: false });
    d.desk.state.agents['agent-a'].positions = {};
    d.fl.positions = {};
    d.clock.t += 5 * MIN;
    await d.host.tick();
    assert.ok(d.host.audit.tail(60).some((e) => e.type === 'live-refused' && e.check === '19'));
  } finally {
    d.host.stop();
    await d.fl.close();
  }
});

test('host: an agent can be switched to live only after 10 paper trading days here; the count is shown', async () => {
  await assert.rejects(liveHost({ paperDays: 6, script: () => [] }), /agent-a has 6 of 10 paper trading days/);
  const s = await liveHost({ paperDays: 10, script: () => [] });
  try {
    const st = s.host.status();
    const a = st.agents.find((x) => x.id === 'agent-a');
    assert.deepEqual([a.paperDays, a.paperDaysNeeded, a.live], [10, 10, true]);
  } finally {
    s.host.stop();
    await s.fl.close();
  }
});

test('limits: A$100 per agent (his words), the rest scaled from his earlier set; all under the hard caps', () => {
  assert.deepEqual(LIVE_PROPOSED, { perAgentAud: 100, totalAud: 400, perOrderAud: 25, buysPerDay: 6, perAgentDayAud: 200, allDayAud: 800, agentDailyLossAud: 3, allDailyLossAud: 8, agentDrawdownAud: 10, totalDrawdownAud: 40 });
  for (const [k, v] of Object.entries(LIVE_PROPOSED)) assert.ok(v <= LIVE_HARD[k], k);
});
