// Tests for the Stock numbers loader, numbers, API and watchlist hook. They use the small
// fixture in test/fixtures (written by hand, same columns as the Hugging Face file) and never
// touch the network: fetch is replaced with a function that fails the test if called.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseIndexCsv, parseDayFirst, indexSymbol, loadIndexDataset, indexBars, isoDay } from '../server/engine/data/indexes.mjs';
import { quote, sliceRange, compress, seriesStats, historyPage, rangeReturns, ageDays } from '../server/engine/numbers.mjs';
import { parseTickers, MAX_SYMBOLS } from '../server/engine/watchlist-input.mjs';
import { createNumbersApi, NOTICE } from '../server/numbers-api.mjs';
import { indexStudy } from '../server/engine/backtest.mjs';
import { STOCK } from '../server/engine/risk.mjs';
import { HttpError } from '../server/store.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures', 'indexes-mini.csv');
const text = fs.readFileSync(FIXTURE, 'utf8');
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const day = (s) => Date.parse(`${s}T00:00:00Z`);

let realFetch;
before(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = () => assert.fail('no network calls in tests');
});
after(() => {
  globalThis.fetch = realFetch;
});

test('dates are read day-first and checked', () => {
  assert.equal(parseDayFirst('02-04-2024'), day('2024-04-02'));
  assert.equal(parseDayFirst('25-04-2024'), day('2024-04-25'));
  assert.ok(Number.isNaN(parseDayFirst('31-02-2024')));
  assert.ok(Number.isNaN(parseDayFirst('2024-04-02')));
  assert.ok(Number.isNaN(parseDayFirst('')));
});

test('index symbols get a caret, so none can pass as a US stock', () => {
  assert.equal(indexSymbol('GSPC'), '^GSPC');
  assert.equal(indexSymbol('^DJI'), '^DJI');
  assert.equal(indexSymbol(' imoex.me '), '^IMOEX.ME');
  assert.equal(STOCK.test('GSPC'), true, 'bare, the file spelling would pass STOCK');
  for (const s of ['GSPC', 'DJI', 'VIX', 'HSI', 'RUT', '000001.SS', 'JN0U.JO']) assert.equal(STOCK.test(indexSymbol(s)), false, s);
});

test('parse: series, columns, bars oldest first', () => {
  const ds = parseIndexCsv(text);
  assert.deepEqual(ds.columns, ['Date', 'Name', 'Symbol', 'Open', 'High', 'Low', 'Close', 'Adj Close', 'Volume']);
  assert.equal(ds.rows, 28);
  assert.deepEqual(Object.keys(ds.series).sort(), ['^TESTA', '^TESTB']);
  const a = ds.series['^TESTA'];
  assert.equal(a.name, 'Test Index A');
  assert.equal(a.sourceSymbol, 'TESTA');
  assert.equal(a.kind, 'index');
  assert.equal(a.hasVolume, true);
  assert.equal(a.bars.length, 12);
  assert.deepEqual(a.bars[0], { t: day('2024-03-01'), o: 100, h: 102, l: 99, c: 101, v: 1000 });
  assert.ok(a.bars.every((b, i) => i === 0 || b.t > a.bars[i - 1].t));
  const b = ds.series['^TESTB'];
  assert.equal(b.hasVolume, false);
  assert.equal(b.bars.length, 11);
  assert.ok(b.bars.every((x) => x.v === null));
});

test('parse: bad rows are dropped and each one is reported with its reason', () => {
  const { series, quality } = parseIndexCsv(text);
  assert.deepEqual(quality.droppedByReason, { 'no prices': 1, spike: 1, duplicate: 1, 'bad numbers': 1, 'bad date or symbol': 1 });
  assert.equal(quality.droppedTotal, 5);
  const find = (reason) => quality.dropped.find((d) => d.reason === reason);
  assert.deepEqual(find('spike'), { line: 13, symbol: '^TESTA', day: '2024-03-12', reason: 'spike' });
  assert.deepEqual(find('no prices'), { line: 18, symbol: '^TESTA', day: '2024-03-08', reason: 'no prices' });
  assert.equal(find('duplicate').line, 9);
  assert.equal(find('bad numbers').day, '2024-03-07');
  assert.equal(find('bad date or symbol').day, '31-02-2024');
  // The first of the duplicate rows is the one kept.
  assert.equal(series['^TESTA'].bars.find((x) => x.t === day('2024-03-14')).c, 106);
  assert.ok(!series['^TESTA'].bars.some((x) => x.c === 40));
});

