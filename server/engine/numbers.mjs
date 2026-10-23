// Numbers for the "Stock numbers" view: the latest quote, a time range, a chart-sized series,
// a page of history and plain descriptive statistics. All of it describes the past only. Nothing
// here predicts anything, and nothing here places or suggests an order.
import { mean, std, maxDrawdown } from './stats.mjs';

const DAY = 86_400_000;

/** Ranges the view offers, counted back from the LAST BAR (not from today: the data is historical). */
export const RANGES = { '1M': 1, '3M': 3, '6M': 6, '1Y': 12, '3Y': 36, All: Infinity };

/** Latest values: last close, change from the bar before, the day's range, volume and the 52-week range. */
export function quote(bars) {
  if (!bars?.length) return null;
  const last = bars[bars.length - 1];
  const prev = bars.length > 1 ? bars[bars.length - 2] : null;
  const yearAgo = last.t - 365 * DAY;
  let hi = -Infinity;
  let lo = Infinity;
  for (let i = bars.length - 1; i >= 0 && bars[i].t > yearAgo; i--) {
    hi = Math.max(hi, bars[i].h);
    lo = Math.min(lo, bars[i].l);
  }
  const change = prev ? last.c - prev.c : null;
  return {
    t: last.t,
    last: last.c,
    open: last.o,
    prevClose: prev ? prev.c : null,
    change,
    changePct: prev ? (change / prev.c) * 100 : null,
    dayLow: last.l,
    dayHigh: last.h,
    volume: last.v ?? null,
    low52: lo,
    high52: hi,
  };
}

/** The bars inside a named range, ending at the last bar. Unknown names mean All. */
export function sliceRange(bars, range = 'All') {
  const months = RANGES[range] ?? Infinity;
  if (!bars.length || months === Infinity) return bars;
  const end = new Date(bars[bars.length - 1].t);
  const from = Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - months, end.getUTCDate());
  return bars.filter((b) => b.t > from);
}

/**
 * At most `max` bars for a chart. Consecutive bars are merged into one OHLC bar (first open,
 * highest high, lowest low, last close, summed volume), so the shape is kept and no value is
 * invented.
 */
export function compress(bars, max = 260) {
  if (bars.length <= max) return bars;
  const per = Math.ceil(bars.length / max);
  const out = [];
  for (let i = 0; i < bars.length; i += per) {
    const g = bars.slice(i, i + per);
    const vols = g.map((b) => b.v).filter((v) => v != null);
    out.push({
      t: g[0].t,
      o: g[0].o,
      h: Math.max(...g.map((b) => b.h)),
      l: Math.min(...g.map((b) => b.l)),
      c: g[g.length - 1].c,
      v: vols.length ? vols.reduce((a, b) => a + b, 0) : null,
    });
  }
  return out;
}

/** Close-to-close returns as fractions. */
export function dailyReturns(bars) {
  const out = [];
  for (let i = 1; i < bars.length; i++) out.push(bars[i].c / bars[i - 1].c - 1);
  return out;
}

/**
 * Descriptive statistics of the bars given (the past, nothing more):
 *   returnPct           first close to last close
 *   annualReturnPct     the same, compounded per year (null under ~3 months: too short to mean much)
 *   volatilityPct       standard deviation of daily returns x sqrt(252)
 *   maxDrawdownPct      largest fall from a running peak of the close
 *   bestDayPct / worstDayPct, upDaysPct
 */
export function seriesStats(bars, periodsPerYear = 252) {
  if (!bars || bars.length < 2) return null;
  const r = dailyReturns(bars);
  const first = bars[0];
  const last = bars[bars.length - 1];
  const years = (last.t - first.t) / (365.25 * DAY);
  const total = last.c / first.c - 1;
  let best = { pct: -Infinity, t: null };
  let worst = { pct: Infinity, t: null };
  r.forEach((x, i) => {
    if (x * 100 > best.pct) best = { pct: x * 100, t: bars[i + 1].t };
    if (x * 100 < worst.pct) worst = { pct: x * 100, t: bars[i + 1].t };
  });
  return {
    from: first.t,
    to: last.t,
    bars: bars.length,
    returnPct: total * 100,
    annualReturnPct: years >= 0.25 ? ((1 + total) ** (1 / years) - 1) * 100 : null,
    meanDailyPct: mean(r) * 100,
    volatilityPct: std(r) * Math.sqrt(periodsPerYear) * 100,
    maxDrawdownPct: maxDrawdown(bars.map((b) => b.c)) * 100,
    bestDay: best,
    worstDay: worst,
    upDaysPct: (r.filter((x) => x > 0).length / r.length) * 100,
  };
}

/** Returns over each named range, for the detail pane's "returns" row. */
export function rangeReturns(bars) {
  const out = {};
  for (const name of Object.keys(RANGES)) {
    const s = sliceRange(bars, name);
    out[name] = s.length > 1 ? (s[s.length - 1].c / s[0].c - 1) * 100 : null;
  }
  return out;
}

/** One page of history, newest first. page is 0-based; size is clamped to 1..200. */
export function historyPage(bars, page = 0, size = 25) {
  const n = Math.min(200, Math.max(1, Math.floor(Number(size) || 25)));
  const pages = Math.max(1, Math.ceil(bars.length / n));
  const p = Math.min(pages - 1, Math.max(0, Math.floor(Number(page) || 0)));
  const end = bars.length - p * n;
  const rows = bars.slice(Math.max(0, end - n), end).reverse();
  return { page: p, size: n, pages, total: bars.length, rows };
}

/** Whole days between the last bar and `now`. */
export const ageDays = (t, now = Date.now()) => (t == null ? null : Math.max(0, Math.floor((now - t) / DAY)));
