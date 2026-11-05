// Guards that act BEFORE a limit is breached, and the end-of-day reconciliation (pure functions; the
// host calls them). Why: on 5 Nov 2026 four agents each held up to four 25 % positions with stops about
// 4 % away, so one tech sell-off could cost more than the 3 % daily loss limit and the 2 % pool limit,
// and those limits only stopped NEW buys after the loss was already on the books.
import { roundQty } from '../risk.mjs';

export const GUARDS = Object.freeze({
  gapFactor: 1.25, // stops are checked at 5-minute closes, so a stop-out can end further down than its level
  minFill: 0.5, // a buy cut below this share of its size is refused instead
  streakDays: 3, // an agent that loses this many trading days in a row ...
  streakLossPct: 0.015, // ... and is down this share of its allocation over them sits out like a drawdown halt
  reconcileUsd: 0.02, // ledger and trade log may differ by this much for one agent-day (rounding)
});

/** Loss if every open position of one agent fell to its stop: sum of qty x (price - stop) x gapFactor, never negative. */
export function openStopRisk(positions, prices, plans, gap = GUARDS.gapFactor) {
  let risk = 0;
  for (const [symbol, p] of Object.entries(positions || {})) {
    const price = prices?.[symbol] ?? p.avg;
    const stop = plans?.[symbol]?.stop ?? p.avg * 0.96;
    risk += p.qty * Math.max(0, price - stop) * gap;
  }
  return risk;
}

/**
 * How many shares of a new buy fit the loss budget. budget = the limit - today's loss so far (a profit
 * is not counted) - the open positions' stop risk. Returns { qty, budget, perShare }; qty is unchanged when it fits.
 */
export function fitToBudget({ qty, price, stop, limit, dayPnl, openRisk, gap = GUARDS.gapFactor }) {
  const perShare = Math.max(0, price - stop) * gap;
  const budget = limit + Math.min(0, dayPnl) - openRisk;
  if (!(perShare > 0)) return { qty, budget, perShare };
  if (qty * perShare <= budget + 1e-9) return { qty, budget, perShare };
  return { qty: budget > 0 ? roundQty(Math.floor((budget / perShare) * 1e4) / 1e4) : 0, budget, perShare };
}

/** True when the last `days` entries are all losses and together lose at least `pct` of the allocation. */
export function lossStreak(results, allocation, { days = GUARDS.streakDays, pct = GUARDS.streakLossPct } = {}) {
  const last = (results || []).slice(-days);
  if (last.length < days || !(allocation > 0)) return false;
  return last.every((r) => r.pnl < 0) && -last.reduce((s, r) => s + r.pnl, 0) >= allocation * pct - 1e-9;
}

/**
 * One agent-day: the ledger's sells against the trade log. Returns '' when they agree, else the problem.
 * ledger: [{ pnl }] (US$), trades: [{ pnlUsd, pnlAud, rate }].
 */
export function reconcileDay(ledger, trades, tol = GUARDS.reconcileUsd) {
  if (ledger.length !== trades.length) return `${ledger.length} ledger sells but ${trades.length} trades in the log`;
  const a = ledger.reduce((s, f) => s + f.pnl, 0);
  const b = trades.reduce((s, t) => s + t.pnlUsd, 0);
  if (Math.abs(a - b) > tol) return `ledger P&L US$${a.toFixed(4)} but the trade log says US$${b.toFixed(4)}`;
  for (const t of trades) {
    if (t.pnlAud != null && t.rate && Math.abs(t.pnlAud * t.rate - t.pnlUsd) > tol) return `a ${t.symbol} trade has A$${t.pnlAud.toFixed(4)} at rate ${t.rate} but US$${t.pnlUsd.toFixed(4)}`;
  }
  return '';
}
