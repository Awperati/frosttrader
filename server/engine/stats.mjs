// Small maths helpers shared by the signals, the strategy and the backtester.
// A bar is { t (ms since 1970), o, h, l, c, v }.

export const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Sample standard deviation (n - 1). 0 for fewer than two values. */
export function std(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

export function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** How many standard deviations x sits above the mean of xs. 0 when xs has no spread. */
export function zscore(x, xs) {
  const sd = std(xs);
  return sd > 0 ? (x - mean(xs)) / sd : 0;
}

/** Average true range over the n bars ending at index i (inclusive). */
export function atr(bars, i, n = 14) {
  const from = Math.max(1, i - n + 1);
  const trs = [];
  for (let k = from; k <= i; k++) {
    const b = bars[k];
    const pc = bars[k - 1].c;
    trs.push(Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc)));
  }
  return trs.length ? mean(trs) : bars[i].h - bars[i].l;
}

/** Largest fall from a running peak, as a fraction (0.25 = 25 %). */
export function maxDrawdown(values) {
  let peak = -Infinity;
  let worst = 0;
  for (const v of values) {
    if (v > peak) peak = v;
    if (peak > 0) worst = Math.max(worst, (peak - v) / peak);
  }
  return worst;
}

/** Annualised Sharpe ratio of a series of period returns (no risk-free rate). */
export function sharpe(returns, periodsPerYear = 252) {
  const sd = std(returns);
  return sd > 0 ? (mean(returns) / sd) * Math.sqrt(periodsPerYear) : 0;
}

/** Deterministic pseudo-random numbers (mulberry32), so simulations and tests repeat exactly. */
export function rng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Exchange clock (US markets, New York time) ────────────────

const nyParts = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
});

/** The New York trading date ("2026-10-21"), minute of the day and weekday for a time. */
export function nyClock(t) {
  const p = Object.fromEntries(nyParts.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, minute: Number(p.hour) * 60 + Number(p.minute), weekday: p.weekday };
}

export const OPEN_MIN = 9 * 60 + 30; // 09:30 New York
export const CLOSE_MIN = 16 * 60; // 16:00 New York

/** True inside the regular US session (no holiday calendar: the broker refuses orders on holidays). */
export function marketOpen(t) {
  const c = nyClock(t);
  return c.weekday !== 'Sat' && c.weekday !== 'Sun' && c.minute >= OPEN_MIN && c.minute < CLOSE_MIN;
}
