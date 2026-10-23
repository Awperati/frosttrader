// Market data from Alpaca, for the paper agents: bars only. This module talks to Alpaca's data host
// and nothing else; it has no order call and can't reach the trading host. Keys are the owner's PAPER
// key pair from Settings (server/alpaca-keys.mjs); they travel only in request headers, never in a URL,
// a log line or an error.
//
// Free plan: real-time bars from the IEX exchange (feed=iex). Rate limit 200 requests a minute; one
// tick asks for up to 40 symbols in one request (a few pages at most), once a minute.

export const DATA_HOST = 'data.alpaca.markets';
export const RETRY = { tries: 3, baseMs: 2000, maxMs: 30_000 };

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)).unref?.());

export class AlpacaData {
  /** base is for tests (a fake server); the real host is fixed. */
  constructor({ keyId, secret, feed = 'iex', fetchImpl = (...a) => globalThis.fetch(...a), base = `https://${DATA_HOST}`, sleep = defaultSleep, timeoutMs = 20_000 }) {
    if (!keyId || !secret) throw new Error('No Alpaca paper keys are saved.');
    this.headers = { 'APCA-API-KEY-ID': keyId, 'APCA-API-SECRET-KEY': secret, accept: 'application/json' };
    this.secrets = [keyId, secret];
    Object.assign(this, { feed, fetchImpl, base, sleep, timeoutMs });
    this.requests = 0; // every HTTP request made, for the nightly report
  }

  /** Any text with the keys taken out. */
  redact(text) {
    let s = String(text ?? '');
    for (const k of this.secrets) if (k && k.length >= 4) s = s.split(k).join('***');
    return s;
  }

  async get(pathAndQuery) {
    let last = null;
    for (let attempt = 0; attempt < RETRY.tries; attempt++) {
      let res;
      this.requests++;
      try {
        res = await this.fetchImpl(this.base + pathAndQuery, { headers: this.headers, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs) });
      } catch (e) {
        last = new Error(this.redact(`Could not reach Alpaca market data: ${e.message}`));
        await this.sleep(Math.min(RETRY.baseMs * 2 ** attempt, RETRY.maxMs));
        continue;
      }
      if (res.ok) return res.json();
      if (res.status === 401 || res.status === 403) throw new Error(`Alpaca refused the paper keys (HTTP ${res.status}). Check them in Settings.`);
      if (res.status === 429 || res.status >= 500) {
        last = new Error(res.status === 429 ? 'Alpaca says too many requests (HTTP 429).' : `Alpaca market data had a server error (HTTP ${res.status}).`);
        const ra = Number(res.headers.get('retry-after'));
        if (attempt < RETRY.tries - 1) await this.sleep(Math.min(Number.isFinite(ra) && ra > 0 ? ra * 1000 : RETRY.baseMs * 2 ** attempt, RETRY.maxMs));
        continue;
      }
      throw new Error(`Alpaca market data answered HTTP ${res.status}.`);
    }
    throw last || new Error('Alpaca market data could not be reached.');
  }

  /** Recent bars: { SYMBOL: [{ t, o, h, l, c, v }] }, oldest first. timeframe like '5Min'. */
  async bars(symbols, { timeframe = '5Min', start, limit = 10_000 } = {}) {
    const out = {};
    if (!symbols.length) return out;
    const q = new URLSearchParams({ symbols: symbols.join(','), timeframe, feed: this.feed, limit: String(limit), adjustment: 'raw', sort: 'asc' });
    if (start) q.set('start', new Date(start).toISOString());
    let token = '';
    let pages = 0;
    do {
      if (token) q.set('page_token', token);
      const body = await this.get(`/v2/stocks/bars?${q}`);
      for (const [s, list] of Object.entries(body?.bars || {})) {
        for (const b of list || []) {
          const bar = { t: Date.parse(b.t), o: +b.o, h: +b.h, l: +b.l, c: +b.c, v: +b.v };
          if (Number.isFinite(bar.t) && bar.c > 0 && bar.h >= bar.l) (out[s] ||= []).push(bar);
        }
      }
      token = body?.next_page_token || '';
    } while (token && ++pages < 20);
    return out;
  }

  /** The latest bar of one symbol (Settings → Test). */
  async latest(symbol) {
    const body = await this.get(`/v2/stocks/bars/latest?${new URLSearchParams({ symbols: symbol, feed: this.feed })}`);
    const b = body?.bars?.[symbol];
    return b ? { t: Date.parse(b.t), c: +b.c } : null;
  }
}
