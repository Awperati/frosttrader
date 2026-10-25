// Tests for the paper agents: fractional shares, gate check 17, the settings, the IPC check, the audit
// log, Alpaca market data and keys, the host (entries, exits, halts, kill, integrity, settings), a
// property test over random proposals, and the child-process isolation. No network, no market
// hours: the clock, the market data and (mostly) the agent processes are fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RiskGuard, agentCapital, positionSize, goodQty } from '../server/engine/risk.mjs';
import { SimBroker } from '../server/engine/broker/sim.mjs';
import { cleanSettings, limitsFor, MEDIUM, DEFAULT_SETTINGS, AGENT_IDS } from '../server/engine/agents/profile.mjs';
import { checkAgentMessage } from '../server/engine/agents/ipc.mjs';
import { AuditLog } from '../server/engine/agents/audit.mjs';
import { AgentHost, childOptions, spawnAgent, SIT_OUT_DAYS, CLEAN_DAYS_TO_FULL } from '../server/engine/agents/host.mjs';
import { AlpacaData } from '../server/engine/data/alpaca-data.mjs';
import { AlpacaKeys } from '../server/alpaca-keys.mjs';
import { createAgentsApi } from '../server/agents-api.mjs';
import { rng } from '../server/engine/stats.mjs';
import { FxRate, STALE_DAYS } from '../server/engine/data/fx.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ft-agents-'));
const MIN = 60_000;
// Wednesday 21 Oct 2026, 11:00 New York (15:00 UTC): inside the entry window
const T0 = Date.parse('2026-10-21T15:00:00Z');

// ── fractional shares, check 17 ──

test('fractional shares: 4 decimals, at least $1 a buy, only where asked for', () => {
  assert.equal(goodQty(0.1234, true), true);
  assert.equal(goodQty(0.12345, true), false);
  assert.equal(goodQty(0.5, false), false);
  const g = new RiskGuard({ ...limitsFor(10, MEDIUM) }, { fractional: true });
  g.startDay('d', 10);
  const acct = { cash: 10, equity: 10, positions: {} };
  assert.equal(g.check({ symbol: 'AAPL', side: 'buy', qty: 0.01, price: 230 }, acct).ok, true);
  assert.match(g.check({ symbol: 'AAPL', side: 'buy', qty: 0.004, price: 230 }, acct).reason, /\$1 minimum/);
  assert.match(new RiskGuard().check({ symbol: 'AAPL', side: 'buy', qty: 0.5, price: 10 }, acct).reason, /whole number/);
  const qty = positionSize({ equity: 10, cash: 10, price: 230, stop: 228, limits: limitsFor(10, MEDIUM), fractional: true });
  assert.ok(qty > 0 && qty * 230 <= 2.5 + 1e-9, `qty ${qty}: at most 25 % of $10`);
  assert.equal(positionSize({ equity: 10, cash: 10, price: 230, stop: 228, limits: limitsFor(10, MEDIUM) }), 0, 'whole shares: nothing fits at $10');
  const b = new SimBroker({ cash: 10, fractional: true, slippageBps: 0 });
  b.submit({ symbol: 'AAPL', side: 'buy', qty: 0.0103, price: 200 });
  b.submit({ symbol: 'AAPL', side: 'sell', qty: 0.0103, price: 210 });
  assert.deepEqual(b.positions, {});
  assert.ok(Math.abs(b.cash - (10 + 0.0103 * 10)) < 1e-9);
});

test('gate check 17 (AGENT_CAPITAL): watchlist only, symbol lock, own cash and allocation; sells always pass', () => {
  const base = { agentId: 'agent-a', cash: 10, exposure: 0, allocation: 10, universe: new Set(['AAPL', 'MSFT']) };
  const buy = (o) => ({ symbol: 'AAPL', side: 'buy', qty: 0.01, price: 200, ...o });
  assert.equal(agentCapital({ ...base, order: buy() }).ok, true);
  assert.match(agentCapital({ ...base, order: buy({ symbol: 'TSLA' }) }).reason, /AGENT_CAPITAL: TSLA is not on the watchlist/);
  assert.match(agentCapital({ ...base, order: buy(), lockedBy: 'agent-b' }).reason, /held by agent agent-b/);
  assert.equal(agentCapital({ ...base, order: buy(), lockedBy: 'agent-a' }).ok, true, 'its own position: adding is fine');
  assert.match(agentCapital({ ...base, cash: 1, order: buy() }).reason, /more than its free cash/);
  assert.match(agentCapital({ ...base, exposure: 9, order: buy() }).reason, /past its allocation/);
  assert.equal(agentCapital({ ...base, universe: new Set(), order: { symbol: 'TSLA', side: 'sell', qty: 1, price: 1 } }).ok, true);
});

