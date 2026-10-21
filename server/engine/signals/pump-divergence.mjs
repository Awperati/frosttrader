// Pump signature: volume many times its normal level while the price runs up fast. In a
// pump-and-dump this is the stage where promoters sell into the crowd, so it is a reason to stay
// out (or get out), never to buy.
import { mean, zscore } from '../stats.mjs';

const LOOKBACK = 40;
const RUN = 10;

export const pumpDivergence = {
  id: 'pump_divergence',
  name: 'Pump: volume surge with a fast run-up',
  kind: 'avoid',
  tell: 'Volume 3+ standard deviations above normal while the price climbs 6 % or more in a few bars. Typical of a pump being sold into.',
  needs: ['bars'],
  horizon: 12,
  available: () => true,
  evaluate(bars, i) {
    if (i < LOOKBACK + 3) return null;
    const hist = bars.slice(i - LOOKBACK - 3, i - 3).map((b) => b.v);
    const recent = mean([bars[i - 2].v, bars[i - 1].v, bars[i].v]);
    const z = zscore(recent, hist);
    const run = bars[i].c / bars[i - RUN].c - 1;
    if (z < 3 || run < 0.06) return null;
    return { score: -Math.min(1, 0.4 + z / 10), note: `volume z ${z.toFixed(1)}, up ${(run * 100).toFixed(1)} % in ${RUN} bars` };
  },
};
