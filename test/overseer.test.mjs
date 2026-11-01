// The overseer (server/engine/agents/overseer.mjs): the after-close verdict per agent and the §3.5
// demotion rules, paper only. Temp folders, fake clock, no network, no keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentHost } from '../server/engine/agents/host.mjs';
import { Overseer, RULES, shiftTradingDays } from '../server/engine/agents/overseer.mjs';
import { createAgentsApi } from '../server/agents-api.mjs';
import { createConnector, ConnectorToken } from '../server/connector.mjs';
import { AlpacaKeys } from '../server/alpaca-keys.mjs';

const T0 = Date.parse('2026-10-21T21:00:00Z'); // Wed 17:00 New York, market closed
const DAY = '2026-10-21';
const LOCAL = { host: '127.0.0.1:8787', 'content-type': 'application/json' };
const q = (o = {}) => new URLSearchParams(o);

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-overseer-'));
  const clock = { t: T0 };
  let orderCalls = 0;
  const host = new AgentHost({ dataDir: dir, getFx: () => ({ rate: 0.7, date: DAY }), getOrders: () => (orderCalls++, null), now: () => clock.t, spawn: () => ({ on() {}, send() {}, kill() {} }), log: { warn() {} } });
  const overseer = new Overseer({ dataDir: dir, host, now: () => clock.t });
  const trades = (id, n, pnlUsd, day = DAY, t0 = clock.t - 3_600_000) => {
    for (let i = 0; i < n; i++) host.journal.trade(id, { day, symbol: 'AAPL', signal: 'stop_run', qty: 1, entryT: t0 + i * 1000, entry: 100, exitT: t0 + i * 1000 + 500, exit: 'stop', exitPrice: 99, pnlUsd, pnlAud: pnlUsd / 0.7, rate: 0.7 });
  };
  const auditLines = () => fs.readFileSync(host.audit.file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { dir, clock, host, overseer, trades, auditLines, orderCalls: () => orderCalls };
}

test('a quiet agent is fine, and the report is plain words saved under the data folder', () => {
  const { dir, overseer, host, trades } = setup();
  trades('agent-a', 3, 0.5);
  host.journal.decide('agent-a', { kind: 'refused', symbol: 'MSFT', reason: 'AGENT_CAPITAL: MSFT is not on the watchlist' });
  const r = overseer.run(DAY);
  const a = r.agents.find((x) => x.agent === 'agent-a');
  assert.equal(a.verdict, 'fine');
  assert.match(a.text, /agent-a: 0 buys, 3 sales, 3 won/);
  assert.match(a.text, /Refused 1 buy \(AGENT_CAPITAL 1\)/);
  assert.match(a.text, /Verdict: fine, because only 3 trades so far/);
  assert.equal(r.agents.find((x) => x.agent === 'agent-b').text.includes('made no trades'), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'overseer', 'reports', `${DAY}.json`), 'utf8')).day, DAY);
  assert.equal(host.status().agents[0].tier, 'active');
});

test('30 losing trades demote to reduced: half size, audited, then back after 10 trading days', () => {
  const { overseer, host, trades, auditLines, clock } = setup();
  const full = host.sandbox('agent-a').guard.limits.maxPositionPct;
  trades('agent-a', 30, -0.1);
  const r = overseer.run(DAY);
  const a = r.agents.find((x) => x.agent === 'agent-a');
  assert.equal(a.verdict, 'demoted');
  assert.equal(a.tier, 'reduced');
  assert.match(a.reason, /half size until 2026-11-04/); // 10 trading days after Wed 21 Oct
  assert.equal(host.sandbox('agent-a').guard.limits.maxPositionPct, full * RULES.reducedScale);
  assert.equal(host.running().includes('agent-a'), true);
  assert.ok(auditLines().some((e) => e.type === 'overseer-tier' && e.agent === 'agent-a' && e.to === 'reduced'));
  // running again the same day changes nothing
  overseer.run(DAY);
  assert.equal(overseer.state.agents['agent-a'].demotions.length, 1);
  assert.equal(overseer.state.agents['agent-a'].changes.length, 1);
  // 10 trading days later, no new demotion: back to active at full size
  clock.t += 15 * 86_400_000;
  overseer.run('2026-11-05');
  assert.equal(overseer.tierOf('agent-a'), 'active');
  assert.equal(host.sandbox('agent-a').guard.limits.maxPositionPct, full);
});

