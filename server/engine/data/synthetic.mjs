// Made-up minute bars for the simulator, the demo and the tests. A random walk per symbol over
// whole US sessions (09:30-16:00 New York, weekdays), with planted episodes of the patterns the
// signals look for: pumps that dump, wash-like volume, stop runs and closing ramps. Same seed,
// same bars. It shows the machinery working; it says nothing about real markets.
import { rng } from '../stats.mjs';

export const DEMO_SYMBOLS = ['FRST', 'ICEE', 'GLCR', 'SNOW', 'PLRX'];

/** Midnight UTC of the first weekday on or after `from`, plus offsets for 09:30 New York (EST/EDT). */
function sessionStarts(days, from) {
  const out = [];
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  while (out.length < days) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) {
      // 09:30 New York is 13:30 UTC in summer time and 14:30 UTC in winter; ask Intl which.
      const probe = new Date(d.getTime() + 14 * 3600_000);
      const nyHour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23' }).format(probe));
      out.push(d.getTime() + (9.5 - nyHour + 14) * 3600_000);
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/**
 * { SYMBOL: bars } for `days` sessions of 1-minute bars (390 a day).
 * Options: seed, symbols, from (Date), episodes (planted patterns per symbol per day, 0..1).
 */
export function syntheticBars({ days = 10, seed = 7, symbols = DEMO_SYMBOLS, from = new Date(Date.UTC(2026, 0, 5)), episodes = 0.6, barMinutes = 1 } = {}) {
  const starts = sessionStarts(days, from);
  const perDay = Math.floor(390 / barMinutes);
  const out = {};
  symbols.forEach((symbol, si) => {
    const r = rng(seed * 1000 + si + 1);
    const gauss = () => Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r());
    let price = 4 + r() * 40;
    const baseVol = 2000 + r() * 20_000;
    const vol = 0.0012 * Math.sqrt(barMinutes);
    const bars = [];
    for (const start of starts) {
      // Plan today's planted episode, if any: which pattern and when.
      const plan = r() < episodes ? { kind: ['pump', 'wash', 'stoprun', 'ramp'][Math.floor(r() * 4)], at: 40 + Math.floor(r() * (perDay - 120)) } : null;
      let pump = 0;
      for (let k = 0; k < perDay; k++) {
        const t = start + k * barMinutes * 60_000;
        const o = price;
        let drift = 0;
        let vMult = 0.6 + r() * 0.8 + (k < 20 || k > perDay - 20 ? 0.8 : 0); // busier at the open and close
        let rangeMult = 1;
        let wick = 0;
        if (plan?.kind === 'pump' && k >= plan.at && k < plan.at + 12) { drift = 0.008; vMult *= 8; pump = 1; }
        else if (pump && k >= plan.at + 12 && k < plan.at + 40) { drift = -0.005; vMult *= 3; }
        if (plan?.kind === 'wash' && k === plan.at) { vMult *= 14; rangeMult = 0.2; }
        if (plan?.kind === 'stoprun' && k === plan.at) { wick = 0.012; vMult *= 5; }
        if (plan?.kind === 'stoprun' && k > plan.at && k < plan.at + 15) drift = 0.0012;
        if (plan?.kind === 'ramp' && k === perDay - 8) { drift = 0.01; vMult *= 6; }
        const c = Math.max(0.5, o * (1 + drift + vol * gauss() * rangeMult));
        const h = Math.max(o, c) * (1 + Math.abs(vol * gauss()) * 0.5 * rangeMult);
        const l = Math.min(o, c) * (1 - Math.abs(vol * gauss()) * 0.5 * rangeMult) * (1 - wick);
        bars.push({ t, o: +o.toFixed(4), h: +h.toFixed(4), l: +l.toFixed(4), c: +c.toFixed(4), v: Math.round(baseVol * vMult * barMinutes) });
        price = c;
      }
      price *= 1 + vol * 3 * gauss(); // overnight gap
    }
    out[symbol] = bars;
  });
  return out;
}
