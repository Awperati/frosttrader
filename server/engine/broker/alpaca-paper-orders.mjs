// Orders on the owner's Alpaca PAPER account, for the paper agents (docs/DESIGN-autonomous-agents.md
// stage 4). The owner (25 Oct 2026): "build Alpaca paper orders next (paper account only, no live
// trading)".
//
// Paper only, in three ways that don't depend on settings:
//   - the trading address is fixed to Alpaca's paper host below; nothing can change it;
//   - a live key pair (key id starting "AK") is refused;
//   - before the first order the account is read, and anything that isn't a paper account (its
//     number starts "PA") is refused.
// Keys travel only in request headers and are taken out of every error.
//
// Every order carries client_order_id "ft-<agent>-<hash of the host's idempotency key>", so a retry
// after a network error finds the first order instead of sending a second one.
import crypto from 'node:crypto';

export const PAPER_HOST = 'https://paper-api.alpaca.markets';
export const FILL_WAIT = Object.freeze({ polls: 20, everyMs: 500 }); // up to 10 s for a market order

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)).unref?.());

export class AlpacaPaperOrders {
  constructor({ keyId, secret, fetchImpl = (...a) => globalThis.fetch(...a), base = PAPER_HOST, sleep = defaultSleep, timeoutMs = 20_000 }) {
    if (!keyId || !secret) throw new Error('No Alpaca paper keys are saved.');
    if (String(keyId).startsWith('AK')) throw new Error('That is a live-trading key: paper orders need the paper key pair.');
    // tests point base at a fake server on this computer; anything else must be the paper host
    if (base !== PAPER_HOST && !/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) throw new Error('Paper orders go only to Alpaca\'s paper host.');
    this.headers = { 'APCA-API-KEY-ID': keyId, 'APCA-API-SECRET-KEY': secret, accept: 'application/json' };
    this.secrets = [keyId, secret];
    Object.assign(this, { fetchImpl, base, sleep, timeoutMs });
    this.keyId = keyId;
    this.checked = null; // { account } once the account was confirmed to be paper
    this.requests = 0;
  }

  redact(text) {
    let s = String(text ?? '');
    for (const k of this.secrets) if (k && k.length >= 4) s = s.split(k).join('***');
    return s;
  }

  async call(p, init = {}) {
    this.requests++;
    let res;
    try {
      res = await this.fetchImpl(this.base + p, { ...init, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs), headers: { ...this.headers, ...(init.body ? { 'content-type': 'application/json' } : {}) } });
    } catch (e) {
      const err = new Error(this.redact(`Could not reach Alpaca paper: ${e.message}`));
      err.network = true;
      throw err;
    }
    const body = res.status === 204 ? {} : await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(res.status === 401 || res.status === 403 ? `Alpaca refused the paper keys (HTTP ${res.status}).` : this.redact(`Alpaca paper answered HTTP ${res.status}: ${body?.message || ''}`.trim()));
      err.status = res.status;
      throw err;
    }
    return body;
  }

  /** Read the account once and refuse anything but a paper account. */
  async ensurePaper() {
    if (this.checked) return this.checked.account;
    const a = await this.call('/v2/account');
    if (!/^PA/.test(String(a?.account_number || ''))) throw new Error('That account is not a paper account: no order was sent.');
    if (a.trading_blocked || a.account_blocked) throw new Error('Alpaca has blocked trading on the paper account.');
    this.checked = { account: a };
    return a;
  }

  /** client_order_id for an idempotency key: the same key always gives the same id. */
  static clientId(agentId, key) {
    return `ft-${agentId}-${crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 24)}`;
  }

  async byClientId(cid) {
    try {
      return await this.call(`/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(cid)}`);
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }

  /**
   * A market order, day only, for one agent. Waits for the fill; an order not filled in time is
   * cancelled. Returns { status, filledQty, avgPrice, id, clientId } (filledQty 0 when nothing filled).
   */
  async submit({ agentId, symbol, side, qty, key }) {
    await this.ensurePaper();
    const clientId = AlpacaPaperOrders.clientId(agentId, key);
    let o = null;
    try {
      o = await this.call('/v2/orders', { method: 'POST', body: JSON.stringify({ symbol, qty: String(qty), side, type: 'market', time_in_force: 'day', client_order_id: clientId }) });
    } catch (e) {
      // a network error or a duplicate id: the order may already be there, so look it up instead of resending
      if (!(e.network || e.status === 422 || e.status >= 500)) throw e;
      o = await this.byClientId(clientId);
      if (!o) throw e;
    }
    for (let n = 0; n < FILL_WAIT.polls && !done(o); n++) {
      await this.sleep(FILL_WAIT.everyMs);
      o = await this.call(`/v2/orders/${encodeURIComponent(o.id)}`);
    }
    if (!done(o)) {
      await this.call(`/v2/orders/${encodeURIComponent(o.id)}`, { method: 'DELETE' }).catch(() => {});
      o = await this.call(`/v2/orders/${encodeURIComponent(o.id)}`);
    }
    return { status: o.status, filledQty: Number(o.filled_qty) || 0, avgPrice: Number(o.filled_avg_price) || 0, id: o.id, clientId };
  }

  /** Long positions on the account: { SYMBOL: qty }. */
  async positions() {
    await this.ensurePaper();
    const list = await this.call('/v2/positions');
    const out = {};
    for (const p of Array.isArray(list) ? list : []) out[p.symbol] = (out[p.symbol] || 0) + (p.side === 'short' ? -1 : 1) * Number(p.qty);
    return out;
  }

  /** Cancel every open order this app sent (ids starting "ft-"). */
  async cancelOpen() {
    const list = await this.call('/v2/orders?status=open&limit=500');
    for (const o of Array.isArray(list) ? list : []) if (String(o.client_order_id || '').startsWith('ft-')) await this.call(`/v2/orders/${encodeURIComponent(o.id)}`, { method: 'DELETE' }).catch(() => {});
  }
}

const done = (o) => ['filled', 'canceled', 'expired', 'rejected', 'done_for_day'].includes(o?.status);