test('quality: per-symbol range, gaps and volume counts', () => {
  const { quality } = parseIndexCsv(text);
  assert.equal(quality.symbols, 2);
  assert.equal(quality.from, '2024-03-01');
  assert.equal(quality.to, '2024-03-20');
  const a = quality.perSymbol['^TESTA'];
  assert.equal(a.from, '2024-03-01');
  assert.equal(a.to, '2024-03-20');
  assert.equal(a.withVolume, 12);
  assert.deepEqual(a.longestGap, { days: 4, from: '2024-03-07', to: '2024-03-11' });
  assert.deepEqual(a.dropped, { 'no prices': 1, spike: 1, duplicate: 1 });
  assert.equal(quality.perSymbol['^TESTB'].to, '2024-03-18');
});

test('parse: refuses a file without the expected columns', () => {
  assert.throws(() => parseIndexCsv('Date,Close\n01-01-2024,5'), /missing columns/);
});

test('loader: reads from disk once, returns null when the file is missing', () => {
  assert.equal(loadIndexDataset(path.join(here, 'fixtures', 'nope.csv')), null);
  const a = loadIndexDataset(FIXTURE);
  assert.equal(loadIndexDataset(FIXTURE), a);
  assert.equal(a.meta.kind, 'index');
  assert.match(a.meta.provenance, /Yahoo/);
  const bars = indexBars(a);
  assert.equal(bars['^TESTB'][0].v, 0, 'missing volume is 0 in the engine bar format');
  assert.deepEqual(Object.keys(indexBars(a, ['^TESTA'])), ['^TESTA']);
});

test('quote: last, change, day range, volume and 52-week range', () => {
  const { bars } = parseIndexCsv(text).series['^TESTA'];
  const q = quote(bars);
  assert.equal(q.last, 102.5);
  assert.equal(q.prevClose, 101.5);
  close(q.change, 1);
  close(q.changePct, (1 / 101.5) * 100);
  assert.equal(q.dayLow, 101);
  assert.equal(q.dayHigh, 103);
  assert.equal(q.volume, 1550);
  assert.equal(q.low52, 99);
  assert.equal(q.high52, 107);
  assert.equal(quote([]), null);
  assert.equal(quote([bars[0]]).change, null);
});

test('ranges count back from the last bar, not from today', () => {
  const mk = (iso, c) => ({ t: day(iso), o: c, h: c, l: c, c, v: null });
  const bars = [mk('2023-01-02', 1), mk('2023-12-29', 2), mk('2024-02-01', 3), mk('2024-03-15', 4), mk('2024-04-05', 5)];
  assert.deepEqual(sliceRange(bars, '1M').map((b) => b.c), [4, 5]);
  assert.deepEqual(sliceRange(bars, '3M').map((b) => b.c), [3, 4, 5]);
  assert.deepEqual(sliceRange(bars, '1Y').map((b) => b.c), [2, 3, 4, 5]);
  assert.equal(sliceRange(bars, 'All').length, 5);
  assert.equal(sliceRange(bars, 'nonsense').length, 5);
  const r = rangeReturns(bars);
  close(r['1M'], 25);
  close(r.All, 400);
});

