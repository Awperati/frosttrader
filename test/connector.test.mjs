// Tests for the Frost AI connector (MCP at /mcp): the token, access checks, the protocol, every tool,
// stop/start/kill and what they can't do. No network: the handler is called directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { ConnectorToken, createConnector, TOOLS, PROTOCOL } from '../server/connector.mjs';
import { AgentHost } from '../server/engine/agents/host.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ft-conn-'));
const MIN = 60_000;
const T0 = Date.parse('2026-10-21T15:00:00Z');

function bars(end, price) {
  const out = [];
  for (let i = 40; i >= 1; i--) {
    const c = price * (1 + 0.002 * Math.sin(i));
    out.push({ t: end - i * 5 * MIN, o: c, h: c * 1.002, l: c * 0.998, c, v: 1000 });
  }
  return out;
}

function setup() {
  const dir = tmp();
  const clock = { t: T0 };
  const spawn = () => {
    const p = new EventEmitter();
    p.send = (m) => setImmediate(() => p.emit('message', { type: 'proposals', t: m.t, items: [{ symbol: 'AAPL', action: 'buy', signal: 'stop_run', score: 0.9 }] }));
    p.kill = () => {};
    return p;
  };
  const host = new AgentHost({ dataDir: dir, getUniverse: () => ['AAPL'], getData: () => ({ bars: async () => ({ AAPL: bars(clock.t, 200) }) }), getFx: () => ({ rate: 0.7, date: '2026-10-21' }), now: () => clock.t, spawn, log: { warn() {} } });
  const token = new ConnectorToken({ dataDir: dir, now: () => clock.t });
  const secret = token.create();
  const conn = createConnector({ host, token, now: () => clock.t, limitPerMin: 1000 });
  const H = { host: '127.0.0.1:8787', authorization: `Bearer ${secret}`, 'content-type': 'application/json' };
  let id = 0;
  const rpc = async (method, params, headers = H) => (await conn.handle('POST', headers, { jsonrpc: '2.0', id: ++id, method, ...(params ? { params } : {}) })).body;
  const call = async (name, args = {}) => {
    const r = await rpc('tools/call', { name, arguments: args });
    return r.result ? { ...r.result, data: r.result.structuredContent } : r;
  };
  return { dir, host, clock, token, secret, conn, H, rpc, call };
}

test('token: shown once, only its fingerprint kept, revocable', () => {
  const dir = tmp();
  const t = new ConnectorToken({ dataDir: dir });
  const s = t.create();
  assert.match(s, /^ftc_[\w-]{40,}$/);
  const file = fs.readFileSync(path.join(dir, 'connector.json'), 'utf8');
  assert.ok(!file.includes(s) && /"hash":"[0-9a-f]{64}"/.test(file));
  assert.equal(t.check(s), true);
  assert.equal(t.check(s + 'x'), false);
  assert.equal(t.check(''), false);
  assert.ok(!JSON.stringify(t.status()).includes(s));
  const s2 = t.create();
  assert.equal(t.check(s), false, 'a new token ends the old one');
  t.revoke();
  assert.equal(t.check(s2), false);
});

test('access: a token, this computer, no foreign web page, a rate limit', async () => {
  const { conn, H, host, token } = setup();
  const body = { jsonrpc: '2.0', id: 1, method: 'ping' };
  await assert.rejects(conn.handle('POST', { ...H, authorization: undefined }, body), (e) => e.status === 401);
  await assert.rejects(conn.handle('POST', { ...H, authorization: 'Bearer nope' }, body), (e) => e.status === 401);
  await assert.rejects(conn.handle('POST', { ...H, host: 'evil.example:8787' }, body), (e) => e.status === 403);
  await assert.rejects(conn.handle('POST', { ...H, origin: 'https://evil.example' }, body), (e) => e.status === 403);
  assert.equal((await conn.handle('POST', { ...H, origin: 'http://127.0.0.1:8787' }, body)).status, 200);
  await assert.rejects(conn.handle('GET', H, null), (e) => e.status === 405);
  const limited = createConnector({ host, token, limitPerMin: 2 });
  await limited.handle('POST', H, body);
  await limited.handle('POST', H, body);
  await assert.rejects(limited.handle('POST', H, body), (e) => e.status === 429);
  host.stop();
});

