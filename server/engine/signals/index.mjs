// The signal pipeline. Each signal is a module that looks at one symbol's bars up to index i
// (never later ones) and returns { score, note } or null. A positive score means "a reason to
// buy now"; a negative one means "a manipulation tell: stay out, or get out". Scores run -1..1.
//
// Every signal also gets a backtest (backtestSignal): how often its call was right over the next
// few bars, next to how often a coin flip on the same bars would have been right. That pair is
// what the "How it decides" page shows.
import { pumpDivergence } from './pump-divergence.mjs';
import { washVolume } from './wash-volume.mjs';
import { stopRun } from './stop-run.mjs';
import { closeRamp } from './close-ramp.mjs';
import { needsData } from './needs-data.mjs';

export const SIGNALS = [
  pumpDivergence,
  washVolume,
  stopRun,
  closeRamp,
  needsData('news_spike', 'News spike on a small stock', 'news', 'A burst of headlines or posts about a thinly traded stock, just before a run-up. Needs a news feed.'),
  needsData('spoof_book', 'Spoofing-like order book', 'book', 'Large orders that appear near the price and vanish before they fill. Needs full order-book (level 2) data.'),
  needsData('options_flow', 'Unusual options activity', 'options', 'Option volume far above normal before news. Needs options trade data.'),
];

/** Run every available signal for one symbol at bar i. */
export function evaluateAll(bars, i, ctx = {}, signals = SIGNALS) {
  const out = [];
  for (const s of signals) {
    if (!s.available(ctx)) continue;
    const r = s.evaluate(bars, i, ctx);
    if (r && r.score !== 0) out.push({ id: s.id, kind: s.kind, score: Math.max(-1, Math.min(1, r.score)), note: r.note });
  }
  return out;
}

/**
 * How often a signal's call came true. A call is a bar where |score| >= minScore. It counts as a
 * hit when the price `horizon` bars later moved the way the score said (up for positive, down
 * for negative). baseRate is the share of all bars that moved that same way anyway, so
 * edge = hitRate - baseRate is the part the signal itself adds.
 */
export function backtestSignal(signal, barsBySymbol, { minScore = 0.5, ctx = {} } = {}) {
  const horizon = signal.horizon;
  let calls = 0;
  let hits = 0;
  let sumRet = 0;
  let upBars = 0;
  let allBars = 0;
  let wantUp = 0;
  for (const bars of Object.values(barsBySymbol)) {
    for (let i = 0; i + horizon < bars.length; i++) {
      const fwd = bars[i + horizon].c / bars[i].c - 1;
      allBars++;
      if (fwd > 0) upBars++;
      if (!signal.available(ctx)) continue;
      const r = signal.evaluate(bars, i, ctx);
      if (!r || Math.abs(r.score) < minScore) continue;
      calls++;
      const dir = Math.sign(r.score);
      if (dir > 0) wantUp++;
      if (Math.sign(fwd) === dir) hits++;
      sumRet += dir * fwd;
    }
  }
  const upShare = allBars ? upBars / allBars : 0;
  // The coin flip to beat: the share of bars that moved in the direction this signal calls.
  const baseRate = calls ? (wantUp / calls) * upShare + (1 - wantUp / calls) * (1 - upShare) : 0;
  const hitRate = calls ? hits / calls : 0;
  return {
    id: signal.id,
    calls,
    hits,
    hitRate,
    baseRate,
    edge: calls ? hitRate - baseRate : 0,
    avgSignedReturn: calls ? sumRet / calls : 0,
    horizon,
    bars: allBars,
  };
}

export function describe(signal, ctx = {}) {
  return { id: signal.id, name: signal.name, kind: signal.kind, tell: signal.tell, needs: signal.needs, horizon: signal.horizon, available: signal.available(ctx) };
}
