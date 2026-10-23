// Tests for the Finviz Elite screener source. A fake Finviz runs on 127.0.0.1 with a fake token;
// nothing here reaches finviz.com. Sleeps are recorded instead of waited.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toExportUrl, parseFinvizCsv, redact, RateLimiter, fetchExport, FinvizSource, inFetchWindow, RATE, readWatchlist } from '../server/engine/finviz.mjs';
import { createFinvizApi, checkLocal } from '../server/finviz-api.mjs';
import { createNumbersApi } from '../server/numbers-api.mjs';
import { HttpError } from '../server/store.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = 'fake-token-0123456789abcdef';
const CSV = '﻿"No.","Ticker","Company","Sector","Price"\r\n"1","AAPL","Apple Inc.","Technology","230.1"\r\n"2","BRK-B","Berkshire Hathaway Inc. ""B""","Financial","460"\r\n"3","MSFT","Microsoft, Corp","Technology","420"\r\n"4","AAPL","dup","x","1"\r\n';

// The fake Finviz: routes by path, records every request (with its auth value) for the checks.
let server;
let base;
const seen = [];
let script = {}; // path -> list of responses to give in turn; the last one repeats
function reply(res, r) {
  res.writeHead(r.status || 200, { 'content-type': r.type || 'text/csv', ...(r.headers || {}) });
  res.end(r.body ?? '');
}
before(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    seen.push({ path: u.pathname, auth: u.searchParams.get('auth'), query: u.search });
    const list = script[u.pathname];
    if (!list) return reply(res, { status: 404, body: 'no' });
    reply(res, list.length > 1 ? list.shift() : list[0]);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const HOSTS = ['127.0.0.1'];
const noWait = () => {
  const slept = [];
  return { slept, sleep: async (ms) => void slept.push(ms) };
};
const limiter = () => new RateLimiter({ max: 1000, windowMs: 1 });
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ft-finviz-'));

test('screener URLs become export URLs; any pasted token is dropped', () => {
  const a = toExportUrl('https://elite.finviz.com/screener/stocks?v=111&f=cap_midover,sh_avgvol_o500&o=-volume');
  assert.equal(a.url, 'https://elite.finviz.com/export/screener?type=stocks&v=111&f=cap_midover%2Csh_avgvol_o500&o=-volume');
  assert.equal(a.type, 'stocks');
  assert.equal(a.hadToken, false);
  const legacy = toExportUrl('https://finviz.com/screener.ashx?v=111&f=exch_nasd&auth=SECRET123&c=0,1,2');
  assert.equal(legacy.hadToken, true);
  assert.ok(!legacy.url.includes('SECRET123') && !legacy.url.includes('auth'));
  assert.match(legacy.url, /^https:\/\/finviz\.com\/export\/screener\?type=stocks&v=111&f=exch_nasd&c=0%2C1%2C2$/);
  assert.equal(toExportUrl('https://elite.finviz.com/screener/etf?v=111').type, 'etf');
  assert.equal(toExportUrl('https://elite.finviz.com/export/screener?type=etf&v=111').url, 'https://elite.finviz.com/export/screener?type=etf&v=111');
  assert.throws(() => toExportUrl('https://evil.example/screener/stocks?v=1'), /Only finviz\.com/);
  assert.throws(() => toExportUrl('http://finviz.com/screener/stocks?v=1'), /https/);
  assert.throws(() => toExportUrl('https://finviz.com/quote.ashx?t=AAPL'), /not a screener/);
  assert.throws(() => toExportUrl('not a url'), /web address/);
});

test('CSV parsing: quotes, commas, BOM, duplicates; web pages and missing Ticker are errors', () => {
  const p = parseFinvizCsv(CSV);
  assert.equal(p.rows, 4);
  assert.deepEqual(p.tickers, ['AAPL', 'BRK-B', 'MSFT', 'AAPL']);
  assert.deepEqual(p.columns, ['No.', 'Ticker', 'Company', 'Sector', 'Price']);
  assert.deepEqual(parseFinvizCsv('').tickers, []);
  assert.deepEqual(parseFinvizCsv('"No.","Ticker"\n').tickers, []);
  assert.throws(() => parseFinvizCsv('<!DOCTYPE html><html>Login</html>'), /web page instead of a CSV/);
  assert.throws(() => parseFinvizCsv('"No.","Company"\n"1","Apple"'), /no "Ticker" column/);
});

test('redaction hides the token in URLs and anywhere it appears', () => {
  assert.equal(redact(`GET https://elite.finviz.com/export/screener?type=stocks&auth=${TOKEN}&v=1`), 'GET https://elite.finviz.com/export/screener?type=stocks&auth=***&v=1');
  assert.equal(redact(`?auth=${TOKEN}`), '?auth=***');
  assert.equal(redact(`token ${TOKEN} in text`, TOKEN), 'token *** in text');
  assert.equal(redact('nothing here', TOKEN), 'nothing here');
});

test('rate limiter: never more than RATE.max starts in any window', async () => {
  let t = 0;
  const lim = new RateLimiter({ now: () => t, sleep: async (ms) => void (t += ms) });
  const starts = [];
  for (let i = 0; i < 7; i++) {
    await lim.acquire();
    starts.push(t);
  }
  assert.ok(RATE.max <= 5 && RATE.windowMs >= 5000, 'well under Finviz\'s 10 per 5 s');
  for (let i = RATE.max; i < starts.length; i++) assert.ok(starts[i] - starts[i - RATE.max] >= RATE.windowMs, `start ${i} came too soon: ${starts}`);
  assert.equal(starts[starts.length - 1], Math.floor((starts.length - 1) / RATE.max) * RATE.windowMs);
});

test('fetch: follows the legacy 301 with the token, on allowed hosts only', async () => {
  seen.length = 0;
  script = {
    '/export.ashx': [{ status: 301, headers: { location: '/export/screener?type=stocks&v=111' } }],
    '/export/screener': [{ body: CSV }],
  };
  const text = await fetchExport(`${base}/export.ashx?v=111`, TOKEN, { limiter: limiter(), hosts: HOSTS, ...noWait() });
  assert.deepEqual(parseFinvizCsv(text).tickers, parseFinvizCsv(CSV).tickers);
  assert.deepEqual(seen.map((s) => [s.path, s.auth]), [['/export.ashx', TOKEN], ['/export/screener', TOKEN]]);

  seen.length = 0;
  script = { '/export/screener': [{ status: 301, headers: { location: 'https://evil.example/steal' } }] };
  await assert.rejects(fetchExport(`${base}/export/screener?type=stocks`, TOKEN, { limiter: limiter(), hosts: HOSTS, ...noWait() }), (e) => /another site/.test(e.message) && !e.message.includes(TOKEN));
});

test('fetch: backs off on 429 and 5xx, honours Retry-After, and errors carry no token', async () => {
  script = { '/export/screener': [{ status: 429, headers: { 'retry-after': '3' } }, { status: 503 }, { body: CSV }] };
  const w = noWait();
  assert.equal(parseFinvizCsv(await fetchExport(`${base}/export/screener?type=stocks`, TOKEN, { limiter: limiter(), hosts: HOSTS, ...w })).rows, 4);
  assert.deepEqual(w.slept, [3000, 4000]);

  script = { '/export/screener': [{ status: 500 }] };
  const w2 = noWait();
  await assert.rejects(fetchExport(`${base}/export/screener?type=stocks`, TOKEN, { limiter: limiter(), hosts: HOSTS, ...w2 }), (e) => /server error \(HTTP 500\)/.test(e.message) && !e.message.includes(TOKEN));
  assert.deepEqual(w2.slept, [2000, 4000, 8000]);

  script = { '/export/screener': [{ status: 403, body: 'bad token' }] };
  await assert.rejects(fetchExport(`${base}/export/screener?type=stocks`, TOKEN, { limiter: limiter(), hosts: HOSTS, ...noWait() }), /refused the API token/);
  await assert.rejects(fetchExport(`${base}/export/screener?type=stocks`, '', { limiter: limiter(), hosts: HOSTS }), /No Finviz API token/);
});

function makeSource(dir, t0 = Date.parse('2026-10-23T14:00:00Z')) {
  const logged = [];
  const clock = { t: t0 };
  const src = new FinvizSource({ dataDir: dir, hosts: HOSTS, now: () => clock.t, limiter: limiter(), ...noWait(), log: { warn: (m) => logged.push(m) } });
  return { src, logged, clock };
}

test('source: a good fetch makes the watchlist; the token is kept apart and never shown', async () => {
  const dir = tmpDir();
  const { src } = makeSource(dir);
  src.update({ urls: [`${base}/screener/stocks?v=111&f=a&auth=${TOKEN}`, `${base}/screener/stocks?v=111&f=b`], token: TOKEN, intervalMin: 15 });
  script = { '/export/screener': [{ body: CSV }, { body: '"No.","Ticker"\n"1","NVDA"\n"2","^VIX"\n"3","MSFT"\n' }] };
  const st = await src.refresh('test');
  assert.equal(st.last.ok, true);
  assert.deepEqual(st.last.perUrl.map((p) => p.rows), [4, 3]);
  assert.deepEqual(st.list.symbols, ['AAPL', 'BRK-B', 'MSFT', 'NVDA']);
  assert.deepEqual(st.list.rejected, ['^VIX']);
  assert.equal(st.tokenSet, true);
  assert.deepEqual(readWatchlist(dir).symbols, ['AAPL', 'BRK-B', 'MSFT', 'NVDA']);
  // The token is only in its own file: not in the status, settings, watchlist or stored URLs.
  assert.ok(!JSON.stringify(st).includes(TOKEN));
  for (const f of ['finviz.json', 'watchlist.json']) assert.ok(!fs.readFileSync(path.join(dir, f), 'utf8').includes(TOKEN), f);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'finviz-token.json'), 'utf8')).token, TOKEN);
  // A restart reads it all back.
  const again = new FinvizSource({ dataDir: dir, hosts: HOSTS });
  assert.equal(again.status().tokenSet, true);
  assert.deepEqual(again.symbols(), ['AAPL', 'BRK-B', 'MSFT', 'NVDA']);
  src.update({ clearToken: true });
  assert.equal(fs.existsSync(path.join(dir, 'finviz-token.json')), false);
});

