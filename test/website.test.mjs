// The private website (server/web-gate.mjs, docs/WEBSITE.md): off by default; through Cloudflare only
// with a signed-in session (password + code), the right hostname and Origin, Cloudflare Access's token
// when configured; no CORS, strict headers; live keys never over the website; sign-ins audited.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { startServer } from '../server/app.mjs';
import { WebGate, isRemote, clientIp } from '../server/web-gate.mjs';
import { Auth } from '../server/auth.mjs';
import { base32Encode, base32Decode, codeAt, createTotp } from '../server/totp.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ft-web-'));
const HOSTNAME = 'trader.example.test';
const SECRET = base32Encode(crypto.randomBytes(20));
const code = () => codeAt(base32Decode(SECRET), Math.floor(Date.now() / 30_000));

function req(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers } }, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(data);
        } catch {}
        resolve({ status: res.statusCode, headers: res.headers, json, text: data });
      });
    });
    r.on('error', reject);
    if (body) r.end(JSON.stringify(body));
    else r.end();
  });
}

async function server(env) {
  const saved = {};
  for (const k of ['FROST_TRADER_PASSWORD', 'FROST_TRADER_TOTP_SECRET', 'FROST_TRADER_PUBLIC_HOST', 'FROST_TRADER_CF_TEAM', 'FROST_TRADER_CF_AUD']) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  const dir = tmp();
  const s = await startServer({ dataDir: dir, ports: [0], agents: false, finviz: false, tickerMirror: false, log: { log() {}, warn() {}, error() {}, info() {} } });
  for (const [k, v] of Object.entries(saved)) (v === undefined ? delete process.env[k] : (process.env[k] = v));
  return { s, dir, port: s.port };
}

const remote = (extra = {}) => ({ host: HOSTNAME, 'cf-connecting-ip': '203.0.113.7', ...extra });

test('remote or local: Cloudflare\'s header or any other Host is remote; its address is trusted only from the local tunnel', () => {
  assert.equal(isRemote({ headers: { host: '127.0.0.1:8795' } }), false);
  assert.equal(isRemote({ headers: { host: '127.0.0.1:8795', 'cf-connecting-ip': '1.2.3.4' } }), true);
  assert.equal(isRemote({ headers: { host: HOSTNAME } }), true);
  assert.equal(clientIp({ headers: { 'cf-connecting-ip': '203.0.113.7' }, socket: { remoteAddress: '127.0.0.1' } }), '203.0.113.7');
  assert.equal(clientIp({ headers: { 'cf-connecting-ip': '203.0.113.7' }, socket: { remoteAddress: '10.0.0.9' } }), '10.0.0.9', 'not from the local tunnel: the header is ignored');
});

test('website off by default: everything through Cloudflare is refused; this computer works as before', async () => {
  const { s, port } = await server({ FROST_TRADER_PASSWORD: 'a-long-owner-password', FROST_TRADER_TOTP_SECRET: SECRET });
  try {
    assert.equal((await req(port, { path: '/api/agents', headers: remote() })).status, 403);
    assert.equal((await req(port, { path: '/', headers: remote() })).status, 403);
    const local = await req(port, { path: '/api/agents', headers: { host: `127.0.0.1:${port}` } });
    assert.equal(local.status, 200);
    assert.match(local.headers['content-security-policy'], /default-src 'self'/);
    assert.equal(local.headers['access-control-allow-origin'], undefined, 'no CORS');
  } finally {
    await s.stop();
  }
});

