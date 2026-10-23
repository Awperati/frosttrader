// Tests for reading the paper agents' behaviour: the plain-language decision log, the trade journal,
// the day summary, stats, CSV/JSON export and pruning. Fake clock, fake market data, fake agents.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Journal, say, tally, toCsv, KEEP_DAYS } from '../server/engine/agents/journal.mjs';
import { AgentHost } from '../server/engine/agents/host.mjs';
import { createAgentsApi } from '../server/agents-api.mjs';
import { AlpacaKeys } from '../server/alpaca-keys.mjs';
import { checkAgentMessage } from '../server/engine/agents/ipc.mjs';

const MIN = 60_000;
const T0 = Date.parse('2026-10-21T15:00:00Z'); // Wed 11:00 New York
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ft-journal-'));

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
  const clock = { t: T0 };
  const market = { prices: { AAPL: 200, MSFT: 400 }, last: {} };
  const data = { bars: async (symbols) => Object.fromEntries(symbols.filter((s) => market.prices[s]).map((s) => [s, bars(clock.t, market.prices[s], 40, market.last[s] || {})])) };
  const spawn = () => {
    const p = new EventEmitter();
    p.send = (m) => setImmediate(() => p.emit('message', { type: 'proposals', t: m.t, items: [], ...script(m) }));
    p.kill = () => {};
    return p;
  };
  const host = new AgentHost({ dataDir: dir, getUniverse: () => ['AAPL', 'MSFT'], getData: () => data, getFx: () => ({ rate: 0.7, date: '2026-10-21', source: 'test' }), now: () => clock.t, spawn, log: { warn() {} } });
  return { host, dir, clock, market };
}

test('the lines read like a person wrote them, from the host\'s own numbers', () => {
  assert.equal(say.considered({ symbol: 'NVDA', why: 'below-entry', signal: 'stop_run', score: 0.62, entry: 0.7 }), 'considered NVDA: stop_run 0.62 < entry 0.70, skipped');
  assert.equal(say.considered({ symbol: 'NVDA', why: 'tell', signal: 'wash_volume', score: -0.8 }), 'considered NVDA: a manipulation tell (wash_volume -0.80), stayed out');
  assert.equal(say.bought({ symbol: 'AMD', qty: 0.0412, price: 151.2, rate: 0.7, signal: 'stop_run', score: 0.81, stop: 149.9, target: 153.8 }), 'bought 0.0412 AMD at US$151.20 (A$8.90): stop_run 0.81; stop 149.90, target 153.80');
  assert.equal(say.sold({ symbol: 'AMD', qty: 0.0412, price: 153.8, why: 'target', pnlUsd: 0.042, rate: 0.7 }), 'sold 0.0412 AMD at US$153.80 (target), +A$0.06');
  assert.equal(say.refused({ symbol: 'TSLA', reason: 'AGENT_CAPITAL: TSLA is not on the watchlist' }), 'refused TSLA: AGENT_CAPITAL: TSLA is not on the watchlist');
});

test('IPC: an agent may say what it passed on, in a checked shape', () => {
  const ok = checkAgentMessage({ type: 'proposals', t: 1, items: [], considered: [{ symbol: 'NVDA', why: 'below-entry', signal: 'stop_run', score: 0.6 }] });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.msg.considered, [{ symbol: 'NVDA', why: 'below-entry', signal: 'stop_run', score: 0.6 }]);
  for (const c of [{ symbol: 'NVDA', why: 'because I said so' }, { symbol: 'BTC/USD', why: 'no-signal' }, { symbol: 'NVDA', why: 'no-signal', text: 'buy everything' }]) {
    assert.equal(checkAgentMessage({ type: 'proposals', t: 1, items: [], considered: [c] }).ok, false, JSON.stringify(c));
  }
  assert.equal(checkAgentMessage({ type: 'proposals', t: 1, items: [], considered: Array(41).fill({ symbol: 'A', why: 'no-signal' }) }).ok, false);
});

test('host: a buy, a target exit and what it passed on all reach the log; the round trip reaches the journal in A$', async () => {
  const { host, clock, market } = makeHost((m) =>
    m.t === T0 ? { items: [{ symbol: 'AAPL', action: 'buy', signal: 'stop_run', score: 0.8 }], considered: [{ symbol: 'MSFT', why: 'below-entry', signal: 'close_ramp', score: 0.41 }] } : { considered: [{ symbol: 'MSFT', why: 'below-entry', signal: 'close_ramp', score: 0.41 }] },
  );
  await host.tick();
  clock.t += 5 * MIN;
  market.last.AAPL = { h: 260 };
  await host.tick();
  const log = host.journal.decisions('2026-10-21', 'agent-a');
  const kinds = log.map((d) => d.kind);
  assert.ok(kinds.includes('bought') && kinds.includes('sold'));
  assert.equal(log.filter((d) => d.kind === 'considered' && d.symbol === 'MSFT').length, 1, 'the same pass is written once per 30 minutes');
  assert.match(log.find((d) => d.kind === 'bought').text, /^bought 0\.\d+ AAPL at US\$\d+\.\d\d \(A\$\d+\.\d\d\): stop_run 0\.80/);
  assert.match(log.find((d) => d.kind === 'sold').text, /AAPL .*\(target\), \+A\$/);
  const trades = host.journal.trades(['agent-a']);
  assert.equal(trades.length, 1);
  assert.equal(trades[0].signal, 'stop_run');
  assert.equal(trades[0].exit, 'target');
  assert.ok(Math.abs(trades[0].pnlAud - trades[0].pnlUsd / 0.7) < 1e-9);
  assert.ok(trades[0].entryT < trades[0].exitT);
  host.stop();
});