test('settings: clamped to their bounds; dollar halts scale with the paper money', () => {
  const s = cleanSettings({ agentsAtOnce: 9, paperPerAgent: 5000, preset: { riskPerTrade: 5, drawdownPct: -1 }, params: { 'agent-a': { entryScore: 0.1, maxHold: 999 } } });
  assert.equal(s.agentsAtOnce, 4);
  assert.equal(s.paperPerAgent, 1000);
  assert.equal(s.preset.riskPerTrade, 0.01);
  assert.equal(s.preset.drawdownPct, 0.02);
  assert.equal(s.params['agent-a'].entryScore, 0.5);
  assert.equal(s.params['agent-a'].maxHold, 48);
  assert.deepEqual(s.params['agent-b'], DEFAULT_SETTINGS.params['agent-b']);
  assert.equal(DEFAULT_SETTINGS.paperPerAgent, 10);
  assert.equal(limitsFor(10, MEDIUM).maxDailyLoss, 0.3);
  assert.equal(limitsFor(250, MEDIUM).maxDailyLoss, 7.5);
  assert.equal(limitsFor(250, MEDIUM, 0.5).riskPerTrade, MEDIUM.riskPerTrade / 2);
});

test('IPC: only known messages and fields; buys only; the host never trusts an agent id in a body', () => {
  assert.equal(checkAgentMessage({ type: 'ready' }).ok, true);
  const ok = checkAgentMessage({ type: 'proposals', t: 1, items: [{ symbol: 'AAPL', action: 'buy', signal: 'stop_run', score: 0.7 }] });
  assert.deepEqual(ok.msg.items, [{ symbol: 'AAPL', action: 'buy', signal: 'stop_run', score: 0.7 }]);
  for (const bad of [
    null,
    [],
    { type: 'order', symbol: 'AAPL' },
    { type: 'ready', agent: 'agent-b' },
    { type: 'proposals', t: 1, items: [{ symbol: 'AAPL', action: 'sell', signal: 'x', score: 0.5 }] },
    { type: 'proposals', t: 1, items: [{ symbol: 'BTC/USD', action: 'buy', signal: 'x', score: 0.5 }] },
    { type: 'proposals', t: 1, items: [{ symbol: 'AAPL', action: 'buy', signal: 'x', score: 2 }] },
    { type: 'proposals', t: 1, items: [{ symbol: 'AAPL', action: 'buy', signal: 'x', score: 0.5, qty: 1000 }] },
    { type: 'proposals', t: 1, items: Array(11).fill({ symbol: 'AAPL', action: 'buy', signal: 'x', score: 0.5 }) },
  ]) assert.equal(checkAgentMessage(bad).ok, false, JSON.stringify(bad));
});

test('audit log: a hash chain that spots an edited or deleted line', () => {
  const dir = tmp();
  const log = new AuditLog({ dir });
  for (let i = 0; i < 5; i++) log.write({ type: 'fill', agent: 'agent-a', i });
  assert.deepEqual(log.verify(), { ok: true, lines: 5, brokenAt: null });
  assert.equal(log.tail(2)[0].i, 4);
  const again = new AuditLog({ dir });
  again.write({ type: 'more' });
  assert.equal(again.verify().ok, true, 'reopening continues the chain');
  const lines = fs.readFileSync(log.file, 'utf8').split('\n');
  lines[2] = lines[2].replace('"i":2', '"i":99');
  fs.writeFileSync(log.file, lines.join('\n'));
  assert.equal(log.verify().brokenAt, 4);
});

// ── Alpaca market data and keys ──

async function fakeAlpaca(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    handler(req, res, seen.length);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() };
}
const KEY = 'PKTESTFAKEKEY0000001';
const SECRET = 'fakeSecretForTests0123456789abcdefghij';