test('website on: sign-in with password and code, then a session token; wrong host, Origin, /mcp and live keys refused; sign-ins audited', async () => {
  const { s, port, dir } = await server({ FROST_TRADER_PASSWORD: 'a-long-owner-password', FROST_TRADER_TOTP_SECRET: SECRET, FROST_TRADER_PUBLIC_HOST: HOSTNAME });
  try {
    const page = await req(port, { path: '/', headers: remote() });
    assert.equal(page.headers['strict-transport-security'], 'max-age=31536000');
    assert.equal(page.headers['x-frame-options'], 'DENY');
    assert.equal((await req(port, { path: '/api/agents', headers: remote() })).status, 401, 'no session');
    assert.equal((await req(port, { path: '/api/agents', headers: remote({ host: 'evil.example' }) })).status, 421, 'any other hostname is refused');
    assert.equal((await req(port, { path: '/api/agents', headers: remote({ host: `${HOSTNAME}.evil.example` }) })).status, 421);
    assert.equal((await req(port, { method: 'POST', path: '/mcp', headers: remote(), body: {} })).status, 403);
    const st = await req(port, { path: '/api/auth/status', headers: remote() });
    assert.deepEqual([st.json.website, st.json.remote, st.json.signedIn], [true, true, false]);
    const bad = await req(port, { method: 'POST', path: '/api/auth/login', headers: remote(), body: { password: 'a-long-owner-password', code: '000000' } });
    assert.equal(bad.status, 401);
    const ok = await req(port, { method: 'POST', path: '/api/auth/login', headers: remote(), body: { password: 'a-long-owner-password', code: code() } });
    assert.equal(ok.status, 200);
    const token = ok.json.token;
    assert.match(token, /^[A-Za-z0-9_-]{20,}$/);
    assert.equal(ok.headers['set-cookie'], undefined, 'no cookie');
    const auth = { authorization: `Bearer ${token}` };
    assert.equal((await req(port, { path: '/api/agents', headers: remote(auth) })).status, 200);
    assert.equal((await req(port, { method: 'PUT', path: '/api/agents/settings', headers: remote({ ...auth, origin: `https://${HOSTNAME}` }), body: { paperPerAgent: 20 } })).status, 200, 'a signed-in change');
    assert.equal((await req(port, { method: 'PUT', path: '/api/agents/settings', headers: remote({ ...auth, origin: 'https://evil.example' }), body: { paperPerAgent: 30 } })).status, 403, 'another site');
    assert.equal((await req(port, { method: 'PUT', path: '/api/agents/settings', headers: remote({ origin: `https://${HOSTNAME}` }), body: { paperPerAgent: 30 } })).status, 401, 'no session, no change');
    const keys = await req(port, { method: 'PUT', path: '/api/live/keys', headers: remote({ ...auth, origin: `https://${HOSTNAME}` }), body: { keyId: 'AKTESTLIVEKEY1234567', secret: 'livesecretlivesecret1234' } });
    assert.equal(keys.status, 403);
    assert.match(keys.json.error, /through the SSH tunnel/);
    assert.equal(fs.existsSync(path.join(dir, 'alpaca-live-keys.json')), false);
    const kill = await req(port, { method: 'POST', path: '/api/agents/kill', headers: remote({ ...auth, origin: `https://${HOSTNAME}` }), body: { reason: 'from the phone' } });
    assert.equal(kill.status, 200, 'the kill switch works from the phone');
    assert.equal(kill.json.killed, true);
    assert.equal((await req(port, { method: 'POST', path: '/api/auth/logout', headers: remote({ ...auth, origin: `https://${HOSTNAME}` }), body: {} })).status, 200);
    assert.equal((await req(port, { path: '/api/agents', headers: remote(auth) })).status, 401, 'signed out');
    const audit = fs.readFileSync(path.join(dir, 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(audit.some((e) => e.type === 'login' && e.ok === false && e.ip === '203.0.113.7'));
    assert.ok(audit.some((e) => e.type === 'login' && e.ok === true));
    assert.ok(audit.some((e) => e.type === 'logout'));
    assert.ok(audit.some((e) => e.type === 'website-action' && e.route === 'POST /api/agents/kill'));
    assert.ok(!fs.readFileSync(path.join(dir, 'audit.jsonl'), 'utf8').includes(token), 'no token in the log');
  } finally {
    await s.stop();
  }
});

test('website needs his 6-digit code: with only a password it stays off', async () => {
  const { s, port } = await server({ FROST_TRADER_PASSWORD: 'a-long-owner-password', FROST_TRADER_PUBLIC_HOST: HOSTNAME });
  try {
    assert.equal((await req(port, { path: '/api/auth/status', headers: remote() })).status, 403);
  } finally {
    await s.stop();
  }
});

test('sessions end after 30 minutes idle or 12 hours', async () => {
  const dir = tmp();
  const clock = { t: Date.parse('2026-10-27T00:00:00Z') };
  const auth = new Auth(dir, 'pw', { enabled: false, check: () => false }, { now: () => clock.t, limits: { idleMs: 30 * 60_000, maxAgeMs: 12 * 3_600_000 } });
  const { token } = await auth.login('1.1.1.1', { password: 'pw', device: 'Website' });
  clock.t += 29 * 60_000;
  assert.ok(auth.check(token));
  clock.t += 31 * 60_000;
  assert.throws(() => auth.check(token), /signed out/);
  const second = await auth.login('1.1.1.1', { password: 'pw', device: 'Website' });
  for (let h = 0; h < 12; h++) {
    clock.t += 25 * 60_000;
    auth.check(second.token);
  }
  clock.t += 25 * 60_000;
  clock.t += 12 * 3_600_000;
  assert.throws(() => auth.check(second.token), /signed out/);
});

test('Cloudflare Access token: checked against Access\'s keys, audience, team and expiry', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256' };
  const sign = (claims, kid = 'k1') => {
    const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid })).toString('base64url');
    const c = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${h}.${c}.${crypto.sign('RSA-SHA256', Buffer.from(`${h}.${c}`), privateKey).toString('base64url')}`;
  };
  const authObj = { totp: { enabled: true }, check: () => ({ id: 'd' }) };
  let fetched = 0;
  const gate = new WebGate({ publicHost: HOSTNAME, auth: authObj, access: { team: 'frost', aud: 'AUD123' }, fetchImpl: async () => (fetched++, { ok: true, json: async () => ({ keys: [jwk] }) }) });
  const r = (jwt) => ({ headers: { ...remote(), 'cf-access-jwt-assertion': jwt }, socket: { remoteAddress: '127.0.0.1' } });
  const good = { aud: ['AUD123'], iss: 'https://frost.cloudflareaccess.com', exp: Math.floor(Date.now() / 1000) + 600 };
  assert.equal((await gate.admit(r(sign(good)), '/')).remote, true);
  await assert.rejects(gate.admit(r(sign({ ...good, aud: ['OTHER'] })), '/'), /another application/);
  await assert.rejects(gate.admit(r(sign({ ...good, iss: 'https://evil.cloudflareaccess.com' })), '/'), /another team/);
  await assert.rejects(gate.admit(r(sign({ ...good, exp: 1 })), '/'), /expired/);
  await assert.rejects(gate.admit(r(sign(good, 'k2')), '/'), /unknown key/);
  await assert.rejects(gate.admit(r('not.a.jwt'), '/'), /unreadable|Access/);
  await assert.rejects(gate.admit({ headers: remote(), socket: { remoteAddress: '127.0.0.1' } }, '/'), /Access sign-in required/);
  const forged = sign(good).split('.');
  forged[1] = Buffer.from(JSON.stringify({ ...good, aud: ['AUD123'], sub: 'x' })).toString('base64url');
  await assert.rejects(gate.admit(r(forged.join('.')), '/'), /bad signature/);
  assert.equal(fetched, 1, 'Access\'s keys are cached');
});

test('the owner sign-in on the server and the TOTP module agree', () => {
  const t = createTotp(SECRET);
  assert.equal(t.enabled, true);
  assert.equal(t.check(code()), true);
});