test('compress merges bars without inventing values', () => {
  const bars = Array.from({ length: 10 }, (_, i) => ({ t: i, o: i, h: i + 1, l: i - 1, c: i + 0.5, v: i % 2 ? 10 : null }));
  const out = compress(bars, 4);
  assert.equal(out.length, 4);
  assert.deepEqual(out[0], { t: 0, o: 0, h: 3, l: -1, c: 2.5, v: 10 });
  assert.deepEqual(out[3], { t: 9, o: 9, h: 10, l: 8, c: 9.5, v: 10 });
  assert.equal(compress(bars, 20), bars);
});

test('stats: return, volatility, max drawdown, best and worst day', () => {
  const { bars } = parseIndexCsv(text).series['^TESTA'];
  const s = seriesStats(bars);
  close(s.returnPct, (102.5 / 101 - 1) * 100);
  close(s.maxDrawdownPct, (4.5 / 106) * 100);
  assert.equal(s.annualReturnPct, null, 'too short to annualise');
  assert.equal(s.bars, 12);
  assert.ok(s.volatilityPct > 0);
  close(s.worstDay.pct, (100.5 / 103 - 1) * 100);
  assert.equal(isoDay(s.worstDay.t), '2024-03-06');
  close(s.bestDay.pct, (104 / 101.5 - 1) * 100);
  assert.equal(seriesStats(bars.slice(0, 1)), null);
});

test('history pages run newest first', () => {
  const { bars } = parseIndexCsv(text).series['^TESTA'];
  const p0 = historyPage(bars, 0, 5);
  assert.equal(p0.pages, 3);
  assert.equal(p0.total, 12);
  assert.deepEqual(p0.rows.map((r) => r.c), [102.5, 101.5, 103, 104, 106]);
  const p2 = historyPage(bars, 2, 5);
  assert.deepEqual(p2.rows.map((r) => r.c), [102, 101]);
  assert.equal(historyPage(bars, 99, 5).page, 2);
  assert.equal(historyPage(bars, -3, 0).page, 0);
  assert.equal(historyPage(bars, 0, 5000).size, 200);
});

test('age of the data in whole days', () => {
  assert.equal(ageDays(day('2024-04-05'), day('2024-04-30') + 3_600_000), 25);
  assert.equal(ageDays(null), null);
});

test('API: overview carries the honest labels and every symbol', async () => {
  const api = createNumbersApi({ file: FIXTURE, now: () => day('2026-10-23') });
  const { status, body } = await api.handle('GET', '/api/numbers');
  assert.equal(status, 200);
  assert.equal(body.available, true);
  assert.equal(body.labels.source, 'Historical dataset, ends 20 Mar 2024');
  assert.equal(body.labels.lastDay, '2024-03-20');
  assert.equal(body.labels.ageDays, 947);
  assert.equal(body.labels.notice, NOTICE);
  assert.equal(NOTICE, 'Paper only. Not financial advice.');
  assert.deepEqual(body.symbols.map((s) => s.symbol), ['^TESTA', '^TESTB']);
  assert.equal(body.symbols[0].quote.last, 102.5);
  assert.equal(body.symbols[0].spark.length, 12);
  assert.equal(body.watchlist.status, 'not-set');
  assert.match(body.watchlist.how, /never logs in to or scrapes Finviz/);
  assert.equal(body.dataset.droppedTotal, 5);
  const words = JSON.stringify(body).toLowerCase();
  for (const w of ['predict', 'forecast', 'guarantee', 'profit']) assert.ok(!words.includes(w), `no "${w}" in what the view shows`);
});

