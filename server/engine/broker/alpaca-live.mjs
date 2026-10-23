// Alpaca LIVE: real money. Used only by the live desk (server/engine/live/desk.mjs), and only after the
// owner's one-time enablement (server/engine/live/enablement.mjs). The trading host is fixed in code;
// a test server is accepted only on this machine (127.0.0.1), so no setting can point real keys or
// orders anywhere else. Keys travel only in request headers, never in a URL, a log line or an error.
//
// Orders are market, day, fractional: buys by dollar amount (notional), sells by share quantity. Each
// carries the desk's client_order_id, so a retry after a timeout can't buy twice: Alpaca refuses a
// second order with the same id, and the desk then looks the first one up by that id.

export const LIVE_HOST = 'api.alpaca.markets';
const LOCAL_TEST = /^http:\/\/127\.0\.0\.1:\d+$/;

export class AlpacaLive {
  constructor({ keyId, secret, fetchImpl = (...a) => globalThis.fetch(...a), base = `https://${LIVE_HOST}`, timeoutMs = 20_000 }) {
    if (!keyId || !secret) throw new Error('No Alpaca live keys are saved.');
    if (base !== `https://${LIVE_HOST}` && !LOCAL_TEST.test(base)) throw new Error('The live trading host is fixed.');
    this.headers = { 'APCA-API-KEY-ID': keyId, 'APCA-API-SECRET-KEY': secret, accept: 'application/json' };
    this.secrets = [keyId, secret];
    Object.assign(this, { fetchImpl, base, timeoutMs });
  }

  redact(text) {
    let s = String(text ?? '');
    for (const k of this.secrets) if (k && k.length >= 4) s = s.split(k).join('***');
    return s;
  }

  async call(method, p, body) {
    let res;
    try {
      res = await this.fetchImpl(this.base + p, {
        method,
        headers: { ...this.headers, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      const err = new Error(this.redact(`Could not reach Alpaca: ${e.message}`));
      err.network = true;
      throw err;
    }
    const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(this.redact(`Alpaca ${res.status}: ${data?.message || 'error'}`));
      err.status = res.status;
      throw err;
    }
    return data;
  }

  /** The account: { number, cash, buyingPower, nonMarginableBuyingPower, multiplier, pdt, daytradeCount, shorting, blocked, currency, status }. */
  async account() {
    const a = await this.call('GET', '/v2/account');
    return {
      number: String(a.account_number || ''),
      cash: Number(a.cash),
      equity: Number(a.equity),
      buyingPower: Number(a.buying_power),
      nonMarginableBuyingPower: Number(a.non_marginable_buying_power),
      multiplier: String(a.multiplier ?? ''),
      pdt: a.pattern_day_trader === true || String(a.multiplier) === '4',
      daytradeCount: Number.isFinite(Number(a.daytrade_count)) ? Number(a.daytrade_count) : null,
      shorting: a.shorting_enabled === true,
      blocked: a.trading_blocked === true || a.account_blocked === true || a.trade_suspended_by_user === true,
      currency: String(a.currency || ''),
      status: String(a.status || ''),
    };
  }

  /** Open positions: { SYMBOL: { qty, avg } }. */
  async positions() {
    const list = await this.call('GET', '/v2/positions');
    const out = {};
    for (const p of list || []) out[p.symbol] = { qty: Number(p.qty), avg: Number(p.avg_entry_price), side: p.side };
    return out;
  }

  /** A market day order. buy: { notional }, sell: { qty }. Returns the order as Alpaca reports it. */
  async submit({ symbol, side, notional, qty, clientOrderId }) {
    const body = { symbol, side, type: 'market', time_in_force: 'day', client_order_id: clientOrderId };
    if (side === 'buy') body.notional = Number(notional).toFixed(2);
    else body.qty = String(qty);
    return this.order(await this.call('POST', '/v2/orders', body));
  }

  /** The order with this client_order_id, or null when Alpaca has none. */
  async byClientId(clientOrderId) {
    try {
      return this.order(await this.call('GET', `/v2/orders:by_client_order_id?${new URLSearchParams({ client_order_id: clientOrderId })}`));
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }

  order(o) {
    return { id: o.id, clientOrderId: o.client_order_id, symbol: o.symbol, side: o.side, status: o.status, filledQty: Number(o.filled_qty) || 0, filledAvgPrice: Number(o.filled_avg_price) || 0 };
  }

  /** The kill switch: cancel every open order, then close every position. */
  async closeAll() {
    await this.call('DELETE', '/v2/orders');
    await this.call('DELETE', '/v2/positions?cancel_orders=true');
  }
}