test('source: a failed fetch keeps the last good list, marks it stale with its age, and logs no token', async () => {
  const dir = tmpDir();
  const { src, logged, clock } = makeSource(dir);
  src.update({ urls: [`${base}/screener/stocks?v=111`], token: TOKEN });
  script = { '/export/screener': [{ body: CSV }] };
  await src.refresh();
  clock.t += 47 * 60_000;
  script = { '/export/screener': [{ status: 502, body: `upstream said auth=${TOKEN}` }] };
  const st = await src.refresh();
  assert.equal(st.last.ok, false);
  assert.match(st.last.error, /HTTP 502/);
  assert.deepEqual(st.list.symbols, ['AAPL', 'BRK-B', 'MSFT']);
  assert.equal(st.list.stale, true);
  assert.equal(st.list.ageMin, 47);
  assert.equal(logged.length, 1);
  assert.ok(!logged.join('\n').includes(TOKEN) && !JSON.stringify(st).includes(TOKEN));
  script = { '/export/screener': [{ body: '<html>Please log in</html>', type: 'text/html' }] };
  const st2 = await src.refresh();
  assert.match(st2.last.error, /web page instead of a CSV/);
  assert.deepEqual(st2.list.symbols, ['AAPL', 'BRK-B', 'MSFT']);
});

