// Phone alerts (server/notify.mjs) against a fake ntfy on 127.0.0.1: off until a topic is set, the
// topic never shown, no account numbers or keys in a message, rate limits, failures never thrown, and
// the events that send them (kill switch, live switch-on, a new website sign-in).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Notifier, sanitize, RATE } from '../server/notify.mjs';
import { AgentHost } from '../server/engine/agents/host.mjs';
import { startServer } from '../server/app.mjs';
import { base32Encode, base32Decode, codeAt } from '../server/totp.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ft-ntfy-'));
const TOPIC = 'frosttrader-k3j9x2m8q7w4r1t6';

/** A fake ntfy that records every POST (and can fail). */
function fakeFetch({ fail = false } = {}) {
  const posts = [];
  const fetchImpl = async (url, init) => {
    posts.push({ url, headers: init.headers, body: init.body });
    if (fail) throw new Error(`connect ECONNREFUSED ${url}`);
    return { ok: true, status: 200 };
  };
  return { posts, fetchImpl };
}

test('notifier: off until a topic is set; the topic is write-only; messages carry no account number or key', async () => {
  const dir = tmp();
  const f = fakeFetch();
  const n = new Notifier({ dataDir: dir, fetchImpl: f.fetchImpl });
  assert.equal(n.on, false);
  assert.equal(await n.send('kill', { message: 'x' }), false);
  assert.equal(f.posts.length, 0);
  assert.throws(() => n.update({ topic: 'short' }), /16 to 64/);
  assert.throws(() => n.update({ server: 'http://ntfy.sh' }), /https/);
  const st = n.update({ topic: TOPIC, priorities: { fill: 2, kill: 9 } });
  assert.equal(st.on, true);
  assert.ok(!JSON.stringify(st).includes(TOPIC), 'the topic is never shown');
  assert.equal(st.priorities.fill, 2);
  assert.equal(st.priorities.kill, 5, 'out of range is ignored');
  assert.equal((fs.statSync(path.join(dir, 'notify.json')).mode & 0o077) === 0 || process.platform === 'win32', true);
  assert.equal(await n.send('liveStop', { message: 'Live trading stopped: a different account (…4321) than 987654321, key AKTESTLIVEKEY1234567' }), true);
  const p = f.posts[0];
  assert.equal(p.url, `https://ntfy.sh/${TOPIC}`);
  assert.equal(p.headers.Priority, '5');
  assert.ok(!/4321|987654321|AKTESTLIVEKEY/.test(p.body), `sanitized: ${p.body}`);
  assert.equal(sanitize('order for A$25.00 at 14:05'), 'order for A$25.00 at 14:05', 'amounts and times stay');
});

test('notifier: a loop can\'t spam (burst limit, same message once a minute); a failure never throws', async () => {
  const f = fakeFetch();
  const clock = { t: 0 };
  const n = new Notifier({ dataDir: tmp(), fetchImpl: f.fetchImpl, now: () => clock.t });
  n.update({ topic: TOPIC });
  await n.send('fill', { message: 'same' });
  await n.send('fill', { message: 'same' });
  assert.equal(f.posts.length, 1, 'the same message once a minute');
  for (let i = 0; i < 50; i++) await n.send('fill', { message: `m${i}` });
  assert.equal(f.posts.length, RATE.burst, `at most ${RATE.burst} in ten minutes`);
  assert.ok(n.counts.dropped > 0);
  clock.t += RATE.windowMs + 1;
  assert.equal(await n.send('fill', { message: 'later' }), true);
  const bad = fakeFetch({ fail: true });
  const m = new Notifier({ dataDir: tmp(), fetchImpl: bad.fetchImpl });
  m.update({ topic: TOPIC });
  assert.equal(await m.send('kill', { message: 'x' }), false, 'returns false, does not throw');
  assert.ok(m.lastError && !m.lastError.includes(TOPIC), 'the topic is kept out of the error');
});

test('host: the kill switch sends an alert; a failing alert does not stop the kill', async () => {
  const sent = [];
  const spawn = () => Object.assign(new EventEmitter(), { send() {}, kill() {} });
  const host = new AgentHost({ dataDir: tmp(), getFx: () => ({ rate: 0.7, date: '2026-10-21' }), spawn, notify: (e, m) => (sent.push([e, m]), undefined), log: { warn() {} } });
  const st = host.kill('from the phone');
  assert.equal(st.killed, true);
  assert.deepEqual(sent.map(([e]) => e), ['kill']);
  assert.match(sent[0][1].message, /from the phone/);
  host.stop();
  const throwing = new AgentHost({ dataDir: tmp(), spawn, notify: () => { throw new Error('ntfy down'); }, log: { warn() {} } });
  assert.equal(throwing.kill('x').killed, true, 'the kill happens even when the alert throws');
  throwing.stop();
});

function req(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers } }, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(data); } catch { return null; } })() }));
    });
    r.on('error', reject);
    r.end(body ? JSON.stringify(body) : undefined);
  });
}

test('server: alert settings from this computer only (or the signed-in website), topic never returned; a new website sign-in alerts once', async () => {
  const SECRET = base32Encode(crypto.randomBytes(20));
  const saved = { ...process.env };
  Object.assign(process.env, { FROST_TRADER_PASSWORD: 'a-long-owner-password', FROST_TRADER_TOTP_SECRET: SECRET, FROST_TRADER_PUBLIC_HOST: 'trader.example.test' });
  const dir = tmp();
  const s = await startServer({ dataDir: dir, ports: [0], agents: false, finviz: false, tickerMirror: false, log: { log() {}, warn() {}, error() {}, info() {} } });
  for (const k of ['FROST_TRADER_PASSWORD', 'FROST_TRADER_TOTP_SECRET', 'FROST_TRADER_PUBLIC_HOST']) (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]));
  const posts = [];
  s.notifier.fetchImpl = async (url, init) => (posts.push({ url, body: init.body }), { ok: true, status: 200 });
  const local = { host: `127.0.0.1:${s.port}` };
  try {
    assert.equal((await req(s.port, { path: '/api/notify', headers: local })).json.on, false, 'off by default');
    assert.equal((await req(s.port, { method: 'PUT', path: '/api/notify', headers: { host: 'evil.example' }, body: { topic: TOPIC } })).status, 421);
    const put = await req(s.port, { method: 'PUT', path: '/api/notify', headers: local, body: { topic: TOPIC } });
    assert.equal(put.status, 200);
    assert.ok(!JSON.stringify(put.json).includes(TOPIC));
    assert.equal((await req(s.port, { method: 'POST', path: '/api/notify/test', headers: local, body: {} })).status, 200);
    assert.equal(posts.length, 1);
    const remote = { host: 'trader.example.test', 'cf-connecting-ip': '198.51.100.23', 'cf-ipcountry': 'AU' };
    const code = () => codeAt(base32Decode(SECRET), Math.floor(Date.now() / 30_000));
    assert.equal((await req(s.port, { method: 'POST', path: '/api/auth/login', headers: remote, body: { password: 'a-long-owner-password', code: code() } })).status, 200);
    await new Promise((r) => setTimeout(r, 50));
    const signIn = posts.find((p) => /New sign-in/.test(p.body));
    assert.ok(signIn, 'a new place alerts');
    assert.match(signIn.body, /from AU/);
    assert.ok(!signIn.body.includes('198.51.100.23'), 'only the end of the address');
  } finally {
    await s.stop();
  }
});
