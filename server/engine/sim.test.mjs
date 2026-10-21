import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SimBroker } from './broker/sim.mjs';
import { syntheticBars } from './data/synthetic.mjs';
import { nyClock } from './stats.mjs';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('buy and sell with slippage and commission', () => {
  const b = new SimBroker({ cash: 1000, slippageBps: 10, commission: 1 });
  const f1 = b.submit({ symbol: 'ABC', side: 'buy', qty: 10, price: 10 });
  close(f1.price, 10.01);
  close(b.cash, 1000 - 100.1 - 1);
  assert.equal(b.positions.ABC.qty, 10);
  close(b.positions.ABC.avg, 10.01);
  b.mark('ABC', 12);
  close(b.equity(), b.cash + 120);
  const f2 = b.submit({ symbol: 'ABC', side: 'sell', qty: 10, price: 12 });
  close(f2.price, 11.988);
  close(f2.pnl, (11.988 - 10.01) * 10 - 1);
  close(b.realized, f2.pnl);
  assert.equal(b.positions.ABC, undefined);
  close(b.cash, 1000 - 100.1 - 1 + 119.88 - 1);
});

test('average price over several buys', () => {
  const b = new SimBroker({ cash: 10_000, slippageBps: 0 });
  b.submit({ symbol: 'X', side: 'buy', qty: 10, price: 10 });
  b.submit({ symbol: 'X', side: 'buy', qty: 30, price: 20 });
  close(b.positions.X.avg, 17.5);
});

test('refuses leverage and shorting', () => {
  const b = new SimBroker({ cash: 100, slippageBps: 0 });
  assert.throws(() => b.submit({ symbol: 'X', side: 'buy', qty: 11, price: 10 }), /cash/);
  assert.throws(() => b.submit({ symbol: 'X', side: 'sell', qty: 1, price: 10 }), /more than held/);
  assert.throws(() => b.submit({ symbol: 'X', side: 'buy', qty: 0.5, price: 10 }), /quantity/);
});

test('flatten sells everything at the last price', () => {
  const b = new SimBroker({ cash: 1000, slippageBps: 0 });
  b.submit({ symbol: 'A', side: 'buy', qty: 5, price: 10 });
  b.submit({ symbol: 'B', side: 'buy', qty: 5, price: 20 });
  b.mark('A', 11);
  b.flatten();
  assert.deepEqual(b.positions, {});
  close(b.cash, 1000 + 5);
});

test('made-up bars: repeatable, sane and inside US market hours', () => {
  const a = syntheticBars({ days: 3, seed: 3, symbols: ['AAA', 'BBB'] });
  const b = syntheticBars({ days: 3, seed: 3, symbols: ['AAA', 'BBB'] });
  assert.deepEqual(a, b);
  assert.equal(a.AAA.length, 3 * 390);
  for (const bar of a.AAA) {
    assert.ok(bar.l <= Math.min(bar.o, bar.c) && bar.h >= Math.max(bar.o, bar.c) && bar.v > 0);
    const { minute, weekday } = nyClock(bar.t);
    assert.ok(minute >= 570 && minute < 960, `minute ${minute}`);
    assert.ok(!['Sat', 'Sun'].includes(weekday));
  }
  // summer time too (July)
  const july = syntheticBars({ days: 1, from: new Date(Date.UTC(2026, 6, 6)), symbols: ['AAA'] });
  assert.equal(nyClock(july.AAA[0].t).minute, 570);
});
