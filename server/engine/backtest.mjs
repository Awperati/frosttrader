// The backtester: replays historical bars through the real Trader, risk guard and simulated
// broker, in time order across all symbols, then reports what happened. Nothing in a report is
// a forecast.
import { SimBroker } from './broker/sim.mjs';
import { Trader } from './strategy.mjs';
import { SIGNALS, backtestSignal } from './signals/index.mjs';
import { maxDrawdown, sharpe, mean } from './stats.mjs';

/** Pair buy and sell fills into round trips (first in, first out per symbol). */
export function roundTrips(fills) {
  const open = {};
  const trips = [];
  for (const f of fills) {
    if (f.side === 'buy') (open[f.symbol] ||= []).push({ ...f, left: f.qty });
    else {
      let qty = f.qty;
      while (qty > 0 && open[f.symbol]?.length) {
        const lot = open[f.symbol][0];
        const n = Math.min(qty, lot.left);
        trips.push({ symbol: f.symbol, qty: n, entry: lot.price, exit: f.price, pnl: (f.price - lot.price) * n, opened: lot.t, closed: f.t, why: f.why, signal: lot.why });
        lot.left -= n;
        qty -= n;
        if (!lot.left) open[f.symbol].shift();
      }
    }
  }
  return trips;
}

/** Summary numbers for a list of round trips. */
export function tradeStats(trips) {
  const wins = trips.filter((t) => t.pnl > 0);
  const losses = trips.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = -losses.reduce((a, t) => a + t.pnl, 0);
  return {
    trades: trips.length,
    winRate: trips.length ? wins.length / trips.length : 0,
    avgWin: wins.length ? grossWin / wins.length : 0,
    avgLoss: losses.length ? -grossLoss / losses.length : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : wins.length ? Infinity : 0,
    expectancy: trips.length ? (grossWin - grossLoss) / trips.length : 0,
    net: grossWin - grossLoss,
  };
}

/**
 * barsBySymbol: { SYMBOL: [bar, ...] } sorted by time. Returns the report. The equity curve is
 * sampled once per timestamp and thinned to about `points` points.
 */
export async function runBacktest(barsBySymbol, { cash = 10_000, limits, strategy, slippageBps = 5, commission = 0, points = 300 } = {}) {
  const broker = new SimBroker({ cash, slippageBps, commission });
  const blocked = [];
  const halts = [];
  const trader = new Trader({ broker, limits, strategy, onEvent: (e) => (e.type === 'blocked' ? blocked.push(e) : e.type === 'halt' ? halts.push(e) : 0) });

  // One timeline across all symbols: each step is (time, symbol, index into its bars).
  const steps = [];
  for (const [symbol, bars] of Object.entries(barsBySymbol)) bars.forEach((b, i) => steps.push([b.t, symbol, i]));
  steps.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : 1));

  const curve = [];
  for (let k = 0; k < steps.length; k++) {
    const [t, symbol, i] = steps[k];
    await trader.onBar(symbol, barsBySymbol[symbol], i);
    if (k === steps.length - 1 || steps[k + 1][0] !== t) curve.push([t, broker.equity()]);
  }
  const lastT = steps.length ? steps[steps.length - 1][0] : Date.now();
  broker.flatten(lastT, 'end of test');
  await trader.rollDay('end');

  const trips = roundTrips(broker.fills);
  const equities = curve.map((c) => c[1]);
  const end = broker.equity();
  const dayReturns = trader.days.map((d, n) => d.pnl / (n === 0 ? cash : cash + trader.days.slice(0, n).reduce((a, x) => a + x.pnl, 0)));
  const hold = Object.values(barsBySymbol).filter((b) => b.length > 1).map((b) => b[b.length - 1].c / b[0].c - 1);
  const step = Math.max(1, Math.ceil(curve.length / points));

  return {
    startEquity: cash,
    endEquity: end,
    returnPct: (end / cash - 1) * 100,
    buyAndHoldPct: hold.length ? mean(hold) * 100 : 0,
    maxDrawdownPct: maxDrawdown(equities) * 100,
    sharpe: sharpe(dayReturns),
    days: trader.days.length,
    haltedDays: trader.days.filter((d) => d.halted).length,
    blocked: blocked.length,
    blockedReasons: countBy(blocked, (b) => b.reason.replace(/\(.*\)/, '').trim()),
    ...tradeStats(trips),
    byExit: countBy(trips, (t) => t.why.split(':')[0]),
    signals: SIGNALS.map((s) => backtestSignal(s, barsBySymbol)),
    curve: curve.filter((_, n) => n % step === 0 || n === curve.length - 1),
    trips: trips.slice(-200),
  };
}

function countBy(xs, key) {
  const out = {};
  for (const x of xs) out[key(x)] = (out[key(x)] || 0) + 1;
  return out;
}