test('Alpaca data: bars with paging, keys only in headers, backoff on 429, errors without keys', async () => {
  const fa = await fakeAlpaca((req, res, n) => {
    if (req.url.includes('/v2/stocks/bars/latest')) return res.end(JSON.stringify({ bars: { SPY: { t: '2026-10-21T15:00:00Z', c: 580.1 } } }));
    if (n === 1) return res.writeHead(429, { 'retry-after': '1' }).end('{}');
    const page2 = req.url.includes('page_token=p2');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(page2 ? { bars: { AAPL: [{ t: '2026-10-21T14:55:00Z', o: 2, h: 3, l: 1, c: 2.5, v: 10 }] } } : { bars: { AAPL: [{ t: '2026-10-21T14:50:00Z', o: 1, h: 2, l: 1, c: 2, v: 5 }], MSFT: [{ t: '2026-10-21T14:50:00Z', o: 1, h: 1, l: 0, c: 0, v: 0 }] }, next_page_token: 'p2' }));
  });
  try {
    const slept = [];
    const d = new AlpacaData({ keyId: KEY, secret: SECRET, base: fa.base, sleep: async (ms) => void slept.push(ms) });
    const bars = await d.bars(['AAPL', 'MSFT'], { start: T0 - 3600_000 });
    assert.deepEqual(bars.AAPL.map((b) => b.c), [2, 2.5]);
    assert.equal(bars.MSFT, undefined, 'a bar with a zero close is dropped');
    assert.deepEqual(slept, [1000]);
    for (const s of fa.seen) {
      assert.equal(s.headers['apca-api-key-id'], KEY);
      assert.ok(!s.url.includes(KEY) && !s.url.includes(SECRET));
    }
    assert.match(fa.seen[1].url, /feed=iex/);
    assert.deepEqual(await d.latest('SPY'), { t: Date.parse('2026-10-21T15:00:00Z'), c: 580.1 });
    assert.equal(d.redact(`x ${SECRET} y`), 'x *** y');
  } finally {
    fa.close();
  }
  const refuse = await fakeAlpaca((req, res) => res.writeHead(403).end(`{"message":"bad key ${SECRET}"}`));
  try {
    const d = new AlpacaData({ keyId: KEY, secret: SECRET, base: refuse.base, sleep: async () => {} });
    await assert.rejects(d.bars(['AAPL']), (e) => /refused the paper keys/.test(e.message) && !e.message.includes(SECRET));
  } finally {
    refuse.close();
  }
  const src = fs.readFileSync(path.join(here, '..', 'server', 'engine', 'data', 'alpaca-data.mjs'), 'utf8');
  assert.ok(!/paper-api|\/v2\/orders|method: 'POST'/.test(src), 'market data only: no trading host, no orders');
});

test('Alpaca keys: paper pair only, write-only, outside git, tested without showing them', async () => {
  const dir = tmp();
  const fa = await fakeAlpaca((req, res) => res.end(JSON.stringify({ bars: { SPY: { t: '2026-10-21T15:00:00Z', c: 580 } } })));
  try {
    const k = new AlpacaKeys({ dataDir: dir, dataOpts: { base: fa.base, sleep: async () => {} } });
    assert.equal(k.status().set, false);
    assert.throws(() => k.update({ keyId: 'AKLIVEKEY00000000001', secret: SECRET }), /live-trading key/);
    assert.throws(() => k.update({ keyId: KEY }), /both/);
    const st = k.update({ keyId: KEY, secret: SECRET });
    assert.equal(st.set, true);
    assert.ok(!JSON.stringify(st).includes(KEY) && !JSON.stringify(st).includes(SECRET));
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'alpaca-keys.json'), 'utf8')).keyId, KEY);
    const t = await k.test();
    assert.equal(t.lastTest.ok, true);
    assert.ok(!JSON.stringify(t).includes(SECRET));
    assert.equal(new AlpacaKeys({ dataDir: dir }).status().set, true, 'kept after a restart');
    k.update({ clear: true });
    assert.equal(fs.existsSync(path.join(dir, 'alpaca-keys.json')), false);
  } finally {
    fa.close();
  }
});

// ── the host, with fake agents and fake market data ──

/** 5-minute bars for one symbol ending at the bar before `end`, around `price`, with some range. */
function bars(end, price, n = 40, last = {}) {
  const out = [];
  for (let i = n; i >= 1; i--) {
    const t = end - i * 5 * MIN;
    const c = price * (1 + 0.002 * Math.sin(i));
    out.push({ t, o: c, h: c * 1.002, l: c * 0.998, c, v: 1000 });
  }
  Object.assign(out[out.length - 1], last);
  return out;
}

/** A fake agent process: answers each tick with script(id, msg) (an array of proposals, or a raw message). */
function fakeSpawn(script) {
  const procs = {};
  const spawn = (id) => {
    const p = new EventEmitter();
    p.sent = [];
    p.send = (m) => {
      p.sent.push(m);
      setImmediate(() => {
        const out = script(id, m);
        p.emit('message', Array.isArray(out) ? { type: 'proposals', t: m.t, items: out } : out);
      });
    };
    p.kill = () => {
      p.killed = true;
    };
    procs[id] = p;
    return p;
  };
  return { spawn, procs };
}

