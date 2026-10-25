// The v11 model as a paper agent: the strategy setting, the host's v11 entries (the model's own
// threshold, the trailing-stop plan), its exits (a close 1 % under the best close, 20 bars, the
// session close), the nightly test leaving it alone, and a real agent process scoring real bars.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { cleanSettings, DEFAULT_SETTINGS } from '../server/engine/agents/profile.mjs';
import { checkAgentMessage } from '../server/engine/agents/ipc.mjs';
import { AgentHost, spawnAgent } from '../server/engine/agents/host.mjs';
import { loadModel } from '../server/engine/models/v11.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ft-v11-'));
const MIN = 60_000;
const T0 = Date.parse('2026-10-21T15:00:00Z'); // Wednesday 11:00 New York
const model = loadModel();

test('settings: each agent has a strategy, signals or v11; agent-d runs v11 unless changed', () => {
  assert.equal(DEFAULT_SETTINGS.strategies['agent-d'], 'v11');
  assert.equal(DEFAULT_SETTINGS.strategies['agent-a'], 'signals');
  const s = cleanSettings({ strategies: { 'agent-a': 'v11', 'agent-b': 'nonsense', 'agent-d': 'signals' } });
  assert.deepEqual(s.strategies, { 'agent-a': 'v11', 'agent-b': 'signals', 'agent-c': 'signals', 'agent-d': 'signals' });
  assert.deepEqual(cleanSettings({}).strategies, DEFAULT_SETTINGS.strategies, 'old saved settings without strategies get the defaults');
});

test('IPC: the model\'s signal id (with a digit) passes; ids still may not start with one', () => {
  assert.equal(checkAgentMessage({ type: 'proposals', t: 1, items: [{ symbol: 'AAPL', action: 'buy', signal: 'model_v11', score: 0.61 }] }).ok, true);
  assert.equal(checkAgentMessage({ type: 'proposals', t: 1, items: [{ symbol: 'AAPL', action: 'buy', signal: '11model', score: 0.61 }] }).ok, false);
});

/** Bars ending at the bar before `end`, around `price`; `last` overrides the newest bar. */
function bars(end, price, n = 40, last = {}) {
  const out = [];
  for (let i = n; i >= 1; i--) {
    const c = price * (1 + 0.002 * Math.sin(i));
    out.push({ t: end - i * 5 * MIN, o: c, h: c * 1.002, l: c * 0.998, c, v: 1000 });
  }
  Object.assign(out[out.length - 1], last);
  return out;
}

function makeHost(script) {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'agents-settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, agentsAtOnce: 4 }));
  const clock = { t: T0 };
  const market = { prices: { ADI: 250, AAPL: 200, FLEX: 60, MSFT: 400 }, last: {} };
  const asked = [];
  const data = {
    bars: async (symbols) => {
      asked.push(symbols);
      return Object.fromEntries(symbols.filter((s) => market.prices[s]).map((s) => [s, bars(clock.t, market.prices[s], 40, market.last[s] || {})]));
    },
  };
  const sent = {};
  const spawn = (id) => {
    const p = new EventEmitter();
    p.send = (m) => {
      (sent[id] ||= []).push(m);
      setImmediate(() => p.emit('message', { type: 'proposals', t: m.t, items: script(id, m) }));
    };
    p.kill = () => {};
    return p;
  };
  const host = new AgentHost({ dataDir: dir, getUniverse: () => ['ADI', 'AAPL'], getData: () => data, getFx: () => ({ rate: 1, date: '2026-10-21', source: 'test' }), now: () => clock.t, spawn, log: { warn() {} } });
  return { host, clock, market, sent, asked };
}

const v11buy = (symbol, score) => ({ symbol, action: 'buy', signal: 'model_v11', score });

test('host: a v11 agent gets the 38 stocks\' bars, buys at the model\'s threshold and plans a trailing stop', async () => {
  const { host, sent, asked } = makeHost((id, m) => (id === 'agent-d' && m.t === T0 ? [v11buy('ADI', 0.62)] : id === 'agent-c' && m.t === T0 ? [] : []));
  const st = await host.tick();
  const msg = sent['agent-d'][0];
  assert.equal(msg.strategy, 'v11');
  assert.ok(msg.context && Object.keys(msg.context).includes('ADI'), 'the model\'s stocks go with the tick');
  assert.ok(asked.some((list) => list.length === model.universe.length), 'all 38 asked for');
  assert.equal(sent['agent-a'][0].strategy, 'signals');
  assert.equal(sent['agent-a'][0].context, undefined, 'signal agents get no model bars');
  const d = st.agents.find((a) => a.id === 'agent-d');
  assert.equal(d.strategy, 'v11');
  assert.equal(d.positions.length, 1);
  const plan = host.state.agents['agent-d'].plans.ADI;
  assert.ok(plan.trailPct > 0 && plan.trailPct < 0.1, `trailing distance ${plan.trailPct}`);
  if (model.exit.kind === 'pct') assert.equal(plan.trailPct, model.exit.stop);
  assert.equal(plan.maxHold, 20);
  assert.equal(plan.target, null);
  assert.equal(plan.signal, 'model_v11');
  assert.ok(st.models.v11.threshold > 0.5);
  host.stop();
});