test('protocol: initialize, a notification (202), ping, tools/list, a batch, unknown methods and tools', async () => {
  const { conn, H, rpc, host } = setup();
  const init = await rpc('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'frost-ai', version: '1' } });
  assert.equal(init.result.protocolVersion, PROTOCOL);
  assert.equal(init.result.serverInfo.name, 'frosttrader');
  assert.deepEqual(await conn.handle('POST', H, { jsonrpc: '2.0', method: 'notifications/initialized' }), { status: 202, body: null });
  assert.deepEqual((await rpc('ping')).result, {});
  const list = (await rpc('tools/list')).result.tools.map((t) => t.name);
  assert.deepEqual(list, TOOLS.map((t) => t.name));
  assert.equal(list.length, 8);
  assert.ok(!list.some((n) => /resume|limit|setting|live|money/.test(n)), 'no tool to resume, change limits, settings, money or live');
  const batch = await conn.handle('POST', H, [{ jsonrpc: '2.0', id: 'a', method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 'b', method: 'tools/list' }]);
  assert.deepEqual(batch.body.map((r) => r.id), ['a', 'b']);
  assert.equal((await rpc('resources/list')).error.code, -32601);
  assert.equal((await rpc('tools/call', { name: 'frosttrader_resume', arguments: {} })).error.code, -32602);
  assert.equal((await rpc('tools/call', { name: 'frosttrader_status', arguments: { live: true } })).error.code, -32602);
  assert.equal((await conn.handle('POST', H, { id: 9 })).body.error.code, -32600);
  host.stop();
});

test('read tools: status, today, stats, decisions, research', async () => {
  const { call, host } = setup();
  await host.tick(); // agent-a buys AAPL on paper
  const st = await call('frosttrader_status');
  assert.equal(st.isError, false);
  assert.equal(st.data.paperOnly, true);
  assert.equal(st.data.agents.find((a) => a.agent === 'agent-a').positions[0].symbol, 'AAPL');
  assert.equal(JSON.parse(st.content[0].text).paperOnly, true);
  const today = await call('frosttrader_today', { day: '2026-10-21' });
  assert.equal(today.data.day, '2026-10-21');
  const dec = await call('frosttrader_decisions', { day: '2026-10-21', agent: 'agent-a' });
  assert.match(dec.data.decisions.at(-1).text, /^bought .* AAPL/);
  assert.equal((await call('frosttrader_decisions', { day: '21/10/2026' })).error.code, -32602);
  assert.equal((await call('frosttrader_stats', { days: 9999 })).error.code, -32602);
  assert.equal((await call('frosttrader_stats', { agent: 'agent-b' })).data.agent, 'agent-b');
  assert.match((await call('frosttrader_research')).data.note, /not running/);
  assert.ok(host.audit.tail(20).some((e) => e.type === 'connector' && e.tool === 'frosttrader_status'));
  host.stop();
});

test('stop, start and kill: stop blocks new buys only; start can\'t undo a kill', async () => {
  const { call, host, clock } = setup();
  assert.equal((await call('frosttrader_stop')).isError, false);
  assert.equal(host.status().paused.by, 'Frost AI connector');
  await host.tick();
  assert.equal(host.status().agents[0].positions.length, 0, 'no buy while stopped');
  assert.match((await call('frosttrader_start')).data.started, /allowed/);
  clock.t += 5 * MIN;
  await host.tick();
  assert.equal(host.status().agents[0].positions.length, 1, 'buys again');
  assert.equal((await call('frosttrader_kill', {})).error.code, -32602, 'a reason is required');
  const k = await call('frosttrader_kill', { reason: 'owner asked in chat' });
  assert.equal(k.data.killed, true);
  assert.equal(host.status().agents[0].positions.length, 0, 'sold');
  assert.match(host.status().killReason, /Frost AI connector: owner asked in chat/);
  const s = await call('frosttrader_start');
  assert.equal(s.data.started, false);
  assert.equal(host.status().killed, true, 'still killed: only FrostTrader\'s own screen resumes');
  host.stop();
});
