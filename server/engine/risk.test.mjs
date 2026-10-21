import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RiskGuard, DEFAULT_LIMITS, HARD_LIMITS, cleanLimits, isTighter, positionSize } from './risk.mjs';

const acct = (over = {}) => ({ cash: 10_000, equity: 10_000, positions: {}, ...over });
const guard = (limits) => {
  const g = new RiskGuard(limits);
  g.startDay('2026-01-05', 10_000);
  return g;
};
const buy = (qty = 10, price = 50, symbol = 'ABC') => ({ symbol, side: 'buy', qty, price });

test('a normal buy inside every limit is allowed', () => {
  assert.deepEqual(guard().check(buy(), acct()), { ok: true, reason: '' });
});

test('position value limit', () => {
  const r = guard().check(buy(41, 50), acct()); // $2050 > $2000
  assert.equal(r.ok, false);
  assert.match(r.reason, /position limit/);
});

test('share of equity limit', () => {
  const g = guard({ maxPositionValue: 25_000, maxPositionPct: 0.2 });
  assert.equal(g.check(buy(39, 50), acct()).ok, true); // 19.5 %
  assert.match(g.check(buy(41, 50), acct()).reason, /% of equity/);
  // shares already held count towards the limit
  assert.match(g.check(buy(20, 50), acct({ positions: { ABC: { qty: 30, avg: 50 } } })).reason, /% of equity/);
});

test('no leverage: a buy must be paid for in cash', () => {
  const r = guard().check(buy(10, 50), acct({ cash: 400 }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /cash/);
});

test('no shorting: sells are limited to shares held', () => {
  const g = guard();
  assert.match(g.check({ symbol: 'ABC', side: 'sell', qty: 1, price: 10 }, acct()).reason, /no shorting/);
  assert.match(g.check({ symbol: 'ABC', side: 'sell', qty: 6, price: 10 }, acct({ positions: { ABC: { qty: 5 } } })).reason, /5 shares/);
  assert.equal(g.check({ symbol: 'ABC', side: 'sell', qty: 5, price: 10 }, acct({ positions: { ABC: { qty: 5 } } })).ok, true);
});

test('no options or crypto', () => {
  const g = guard();
  assert.match(g.check(buy(1, 5, 'AAPL261218C00150000'), acct()).reason, /US stocks only/);
  assert.match(g.check(buy(1, 5, 'BTC/USD'), acct()).reason, /US stocks only/);
  assert.match(g.check({ ...buy(), assetClass: 'crypto' }, acct()).reason, /US stocks only/);
  assert.equal(g.check(buy(1, 5, 'BRK.B'), acct()).ok, true);
});

test('whole shares and a price are required', () => {
  const g = guard();
  assert.equal(g.check(buy(1.5), acct()).ok, false);
  assert.equal(g.check(buy(0), acct()).ok, false);
  assert.equal(g.check(buy(1, 0), acct()).ok, false);
  assert.equal(g.check({ ...buy(), side: 'short' }, acct()).ok, false);
});

test('trades per day limit counts buys', () => {
  const g = guard({ maxTradesPerDay: 2 });
  g.recordBuy();
  g.recordBuy();
  assert.match(g.check(buy(), acct()).reason, /Trade limit/);
  g.startDay('2026-01-06', 10_000);
  assert.equal(g.check(buy(), acct()).ok, true);
});

test('open positions limit (adding to a held stock is fine)', () => {
  const g = guard({ maxOpenPositions: 2 });
  const positions = { AAA: { qty: 1 }, BBB: { qty: 1 } };
  assert.match(g.check(buy(1, 50, 'CCC'), acct({ positions })).reason, /Open position limit/);
  assert.equal(g.check(buy(1, 50, 'AAA'), acct({ positions })).ok, true);
});

test('daily loss limit halts buys for the rest of the day but not sells', () => {
  const g = guard({ maxDailyLoss: 200 });
  assert.equal(g.watch(9_801), false);
  assert.equal(g.watch(9_800), true);
  assert.match(g.check(buy(), acct({ equity: 9_900 })).reason, /Daily loss limit/); // stays halted even after a bounce
  assert.equal(g.check({ symbol: 'ABC', side: 'sell', qty: 1, price: 10 }, acct({ positions: { ABC: { qty: 1 } } })).ok, true);
  g.startDay('2026-01-06', 9_900);
  assert.equal(g.check(buy(), acct({ equity: 9_900 })).ok, true);
});

test('kill switch blocks buys, allows getting flat', () => {
  const g = guard();
  g.killed = true;
  assert.match(g.check(buy(), acct()).reason, /Kill switch/);
  assert.equal(g.check({ symbol: 'ABC', side: 'sell', qty: 1, price: 10 }, acct({ positions: { ABC: { qty: 1 } } })).ok, true);
});

test('no buys before the trading day starts', () => {
  assert.match(new RiskGuard().check(buy(), acct()).reason, /not started/);
});

test('limits are clamped to the hard limits and bad values ignored', () => {
  const l = cleanLimits({ maxPositionValue: 1e9, maxDailyLoss: -5, maxTradesPerDay: 3.7, riskPerTrade: 'x', maxPositionPct: 1 });
  assert.equal(l.maxPositionValue, HARD_LIMITS.maxPositionValue);
  assert.equal(l.maxDailyLoss, DEFAULT_LIMITS.maxDailyLoss);
  assert.equal(l.maxTradesPerDay, 3);
  assert.equal(l.riskPerTrade, DEFAULT_LIMITS.riskPerTrade);
  assert.equal(l.maxPositionPct, HARD_LIMITS.maxPositionPct);
  assert.equal(isTighter(DEFAULT_LIMITS, { ...DEFAULT_LIMITS, maxDailyLoss: 100 }), true);
  assert.equal(isTighter(DEFAULT_LIMITS, { ...DEFAULT_LIMITS, maxDailyLoss: 300 }), false);
});

test('position size: risk-based, then capped by value, share of equity and cash', () => {
  const limits = { ...DEFAULT_LIMITS, riskPerTrade: 0.005, maxPositionValue: 2000, maxPositionPct: 0.2 };
  // risk $50 / $1 a share = 50 shares = $500
  assert.equal(positionSize({ equity: 10_000, cash: 10_000, price: 10, stop: 9, limits }), 50);
  // risk allows 500 shares ($5000) but the value limit caps at $2000 = 200
  assert.equal(positionSize({ equity: 10_000, cash: 10_000, price: 10, stop: 9.9, limits }), 200);
  // share of equity: 20 % of $5000 = $1000 = 100 shares
  assert.equal(positionSize({ equity: 5_000, cash: 5_000, price: 10, stop: 9.99, limits }), 100);
  // cash: only $300
  assert.equal(positionSize({ equity: 10_000, cash: 300, price: 10, stop: 9.9, limits }), 30);
  // a stop at or above the price, or no price: nothing
  assert.equal(positionSize({ equity: 10_000, cash: 10_000, price: 10, stop: 10, limits }), 0);
  assert.equal(positionSize({ equity: 10_000, cash: 10_000, price: 0, stop: -1, limits }), 0);
  // a size from positionSize always passes the guard's value checks
  const g = guard(limits);
  const qty = positionSize({ equity: 10_000, cash: 10_000, price: 37.37, stop: 37.2, limits });
  assert.equal(g.check({ symbol: 'ABC', side: 'buy', qty, price: 37.37 }, acct()).ok, true);
});