test('source: settings are checked; non-Finviz hosts and bad tokens are refused', () => {
  const src = new FinvizSource({ dataDir: tmpDir() });
  assert.throws(() => src.update({ urls: ['https://evil.example/screener/stocks?v=1'] }), /Only finviz\.com/);
  assert.throws(() => src.update({ urls: Array(6).fill('https://finviz.com/screener/stocks?v=1') }), /At most 5/);
  assert.throws(() => src.update({ intervalMin: 1 }), /interval/);
  assert.throws(() => src.update({ token: 'has spaces in it' }), /does not look like/);
  const st = src.update({ urls: ['https://finviz.com/screener.ashx?v=111&auth=PASTED1234'] });
  assert.deepEqual(st.urls, ['https://finviz.com/export/screener?type=stocks&v=111']);
  assert.match(st.note, /token in that URL was not saved/);
  assert.equal(st.tokenSet, false);
});

test('schedule: weekdays 09:00 to 16:15 New York time', () => {
  assert.equal(inFetchWindow(Date.parse('2026-10-23T13:00:00Z')), true); // Fri 09:00 EDT
  assert.equal(inFetchWindow(Date.parse('2026-10-23T12:59:00Z')), false); // 08:59
  assert.equal(inFetchWindow(Date.parse('2026-10-23T20:14:00Z')), true); // 16:14
  assert.equal(inFetchWindow(Date.parse('2026-10-23T20:15:00Z')), false); // 16:15
  assert.equal(inFetchWindow(Date.parse('2026-10-24T15:00:00Z')), false); // Saturday
  assert.equal(inFetchWindow(Date.parse('2026-12-01T14:30:00Z')), true); // 09:30 EST
});

