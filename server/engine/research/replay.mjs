// Replaying one agent's parameters over stored bars, with the paper agents' own rules: the same
// signals, entry window, fractional sizing (positionSize), RiskGuard limits and SimBroker fills with
// 5 bps slippage, and the host's exits (stop, target, max hold, session close). Deterministic.
//
// The signals don't depend on an agent's parameters, so they are worked out once per bar
// (signalCache) and every parameter set replays from that cache: what a variant changes is only the
// entry threshold, the stop and target distances and the hold time.
//
// Not replayed: the drawdown halt, the pool's daily loss and the symbol lock between agents (one
// agent at a time). A replay never looks at a bar after the one it is deciding on.
import { evaluateAll, SIGNALS } from '../signals/index.mjs';
import { SimBroker } from '../broker/sim.mjs';
import { RiskGuard, positionSize } from '../risk.mjs';
import { limitsFor } from '../agents/profile.mjs';
import { atr, nyClock, OPEN_MIN, CLOSE_MIN } from '../stats.mjs';

const NO_ENTRY_FIRST = 15;
const NO_ENTRY_LAST = 30;
const FLATTEN_LAST = 5;

/**
 * For each symbol and bar: the best entry signal and whether a manipulation tell was there (looks at
 * bars[0..i] only), plus every bar as one time-sorted event list with its New York day and minute,
 * worked out once so each replay is a plain loop.
 */
export function signalCache(barsBySymbol) {
  const out = {};
  const events = [];
  for (const [s, bars] of Object.entries(barsBySymbol)) {
    for (let i = 0; i < bars.length; i++) {
      const c = nyClock(bars[i].t);
      events.push({ t: bars[i].t, s, i, day: c.day, minute: c.minute });
    }
  }
  events.sort((a, b) => a.t - b.t || (a.s < b.s ? -1 : 1));
  Object.defineProperty(out, '$events', { value: events, enumerable: false });
  for (const [s, bars] of Object.entries(barsBySymbol)) {
    out[s] = bars.map((_, i) => {
      if (i < 20) return null;
      const sigs = evaluateAll(bars, i, {}, SIGNALS);
      const best = sigs.filter((x) => x.kind === 'entry').sort((a, b) => b.score - a.score)[0];
      return { best: best ? { id: best.id, score: best.score } : null, tell: sigs.some((x) => x.score <= -0.5), atr: atr(bars, i) };
    });
  }
  return out;
}

/**
 * Replay params over the given days (a Set of YYYY-MM-DD). Returns
 * { trades: [{ symbol, signal, entryT, exitT, pnl, exit }], pnl, n, wins, expectancy, maxDrawdown, maxDrawdownPct }.
 */
export function replay({ bars, cache, params, preset, allocation, days }) {
  const broker = new SimBroker({ cash: allocation, slippageBps: 5, fractional: true });
  const guard = new RiskGuard(limitsFor(allocation, preset), { fractional: true });
  const events = cache.$events.filter((e) => days.has(e.day));
  const plans = {};
  const trades = [];
  let curDay = null;
  let peak = allocation;
  let maxDrawdown = 0;
  const sell = (s, price, t, why) => {
    const qty = broker.positions[s]?.qty;
    if (!qty) return;
    const f = broker.submit({ symbol: s, side: 'sell', qty, price, t });
    trades.push({ symbol: s, signal: plans[s]?.signal ?? '?', entryT: plans[s]?.entryT ?? null, exitT: t, pnl: f.pnl, exit: why });
    delete plans[s];
  };
  for (const { t, s, i, day, minute } of events) {
    if (day !== curDay) {
      // a new day: anything left from the last one is closed at its last price (the host flattens by the close)
      for (const sym of Object.keys(broker.positions)) sell(sym, broker.prices[sym], t, 'session close');
      curDay = day;
      guard.startDay(day, broker.equity());
    }
    const b = bars[s][i];
    broker.mark(s, b.c);
    const plan = plans[s];
    if (plan && broker.positions[s]) {
      plan.held++;
      if (b.l <= plan.stop) sell(s, Math.min(b.o, plan.stop), t, 'stop');
      else if (b.h >= plan.target) sell(s, Math.max(b.o, plan.target), t, 'target');
      else if (plan.held >= params.maxHold) sell(s, b.c, t, 'time');
      else if (minute >= CLOSE_MIN - FLATTEN_LAST) sell(s, b.c, t, 'session close');
    } else if (!broker.positions[s]) {
      const c = cache[s]?.[i];
      const halted = guard.watch(broker.equity());
      if (c?.best && !c.tell && c.best.score >= params.entryScore && !halted && minute >= OPEN_MIN + NO_ENTRY_FIRST && minute < CLOSE_MIN - NO_ENTRY_LAST && c.atr > 0) {
        const stop = b.c - params.stopAtr * c.atr;
        const acct = broker.account();
        const qty = positionSize({ equity: acct.equity, cash: acct.cash, price: b.c, stop, limits: guard.limits, fractional: true });
        const order = { symbol: s, side: 'buy', qty, price: b.c };
        if (qty > 0 && guard.check(order, acct).ok) {
          broker.submit({ ...order, t });
          guard.recordBuy();
          plans[s] = { stop, target: b.c + params.targetAtr * c.atr, held: 0, signal: c.best.id, entryT: t };
        }
      }
    }
    if (guard.watch(broker.equity())) for (const sym of Object.keys(broker.positions)) sell(sym, broker.prices[sym], t, 'daily loss');
    const eq = broker.equity();
    peak = Math.max(peak, eq);
    maxDrawdown = Math.max(maxDrawdown, peak - eq);
  }
  for (const sym of Object.keys(broker.positions)) sell(sym, broker.prices[sym], events.at(-1)?.t ?? 0, 'end');
  const pnl = trades.reduce((x, tr) => x + tr.pnl, 0);
  const n = trades.length;
  return { trades, pnl, n, wins: trades.filter((tr) => tr.pnl > 0).length, expectancy: n ? pnl / n : 0, maxDrawdown, maxDrawdownPct: (maxDrawdown / allocation) * 100 };
}
