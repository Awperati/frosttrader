// The guards in server/engine/agents/guards.mjs: pure functions, no files, no clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GUARDS, openStopRisk, fitToBudget, lossStreak, reconcileDay } from '../server/engine/agents/guards.mjs';

test('open stop risk: qty x distance to the stop x the gap factor; a position under its stop adds nothing', () => {
  const pos = { AAPL: { qty: 2, avg: 100 }, MSFT: { qty: 1, avg: 50 } };
  const risk = openStopRisk(pos, { AAPL: 100, MSFT: 40 }, { AAPL: { stop: 96 }, MSFT: { stop: 48 } });
  assert.equal(risk, 2 * 4 * GUARDS.gapFactor);
  assert.ok(Math.abs(openStopRisk({ X: { qty: 1, avg: 10 } }, {}, {}) - 10 * 0.04 * GUARDS.gapFactor) < 1e-9, 'no plan: a 4 % stop is assumed');
  assert.equal(openStopRisk({}, {}, {}), 0);
});

test('fit to budget: unchanged when it fits, cut to what fits, zero when nothing is left', () => {
  const base = { qty: 10, price: 100, stop: 96, limit: 100, dayPnl: 0, openRisk: 0 }; // 10 x 4 x 1.25 = 50
  assert.equal(fitToBudget(base).qty, 10);
  assert.equal(fitToBudget({ ...base, openRisk: 75 }).qty, 5, 'budget 25 / 5 a share');
  assert.equal(fitToBudget({ ...base, dayPnl: -60 }).qty, 8, 'budget 40 / 5 a share');
  assert.equal(fitToBudget({ ...base, dayPnl: +60 }).qty, 10, 'a profit is not counted');
  assert.equal(fitToBudget({ ...base, openRisk: 100 }).qty, 0);
  assert.equal(fitToBudget({ ...base, openRisk: 150 }).qty, 0);
});

test('loss streak: needs the last N days all down and enough lost', () => {
  const r = (...p) => p.map((pnl, i) => ({ day: `d${i}`, pnl }));
  assert.equal(lossStreak(r(-4, -5, -5), 1000), false, 'US$14 of 1000 is under 1.5 %');
  assert.equal(lossStreak(r(-5, -5, -5), 1000), true, 'US$15 is the line');
  assert.equal(lossStreak(r(-50, 1, -50), 1000), false, 'a winning day in between');
  assert.equal(lossStreak(r(-50, -50), 1000), false, 'only two days');
  assert.equal(lossStreak(r(1, -50, -50, -50), 1000), true, 'only the last three count');
  assert.equal(lossStreak([], 1000), false);
  assert.equal(lossStreak(r(-5, -5, -5), 0), false);
});

test('reconcile a day: counts, dollars and the A$ figure at the trade\'s own rate', () => {
  const ledger = [{ pnl: 1.5 }, { pnl: -0.5 }];
  const trades = [{ symbol: 'A', pnlUsd: 1.5, pnlAud: 2, rate: 0.75 }, { symbol: 'B', pnlUsd: -0.5, pnlAud: -0.5 / 0.7, rate: 0.7 }];
  assert.equal(reconcileDay(ledger, trades), '');
  assert.match(reconcileDay(ledger, trades.slice(1)), /2 ledger sells but 1 trades/);
  assert.match(reconcileDay(ledger, [{ ...trades[0], pnlUsd: 1.6 }, trades[1]]), /ledger P&L US\$1\.0000 but the trade log says US\$1\.1000/);
  assert.match(reconcileDay(ledger, [trades[0], { ...trades[1], pnlAud: -0.9 }]), /a B trade has A\$-0\.9000 at rate 0\.7/);
  assert.equal(reconcileDay([], []), '');
  assert.equal(reconcileDay([{ pnl: 0.01 }], [{ pnlUsd: 0.0, pnlAud: null, rate: null }]), '', 'under the US$0.02 rounding allowance');
});

test('the unit slip of 5 Nov: a US$ ledger total is not an A$ trade-log total, and the check says which differs', () => {
  const trades = [{ symbol: 'A', pnlUsd: -40, pnlAud: -57.1, rate: 0.7006 }];
  assert.equal(reconcileDay([{ pnl: -40 }], trades), '');
  assert.match(reconcileDay([{ pnl: -57.1 }], trades), /ledger P&L US\$-57\.1000 but the trade log says US\$-40\.0000/);
});