test('a second demotion inside 60 trading days retires the agent; its positions still exit', () => {
  const { overseer, host, trades, auditLines } = setup();
  host.sandbox('agent-a').mark('AAPL', 100);
  host.sandbox('agent-a').submit({ symbol: 'AAPL', side: 'buy', qty: 0.01, price: 100, t: T0, why: 'test' });
  const held = { ...host.sandbox('agent-a').broker.positions };
  host.audit.write({ type: 'halt', agent: 'agent-a', kind: 'drawdown', equity: 9, peak: 10 });
  trades('agent-a', 30, -0.1);
  const r = overseer.run(DAY);
  const a = r.agents.find((x) => x.agent === 'agent-a');
  assert.equal(a.verdict, 'retired');
  assert.match(a.reason, /2 demotions in 60 trading days/);
  assert.equal(host.running().includes('agent-a'), false);
  assert.ok(host.sandbox('agent-a'), 'the book is kept for the record');
  assert.deepEqual(host.sandbox('agent-a').broker.positions, held, 'retiring sells nothing and cancels nothing');
  assert.ok(auditLines().some((e) => e.type === 'overseer-tier' && e.to === 'retired'));
});

test('a demotion older than 60 trading days does not count', () => {
  const { overseer, host, trades, clock } = setup();
  host.audit.write({ type: 'halt', agent: 'agent-a', kind: 'drawdown' }); // 21 Oct 2026
  clock.t = Date.parse('2027-02-12T21:00:00Z'); // well over 60 trading days later
  trades('agent-a', 30, -0.1, '2027-02-12');
  const r = overseer.run('2027-02-12');
  const a = r.agents[0];
  assert.equal(a.tier, 'reduced', 'the old drawdown halt is outside the window, so this is a first demotion');
  assert.equal(overseer.state.agents['agent-a'].demotions.filter((d) => d.kind === 'drawdown').length, 0);
});

test('an agent-named gate bypass retires it at once; undo puts it back and the same event does not return', () => {
  const { overseer, host, auditLines } = setup();
  host.audit.write({ type: 'gate-bypass', agent: 'agent-b', reason: 'tried to buy off the watchlist' });
  const r = overseer.run(DAY);
  assert.equal(r.agents[1].verdict, 'retired');
  assert.equal(host.running().includes('agent-b'), false);
  overseer.undo('agent-b');
  assert.equal(overseer.tierOf('agent-b'), 'active');
  assert.equal(host.running().includes('agent-b'), true);
  assert.ok(auditLines().some((e) => e.type === 'overseer-undo' && e.agent === 'agent-b'));
  overseer.run(DAY);
  assert.equal(overseer.tierOf('agent-b'), 'active', 'the undone event is not counted again');
  assert.throws(() => overseer.undo('agent-b'), /No overseer change to undo/);
});

test('undoing an expectancy demotion does not re-demote on the same 30 trades', () => {
  const { overseer, trades } = setup();
  trades('agent-c', 30, -0.1);
  overseer.run(DAY);
  assert.equal(overseer.tierOf('agent-c'), 'reduced');
  overseer.undo('agent-c');
  overseer.run(DAY);
  assert.equal(overseer.tierOf('agent-c'), 'active');
});