test('host: the v11 agent may buy its own 38 stocks off the watchlist; signal agents may not', async () => {
  // the owner, 25 Oct 2026: "let the v11 agent trade all 38 of its own stocks even if they are not on my watchlist"
  const { host } = makeHost((id, m) => {
    if (m.t !== T0) return [];
    if (id === 'agent-d') return [v11buy('FLEX', 0.62), v11buy('MSFT', 0.65)];
    if (id === 'agent-a') return [{ symbol: 'FLEX', action: 'buy', signal: 'stop_run', score: 0.9 }];
    return [];
  });
  const st = await host.tick();
  const d = st.agents.find((a) => a.id === 'agent-d');
  assert.deepEqual(d.positions.map((p) => p.symbol), ['FLEX'], 'FLEX is one of the 38, not on the watchlist (ADI, AAPL)');
  assert.ok(host.state.agents['agent-d'].plans.FLEX.trailPct > 0);
  assert.equal(st.lastError, '', 'the tick ran to the end');
  assert.ok(host.journal.decisions('2026-10-21', 'agent-d').some((x) => /^bought .* FLEX .*trailing stop/.test(x.text)), 'the decision log reads the trailing stop');
  const refused = host.audit.tail(40).filter((e) => e.type === 'refused');
  assert.ok(refused.some((e) => e.agent === 'agent-d' && e.symbol === 'MSFT' && /not on the watchlist or among the v11 model's stocks/.test(e.reason)), 'MSFT is neither');
  assert.ok(refused.some((e) => e.agent === 'agent-a' && e.symbol === 'FLEX' && /not on the watchlist/.test(e.reason)), 'a signal agent keeps the watchlist');
  assert.equal(st.agents.find((a) => a.id === 'agent-a').positions.length, 0);
  host.stop();
});

test('host: a v11 buy under the model\'s threshold is refused; the agent\'s entry score is not used', async () => {
  const { host } = makeHost((id, m) => (id === 'agent-d' && m.t === T0 ? [v11buy('ADI', 0.55), v11buy('AAPL', 0.6)] : []));
  const st = await host.tick();
  const d = st.agents.find((a) => a.id === 'agent-d');
  assert.deepEqual(d.positions.map((p) => p.symbol), ['AAPL'], '0.60 clears the 0.594 threshold though agent-d\'s entry score is 0.65');
  assert.ok(host.audit.tail(30).some((e) => e.type === 'refused' && e.symbol === 'ADI' && /model's threshold/.test(e.reason)));
  host.stop();
});

test('host: v11 exits on a close its trailing distance under the best close since entry, at that close', async () => {
  const { host, clock, market } = makeHost((id, m) => (id === 'agent-d' && m.t === T0 ? [v11buy('ADI', 0.62)] : []));
  await host.tick();
  const entry = host.state.agents['agent-d'].plans.ADI.entry;
  clock.t += 5 * MIN;
  market.last.ADI = { o: 252, h: 254, l: 251, c: 253 }; // a new best close
  await host.tick();
  const plan = host.state.agents['agent-d'].plans.ADI;
  assert.equal(plan.best, 253);
  const line = 253 * (1 - plan.trailPct);
  assert.ok(Math.abs(plan.stop - line) < 1e-9);
  clock.t += 5 * MIN;
  market.last.ADI = { o: 253, h: 253, l: line - 1, c: line + 0.05 }; // the low goes under the line, the close does not: holds
  await host.tick();
  assert.ok(host.state.agents['agent-d'].plans.ADI, 'an intrabar dip does not sell; only a close does');
  clock.t += 5 * MIN;
  const exitClose = line - 0.1;
  market.last.ADI = { o: line, h: line, l: exitClose - 0.2, c: exitClose };
  await host.tick();
  assert.equal(host.state.agents['agent-d'].plans.ADI, undefined);
  const sell = host.audit.tail(20).find((e) => e.type === 'fill' && e.side === 'sell' && e.agent === 'agent-d');
  assert.equal(sell.why, 'trailing stop');
  assert.ok(sell.price <= exitClose && sell.price > exitClose * 0.999, `sold at about the close (slippage 5 bps): ${sell.price} vs ${exitClose}`);
  assert.ok(entry > 0);
  host.stop();
});

test('host: v11 sells after 20 bars when the trailing stop never fires', async () => {
  const { host, clock, market } = makeHost((id, m) => (id === 'agent-d' && m.t === T0 ? [v11buy('ADI', 0.62)] : []));
  await host.tick();
  let c = 250;
  for (let k = 1; k <= 20; k++) {
    clock.t += 5 * MIN;
    c += 0.1; // a slow climb: a new best close every bar
    market.last.ADI = { o: c, h: c + 0.05, l: c - 0.05, c };
    await host.tick();
    if (k < 20) assert.ok(host.state.agents['agent-d'].plans.ADI, `still held after ${k} bars`);
  }
  assert.equal(host.state.agents['agent-d'].plans.ADI, undefined);
  assert.equal(host.audit.tail(20).find((e) => e.type === 'fill' && e.side === 'sell').why, 'time');
  host.stop();
});

function readBars(file) {
  const [head, ...lines] = fs.readFileSync(path.join(root, file), 'utf8').trim().split(/\r?\n/);
  const col = Object.fromEntries(head.split(',').map((k, i) => [k, i]));
  const out = {};
  for (const line of lines) {
    const f = line.split(',');
    (out[f[col.ticker]] ||= []).push({ t: Date.parse(f[col.timestamp].replace(' ', 'T')), o: +f[col.open], h: +f[col.high], l: +f[col.low], c: +f[col.close], v: +f[col.volume] });
  }
  return out;
}

test('a real v11 agent process scores real bars as Python does and proposes the ones over the threshold', async () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(root, 'test', 'fixtures', 'v11-parity.json'), 'utf8'));
  const top = fixture.rows.filter((r) => r.prob != null).sort((a, b) => b.prob - a.prob)[0];
  assert.ok(top.prob >= model.threshold, 'the fixture has a bar over the threshold');
  const below = fixture.rows.find((r) => r.t === top.t && r.prob != null && r.prob < model.threshold);
  const all = readBars(fixture.bars);
  const start = top.t - 18 * 86_400_000;
  const context = Object.fromEntries(Object.entries(all).map(([s, list]) => [s, list.filter((b) => b.t <= top.t && b.t >= start)]));
  const child = spawnAgent('agent-d');
  try {
    const answer = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no answer in 20 s')), 20_000);
      child.on('message', (m) => {
        if (m.type === 'ready') child.send({ type: 'tick', t: top.t + 5 * MIN, strategy: 'v11', params: DEFAULT_SETTINGS.params['agent-d'], bars: { [top.ticker]: context[top.ticker].slice(-80), [below.ticker]: context[below.ticker].slice(-80), AAPL: [] }, context, held: [] });
        if (m.type === 'proposals') {
          clearTimeout(timer);
          resolve(m);
        }
      });
    });
    assert.equal(checkAgentMessage(answer).ok, true);
    const item = answer.items.find((x) => x.symbol === top.ticker);
    assert.ok(item, `${top.ticker} proposed`);
    assert.equal(item.signal, 'model_v11');
    assert.ok(Math.abs(item.score - top.prob) < 0.0006, `score ${item.score} vs python ${top.prob}`);
    const c = answer.considered.find((x) => x.symbol === below.ticker);
    assert.equal(c.why, 'below-entry');
    assert.ok(!answer.items.some((x) => x.symbol === 'AAPL') && !answer.considered.some((x) => x.symbol === 'AAPL'), 'a stock outside the 38 is not scored');
  } finally {
    child.kill();
  }
});

test('host: v11 agents trade with an empty watchlist (no Finviz needed)', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'agents-settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, strategies: { 'agent-a': 'v11', 'agent-b': 'v11', 'agent-c': 'v11', 'agent-d': 'v11' } }));
  const data = { bars: async (symbols) => Object.fromEntries(symbols.filter((s) => s === 'FLEX').map((s) => [s, bars(T0, 60)])) };
  const spawn = () => {
    const p = new EventEmitter();
    p.send = (m) => setImmediate(() => p.emit('message', { type: 'proposals', t: m.t, items: [v11buy('FLEX', 0.62)] }));
    p.kill = () => {};
    return p;
  };
  const host = new AgentHost({ dataDir: dir, getUniverse: () => [], getData: () => data, getFx: () => ({ rate: 1, date: '2026-10-21', source: 'test' }), now: () => T0, spawn, log: { warn() {} } });
  const st = await host.tick();
  assert.equal(st.lastError, '');
  assert.equal(st.agents.filter((a) => a.positions.length).length, 1, 'one agent holds FLEX; the symbol lock keeps the others out');
  host.stop();
});
