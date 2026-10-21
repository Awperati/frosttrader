// Alpaca, paper account only. The trading address is fixed to Alpaca's paper endpoint and can't
// be changed by settings or environment, so this adapter can never place a real-money order.
// Keys come from the server's .env (ALPACA_KEY_ID, ALPACA_SECRET_KEY) and only ever travel in
// request headers to Alpaca.
//
// Market data: Alpaca's free plan gives real-time IEX bars and full-market bars 15 minutes old.
// The scanner uses Alpaca's screener (most active and top movers) to pick symbols.
//
// Not yet checked against a real Alpaca paper account: the exact response shapes below follow
// Alpaca's v2 documentation.

export const PAPER_URL = 'https://paper-api.alpaca.markets';
const DATA_URL = 'https://data.alpaca.markets';

export class AlpacaBroker {
  constructor({ keyId, secret, feed = 'iex', fetchImpl = fetch }) {
    if (!keyId || !secret) throw new Error('Alpaca keys missing');
    this.name = 'alpaca-paper';
    this.paper = true;
    this.headers = { 'APCA-API-KEY-ID': keyId, 'APCA-API-SECRET-KEY': secret };
    this.feed = feed;
    this.fetch = fetchImpl;
    this.prices = {};
    this.cache = null; // last account() result, refreshed by refresh()
  }

  async call(base, p, init = {}) {
    const res = await this.fetch(base + p, { ...init, headers: { ...this.headers, ...(init.body ? { 'Content-Type': 'application/json' } : {}) } });
    const body = res.status === 204 ? {} : await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Alpaca ${res.status}: ${body.message || res.statusText}`);
    return body;
  }

  mark(symbol, price) {
    this.prices[symbol] = price;
  }

  /** Fetch cash, equity and positions from the paper account. */
  async refresh() {
    const [a, ps] = await Promise.all([this.call(PAPER_URL, '/v2/account'), this.call(PAPER_URL, '/v2/positions')]);
    const positions = {};
    for (const p of ps) if (p.side === 'long') positions[p.symbol] = { qty: Number(p.qty), avg: Number(p.avg_entry_price) };
    this.cache = { cash: Number(a.cash), equity: Number(a.equity), positions, multiplier: Number(a.multiplier), status: a.status };
    return this.cache;
  }

  async account() {
    return this.cache || this.refresh();
  }

  /** Market order, day only. Waits briefly for the fill and returns it like SimBroker does. */
  async submit({ symbol, side, qty, t = Date.now(), why = '' }) {
    const o = await this.call(PAPER_URL, '/v2/orders', { method: 'POST', body: JSON.stringify({ symbol, qty: String(qty), side, type: 'market', time_in_force: 'day' }) });
    let filled = o;
    for (let n = 0; n < 10 && filled.status !== 'filled'; n++) {
      await new Promise((r) => setTimeout(r, 500));
      filled = await this.call(PAPER_URL, `/v2/orders/${o.id}`);
    }
    await this.refresh();
    const price = Number(filled.filled_avg_price) || this.prices[symbol] || 0;
    return { t, symbol, side, qty: Number(filled.filled_qty) || 0, price, pnl: 0, why, status: filled.status, id: o.id };
  }

  /** Cancel open orders and close every position (the kill switch). */
  async flatten() {
    await this.call(PAPER_URL, '/v2/orders', { method: 'DELETE' });
    await this.call(PAPER_URL, '/v2/positions?cancel_orders=true', { method: 'DELETE' });
    await this.refresh();
  }

  /** Recent bars for some symbols: { SYMBOL: [bar...] }. timeframe like '5Min'. */
  async bars(symbols, { timeframe = '5Min', start, limit = 1000 } = {}) {
    const q = new URLSearchParams({ symbols: symbols.join(','), timeframe, feed: this.feed, limit: String(limit), adjustment: 'raw' });
    if (start) q.set('start', new Date(start).toISOString());
    const out = {};
    let token = '';
    do {
      if (token) q.set('page_token', token);
      const body = await this.call(DATA_URL, `/v2/stocks/bars?${q}`);
      for (const [s, list] of Object.entries(body.bars || {})) (out[s] ||= []).push(...list.map((b) => ({ t: Date.parse(b.t), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v })));
      token = body.next_page_token || '';
    } while (token);
    return out;
  }

  /** Symbols worth watching right now: the most active stocks and the top gainers. */
  async scan({ top = 20 } = {}) {
    const [active, movers] = await Promise.all([
      this.call(DATA_URL, `/v1beta1/screener/stocks/most-actives?by=volume&top=${top}`).catch(() => ({})),
      this.call(DATA_URL, `/v1beta1/screener/stocks/movers?top=${top}`).catch(() => ({})),
    ]);
    const list = [...(active.most_actives || []), ...(movers.gainers || [])].map((x) => x.symbol);
    return [...new Set(list)].filter((s) => /^[A-Z]{1,5}$/.test(s));
  }
}
