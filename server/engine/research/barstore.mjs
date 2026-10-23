// Recent 5-minute bars for the research loop, kept on disk so each night asks Alpaca only for what is
// new: DATA_DIR/research/bars/<SYMBOL>.json, regular hours only (09:30–16:00 New York), the last
// KEEP_DAYS trading days per symbol.
//
// Cost (Alpaca's free plan allows 200 requests a minute): the first night fetches ~45 calendar days
// for up to 40 symbols in one multi-symbol request, about 10 pages of 10,000 bars; after that one
// request (1–2 pages) a night. AlpacaData.requests counts them; the nightly report shows the number.
import fs from 'node:fs';
import path from 'node:path';
import { STOCK } from '../risk.mjs';
import { nyClock, OPEN_MIN, CLOSE_MIN } from '../stats.mjs';

export const KEEP_DAYS = 30;
export const FIRST_FETCH_DAYS = 45; // calendar days, so ~30 trading days

const regular = (t) => {
  const m = nyClock(t).minute;
  return m >= OPEN_MIN && m < CLOSE_MIN;
};

export class BarStore {
  constructor({ dataDir }) {
    this.dir = path.join(dataDir, 'research', 'bars');
  }

  file(symbol) {
    if (!STOCK.test(symbol)) throw new Error(`bad symbol ${symbol}`);
    return path.join(this.dir, `${symbol}.json`);
  }

  /** One symbol's bars, oldest first: [{ t, o, h, l, c, v }]. */
  read(symbol) {
    try {
      return JSON.parse(fs.readFileSync(this.file(symbol), 'utf8')).map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));
    } catch {
      return [];
    }
  }

  write(symbol, bars) {
    fs.mkdirSync(this.dir, { recursive: true });
    const days = [...new Set(bars.map((b) => nyClock(b.t).day))].slice(-KEEP_DAYS);
    const keep = bars.filter((b) => days.includes(nyClock(b.t).day));
    fs.writeFileSync(this.file(symbol), JSON.stringify(keep.map((b) => [b.t, b.o, b.h, b.l, b.c, b.v])));
  }

  /** Bring the store up to date for these symbols. Returns { symbols, newBars }. */
  async update(data, symbols, now) {
    const list = symbols.filter((s) => STOCK.test(s)).slice(0, 40);
    const have = Object.fromEntries(list.map((s) => [s, this.read(s)]));
    const fresh = list.filter((s) => !have[s].length);
    const known = list.filter((s) => have[s].length);
    const got = {};
    const add = (more) => {
      for (const [s, l] of Object.entries(more || {})) (got[s] ||= []).push(...l);
    };
    if (fresh.length) add(await data.bars(fresh, { timeframe: '5Min', start: now - FIRST_FETCH_DAYS * 86_400_000 }));
    if (known.length) add(await data.bars(known, { timeframe: '5Min', start: Math.min(...known.map((s) => have[s].at(-1).t)) + 1 }));
    let newBars = 0;
    for (const s of list) {
      const byT = new Map(have[s].map((b) => [b.t, b]));
      for (const b of got[s] || []) {
        // only finished bars in regular hours
        if (!regular(b.t) || b.t + 5 * 60_000 > now) continue;
        if (!byT.has(b.t)) newBars++;
        byT.set(b.t, b);
      }
      const all = [...byT.values()].sort((a, b) => a.t - b.t);
      if (all.length) this.write(s, all);
    }
    return { symbols: list.length, newBars };
  }

  /** Bars for several symbols, and the trading days they cover (sorted). */
  load(symbols) {
    const bars = {};
    const days = new Set();
    for (const s of symbols) {
      const l = this.read(s);
      if (l.length) bars[s] = l;
      for (const b of l) days.add(nyClock(b.t).day);
    }
    return { bars, days: [...days].sort() };
  }
}
