// The internal paper broker: fills market orders at the given price plus slippage, keeps cash
// and positions, and refuses anything a cash account can't do (leverage or shorting), as a
// second line behind the risk guard.
import { goodQty, roundQty } from '../risk.mjs';

export class SimBroker {
  /** fractional: allow fractional quantities (the paper agents), see risk.mjs goodQty. */
  constructor({ cash = 10_000, slippageBps = 5, commission = 0, fractional = false } = {}) {
    this.fractional = fractional;
    this.name = 'simulator';
    this.paper = true;
    this.cash = cash;
    this.slippage = slippageBps / 10_000;
    this.commission = commission;
    this.positions = {}; // symbol -> { qty, avg }
    this.prices = {}; // symbol -> last price seen
    this.realized = 0;
    this.fills = [];
  }

  mark(symbol, price) {
    this.prices[symbol] = price;
  }

  equity() {
    let e = this.cash;
    for (const [s, p] of Object.entries(this.positions)) e += p.qty * (this.prices[s] ?? p.avg);
    return e;
  }

  account() {
    return { cash: this.cash, equity: this.equity(), positions: this.positions };
  }

  /** Fill { symbol, side, qty, price } now. Returns the fill; throws if a cash account can't do it. */
  submit({ symbol, side, qty, price, t = Date.now(), why = '' }) {
    if (!goodQty(qty, this.fractional)) throw new Error('Bad quantity');
    const px = side === 'buy' ? price * (1 + this.slippage) : price * (1 - this.slippage);
    const pos = this.positions[symbol] || { qty: 0, avg: 0 };
    let pnl = 0;
    if (side === 'buy') {
      const cost = qty * px + this.commission;
      if (cost > this.cash + 1e-9) throw new Error('Not enough cash');
      this.cash -= cost;
      pos.avg = (pos.avg * pos.qty + px * qty) / (pos.qty + qty);
      pos.qty = roundQty(pos.qty + qty);
      this.positions[symbol] = pos;
    } else {
      if (qty > pos.qty + 1e-9) throw new Error('Cannot sell more than held');
      this.cash += qty * px - this.commission;
      pnl = (px - pos.avg) * qty - this.commission;
      this.realized += pnl;
      pos.qty = roundQty(pos.qty - qty);
      if (pos.qty <= 0) delete this.positions[symbol];
    }
    this.mark(symbol, price);
    const fill = { t, symbol, side, qty, price: px, pnl, why };
    this.fills.push(fill);
    return fill;
  }

  /** Sell everything at the last prices seen. */
  flatten(t = Date.now(), why = 'flatten') {
    return Object.entries(this.positions).map(([s, p]) => this.submit({ symbol: s, side: 'sell', qty: p.qty, price: this.prices[s] ?? p.avg, t, why }));
  }
}