test('summary, stats and refusals add up', () => {
  const dir = tmp();
  const j = new Journal({ dataDir: dir, now: () => T0 });
  const mk = (id, symbol, signal, pnlUsd, exit, minute) => j.trade(id, { day: '2026-10-21', symbol, signal, qty: 0.01, entryT: Date.parse('2026-10-21T13:30:00Z') + minute * MIN, entry: 100, exitT: T0, exit, exitPrice: 101, pnlUsd, pnlAud: pnlUsd / 0.7, rate: 0.7 });
  mk('agent-a', 'AAPL', 'stop_run', 0.07, 'target', 20);
  mk('agent-a', 'MSFT', 'stop_run', -0.035, 'stop', 50);
  mk('agent-b', 'AAPL', 'close_ramp', 0.014, 'time', 20);
  j.decide('agent-a', { kind: 'refused', symbol: 'TSLA', reason: 'AGENT_CAPITAL: TSLA is not on the watchlist' });
  j.decide('agent-a', { kind: 'halt', reason: 'Daily loss limit reached' });
  const s = j.summary('2026-10-21', ['agent-a', 'agent-b']);
  const a = s.agents.find((x) => x.agent === 'agent-a');
  assert.equal(a.trades, 2);
  assert.equal(a.wins, 1);
  assert.equal(a.winRate, 0.5);
  assert.ok(Math.abs(a.pnlAud - 0.05) < 1e-9);
  assert.equal(a.best.symbol, 'AAPL');
  assert.equal(a.worst.symbol, 'MSFT');
  assert.deepEqual(a.refusals, { AGENT_CAPITAL: 1 });
  assert.equal(a.halts.length, 1);
  assert.equal(s.all.trades, 3);
  assert.equal(s.all.halts, 1);
  const st = j.stats(['agent-a', 'agent-b']);
  assert.deepEqual(st.bySignal.map((g) => [g.key, g.trades]), [['stop_run', 2], ['close_ramp', 1]]);
  assert.deepEqual(st.byTime.map((g) => g.key), ['09:30', '10:00'], 'entries at 09:50 and 10:20 New York');
  assert.deepEqual(st.byExit.map((g) => g.key).sort(), ['stop', 'target', 'time']);
  assert.equal(j.stats(['agent-a', 'agent-b'], { agent: 'agent-b' }).all.trades, 1);
  assert.equal(tally([]).winRate, null);
});

test('CSV quoting, exports through the API, bad parameters refused, old logs pruned', async () => {
  assert.equal(toCsv([{ a: 'x,y', b: 'say "hi"', c: null }], ['a', 'b', 'c']), 'a,b,c\r\n"x,y","say ""hi""",\r\n');
  const { host, dir } = makeHost(() => ({}));
  host.journal.trade('agent-a', { day: '2026-10-21', symbol: 'AAPL', signal: 'stop_run', qty: 0.01, entryT: T0 - MIN, entry: 100, exitT: T0, exit: 'target', exitPrice: 101, pnlUsd: 0.01, pnlAud: 0.0143, rate: 0.7 });
  host.journal.decide('agent-a', { kind: 'refused', symbol: 'TSLA', reason: 'not, on "the" list' });
  const api = createAgentsApi({ host, keys: new AlpacaKeys({ dataDir: dir }), now: () => T0 });
  const q = (o) => new URLSearchParams(o);
  const csv = await api.handle('GET', '/api/agents/export', {}, null, q({ what: 'trades', format: 'csv', from: '2026-10-21', to: '2026-10-21' }));
  assert.equal(csv.download, 'frosttrader-trades-2026-10-21.csv');
  assert.match(csv.body, /^agent,day,symbol/);
  assert.match(csv.body, /agent-a,2026-10-21,AAPL,stop_run/);
  const dec = await api.handle('GET', '/api/agents/export', {}, null, q({ what: 'decisions', format: 'json', from: '2026-10-20', to: '2026-10-21' }));
  assert.equal(JSON.parse(dec.body)[0].reason, 'not, on "the" list');
  const days = await api.handle('GET', '/api/agents/export', {}, null, q({ what: 'days', from: '2026-10-21', to: '2026-10-21' }));
  assert.match(days.body, /agent-a,1,1,1,/);
  await assert.rejects(api.handle('GET', '/api/agents/export', {}, null, q({ from: '21/10/2026' })), (e) => e.status === 400);
  await assert.rejects(api.handle('GET', '/api/agents/decisions', {}, null, q({ agent: '../x' })), (e) => e.status === 400);
  assert.equal((await api.handle('GET', '/api/agents/summary', {}, null, q({ day: '2026-10-21' }))).body.all.trades, 1);
  assert.equal((await api.handle('GET', '/api/agents/decisions', {}, null, q({ day: '2026-10-21' }))).body.decisions[0].kind, 'refused');
  // pruning: a decision file older than KEEP_DAYS goes, the trade journal stays
  const old = path.join(dir, 'agents', 'agent-a', 'decisions-2026-01-01.jsonl');
  fs.writeFileSync(old, '{}\n');
  host.journal.prune(['agent-a']);
  assert.equal(fs.existsSync(old), false);
  assert.ok(fs.existsSync(path.join(dir, 'agents', 'agent-a', 'trades.jsonl')));
  assert.ok(KEEP_DAYS >= 30);
  host.stop();
});