test('API: GET never carries the token; changes only from this machine\'s own page', async () => {
  const dir = tmpDir();
  const { src } = makeSource(dir);
  const api = createFinvizApi({ source: src });
  const local = { host: '127.0.0.1:8787', origin: 'http://127.0.0.1:8787', 'content-type': 'application/json' };
  const put = await api.handle('PUT', '/api/finviz', local, { urls: [`${base}/screener/stocks?v=111`], token: TOKEN });
  assert.equal(put.body.tokenSet, true);
  const get = await api.handle('GET', '/api/finviz', {});
  assert.ok(!JSON.stringify(get.body).includes(TOKEN));
  await assert.rejects(api.handle('PUT', '/api/finviz', { ...local, origin: 'https://evil.example' }, { clearToken: true }), (e) => e instanceof HttpError && e.status === 403);
  await assert.rejects(api.handle('PUT', '/api/finviz', { ...local, host: 'evil.example:8787', origin: undefined }, {}), (e) => e.status === 403);
  await assert.rejects(api.handle('POST', '/api/finviz/test', { ...local, 'content-type': 'text/plain' }), (e) => e.status === 415);
  await assert.rejects(api.handle('PUT', '/api/finviz', local, { urls: ['https://evil.example/x'] }), (e) => e.status === 400);
  assert.doesNotThrow(() => checkLocal({ host: 'localhost:8787', 'content-type': 'application/json' }));
  script = { '/export/screener': [{ body: CSV }] };
  const t = await api.handle('POST', '/api/finviz/test', local);
  assert.equal(t.body.last.perUrl[0].rows, 4);
  assert.ok(!JSON.stringify(t.body).includes(TOKEN));
  // The Stock numbers view shows the same list.
  const numbers = createNumbersApi({ dataDir: dir, watchlist: () => src.status() });
  const ov = await numbers.handle('GET', '/api/numbers');
  assert.equal(ov.body.watchlist.status, 'set');
  assert.deepEqual(ov.body.watchlist.symbols, ['AAPL', 'BRK-B', 'MSFT']);
});

test('the token store sits in the git-ignored data folder; the Finviz code places no orders', () => {
  const ignore = fs.readFileSync(path.join(here, '..', '.gitignore'), 'utf8').split(/\r?\n/);
  assert.ok(ignore.includes('/data'), 'DATA_DIR (./data) must stay out of git');
  for (const f of ['../server/engine/finviz.mjs', '../server/finviz-api.mjs']) {
    const src = fs.readFileSync(path.join(here, f), 'utf8');
    const imports = src.match(/^import .*$/gm) || [];
    assert.ok(!imports.some((l) => /broker|alpaca|strategy|engine\.mjs/i.test(l)), `${f} must not import a broker`);
    assert.ok(!/ALPACA_|\/v2\/orders|submit\(|console\.log\(/.test(src), `${f} must not touch orders or print`);
  }
});
