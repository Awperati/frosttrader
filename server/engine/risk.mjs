// The risk guard. Every order passes through check() on the server before any broker sees it,
// in the backtest, the simulator and the Alpaca paper account alike. The rules:
//   - kill switch on: no new buys (selling to get flat is still allowed)
//   - daily loss limit hit: no new buys for the rest of the trading day
//   - US stocks only: no options, no crypto, no leverage (a buy must be paid for in cash),
//     no shorting (a sell can't exceed the shares held)
//   - per order: at most maxPositionValue dollars and maxPositionPct of equity
//   - per day: at most maxTradesPerDay buys, and at most maxOpenPositions at once
// The limits can be changed in Settings, but never past HARD_LIMITS.

export const DEFAULT_LIMITS = {
  maxPositionValue: 2000, // dollars in one position
  maxPositionPct: 0.2, // share of equity in one position
  maxDailyLoss: 200, // dollars lost in one trading day (closed + open) before trading stops
  maxTradesPerDay: 10, // buys per trading day
  maxOpenPositions: 3,
  riskPerTrade: 0.005, // share of equity lost if a trade hits its stop
};

/** The furthest Settings can loosen each limit. */
export const HARD_LIMITS = {
  maxPositionValue: 25_000,
  maxPositionPct: 0.25,
  maxDailyLoss: 2_000,
  maxTradesPerDay: 30,
  maxOpenPositions: 8,
  riskPerTrade: 0.01,
};

/** Limits from Settings, each clamped to (0, hard limit]. Unknown or bad values keep the default. */
export function cleanLimits(input = {}, base = DEFAULT_LIMITS) {
  const out = { ...base };
  for (const k of Object.keys(DEFAULT_LIMITS)) {
    const v = Number(input[k]);
    if (input[k] === undefined || !Number.isFinite(v) || v <= 0) continue;
    out[k] = Math.min(v, HARD_LIMITS[k]);
    if (k === 'maxTradesPerDay' || k === 'maxOpenPositions') out[k] = Math.max(1, Math.floor(out[k]));
  }
  return out;
}

/** True if b is no looser than a on every limit. */
export const isTighter = (a, b) => Object.keys(DEFAULT_LIMITS).every((k) => b[k] <= a[k]);

export const STOCK = /^[A-Z]{1,5}([.-][A-Z])?$/; // AAPL, BRK.B. Options symbols (AAPL261218C00150000) and crypto pairs (BTC/USD) fail.

export class RiskGuard {
  constructor(limits = DEFAULT_LIMITS) {
    this.limits = cleanLimits(limits);
    this.killed = false;
    this.day = null; // { key, startEquity, buys, halted, haltReason }
  }

  /** Start a new trading day (or keep the current one). Call with the account at the first bar of the day. */
  startDay(key, equity) {
    if (this.day?.key === key) return this.day;
    this.day = { key, startEquity: equity, buys: 0, halted: false, haltReason: '' };
    return this.day;
  }

  /** Today's profit or loss, closed and open, from equity now versus equity at the start of the day. */
  dayPnl(equity) {
    return this.day ? equity - this.day.startEquity : 0;
  }

  /** Check the daily loss limit against equity now; halts the day when it is reached. */
  watch(equity) {
    if (this.day && !this.day.halted && this.dayPnl(equity) <= -this.limits.maxDailyLoss) {
      this.day.halted = true;
      this.day.haltReason = `Daily loss limit reached (${this.dayPnl(equity).toFixed(2)} of -${this.limits.maxDailyLoss})`;
    }
    return this.day?.halted || false;
  }

  /**
   * Is this order allowed? order: { symbol, side: 'buy' | 'sell', qty, price, assetClass? }.
   * account: { cash, equity, positions: { [symbol]: { qty } } }. Returns { ok, reason }.
   */
  check(order, account) {
    const no = (reason) => ({ ok: false, reason });
    const { symbol, side, qty, price } = order;
    if (side !== 'buy' && side !== 'sell') return no('Only buy and sell orders');
    if (!Number.isInteger(qty) || qty <= 0) return no('Quantity must be a whole number of shares');
    if (!(price > 0)) return no('No price for this order');
    if ((order.assetClass && order.assetClass !== 'us_equity') || !STOCK.test(symbol || '')) return no('US stocks only: no options, crypto or other assets');
    const held = account.positions?.[symbol]?.qty || 0;

    if (side === 'sell') {
      if (qty > held) return no(held ? `Can only sell the ${held} shares held (no shorting)` : 'No shares held (no shorting)');
      return { ok: true, reason: '' };
    }

    if (this.killed) return no('Kill switch is on');
    if (!this.day) return no('Trading day has not started');
    if (this.watch(account.equity)) return no(this.day.haltReason);
    const value = qty * price;
    if (value > this.limits.maxPositionValue + 1e-9) return no(`Over the position limit ($${value.toFixed(2)} > $${this.limits.maxPositionValue})`);
    const pos = (held * price + value) / account.equity;
    if (pos > this.limits.maxPositionPct + 1e-9) return no(`Over ${(this.limits.maxPositionPct * 100).toFixed(0)} % of equity in one stock`);
    if (value > account.cash + 1e-9) return no('Not enough cash (no leverage)');
    if (this.day.buys >= this.limits.maxTradesPerDay) return no(`Trade limit for today reached (${this.limits.maxTradesPerDay})`);
    const open = Object.values(account.positions || {}).filter((p) => p.qty > 0).length;
    if (!held && open >= this.limits.maxOpenPositions) return no(`Open position limit reached (${this.limits.maxOpenPositions})`);
    return { ok: true, reason: '' };
  }

  /** Count a buy that was actually sent to the broker. */
  recordBuy() {
    if (this.day) this.day.buys++;
  }
}

/**
 * How many shares to buy: enough that hitting the stop loses riskPerTrade of equity, then cut
 * down to fit the position limits and the cash on hand. 0 when nothing fits.
 */
export function positionSize({ equity, cash, price, stop, limits = DEFAULT_LIMITS }) {
  if (!(price > 0) || !(stop < price) || !(equity > 0)) return 0;
  const byRisk = (equity * limits.riskPerTrade) / (price - stop);
  const byValue = limits.maxPositionValue / price;
  const byPct = (equity * limits.maxPositionPct) / price;
  const byCash = cash / price;
  return Math.max(0, Math.floor(Math.min(byRisk, byValue, byPct, byCash) + 1e-9));
}
