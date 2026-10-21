// Stop run: the price is pushed just below an obvious recent low (where stop-loss orders sit),
// the stops fire on extra volume, and the price closes back above the low in the same bar. The
// flush was a grab for liquidity, not real selling, so this is the one buy setup.
import { zscore } from '../stats.mjs';

const LOOKBACK = 30;

export const stopRun = {
  id: 'stop_run',
  name: 'Stop run: flush below support that snaps back',
  kind: 'entry',
  tell: 'The low pokes 0.3 % or more under the lowest low of the last 30 bars on above-normal volume, then the bar closes back above that low.',
  needs: ['bars'],
  horizon: 12,
  available: () => true,
  evaluate(bars, i) {
    if (i < LOOKBACK) return null;
    const hist = bars.slice(i - LOOKBACK, i);
    const support = Math.min(...hist.map((b) => b.l));
    const b = bars[i];
    const poke = (support - b.l) / support;
    if (poke < 0.003 || b.c <= support) return null;
    const z = zscore(b.v, hist.map((x) => x.v));
    if (z < 1.5) return null;
    const recovery = (b.c - b.l) / Math.max(1e-9, b.h - b.l); // 1 = closed on the high
    return { score: Math.min(1, 0.5 + recovery * 0.3 + Math.min(z, 6) / 20), note: `poked ${(poke * 100).toFixed(2)} % under support, volume z ${z.toFixed(1)}` };
  },
};