function makeHost({ script = () => [], universe = ['AAPL', 'MSFT', 'NVDA'], prices = { AAPL: 200, MSFT: 400, NVDA: 120 }, settings } = {}) {
  // fx rate 1 by default, so dollar figures read the same in AUD and USD; the AUD test sets 0.7
  const dir = tmp();
  if (settings) fs.writeFileSync(path.join(dir, 'agents-settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, ...settings }));
  const clock = { t: T0 };
  const market = { prices: { ...prices }, last: {} };
  const data = { bars: async (symbols) => Object.fromEntries(symbols.filter((s) => market.prices[s]).map((s) => [s, bars(clock.t, market.prices[s], 40, market.last[s] || {})])) };
  const { spawn, procs } = fakeSpawn(script);
  const fx = { rate: 1, date: '2026-10-21', source: 'test' };
  const host = new AgentHost({ dataDir: dir, getUniverse: () => universe, getData: () => data, getFx: () => (fx.rate ? fx : null), now: () => clock.t, spawn, log: { warn() {} } });
  return { host, dir, clock, market, procs, fx };
}
const buy = (symbol, score = 0.8, signal = 'stop_run') => ({ symbol, action: 'buy', signal, score });

test('host: proposals are sized in fractional shares, gated by check 17 and filled on paper', async () => {
  const { host } = makeHost({
    script: (id) => ({ 'agent-a': [buy('AAPL'), buy('TSLA')], 'agent-b': [buy('AAPL')], 'agent-c': [buy('MSFT', 0.3)], 'agent-d': [] })[id],
  });
  const st = await host.tick();
  const a = st.agents.find((x) => x.id === 'agent-a');
  assert.equal(a.positions.length, 1);
  assert.equal(a.positions[0].symbol, 'AAPL');
  assert.ok(a.positions[0].qty > 0 && a.positions[0].qty < 1, 'a fraction of a share');
  assert.ok(a.positions[0].qty * 200 <= 10 * MEDIUM.maxPositionPct + 0.01);
  assert.equal(st.holders.AAPL, 'agent-a');
  const events = host.audit.tail(50);
  assert.ok(events.some((e) => e.type === 'refused' && e.symbol === 'TSLA' && /not on the watchlist/.test(e.reason)));
  assert.ok(events.some((e) => e.type === 'refused' && e.agent === 'agent-b' && /held by agent agent-a/.test(e.reason)), 'symbol lock');
  assert.ok(events.some((e) => e.type === 'refused' && e.agent === 'agent-c' && /entry score/.test(e.reason)));
  assert.equal(st.agents.find((x) => x.id === 'agent-b').positions.length, 0);
  assert.equal(st.paperOnly, true);
  assert.equal(host.audit.verify().ok, true);
  host.stop();
});

test('host: exits are the host\'s: a stop hit on a later bar sells', async () => {
  const { host, clock, market } = makeHost({ script: (id, m) => (id === 'agent-a' && m.t === T0 ? [buy('AAPL')] : []) });
  await host.tick();
  const plan = host.state.agents['agent-a'].plans.AAPL;
  assert.ok(plan && plan.stop < 200);
  clock.t += 5 * MIN;
  market.last.AAPL = { l: plan.stop - 0.5, o: 200 };
  const st = await host.tick();
  assert.equal(st.agents[0].positions.length, 0);
  assert.ok(host.audit.tail(20).some((e) => e.type === 'fill' && e.side === 'sell' && e.why === 'stop'));
  host.stop();
});

test('host: an agent\'s daily loss halts it for the day only; it is back the next trading day', async () => {
  const { host, clock, market } = makeHost({ script: (id) => (id === 'agent-a' ? [buy('AAPL')] : []), settings: { preset: { ...MEDIUM, drawdownPct: 0.3 } } });
  await host.tick();
  // a gap down: $2.50 position falls 20 %, the agent is down 0.5 $ = 5 % > 3 %
  clock.t += 5 * MIN;
  market.prices.AAPL = 160;
  market.last.AAPL = { l: 159, h: 161, o: 160 };
  host.state.agents['agent-a'].plans.AAPL.stop = 100; // only the halt can close it
  let st = await host.tick();
  const a = st.agents[0];
  assert.match(a.halt?.reason || '', /Daily loss limit/);
  assert.equal(a.positions.length, 0, 'flattened');
  clock.t += 10 * MIN;
  await host.tick();
  assert.equal(host.state.agents['agent-a'].plans.AAPL, undefined, 'no new buy while halted');
  // next trading day (Thursday 11:00 New York)
  clock.t = T0 + 86_400_000;
  market.prices.AAPL = 160;
  market.last.AAPL = {};
  st = await host.tick();
  assert.equal(st.agents[0].halt, null);
  assert.equal(st.agents[0].positions.length, 1, 'trading again');
  host.stop();
});

test('host: drawdown halt is automatic: sits out a day, back at half size, full size after 5 clean days', async () => {
  const { host, clock } = makeHost({ script: () => [] });
  await host.tick();
  const a = host.state.agents['agent-a'];
  a.peak = 20; // pretend its best was $20: $10 now is 50 % below
  await host.tick();
  assert.equal(a.sitOut, SIT_OUT_DAYS);
  assert.match(a.dayHalt.reason, /drawdown/);
  const day = (n) => (clock.t = T0 + n * 86_400_000) && host.tick();
  await day(1); // Thursday: sits out
  assert.equal(a.sitOut, 1);
  assert.ok(!host.status().agents[0].lastProposals.length);
  await day(2); // Friday: back at half size, best equity reset
  assert.equal(a.sitOut, 0);
  assert.equal(a.scale, 0.5);
  assert.equal(a.peak, 10);
  assert.equal(host.sandbox('agent-a').guard.limits.riskPerTrade, MEDIUM.riskPerTrade / 2);
  for (const n of [5, 6, 7, 8]) await day(n); // Mon–Thu
  assert.equal(a.scale, 0.5);
  await day(9); // Friday: 5 clean trading days
  assert.equal(a.scale, 1);
  assert.ok(host.audit.tail(80).some((e) => e.type === 'resume' && e.after === 'drawdown halt'));
  host.stop();
});

test('host: the pool\'s daily loss stops every agent buying for the day', async () => {
  const { host, clock, market } = makeHost({ script: (id) => ({ 'agent-a': [buy('AAPL')], 'agent-b': [buy('MSFT')] })[id] || [], settings: { preset: { ...MEDIUM, dailyLossPct: 0.1, drawdownPct: 0.3 } } });
  await host.tick();
  clock.t += 5 * MIN;
  market.prices.AAPL = 150;
  market.prices.MSFT = 300;
  for (const id of ['agent-a', 'agent-b']) for (const p of Object.values(host.state.agents[id].plans)) p.stop = 1;
  const st = await host.tick();
  assert.match(st.poolPause?.reason || '', /pool daily loss/);
  assert.ok(host.audit.tail(30).some((e) => e.kind === 'pool'));
  host.stop();
});

test('host: the kill switch flattens, stops every agent and stays on until the owner resumes', async () => {
  const { host, clock, dir, procs } = makeHost({ script: (id) => (id === 'agent-a' ? [buy('AAPL')] : []) });
  await host.tick();
  assert.equal(host.status().agents[0].positions.length, 1);
  let st = host.kill('test');
  assert.equal(st.killed, true);
  assert.equal(st.agents[0].positions.length, 0);
  assert.ok(procs['agent-a'].killed);
  clock.t += 5 * MIN;
  st = await host.tick();
  assert.equal(st.agents[0].positions.length, 0, 'nothing trades while killed');
  st = host.resume();
  assert.equal(st.killed, false);
  // the KILL file works the same
  fs.writeFileSync(path.join(dir, 'KILL'), 'stop');
  st = await host.tick();
  assert.equal(st.killed, true);
  assert.match(st.killReason, /KILL file/);
  host.resume();
  assert.equal(fs.existsSync(path.join(dir, 'KILL')), false);
  host.stop();
});

test('host: an integrity problem (two agents holding one symbol) stops everything until the owner resumes', async () => {
  const { host } = makeHost({ script: () => [] });
  await host.tick();
  host.sandbox('agent-a').broker.positions.AAPL = { qty: 0.01, avg: 200 };
  host.sandbox('agent-b').broker.positions.AAPL = { qty: 0.01, avg: 200 };
  const st = await host.tick();
  assert.match(st.integrity?.reason || '', /AAPL is held by both agent-a and agent-b/);
  assert.equal(st.agents[0].positions.length + st.agents[1].positions.length, 0);
  assert.equal(host.resume().integrity, null);
  host.stop();
});

test('host: 3 malformed messages in a row, or 3 crashes in an hour, stop that agent for the day', async () => {
  const { host, procs } = makeHost({ script: (id) => (id === 'agent-a' ? { type: 'order', symbol: 'AAPL' } : []) });
  for (let i = 0; i < 3; i++) await host.tick().then(() => new Promise((r) => setTimeout(r, 10)));
  assert.match(host.state.agents['agent-a'].dayHalt?.reason || '', /malformed/);
  assert.equal(host.state.agents['agent-b'].dayHalt, null);
  for (let i = 0; i < 3; i++) {
    host.ensureChild('agent-c');
    procs['agent-c'].emit('exit', 1);
  }
  assert.match(host.state.agents['agent-c'].dayHalt?.reason || '', /3 crashes/);
  host.stop();
});

test('host: paper money per agent changes from the next trading day; agents at once; no keys means no trading', async () => {
  const { host, clock } = makeHost({ script: () => [] });
  await host.tick();
  host.updateSettings({ paperPerAgent: 250, agentsAtOnce: 2 });
  assert.equal(host.sandbox('agent-a').allocation, 10, 'not today');
  assert.deepEqual(host.running(), ['agent-a', 'agent-b']);
  clock.t = T0 + 86_400_000;
  const st = await host.tick();
  assert.deepEqual(st.agents.map((a) => a.allocation), [250, 250, 250, 250]);
  assert.equal(st.pool, 1000);
  assert.equal(host.sandbox('agent-a').guard.limits.maxDailyLoss, 7.5);
  const noKeys = new AgentHost({ dataDir: tmp(), getUniverse: () => ['AAPL'], getData: () => null, getFx: () => ({ rate: 1, date: '2026-10-21' }), now: () => T0, spawn: fakeSpawn(() => []).spawn });
  assert.match((await noKeys.tick()).lastError, /No Alpaca paper keys/);
  noKeys.stop();
  host.stop();
});

test('host: outside market hours nothing trades, and the day\'s results go to the knowledge store after the close', async () => {
  const { host, clock, market } = makeHost({ script: (id, m) => (id === 'agent-a' && m.t === T0 ? [buy('AAPL')] : []) });
  await host.tick();
  clock.t += 5 * MIN;
  market.last.AAPL = { h: 260 };
  await host.tick(); // target hit
  clock.t = Date.parse('2026-10-21T20:30:00Z'); // 16:30 New York
  const st = await host.tick();
  assert.equal(st.marketOpen, false);
  const notes = host.knowledge.findings();
  assert.equal(notes.length, 1);
  assert.equal(notes[0].agentId, 'agent-a');
  assert.equal(notes[0].kind, 'signal-note');
  host.stop();
});

test('property: random proposals from random agents never break the books', async () => {
  const universe = ['AAPL', 'MSFT', 'NVDA', 'AMD'];
  const all = [...universe, 'TSLA', 'META', 'BRK.B'];
  const r = rng(42);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const { host, clock, market } = makeHost({
    universe,
    prices: { AAPL: 200, MSFT: 400, NVDA: 120, AMD: 150, TSLA: 250, META: 500, 'BRK.B': 450 },
    script: () => Array.from({ length: Math.floor(r() * 5) }, () => buy(pick(all), 0.4 + r() * 0.6)),
  });
  for (let i = 0; i < 60; i++) {
    for (const s of all) market.prices[s] *= 1 + (r() - 0.5) * 0.04;
    await host.tick();
    const seen = {};
    for (const [id, sb] of host.manager.sandboxes) {
      assert.ok(sb.broker.cash >= -1e-9, `${id} cash`);
      assert.ok(sb.exposure() <= sb.allocation + 1e-6, `${id} exposure ${sb.exposure()}`);
      for (const s of Object.keys(sb.broker.positions)) {
        assert.ok(universe.includes(s), `${id} holds ${s}, not on the watchlist`);
        assert.ok(!seen[s], `${s} held twice`);
        seen[s] = id;
      }
    }
    assert.equal(host.state.integrity, null);
    clock.t += 5 * MIN;
    if (nyMinute(clock.t) >= 15 * 60 + 30) clock.t += 18 * 3600_000; // into the next morning
  }
  assert.equal(host.audit.verify().ok, true);
  host.stop();
});
const nyMinute = (t) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return Number(p.hour) * 60 + Number(p.minute);
};

test('API: changes only from this computer; kill and resume; status carries no key', async () => {
  const { host, dir } = makeHost({ script: () => [] });
  const keys = new AlpacaKeys({ dataDir: dir });
  const api = createAgentsApi({ host, keys });
  const local = { host: '127.0.0.1:8787', origin: 'http://127.0.0.1:8787', 'content-type': 'application/json' };
  await assert.rejects(api.handle('POST', '/api/agents/kill', { ...local, origin: 'https://evil.example' }, {}), (e) => e.status === 403);
  assert.equal((await api.handle('POST', '/api/agents/kill', local, {})).body.killed, true);
  assert.equal((await api.handle('POST', '/api/agents/resume', local, {})).body.killed, false);
  await api.handle('PUT', '/api/alpaca', local, { keyId: KEY, secret: SECRET });
  for (const p of ['/api/agents', '/api/alpaca']) assert.ok(!JSON.stringify((await api.handle('GET', p)).body).includes(SECRET));
  assert.equal((await api.handle('PUT', '/api/agents/settings', local, { paperPerAgent: 25 })).body.settings.paperPerAgent, 25);
  await assert.rejects(api.handle('PUT', '/api/alpaca', local, { keyId: 'AKLIVE00000000000001', secret: SECRET }), (e) => e.status === 400);
  host.stop();
});

// ── the real agent process ──

test('a real agent process answers a tick with valid proposals', async () => {
  const child = spawnAgent('agent-a');
  try {
    const ready = await new Promise((resolve, reject) => {
      child.once('message', resolve);
      child.once('error', reject);
    });
    assert.deepEqual(ready, { type: 'ready' });
    const answer = new Promise((r) => child.once('message', r));
    child.send({ type: 'tick', t: T0, params: DEFAULT_SETTINGS.params['agent-a'], bars: { AAPL: bars(T0, 200), MSFT: bars(T0, 400) }, held: [] });
    const m = await answer;
    assert.equal(checkAgentMessage(m).ok, true, JSON.stringify(m));
    assert.equal(m.t, T0);
  } finally {
    child.kill();
  }
});

test('an agent process can\'t read another agent\'s folder or a key, write anything, start a process, or see a secret', async () => {
  const dir = tmp();
  const other = path.join(dir, 'agents', 'agent-b');
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, 'ledger.json'), '{}');
  fs.writeFileSync(path.join(dir, 'alpaca-keys.json'), JSON.stringify({ keyId: KEY, secret: SECRET }));
  const probe = path.join(here, 'fixtures', 'agent-probe.mjs');
  process.env.FT_TEST_SECRET = SECRET; // a secret in the host's environment
  const child = fork(probe, [], childOptions('agent-a', [probe]));
  try {
    const out = await new Promise((resolve, reject) => {
      child.once('message', resolve);
      child.once('error', reject);
      child.send({ read: [path.join(other, 'ledger.json'), path.join(dir, 'alpaca-keys.json')], write: path.join(dir, 'x.txt') });
    });
    for (const v of Object.values(out.read)) assert.equal(v, 'ERR_ACCESS_DENIED');
    assert.equal(out.write, 'ERR_ACCESS_DENIED');
    assert.equal(out.spawn, 'ERR_ACCESS_DENIED');
    assert.equal(out.env.FT_TEST_SECRET, undefined);
    assert.equal(out.env.AGENT_ID, 'agent-a');
    assert.ok(!JSON.stringify(out).includes(SECRET), 'no secret anywhere in its environment or arguments');
    assert.equal(fs.existsSync(path.join(dir, 'x.txt')), false);
  } finally {
    delete process.env.FT_TEST_SECRET;
    child.kill();
  }
});

