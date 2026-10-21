// The strategy: on each new bar of a symbol, read the signals, then manage that symbol.
//   - Holding it: sell at the stop, at the target, after MAX_HOLD bars, on any avoid signal,
//     or in the last minutes of the session (the app is always flat overnight).
//   - Not holding it: buy when an entry signal scores at least ENTRY_SCORE, no avoid signal is
//     on, and it is not the first or last stretch of the session. The stop goes 2 average
//     ranges below the price, the target 3 above, and positionSize() picks the share count.
// Every order goes through the risk guard first. The same Trader runs the backtest, the
// simulator and the Alpaca paper account, so what the backtest measures is what runs.
import { evaluateAll, SIGNALS } from './signals/index.mjs';
import { RiskGuard, positionSize } from './risk.mjs';
import { atr, nyClock, OPEN_MIN, CLOSE_MIN } from './stats.mjs';

export const STRATEGY = {
  entryScore: 0.6,
  stopAtr: 2,
  targetAtr: 3,
  maxHold: 24, // bars
  noEntryFirst: 15, // minutes after the open
  noEntryLast: 30, // minutes before the close
  flattenLast: 5, // minutes before the close
};

export class Trader {
  /** broker: SimBroker or AlpacaBroker. onEvent(e) hears every fill, block and halt. */
  constructor({ broker, limits, strategy = STRATEGY, signals = SIGNALS, ctx = {}, onEvent = () => {} }) {
    this.broker = broker;
    this.guard = new RiskGuard(limits);
    this.s = { ...STRATEGY, ...strategy };
    this.signals = signals;
    this.ctx = ctx;
    this.onEvent = onEvent;
    this.plans = {}; // symbol -> { entry, stop, target, held }
    this.radar = {}; // symbol -> { t, price, signals }
    this.days = []; // finished days: { key, pnl, buys, halted }
  }

  emit(e) {
    this.onEvent(e);
  }

  async account() {
    return this.broker.account();
  }

  /** Close the books on the current day (if any) and start a new one. */
  async rollDay(key) {
    const acct = await this.account();
    const d = this.guard.day;
    if (d && d.key !== key) this.days.push({ key: d.key, pnl: this.guard.dayPnl(acct.equity), buys: d.buys, halted: d.halted });
    if (!d || d.key !== key) this.guard.startDay(key, acct.equity);
  }

  async order(o, why) {
    const acct = await this.account();
    const verdict = this.guard.check(o, acct);
    if (!verdict.ok) {
      this.emit({ type: 'blocked', t: o.t, symbol: o.symbol, side: o.side, qty: o.qty, reason: verdict.reason, why });
      return null;
    }
    const fill = await this.broker.submit({ ...o, why });
    if (o.side === 'buy') this.guard.recordBuy();
    this.emit({ type: 'fill', ...fill, why });
    return fill;
  }

  async sellAll(symbol, price, t, why) {
    const acct = await this.account();
    const qty = acct.positions[symbol]?.qty || 0;
    delete this.plans[symbol];
    if (qty > 0) return this.order({ symbol, side: 'sell', qty, price, t }, why);
    return null;
  }

  /** Flatten every position (kill switch, daily limit, end of session). */
  async flattenAll(t, why) {
    const acct = await this.account();
    for (const [symbol, p] of Object.entries(acct.positions)) {
      if (p.qty > 0) await this.sellAll(symbol, this.broker.prices?.[symbol] ?? p.avg, t, why);
    }
  }

  /** Handle bar i of one symbol (bars[0..i] are known; nothing later is looked at). */
  async onBar(symbol, bars, i) {
    const b = bars[i];
    const { day, minute } = nyClock(b.t);
    await this.rollDay(day);
    this.broker.mark?.(symbol, b.c);

    const wasHalted = this.guard.day.halted;
    const acct0 = await this.account();
    if (this.guard.watch(acct0.equity) && !wasHalted) {
      this.emit({ type: 'halt', t: b.t, reason: this.guard.day.haltReason });
      await this.flattenAll(b.t, 'daily loss limit');
    }

    const sigs = evaluateAll(bars, i, this.ctx, this.signals);
    this.radar[symbol] = { t: b.t, price: b.c, signals: sigs };
    const avoid = sigs.filter((x) => x.score <= -0.5);
    const entry = sigs.filter((x) => x.kind === 'entry').sort((x, y) => y.score - x.score)[0];

    const acct = await this.account();
    const held = acct.positions[symbol]?.qty || 0;
    // A position with no plan (the server restarted, or it was bought outside the app): give it
    // the usual stop and target from its average price, so it is still managed and closed by
    // the end of the session. The paper account is meant for this app alone.
    if (held > 0 && !this.plans[symbol]) {
      const a = atr(bars, i);
      const avg = acct.positions[symbol].avg;
      this.plans[symbol] = { entry: avg, stop: avg - this.s.stopAtr * a, target: avg + this.s.targetAtr * a, held: 0, signal: 'adopted' };
    }
    const plan = this.plans[symbol];

    if (held > 0 && plan) {
      plan.held++;
      if (b.l <= plan.stop) return this.sellAll(symbol, Math.min(b.o, plan.stop), b.t, 'stop');
      if (b.h >= plan.target) return this.sellAll(symbol, Math.max(b.o, plan.target), b.t, 'target');
      if (avoid.length) return this.sellAll(symbol, b.c, b.t, `avoid: ${avoid[0].id}`);
      if (plan.held >= this.s.maxHold) return this.sellAll(symbol, b.c, b.t, 'time');
      if (minute >= CLOSE_MIN - this.s.flattenLast) return this.sellAll(symbol, b.c, b.t, 'session close');
      return null;
    }

    if (!entry || entry.score < this.s.entryScore || avoid.length) return null;
    if (minute < OPEN_MIN + this.s.noEntryFirst || minute >= CLOSE_MIN - this.s.noEntryLast) return null;
    if (this.guard.killed || this.guard.day.halted) return null;
    const a = atr(bars, i);
    const stop = b.c - this.s.stopAtr * a;
    const target = b.c + this.s.targetAtr * a;
    const qty = positionSize({ equity: acct.equity, cash: acct.cash, price: b.c, stop, limits: this.guard.limits });
    if (qty <= 0) return null;
    const fill = await this.order({ symbol, side: 'buy', qty, price: b.c, t: b.t }, `entry: ${entry.id} ${entry.score.toFixed(2)}`);
    if (fill) this.plans[symbol] = { entry: fill.price, stop, target, held: 0, signal: entry.id };
    return fill;
  }
}
