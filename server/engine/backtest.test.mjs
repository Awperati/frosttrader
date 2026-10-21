import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roundTrips, tradeStats, runBacktest } from './backtest.mjs';
import { backtestSignal } from './signals/index.mjs';
import { maxDrawdown, sharpe, std, zscore, atr } from './stats.mjs';
import { syntheticBars } from './data/synthetic.mjs';
import { gameState } from './game.mjs';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('stats: std, zscore, drawdown, sharpe, atr', () => {
  close(std([2, 4, 4, 4, 5, 5, 7, 9]), 2.138089935299395);
  close(zscore(10, [1, 2, 3]), 8);
  assert.equal(zscore(5, [5, 5, 5]), 0);
  close(maxDrawdown([100, 120, 90, 130, 117]), 0.25);
  assert.equal(maxDrawdown([1, 2, 3]), 0);
  close(sharpe([0.01, -0.01, 0.01, -0.01], 1), 0);
  close(sharpe([0.02, 0.01], 4), (0.015 / std([0.02, 0.01])) * 2);
  const bars = [{ h: 11, l: 9, c: 10 }, { h: 12, l: 10, c: 11 }, { h: 15, l: 11, c: 14 }];
  close(atr(bars, 2, 2), (2 + 4) / 2);
});

test('round trips pair sells with the oldest buys', () => {
  const fills = [
    { t: 1, symbol: 'A', side: 'buy', qty: 10, price: 10, why: 'entry' },
    { t: 2, symbol: 'A', side: 'buy', qty: 10, price: 12, why: 'entry' },
    { t: 3, symbol: 'A', side: 'sell', qty: 15, price: 13, why: 'target' },
    { t: 4, symbol: 'A', side: 'sell', qty: 5, price: 11, why: 'stop' },
  ];
  const trips = roundTrips(fills);
  assert.deepEqual(trips.map((t) => [t.qty, t.entry, t.exit, t.pnl]), [[10, 10, 13, 30], [5, 12, 13, 5], [5, 12, 11, -5]]);
  const s = tradeStats(trips);
  assert.equal(s.trades, 3);
  close(s.winRate, 2 / 3);
  close(s.avgWin, 17.5);
  close(s.avgLoss, -5);
  close(s.profitFactor, 7);
  close(s.expectancy, 10);
  close(s.net, 30);
  assert.equal(tradeStats([]).profitFactor, 0);
});

test('signal backtest: hit rate against the coin-flip rate', () => {
  // A signal that calls "up" on every bar, on a series that rises 3 bars in 4.
  const closes = [10, 11, 12, 13, 12, 13, 14, 15, 14, 15, 16, 17, 16];
  const bars = { X: closes.map((c, i) => ({ t: i, o: c, h: c, l: c, c, v: 1 })) };
  const always = { id: 'up', horizon: 1, available: () => true, evaluate: () => ({ score: 1 }) };
  const r = backtestSignal(always, bars);
  assert.equal(r.calls, 12);
  assert.equal(r.hits, 9);
  close(r.hitRate, 0.75);
  close(r.baseRate, 0.75); // calling "up" always is exactly the coin flip here: no edge
  close(r.edge, 0);
  const down = backtestSignal({ ...always, evaluate: () => ({ score: -1 }) }, bars);
  close(down.hitRate, 0.25);
  close(down.baseRate, 0.25);
});

test('backtest: books balance and every rule holds', async () => {
  const bars = syntheticBars({ days: 10, barMinutes: 5, seed: 11 });
  const limits = { maxPositionValue: 1500, maxPositionPct: 0.15, maxDailyLoss: 50, maxTradesPerDay: 3, maxOpenPositions: 2, riskPerTrade: 0.005 };
  const r = await runBacktest(bars, { cash: 10_000, limits, slippageBps: 0 });
  close(r.endEquity - r.startEquity, r.net, 1e-6); // every dollar is explained by round trips
  for (const t of r.trips) assert.ok(t.qty * t.entry <= 1500 + 1e-6, 'position limit');
  const perDay = {};
  for (const t of r.trips) {
    const d = new Date(t.opened).toISOString().slice(0, 10);
    perDay[d] = (perDay[d] || 0) + 1;
  }
  for (const n of Object.values(perDay)) assert.ok(n <= 3, 'trades per day');
  assert.ok(r.maxDrawdownPct >= 0 && r.maxDrawdownPct <= 100);
  assert.equal(r.signals.length, 7);
});

test('backtest: nothing is held overnight', async () => {
  const bars = syntheticBars({ days: 6, barMinutes: 5, seed: 5 });
  const r = await runBacktest(bars, { slippageBps: 0 });
  for (const t of r.trips) assert.equal(new Date(t.opened).toISOString().slice(0, 10), new Date(t.closed).toISOString().slice(0, 10));
});

test('game: points for discipline only, never for profit', () => {
  const day = (key, pnl, halted = false, buys = 2) => ({ key, pnl, buys, halted });
  const a = gameState({ days: [day('d1', 500), day('d2', 900)] });
  const b = gameState({ days: [day('d1', -150), day('d2', -10)] });
  assert.equal(a.xp, b.xp);
  const halted = gameState({ days: [day('d1', -200, true)] });
  assert.equal(halted.xp, gameState({ days: [day('d1', 50)] }).xp);
  assert.ok(halted.badges.some((x) => x.id === 'stopped'));
  const broke = gameState({ days: [day('d1', 0), day('d2', 0), day('d3', 0)], overrides: [{ day: 'd2', kind: 'loosen' }] });
  assert.equal(broke.streak, 1);
  assert.ok(gameState({ days: [], kills: 1 }).xp > 0);
  const five = gameState({ days: ['a', 'b', 'c', 'd', 'e'].map((k) => day(k, 0)) });
  assert.equal(five.streak, 5);
  assert.ok(five.badges.some((x) => x.id === 'streak-5'));
});
