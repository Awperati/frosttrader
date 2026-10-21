// Wash-trading-like volume: a huge print that barely moves the price. Real buying or selling
// that size usually moves the price; trades between friendly accounts don't. It inflates the
// "activity" that scanners (and people) chase, so it is a reason to stay out.
import { median, zscore } from '../stats.mjs';

const LOOKBACK = 40;

export const washVolume = {
  id: 'wash_volume',
  name: 'Wash-like volume: heavy trading, no price move',
  kind: 'avoid',
  tell: 'Volume 4+ standard deviations above normal while the bar is narrower than the usual bar. Lots of shares changing hands without moving the price.',
  needs: ['bars'],
  horizon: 12,
  available: () => true,
  evaluate(bars, i) {
    if (i < LOOKBACK) return null;
    const hist = bars.slice(i - LOOKBACK, i);
    const z = zscore(bars[i].v, hist.map((b) => b.v));
    const range = (bars[i].h - bars[i].l) / bars[i].c;
    const usual = median(hist.map((b) => (b.h - b.l) / b.c));
    if (z < 4 || !(usual > 0) || range > usual) return null;
    return { score: -0.6, note: `volume z ${z.toFixed(1)}, range ${(range / usual).toFixed(2)}x the usual bar` };
  },
};
