// Marking the close: a big move in the last minutes of the session on heavy volume, aimed at the
// closing price (which sets fund valuations and option settlement). It often fades soon after.
// The app is long-only and flat overnight, so a ramp up is an avoid and a ramp down is only
// noted: buying into the last minutes would mean holding overnight, which v1 never does.
import { atr, nyClock, zscore, CLOSE_MIN } from '../stats.mjs';

const LOOKBACK = 40;

export const closeRamp = {
  id: 'close_ramp',
  name: 'Closing ramp: a push into the close',
  kind: 'avoid',
  tell: 'In the last 20 minutes, one bar moves 2+ average ranges on volume 2+ standard deviations above normal. Often an attempt to set the closing price.',
  needs: ['bars'],
  horizon: 6,
  available: () => true,
  evaluate(bars, i) {
    if (i < LOOKBACK) return null;
    const { minute } = nyClock(bars[i].t);
    if (minute < CLOSE_MIN - 20 || minute >= CLOSE_MIN) return null;
    const move = bars[i].c - bars[i - 1].c;
    const a = atr(bars, i - 1);
    const z = zscore(bars[i].v, bars.slice(i - LOOKBACK, i).map((b) => b.v));
    if (!(a > 0) || Math.abs(move) < 2 * a || z < 2) return null;
    return { score: move > 0 ? -0.7 : 0, note: `${move > 0 ? 'ramp up' : 'push down'} of ${(Math.abs(move) / a).toFixed(1)} ranges into the close` };
  },
};
