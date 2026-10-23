// The AUD → USD rate. The owner sets the agents' money in Australian dollars; US stocks are priced in
// US dollars, so each trading day the books get AUD amount × this rate.
//
// Source: Frankfurter (api.frankfurter.dev), which serves the European Central Bank's reference rates,
// published once each working day around 16:00 CET. Free, no key, nothing about him is sent. Fetched
// at most every 6 hours; the last good rate is kept in DATA_DIR/fx.json with its date, and every use
// shows that date. The AUD amount is the cap: a rate change moves the US-dollar figure, never the AUD.
import fs from 'node:fs';
import path from 'node:path';

export const FX_URL = 'https://api.frankfurter.dev/v1/latest?from=AUD&to=USD';
export const SOURCE = 'European Central Bank reference rate, via Frankfurter';
export const REFRESH_MS = 6 * 3600_000;
export const STALE_DAYS = 5; // older than this (a long outage): the agents wait rather than guess

export class FxRate {
  constructor({ dataDir, fetchImpl = (...a) => globalThis.fetch(...a), now = Date.now, url = FX_URL, log = console }) {
    Object.assign(this, { fetchImpl, now, url, log });
    this.file = path.join(dataDir, 'fx.json');
    this.cached = read(this.file); // { rate, date, fetchedAt, source }
    this.lastTry = 0;
    this.busy = null;
  }

  /** The rate to use now: { rate, date, source, ageDays }, or null when there is none (or it is too old). */
  current() {
    const c = this.cached;
    if (!c) return null;
    const ageDays = Math.floor((this.now() - Date.parse(`${c.date}T00:00:00Z`)) / 86_400_000);
    if (!(c.rate > 0) || ageDays > STALE_DAYS) return null;
    return { rate: c.rate, date: c.date, source: c.source, ageDays };
  }

  /** Refresh when due (at most every 6 hours). Never throws; the last good rate stays on failure. */
  refresh() {
    if (this.now() - this.lastTry < REFRESH_MS && this.cached) return Promise.resolve(this.current());
    this.busy ||= this.#fetch().finally(() => {
      this.busy = null;
    });
    return this.busy;
  }

  async #fetch() {
    this.lastTry = this.now();
    try {
      const res = await this.fetchImpl(this.url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const rate = Number(body?.rates?.USD);
      if (!(rate > 0.2 && rate < 2) || !/^\d{4}-\d{2}-\d{2}$/.test(body?.date || '')) throw new Error('an unexpected answer');
      this.cached = { rate, date: body.date, fetchedAt: new Date(this.now()).toISOString(), source: SOURCE };
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.cached));
    } catch (e) {
      this.log.warn?.(`AUD/USD rate: ${e.message}; keeping ${this.cached ? `the ${this.cached.date} rate` : 'none'}`);
    }
    return this.current();
  }
}

function read(file) {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    return d?.rate > 0 && d?.date ? d : null;
  } catch {
    return null;
  }
}
