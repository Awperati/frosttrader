// refresh_bars: the pure merge, and the refresher's rate limit, lock, freshness skip, no-keys and
// append behaviour — all with a fake Alpaca data client, no network and no keys.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BarsRefresher, mergeInto, parseRows, fmtTs, BARS_CSV } from './refresh-bars.mjs';

const BASE = Date.parse('2026-10-29T19:55:00Z');
const MIN = 5 * 60_000;
const header = 'ticker,timestamp,open,high,low,close,volume';
// two tickers, three bars each, newest at BASE
function seedCsv() {
  const rows = [];
  for (const tk of ['AAA', 'BBB']) for (let k = 2; k >= 0; k--) rows.push(`${tk},${fmtTs(BASE - k * MIN)},10,11,9,10.5,100`);
  return [header, ...rows].join('\n') + '\n';
}
function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'refresh-bars-'));
  fs.writeFileSync(path.join(d, BARS_CSV), seedCsv());
  return d;
}
// a fake AlpacaData: bars() returns the queued new bars for the asked symbols, after `start`
function fakeData(byTicker) {
  return {
    redact: (s) => s,
    async bars(symbols, { start }) {
      const out = {};
      for (const s of symbols) {
        const list = (byTicker[s] || []).filter((b) => b.t >= start);
        if (list.length) out[s] = list;
      }
      return out;
    },
  };
}

test('mergeInto: adds new bars, dedups ticker+timestamp (new wins), sorts by ticker then time', () => {
  const next = BASE + MIN;
  const { text, counts } = mergeInto(seedCsv(), [
    { ticker: 'AAA', t: next, o: 20, h: 21, l: 19, c: 20.25, v: 200 },
    { ticker: 'AAA', t: BASE, o: 99, h: 99, l: 99, c: 99, v: 999 }, // overwrites the existing AAA@BASE
  ]);
  assert.equal(counts.old, 6);
  assert.equal(counts.added, 1); // one brand-new bar; the other was a dedup overwrite
  assert.equal(counts.total, 7);
  const rows = parseRows(text);
  // sorted: all AAA (by time) then all BBB
  assert.deepEqual(rows.map((r) => r.ticker), ['AAA', 'AAA', 'AAA', 'AAA', 'BBB', 'BBB', 'BBB']);
  const overwritten = rows.find((r) => r.ticker === 'AAA' && r.t === BASE);
  assert.equal(overwritten.cells.join(','), '99,99,99,99,999', 'the re-fetched bar overwrote the old copy');
});

test('refresh: appends the new bars, backs up first, reports counts', async () => {
  const dir = tmpDir();
  let now = BASE + 10 * MIN; // newest bar is well over one interval old
  const data = fakeData({ AAA: [{ t: BASE + MIN, o: 1, h: 2, l: 1, c: 1.5, v: 50 }, { t: BASE + 2 * MIN, o: 1, h: 2, l: 1, c: 1.6, v: 60 }] });
  const r = new BarsRefresher({ dataDir: dir, getData: () => data, now: () => now, log: {} });
  const out = await r.refresh();
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.added, 2);
  assert.equal(out.total, 8);
  assert.ok(out.backup && out.backup.endsWith('.bak.csv'), 'a dated backup was made');
  assert.ok(fs.existsSync(path.join(dir, out.backup)));
  // the file now holds the new bars
  const rows = parseRows(fs.readFileSync(path.join(dir, BARS_CSV), 'utf8'));
  assert.ok(rows.some((x) => x.ticker === 'AAA' && x.t === BASE + 2 * MIN));
  assert.ok(!fs.existsSync(path.join(dir, BARS_CSV + '.lock')), 'the lock is released');
});

test('refresh: rate-limited within five minutes', async () => {
  const dir = tmpDir();
  let now = BASE + 10 * MIN;
  const data = fakeData({ AAA: [{ t: BASE + MIN, o: 1, h: 2, l: 1, c: 1.5, v: 50 }] });
  const r = new BarsRefresher({ dataDir: dir, getData: () => data, now: () => now, log: {} });
  assert.equal((await r.refresh()).ok, true);
  now += 60_000; // one minute later
  const out = await r.refresh();
  assert.equal(out.ok, false);
  assert.equal(out.skipped, 'rate-limited');
  assert.ok(out.retryInSec > 0 && out.retryInSec <= 300);
});

test('refresh: skipped when the newest bar is under one interval old', async () => {
  const dir = tmpDir();
  const now = BASE + 2 * 60_000; // only 2 minutes after the newest bar
  const data = fakeData({ AAA: [{ t: BASE + MIN, o: 1, h: 2, l: 1, c: 1.5, v: 50 }] });
  const r = new BarsRefresher({ dataDir: dir, getData: () => data, now: () => now, log: {} });
  const out = await r.refresh();
  assert.equal(out.ok, true);
  assert.match(out.skipped, /under one 5-minute interval/);
});

test('refresh: a held lock makes it skip (single-flight)', async () => {
  const dir = tmpDir();
  const now = BASE + 10 * MIN;
  fs.writeFileSync(path.join(dir, BARS_CSV + '.lock'), String(now)); // a fresh lock held by "someone else"
  const r = new BarsRefresher({ dataDir: dir, getData: () => fakeData({}), now: () => now, log: {} });
  const out = await r.refresh({ force: true }); // force skips the rate limit, never the lock
  assert.equal(out.ok, false);
  assert.match(out.skipped, /already running/);
});

test('refresh: no keys -> a clear error, nothing written', async () => {
  const dir = tmpDir();
  const before = fs.readFileSync(path.join(dir, BARS_CSV), 'utf8');
  const r = new BarsRefresher({ dataDir: dir, getData: () => null, now: () => BASE + 10 * MIN, log: {} });
  const out = await r.refresh();
  assert.equal(out.ok, false);
  assert.match(out.error, /No Alpaca paper keys/);
  assert.equal(fs.readFileSync(path.join(dir, BARS_CSV), 'utf8'), before, 'the file is untouched');
});

test('refresh: no new bars -> added 0, no backup churn', async () => {
  const dir = tmpDir();
  const r = new BarsRefresher({ dataDir: dir, getData: () => fakeData({}), now: () => BASE + 10 * MIN, log: {} });
  const out = await r.refresh();
  assert.equal(out.ok, true);
  assert.equal(out.added, 0);
  assert.ok(!out.backup, 'no backup when nothing changed');
  assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith('.bak.csv')), 'no backup file churn');
});
