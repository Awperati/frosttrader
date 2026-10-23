// Tests for the ~/.ticker.yaml mirror. Each test uses its own temporary HOME and DATA_DIR; the
// real home folder is never touched and the ticker app is never started.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TickerMirror, managedBlock, replaceBlock, readPaperLots, yahooSymbol, START, END, BACKUP_SUFFIX } from '../server/engine/ticker-mirror.mjs';

const T0 = Date.parse('2026-10-23T14:00:00Z');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

function setup({ symbols = ['AAPL', 'BRK.B', 'MSFT'], positions = null } = {}) {
  const home = tmp('ft-home-');
  const data = tmp('ft-data-');
  fs.writeFileSync(path.join(data, 'watchlist.json'), JSON.stringify({ source: 'finviz', at: T0, symbols, rows: symbols.length }));
  if (positions) {
    fs.mkdirSync(path.join(data, 'agents', 'alpha'), { recursive: true });
    fs.writeFileSync(path.join(data, 'agents', 'alpha', 'ledger.json'), JSON.stringify({ id: 'alpha', cash: 100, positions }));
  }
  const clock = { t: T0 + 60_000 };
  const mirror = new TickerMirror({ dataDir: data, home, now: () => clock.t, log: { warn() {} } });
  return { home, data, clock, mirror, file: path.join(home, '.ticker.yaml') };
}

test('a new ~/.ticker.yaml gets display options, the watchlist and the paper lots', () => {
  const { mirror, file } = setup({ positions: { AAPL: { qty: 3, avg: 230.1 }, 'BRK.B': { qty: 1.5, avg: 460 } } });
  const st = mirror.sync();
  assert.equal(st.status, 'ok');
  assert.equal(st.symbols, 3);
  assert.equal(st.lots, 2);
  const text = fs.readFileSync(file, 'utf8');
  for (const key of ['show-summary: true', 'show-positions: true', 'show-fundamentals: true', 'show-tags: true', 'sort: user']) assert.ok(text.includes(key), key);
  assert.ok(text.includes('watchlist:\n  - "AAPL"\n  - "BRK-B"\n  - "MSFT"\n'));
  assert.ok(text.includes('lots:\n  - symbol: "AAPL" # paper, agent alpha\n    quantity: 3\n    unit_cost: 230.1\n'));
  assert.ok(text.includes('  - symbol: "BRK-B" # paper, agent alpha\n    quantity: 1.5\n    unit_cost: 460\n'));
  assert.ok(text.includes('fetched 2026-10-23 14:00 UTC'));
  assert.equal(text.split(START).length, 2);
  assert.equal(text.split(END).length, 2);
});

test('only the managed block is rewritten; the owner\'s own lines stay', () => {
  const { mirror, file, data } = setup();
  mirror.sync();
  const mine = fs.readFileSync(file, 'utf8').replace('interval: 15', 'interval: 30').replace(END, `${END}\ncolors:\n  text: "#005fff"`) + '# my note\n';
  fs.writeFileSync(file, mine);
  fs.writeFileSync(path.join(data, 'watchlist.json'), JSON.stringify({ source: 'finviz', at: T0 + 900_000, symbols: ['NVDA'] }));
  mirror.sync();
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes('interval: 30') && text.includes('colors:\n  text: "#005fff"') && text.endsWith('# my note\n'));
  assert.ok(text.includes('watchlist:\n  - "NVDA"\n'));
  assert.ok(!text.includes('"AAPL"'));
});

test('a ~/.ticker.yaml Frost Trader did not write is backed up once and never changed', () => {
  const { mirror, file } = setup();
  const his = 'watchlist:\n  - TSLA\nshow-summary: false\n';
  fs.writeFileSync(file, his);
  const st = mirror.sync();
  assert.equal(st.status, 'foreign');
  assert.match(st.error, /not written by Frost Trader/);
  assert.equal(fs.readFileSync(file, 'utf8'), his);
  assert.equal(fs.readFileSync(file + BACKUP_SUFFIX, 'utf8'), his);
  fs.writeFileSync(file, his + '# changed later\n');
  mirror.sync();
  assert.equal(fs.readFileSync(file + BACKUP_SUFFIX, 'utf8'), his, 'the first backup is kept');
  assert.equal(fs.readFileSync(file, 'utf8'), his + '# changed later\n');
});

test('an unchanged list is not rewritten; a change is', () => {
  const { mirror, file, clock, data } = setup();
  mirror.sync();
  const m1 = fs.statSync(file).mtimeMs;
  const first = fs.readFileSync(file, 'utf8');
  clock.t += 5 * 60_000;
  mirror.sync();
  assert.equal(fs.readFileSync(file, 'utf8'), first);
  assert.equal(fs.statSync(file).mtimeMs, m1);
  fs.mkdirSync(path.join(data, 'agents', 'beta'), { recursive: true });
  fs.writeFileSync(path.join(data, 'agents', 'beta', 'ledger.json'), JSON.stringify({ id: 'beta', cash: 1, positions: { MSFT: { qty: 2, avg: 420 } } }));
  assert.equal(mirror.sync().lots, 1);
  assert.ok(fs.readFileSync(file, 'utf8').includes('symbol: "MSFT" # paper, agent beta'));
});

test('stale lists say so; no list, bad symbols and damaged ledgers are handled', () => {
  const b = managedBlock({ list: { at: T0, symbols: ['AAPL', 'BAD SYM"', 'x:y'], stale: true }, lots: [], now: T0 });
  assert.match(b, /last fetch failed: this is the last good list/);
  assert.ok(b.includes('  - "AAPL"') && !b.includes('BAD') && !b.includes('X:Y'));
  assert.ok(!b.includes('lots:'));
  const none = managedBlock({ list: null, lots: [], now: T0 });
  assert.match(none, /none yet/);
  assert.ok(!none.includes('watchlist:'));
  const data = tmp('ft-data-');
  fs.mkdirSync(path.join(data, 'agents', 'bad'), { recursive: true });
  fs.writeFileSync(path.join(data, 'agents', 'bad', 'ledger.json'), '{not json');
  fs.mkdirSync(path.join(data, 'agents', '..evil'), { recursive: true });
  assert.deepEqual(readPaperLots(data), []);
  assert.equal(replaceBlock('no markers', 'x'), null);
  assert.equal(replaceBlock(`${START}\n${START}\n${END}`, 'x'), null);
  assert.equal(yahooSymbol('brk.b'), 'BRK-B');
});

test('no secrets reach the file', () => {
  const { mirror, file, data } = setup();
  const TOKEN = 'fake-token-0123456789abcdef';
  fs.writeFileSync(path.join(data, 'finviz-token.json'), JSON.stringify({ token: TOKEN }));
  fs.writeFileSync(path.join(data, 'finviz.json'), JSON.stringify({ urls: ['https://elite.finviz.com/export/screener?type=stocks&v=111'] }));
  mirror.sync();
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(!text.includes(TOKEN) && !/auth=|finviz\.com|ALPACA/i.test(text));
});