test('nothing in the agents code can send a real order or open live trading', () => {
  const files = ['server/engine/agents/host.mjs', 'server/engine/agents/agent-runner.mjs', 'server/engine/agents/profile.mjs', 'server/agents-api.mjs', 'server/alpaca-keys.mjs', 'server/engine/data/alpaca-data.mjs'];
  for (const f of files) {
    const src = fs.readFileSync(path.join(here, '..', f), 'utf8');
    const imports = src.match(/^import .*$/gm) || [];
    assert.ok(!imports.some((l) => /broker\/alpaca|strategy\.mjs|engine\.mjs/.test(l)), `${f} imports a broker or the engine`);
    assert.ok(!/paper-api\.alpaca|\/v2\/orders|live-enablement/.test(src), `${f} reaches an order endpoint or the live enablement`);
  }
  assert.ok(AGENT_IDS.length === 4);
});

// ── AUD ──

test('AUD/USD rate: fetched, dated, cached, kept on failure, refused when too old', async () => {
  const dir = tmp();
  let answer = { ok: true, status: 200, json: async () => ({ amount: 1, base: 'AUD', date: '2026-10-22', rates: { USD: 0.70119 } }) };
  let calls = 0;
  const clock = { t: Date.parse('2026-10-23T00:00:00Z') };
  const fx = new FxRate({ dataDir: dir, fetchImpl: async (url) => (calls++, assert.match(url, /from=AUD&to=USD/), answer), now: () => clock.t, log: { warn() {} } });
  assert.equal(fx.current(), null);
  const r = await fx.refresh();
  assert.equal(r.rate, 0.70119);
  assert.equal(r.date, '2026-10-22');
  assert.match(r.source, /European Central Bank/);
  await fx.refresh();
  assert.equal(calls, 1, 'at most every 6 hours');
  clock.t += 7 * 3600_000;
  answer = { ok: false, status: 503, json: async () => ({}) };
  assert.equal((await fx.refresh()).rate, 0.70119, 'the last good rate stays');
  answer = { ok: true, status: 200, json: async () => ({ date: '2026-10-23', rates: { USD: 70 } }) };
  clock.t += 7 * 3600_000;
  assert.equal((await fx.refresh()).rate, 0.70119, 'a silly rate is refused');
  assert.equal(new FxRate({ dataDir: dir, now: () => clock.t }).current().rate, 0.70119, 'cached on disk');
  clock.t += (STALE_DAYS + 1) * 86_400_000;
  assert.equal(fx.current(), null, 'too old: none');
});

