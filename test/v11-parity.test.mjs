// The app's v11 (server/engine/models/v11.mjs) against Python's own numbers: the features and the
// win probability for every stock at five times on the last day of stock_ohlcv/ALL_STOCKS_5m.csv
// (test/fixtures/v11-parity.json, written by scripts/export_v11.py from the same bars).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { featuresAt, loadModel, score, tradable } from '../server/engine/models/v11.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(fs.readFileSync(path.join(root, 'test', 'fixtures', 'v11-parity.json'), 'utf8'));

function readBars(file) {
  const [head, ...lines] = fs.readFileSync(path.join(root, file), 'utf8').trim().split(/\r?\n/);
  const col = Object.fromEntries(head.split(',').map((k, i) => [k, i]));
  const out = {};
  for (const line of lines) {
    const f = line.split(',');
    (out[f[col.ticker]] ||= []).push({ t: Date.parse(f[col.timestamp].replace(' ', 'T')), o: +f[col.open], h: +f[col.high], l: +f[col.low], c: +f[col.close], v: +f[col.volume] });
  }
  for (const list of Object.values(out)) list.sort((a, b) => a.t - b.t);
  return out;
}

const close = (a, b, rel = 1e-9) => (a == null && Number.isNaN(b)) || (a != null && Math.abs(a - b) <= rel * Math.max(1, Math.abs(a)));

test('v11 features and probabilities match Python', () => {
  const bars = readBars(fixture.bars);
  const model = loadModel();
  const times = [...new Set(fixture.rows.map((r) => r.t))];
  let scored = 0;
  for (const t of times) {
    const upTo = Object.fromEntries(Object.entries(bars).map(([s, list]) => [s, list.filter((b) => b.t <= t)]));
    const rows = featuresAt(upTo, t);
    for (const want of fixture.rows.filter((r) => r.t === t)) {
      const got = rows[want.ticker];
      assert.ok(got, `${want.ticker} at ${new Date(t).toISOString()}: no row`);
      for (const k of ['atr', 'bar_of_day', ...model.features]) {
        assert.ok(close(want[k], got[k]), `${want.ticker} ${new Date(t).toISOString()} ${k}: python ${want[k]}, app ${got[k]}`);
      }
      assert.equal(tradable(got), want.prob != null, `${want.ticker}: tradable`);
      if (want.prob != null) {
        assert.ok(Math.abs(score(model, got) - want.prob) < 1e-9, `${want.ticker} ${new Date(t).toISOString()}: python ${want.prob}, app ${score(model, got)}`);
        scored++;
      }
    }
  }
  assert.ok(scored >= 150, `only ${scored} rows scored`);
});

test('v11 model file: threshold, exit and stock list', () => {
  const m = loadModel();
  assert.equal(m.universe.length, 38);
  assert.ok(m.threshold > 0.5 && m.threshold < 0.9);
  assert.ok(['pct', 'atr'].includes(m.exit.kind) && m.exit.stop > 0);
  assert.equal(m.exit.maxHold, 20);
  assert.equal(m.feed, 'iex', 'trained on the feed the app reads');
  assert.deepEqual(m.entryBars, [2, 71]);
  assert.equal(m.models.length, 3);
});