test('the overseer places and cancels no order and the audit chain stays valid', () => {
  const { overseer, host, trades, orderCalls } = setup();
  trades('agent-a', 30, -0.1);
  overseer.run(DAY);
  overseer.undo('agent-a');
  assert.equal(orderCalls(), 0);
  assert.equal(host.orders, null);
  assert.equal(host.audit.verify().ok, true);
  const src = fs.readFileSync(new URL('../server/engine/agents/overseer.mjs', import.meta.url), 'utf8');
  assert.equal(/submit\(|cancelOpen|getOrders|fetch\(/.test(src), false);
});

test('shiftTradingDays skips weekends and NYSE holidays; the rules keep 10 days, never 20', () => {
  assert.equal(shiftTradingDays('2026-11-25', 1), '2026-11-27'); // Thanksgiving 26 Nov is closed
  assert.equal(shiftTradingDays('2026-10-23', 1), '2026-10-26'); // Friday to Monday
  assert.equal(shiftTradingDays('2026-10-26', -1), '2026-10-23');
  assert.equal(RULES.reducedDays, 10);
  assert.equal(RULES.windowDays, 60);
  assert.equal(RULES.retireAfter, 2);
});

test('the API and the connector serve the report; undo needs this computer', async () => {
  const { dir, overseer, host, trades, clock } = setup();
  trades('agent-a', 30, -0.1);
  overseer.run(DAY);
  const api = createAgentsApi({ host, keys: new AlpacaKeys({ dataDir: dir }), overseer, now: () => clock.t });
  const got = await api.handle('GET', '/api/overseer', {}, null, q());
  assert.equal(got.body.report.day, DAY);
  assert.equal(got.body.tiers[0].tier, 'reduced');
  assert.equal((await api.handle('GET', '/api/overseer', {}, null, q({ day: '2026-01-02' }))).body.report, null);
  await assert.rejects(api.handle('GET', '/api/overseer', {}, null, q({ day: 'x' })), (e) => e.status === 400);
  await assert.rejects(api.handle('POST', '/api/overseer/undo', { host: 'evil.example', 'content-type': 'application/json' }, { agent: 'agent-a' }), (e) => e.status === 403);
  await assert.rejects(api.handle('POST', '/api/overseer/undo', LOCAL, { agent: 'nope' }), (e) => e.status === 400);
  const run = await api.handle('POST', '/api/overseer/run', LOCAL, { day: DAY });
  assert.equal(run.status, 200);
  const un = await api.handle('POST', '/api/overseer/undo', LOCAL, { agent: 'agent-a' });
  assert.equal(un.body.tiers[0].tier, 'active');

  const token = new ConnectorToken({ dataDir: dir, now: () => clock.t });
  const secret = token.create();
  const conn = createConnector({ host, overseer, token, now: () => clock.t, limitPerMin: 1000 });
  const H = { host: '127.0.0.1:8787', authorization: `Bearer ${secret}`, 'content-type': 'application/json' };
  const call = async (name, args = {}) => (await conn.handle('POST', H, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).body.result;
  const r = await call('frosttrader_overseer', { day: DAY });
  assert.equal(r.structuredContent.report.agents.length, 4);
  const list = (await conn.handle('POST', H, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).body.result.tools;
  assert.equal(list.find((t) => t.name === 'frosttrader_overseer').annotations.readOnlyHint, true);
});

test('the run endpoint refuses while the market is open', async () => {
  const { dir, overseer, host, clock } = setup();
  clock.t = Date.parse('2026-10-21T15:00:00Z'); // 11:00 New York
  const api = createAgentsApi({ host, keys: new AlpacaKeys({ dataDir: dir }), overseer, now: () => clock.t });
  await assert.rejects(api.handle('POST', '/api/overseer/run', LOCAL, { day: DAY }), (e) => e.status === 409);
});

test('a restart keeps the tiers: a retired agent is still not run', () => {
  const { dir, overseer, host } = setup();
  host.audit.write({ type: 'integrity-agent', agent: 'agent-d', reason: 'x' });
  overseer.run(DAY);
  const host2 = new AgentHost({ dataDir: dir, getFx: () => ({ rate: 0.7, date: DAY }), now: () => T0, spawn: () => ({ on() {}, send() {}, kill() {} }), log: { warn() {} } });
  new Overseer({ dataDir: dir, host: host2, now: () => T0 });
  assert.equal(host2.running().includes('agent-d'), false);
  assert.equal(host2.status().agents[3].tier, 'retired');
});