test("paper money is in AUD: the books get AUD × the day's rate; the AUD amount never grows", async () => {
  const { host, clock, fx } = makeHost({ script: () => [] });
  fx.rate = 0.7;
  let st = await host.tick();
  assert.equal(st.settings.paperPerAgent, 10, 'AUD');
  assert.equal(st.usdPerAgent, 7);
  assert.deepEqual(st.agents.map((a) => a.allocation), [7, 7, 7, 7]);
  assert.equal(host.sandbox('agent-a').guard.limits.maxDailyLoss, 7 * MEDIUM.dailyLossPct);
  // the next day the AUD buys a little more: the US-dollar figure follows, the AUD stays $10
  fx.rate = 0.71;
  clock.t = T0 + 86_400_000;
  st = await host.tick();
  assert.deepEqual(st.agents.map((a) => a.allocation), [7.1, 7.1, 7.1, 7.1]);
  assert.ok(host.audit.tail(30).some((e) => e.type === 'allocation' && e.aud === 10 && e.rate === 0.71));
  // no rate: nothing trades
  fx.rate = 0;
  clock.t += 5 * MIN;
  st = await host.tick();
  assert.match(st.lastError, /No AUD → US dollar rate/);
  host.stop();
});

test('the old Alpaca paper adapter cannot send an order, and nothing the server starts reaches it', async () => {
  const { AlpacaBroker, PAPER_ORDERS_ENABLED } = await import('../server/engine/broker/alpaca.mjs');
  assert.equal(PAPER_ORDERS_ENABLED, false);
  let calls = 0;
  const b = new AlpacaBroker({ keyId: 'PKX', secret: 'Y', fetchImpl: async () => (calls++, { ok: true, status: 200, json: async () => ({}) }) });
  await assert.rejects(b.submit({ symbol: 'AAPL', side: 'buy', qty: 1 }), /switched off/);
  await assert.rejects(b.flatten(), /switched off/);
  assert.equal(calls, 0, 'no request left the adapter');
  // walk every import from server/index.mjs: neither the adapter nor the old engine is reachable
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/^import [^'"]*['"](\.[^'"]+)['"]/gm)) walk(path.resolve(path.dirname(file), m[1]));
  };
  walk(path.join(here, '..', 'server', 'index.mjs'));
  const rel = [...seen].map((f) => path.relative(path.join(here, '..'), f).split(path.sep).join('/'));
  assert.ok(rel.includes('server/engine/agents/host.mjs'), 'the walk works');
  for (const bad of ['server/engine/broker/alpaca.mjs', 'server/engine/engine.mjs', 'server/engine/strategy.mjs']) assert.ok(!rel.includes(bad), `${bad} is reachable from the server`);
});

test('host: bars are fetched once in full, then only what is new; unfinished bars are left out', async () => {
  const calls = [];
  const dir = tmp();
  let now = T0;
  const data = {
    bars: async (symbols, { start }) => {
      calls.push({ symbols, start });
      return Object.fromEntries(symbols.map((s) => [s, [...bars(now, 100, 40), { t: now - 2 * MIN, o: 100, h: 101, l: 99, c: 100, v: 5 }]]));
    },
  };
  const host = new AgentHost({ dataDir: dir, getUniverse: () => ['AAPL'], getData: () => data, getFx: () => ({ rate: 1, date: '2026-10-21' }), now: () => now, spawn: fakeSpawn(() => []).spawn, log: { warn() {} } });
  const first = await host.fetchBars(data, ['AAPL'], now);
  assert.equal(calls[0].start, now - 4 * 86_400_000);
  assert.ok(first.AAPL.every((b) => b.t + 5 * MIN <= now), 'the bar that started 2 minutes ago is not finished');
  now += 5 * MIN;
  await host.fetchBars(data, ['AAPL'], now);
  assert.ok(calls[1].start > now - 3600_000, 'only the recent part');
  host.stop();
});