test('API: detail and paged history for one symbol (caret encoded in the path)', async () => {
  const api = createNumbersApi({ file: FIXTURE, now: () => day('2026-10-23') });
  const d = (await api.handle('GET', '/api/numbers/%5ETESTA', new URLSearchParams('range=All'))).body;
  assert.equal(d.symbol, '^TESTA');
  assert.equal(d.range, 'All');
  assert.equal(d.chart.length, 12);
  assert.equal(d.stats.bars, 12);
  assert.equal(d.quality.withVolume, 12);
  assert.equal((await api.handle('GET', '/api/numbers/%5ETESTA', new URLSearchParams('range=bogus'))).body.range, '1Y');
  const h = (await api.handle('GET', '/api/numbers/%5ETESTB/history', new URLSearchParams('page=1&size=4'))).body;
  assert.equal(h.page, 1);
  assert.equal(h.pages, 3);
  assert.deepEqual(h.rows.map((r) => r.c), [51.9, 52, 51.3, 51.2]);
  await assert.rejects(api.handle('GET', '/api/numbers/%5ENOPE'), (e) => e instanceof HttpError && e.status === 404);
  await assert.rejects(api.handle('DELETE', '/api/numbers/%5ETESTA'), (e) => e.status === 404);
});

test('API: says how to get the dataset when it is missing', async () => {
  const api = createNumbersApi({ file: path.join(here, 'fixtures', 'missing.csv') });
  const { body } = await api.handle('GET', '/api/numbers');
  assert.equal(body.available, false);
  assert.match(body.how, /npm run fetch:indexes/);
  assert.deepEqual(body.symbols, []);
  await assert.rejects(api.handle('GET', '/api/numbers/%5EGSPC'), (e) => e.status === 404);
});

test('watchlist hook: paste and Finviz CSV export, checked and never stored', async () => {
  const p = parseTickers('aapl, MSFT  nvda;$TSLA\nBRK.B\nAAPL ^GSPC BTC/USD AAPL261218C00150000');
  assert.equal(p.source, 'paste');
  assert.deepEqual(p.symbols, ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'BRK.B']);
  assert.deepEqual(p.rejected.map((r) => r.value), ['^GSPC', 'BTC/USD', 'AAPL261218C00150000']);
  const csv = 'No.,Ticker,Company,Sector,Price\n1,AAPL,"Apple Inc.",Technology,190.1\n2,MSFT,"Microsoft, Corp",Technology,410\n3,aapl,Dup,x,1\n';
  const c = parseTickers(csv);
  assert.equal(c.source, 'csv');
  assert.deepEqual(c.symbols, ['AAPL', 'MSFT']);
  const many = parseTickers(Array.from({ length: 45 }, (_, i) => `A${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))}`).join(' '));
  assert.equal(many.symbols.length, MAX_SYMBOLS);
  assert.equal(many.rejected.length, 5);
  const api = createNumbersApi({ file: FIXTURE });
  const r = await api.handle('POST', '/api/numbers/watchlist/preview', undefined, { text: 'AAPL MSFT' });
  assert.deepEqual(r.body.symbols, ['AAPL', 'MSFT']);
  assert.equal(r.body.stored, false);
});

test('backtest harness: daily index study over the dataset', () => {
  const ds = loadIndexDataset(FIXTURE);
  const r = indexStudy(indexBars(ds));
  assert.equal(r.symbols, 2);
  assert.deepEqual(r.rows.map((x) => x.symbol), ['^TESTA', '^TESTB']);
  close(r.rows[1].returnPct, (53.2 / 50.5 - 1) * 100);
  close(r.average.returnPct, (r.rows[0].returnPct + r.rows[1].returnPct) / 2);
  assert.equal(indexStudy({}).average, null);
});

test('the numbers API imports no broker', () => {
  for (const f of ['../server/numbers-api.mjs', '../server/engine/numbers.mjs', '../server/engine/data/indexes.mjs', '../server/engine/watchlist-input.mjs', '../server/index.mjs']) {
    const src = fs.readFileSync(path.join(here, f), 'utf8');
    const imports = src.match(/^import .*$/gm) || [];
    // Alpaca market data (alpaca-keys, alpaca-data) is allowed; the Alpaca broker (broker/alpaca.mjs) is not
    assert.ok(!imports.some((l) => /broker|alpaca\.mjs|strategy|engine\.mjs/i.test(l)), `${f} must not import a broker or the trading engine`);
    assert.ok(!/ALPACA_|\/v2\/orders|submit\(/.test(src), `${f} must not touch broker keys or orders`);
  }
});
