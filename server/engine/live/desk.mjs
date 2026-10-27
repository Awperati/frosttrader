// The live desk: REAL MONEY, US stocks only, through the owner's Alpaca account, and only while his
// signed enablement (enablement.mjs) is valid. Everything here runs inside the host's tick, after the
// paper books; the agents' proposals are the same ones (an agent trades live when its own signals
// and every check below say so).
//
// Money is set in AUD. Each agent has a virtual sub-ledger on the one real account; its exposure is
// kept in AUD at fill-time cost, so a later rate move never frees extra room, and gains never raise
// the cap. An order is converted to US dollars at the newest dated ECB rate, which must be no older
// than the previous business day; the rate and its date go into the order's audit line.
//
// Before any live buy (each refusal is audited with its check):
//   L1  a valid, signed enablement; live not stopped (kill, integrity, total drawdown)
//   L2  a fresh AUD/USD rate
//   L3  the account is still a cash account: multiplier 1, not flagged pattern day trader, no
//       shorting, not blocked, USD (read from Alpaca every tick)
//   17  AGENT_CAPITAL: the watchlist; one live agent per symbol; within the agent's AUD room
//   18  SETTLED CASH: sale proceeds count only from the next business day (T+1), for the agent and for
//       the account (Alpaca's non-marginable buying power, minus buys still pending)
//   19  DAY TRADES: at most 3 in 5 business days across all agents (every entry here is closed the
//       same day), unless the owner's account shows it isn't subject to the rule
//   L4  his limits: per order, buys and A$ bought per agent per day, A$ bought by all per day
//   L5  halts: that agent's daily loss or drawdown sit-out; all agents' daily loss
// Exits (stop, target, time, session close) are the desk's, as on paper; a v11 agent's exit is v11's
// own (a close a set ATR distance under the best close since the buy, a bar limit, the session close,
// 13:00 on early-close days). Every order carries a client_order_id written down before it is sent,
// so a retry can't double-buy. Only agents the owner switched to "live" (Settings) trade here.
//
// Halts: an agent's daily loss (back next day); its drawdown (sits out the next trading day, back at
// half size, full after 5 clean days); all agents' daily loss (all back next day). The total drawdown,
// a reconciliation mismatch, a changed account (margin, PDT, blocked) and the kill switch close every
// live position and stop live trading until the owner resumes with his password and code.
import fs from 'node:fs';
import path from 'node:path';
import { STOCK } from '../risk.mjs';
import { atr, nyClock, closeMinute } from '../stats.mjs';
import { loadModel } from '../models/v11.mjs';

export const SIT_OUT_DAYS = 2;
export const CLEAN_DAYS_TO_FULL = 5;
export const DAY_TRADES_IN_5 = 3;
export const RISK_PER_TRADE = 0.0075; // the Medium preset's share of the agent's equity at risk to the stop
const FLATTEN_LAST = 5;

const round2 = (x) => Math.floor(x * 100 + 1e-9) / 100;
const isoDay = (t) => new Date(t).toISOString().slice(0, 10);

/** The business day after `day` (YYYY-MM-DD): Mon–Fri, no holiday calendar (holidays settle later, never sooner). */
export function nextBusinessDay(day) {
  const d = new Date(`${day}T12:00:00Z`);
  do d.setUTCDate(d.getUTCDate() + 1);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return isoDay(d);
}
export function previousBusinessDay(day) {
  const d = new Date(`${day}T12:00:00Z`);
  do d.setUTCDate(d.getUTCDate() - 1);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return isoDay(d);
}
/** Is a rate dated `rateDay` fresh enough for a live order on `day` (no older than the previous business day)? */
export const rateFresh = (rateDay, day) => !!rateDay && rateDay >= previousBusinessDay(day);

const blankAgent = () => ({ positions: {}, plans: {}, lastBarT: {}, realizedAud: 0, peakAud: null, sitOut: 0, scale: 1, cleanDays: 0, day: null });
const blankDay = (key, startAud) => ({ key, startAud, buys: 0, boughtAud: 0, halt: null });

export class LiveDesk {
  /**
   * enablement: an Enablement. broker(): an AlpacaLive with his live keys, or null. getFx(): the rate.
   * audit: the host's AuditLog. agentIds, params(id), running(id): from the host.
   */
  constructor({ dataDir, enablement, broker = () => null, getFx = () => null, audit, now = Date.now, params, running, strategy = () => 'signals', allowed = null, notify = () => {}, log = console }) {
    Object.assign(this, { enablement, broker, getFx, audit, now, params, running, strategy, allowed, log });
    this.notify = (event, msg) => {
      try {
        notify(event, msg);
      } catch {
        /* a failing alert never stops trading */
      }
    };
    this.file = path.join(dataDir, 'live-state.json');
    this.state = { agents: {}, pending: {}, unsettled: [], dayTrades: [], seq: 0, day: null, allHalt: null, stopped: null, peakTotalAud: null, account: null, lastError: '', ...(readJson(this.file) || {}) };
  }

  agent(id) {
    return (this.state.agents[id] ??= blankAgent());
  }

  enabled() {
    return this.enablement.read();
  }

  save() {
    writeJson(this.file, this.state);
  }

  // ── money in AUD ──

  rate() {
    const fx = this.getFx();
    return fx?.rate > 0 ? fx : null;
  }

  exposureAud(a) {
    return Object.values(a.positions).reduce((s, p) => s + p.costAud, 0);
  }

  unsettledAud(id, day) {
    return this.state.unsettled.filter((u) => u.agent === id && u.settles > day).reduce((s, u) => s + u.aud, 0);
  }

  equityAud(a, prices, rate) {
    let e = this.limits().perAgentAud + a.realizedAud;
    for (const [s, p] of Object.entries(a.positions)) e += (p.qty * (prices[s] ?? p.costUsd / p.qty)) / rate - p.costAud;
    return e;
  }

  limits() {
    return this.enabled()?.limits;
  }

  // ── the tick ──

  /**
   * One pass, inside the host's tick in market hours. proposals: [[agentId, items]]. Never throws.
   */
  async tick({ now, bars, universe, proposals = [], inWindow }) {
    const en = this.enabled();
    if (!en) return;
    if (this.state.stopped) return;
    const b = this.broker();
    if (!b) {
      this.state.lastError = 'Live is enabled but no live keys are saved.';
      return;
    }
    try {
      await this.#tick(b, en, { now, bars, universe, proposals, inWindow });
      this.state.lastError = '';
    } catch (e) {
      this.state.lastError = b.redact(e.message);
      this.audit.write({ type: 'live-error', reason: this.state.lastError });
    } finally {
      this.save();
    }
  }

  async #tick(b, en, { now, bars, universe, proposals, inWindow }) {
    const day = nyClock(now).day;
    const L = en.limits;
    const prices = Object.fromEntries(Object.entries(bars).filter(([, l]) => l.length).map(([s, l]) => [s, l[l.length - 1].c]));
    await this.pollPending(b);

    // L3: the account is still what he enabled
    const acct = await b.account();
    this.state.account = { number: acct.number.slice(-4), cash: acct.cash, multiplier: acct.multiplier, pdt: acct.pdt, daytradeCount: acct.daytradeCount, at: now };
    const bad = accountProblem(acct, en.account);
    if (bad) return this.stopAll(bad, b);

    // reconciliation: the broker's positions are the sum of the sub-ledgers (symbols with pending orders aside)
    const mismatch = await this.reconcile(b);
    if (mismatch) return this.stopAll(`integrity: ${mismatch}`, b);

    const fx = this.rate();
    if (this.state.day !== day) this.startDay(day, prices, fx);

    // exits and halts
    for (const [id, a] of Object.entries(this.state.agents)) {
      for (const symbol of Object.keys(a.positions)) await this.manageExit(b, id, a, symbol, bars[symbol] || [], fx, day);
      if (!fx) continue;
      const eq = this.equityAud(a, prices, fx.rate);
      a.peakAud = Math.max(a.peakAud ?? eq, eq);
      if (a.day && !a.day.halt && eq - a.day.startAud <= -L.agentDailyLossAud + 1e-9) await this.haltAgent(b, id, a, `live daily loss A$${(a.day.startAud - eq).toFixed(2)} reached A$${L.agentDailyLossAud}`, fx, day);
      if (a.day && !a.day.halt && a.sitOut === 0 && eq <= a.peakAud - L.agentDrawdownAud + 1e-9) {
        a.sitOut = SIT_OUT_DAYS;
        a.cleanDays = 0;
        await this.haltAgent(b, id, a, `live drawdown: A$${eq.toFixed(2)} is A$${L.agentDrawdownAud} or more below its best (A$${a.peakAud.toFixed(2)})`, fx, day);
      }
    }
    if (fx) {
      const ids = Object.keys(this.state.agents);
      const dayPnl = ids.reduce((s, id) => s + (this.state.agents[id].day ? this.equityAud(this.state.agents[id], prices, fx.rate) - this.state.agents[id].day.startAud : 0), 0);
      if (!this.state.allHalt && dayPnl <= -L.allDailyLossAud + 1e-9) {
        this.state.allHalt = { day, reason: `all agents' live daily loss A$${(-dayPnl).toFixed(2)} reached A$${L.allDailyLossAud}` };
        this.audit.write({ type: 'live-halt', kind: 'all-day', reason: this.state.allHalt.reason });
        this.notify('halt', { message: `Every agent stopped live buying for today: ${this.state.allHalt.reason}. Live positions are being sold.` });
        for (const [id, a] of Object.entries(this.state.agents)) for (const s of Object.keys(a.positions)) await this.sell(b, id, a, s, prices[s], 'all agents daily loss', fx, day);
      }
      const total = ids.reduce((s, id) => s + this.equityAud(this.state.agents[id], prices, fx.rate), 0) + (4 - ids.length) * L.perAgentAud;
      this.state.peakTotalAud = Math.max(this.state.peakTotalAud ?? total, total);
      if (total <= this.state.peakTotalAud - L.totalDrawdownAud + 1e-9) return this.stopAll(`total live drawdown: A$${total.toFixed(2)} is A$${L.totalDrawdownAud} or more below its best (A$${this.state.peakTotalAud.toFixed(2)})`, b);
    }

    // entries
    if (!inWindow) return;
    for (const [id, items] of proposals) for (const p of items || []) await this.enter(b, id, p, bars[p.symbol] || [], universe, acct, day, fx);
  }

  startDay(day, prices, fx) {
    this.state.day = day;
    this.state.allHalt = null;
    this.state.unsettled = this.state.unsettled.filter((u) => u.settles > day);
    const five = [];
    for (let d = day, i = 0; i < 5; i++, d = previousBusinessDay(d)) five.push(d);
    this.state.dayTrades = this.state.dayTrades.filter((t) => five.includes(t.day));
    for (const [id, a] of Object.entries(this.state.agents)) {
      if (a.sitOut > 0) {
        a.sitOut--;
        if (a.sitOut === 0) {
          a.scale = 0.5;
          a.peakAud = fx ? this.equityAud(a, prices, fx.rate) : null;
          this.audit.write({ type: 'live-resume', agent: id, after: 'drawdown halt', scale: 0.5 });
        }
      } else if (a.scale < 1 && ++a.cleanDays >= CLEAN_DAYS_TO_FULL) a.scale = 1;
      a.day = blankDay(day, fx ? this.equityAud(a, prices, fx.rate) : this.limits().perAgentAud + a.realizedAud);
    }
    this.audit.write({ type: 'live-day', day });
  }

  /** Is a buy allowed? Returns { ok, check, reason, notionalUsd, aud }. Pure apart from reading state. */
  gate({ id, a, p, list, universe, acct, day, fx }) {
    const L = this.limits();
    const no = (check, reason) => ({ ok: false, check, reason });
    if (!L) return no('L1', 'live is not enabled');
    if (this.state.stopped) return no('L1', `live is stopped: ${this.state.stopped.reason}`);
    if (!fx || !rateFresh(fx.date, day)) return no('L2', `no fresh AUD/USD rate (have ${fx?.date ?? 'none'}, need ${previousBusinessDay(day)} or newer)`);
    const list17 = this.allowed ? this.allowed(id, universe) : universe;
    if (!STOCK.test(p.symbol) || !list17.has(p.symbol)) return no('17', `${p.symbol} is not on the watchlist${this.strategy(id) === 'v11' ? ' or among the v11 model\'s stocks' : ''}`);
    for (const [other, o] of Object.entries(this.state.agents)) if (other !== id && o.positions[p.symbol]) return no('17', `${p.symbol} is held live by ${other}`);
    if (Object.values(this.state.pending).some((o) => o.symbol === p.symbol)) return no('17', `an order for ${p.symbol} is still open`);
    if (a.day?.halt) return no('L5', `halted today: ${a.day.halt}`);
    if (a.sitOut > 0) return no('L5', 'sitting out after a drawdown halt');
    if (this.state.allHalt) return no('L5', this.state.allHalt.reason);
    if (list.length < 20) return no('L4', 'not enough bars');
    const bar = list[list.length - 1];
    const r = atr(list, list.length - 1);
    if (!(r > 0)) return no('L4', 'no volatility measure (ATR)');
    const params = this.params(id);
    const v11 = this.strategy(id) === 'v11';
    const exit = v11 ? loadModel().exit : null;
    // v11: the trailing distance at the buy, as a fraction of the price; signal agents: their ATR stop
    const stopDist = v11 ? (exit.kind === 'atr' ? (exit.stop * r) / bar.c : exit.stop) : (params.stopAtr * r) / bar.c;
    // the agent's room in AUD: never above its cap, never raised by gains, settled money only
    const cap = L.perAgentAud;
    const room = Math.min(cap, cap + a.realizedAud) - this.exposureAud(a) - this.unsettledAud(id, day);
    const equity = cap + a.realizedAud;
    const byRisk = (equity * RISK_PER_TRADE * a.scale) / stopDist;
    let aud = Math.min(L.perOrderAud * a.scale, byRisk, room, L.perAgentDayAud - (a.day?.boughtAud ?? 0));
    const allBought = Object.values(this.state.agents).reduce((s, x) => s + (x.day?.boughtAud ?? 0), 0);
    aud = Math.min(aud, L.allDayAud - allBought);
    const totalExposure = Object.values(this.state.agents).reduce((s, x) => s + this.exposureAud(x), 0);
    aud = Math.min(aud, L.totalAud - totalExposure);
    if (room <= 0.01) return no('17', `no room left in its A$${cap} (exposure A$${this.exposureAud(a).toFixed(2)}, unsettled A$${this.unsettledAud(id, day).toFixed(2)})`);
    if ((a.day?.buys ?? 0) >= L.buysPerDay) return no('L4', `${L.buysPerDay} buys today already`);
    const notionalUsd = round2(aud * fx.rate);
    if (notionalUsd < 1) return no('L4', `order too small after the limits (US$${notionalUsd.toFixed(2)}; Alpaca's minimum is US$1)`);
    // 18: the account's settled buying power, minus buys still open
    const pendingBuys = Object.values(this.state.pending).filter((o) => o.side === 'buy').reduce((s, o) => s + o.notionalUsd, 0);
    const settled = Math.min(acct.cash, Number.isFinite(acct.nonMarginableBuyingPower) ? acct.nonMarginableBuyingPower : acct.cash) - pendingBuys;
    if (notionalUsd > settled + 1e-9) return no('18', `US$${notionalUsd.toFixed(2)} is more than the account's settled cash (US$${settled.toFixed(2)})`);
    // 19: day trades (every entry is closed by the session's end): the pattern-day-trader rule binds
    // margin accounts only, so it is skipped when he confirmed a CASH account (check 18 then limits
    // each dollar to one round trip a day); Alpaca's own protection still has the last word
    const trades = Math.max(this.state.dayTrades.length, acct.daytradeCount ?? 0);
    if (this.enabled()?.cashAccount !== true && trades >= DAY_TRADES_IN_5) return no('19', `${trades} day trades in the last 5 business days (the limit under US$25k is ${DAY_TRADES_IN_5})`);
    const plan = v11
      ? { stop: bar.c * (1 - stopDist), target: null, trailPct: stopDist, best: bar.c, maxHold: exit.maxHold }
      : { stop: bar.c - params.stopAtr * r, target: bar.c + params.targetAtr * r };
    return { ok: true, check: '', reason: '', notionalUsd, aud: notionalUsd / fx.rate, ...plan, price: bar.c, t: bar.t };
  }

  async enter(b, id, p, list, universe, acct, day, fx) {
    if (!this.running(id)) return;
    const a = this.agent(id);
    a.day ??= blankDay(day, this.limits().perAgentAud + a.realizedAud);
    const g = this.gate({ id, a, p, list, universe, acct, day, fx });
    if (!g.ok) {
      this.audit.write({ type: 'live-refused', agent: id, side: 'buy', symbol: p.symbol, check: g.check, reason: g.reason });
      return;
    }
    const clientOrderId = `ft-${id}-${day}-${++this.state.seq}`;
    // written down before it is sent: a timeout is resolved by looking this id up, never by sending again
    this.state.pending[clientOrderId] = { agent: id, symbol: p.symbol, side: 'buy', notionalUsd: g.notionalUsd, aud: g.aud, rate: fx.rate, rateDate: fx.date, t: this.now(), day };
    a.day.buys++;
    a.day.boughtAud += g.aud;
    a.plans[p.symbol] = { stop: g.stop, target: g.target, held: 0, signal: p.signal, ...(g.trailPct ? { trailPct: g.trailPct, best: g.best, maxHold: g.maxHold } : {}) };
    a.lastBarT[p.symbol] = g.t;
    this.save();
    this.audit.write({ type: 'live-order', agent: id, side: 'buy', symbol: p.symbol, notionalUsd: g.notionalUsd, aud: Number(g.aud.toFixed(4)), rate: fx.rate, rateDate: fx.date, clientOrderId, signal: p.signal, score: p.score });
    try {
      const o = await b.submit({ symbol: p.symbol, side: 'buy', notional: g.notionalUsd, clientOrderId });
      this.applyOrder(clientOrderId, o);
    } catch (e) {
      if (e.status === 422 || e.network) {
        const o = await b.byClientId(clientOrderId).catch(() => null);
        if (o) return this.applyOrder(clientOrderId, o);
        if (e.network) return; // unknown: the next tick looks it up again
      }
      delete this.state.pending[clientOrderId];
      a.day.buys--;
      a.day.boughtAud -= g.aud;
      delete a.plans[p.symbol];
      this.audit.write({ type: 'live-rejected', agent: id, symbol: p.symbol, clientOrderId, reason: b.redact(e.message) });
    }
  }

  async sell(b, id, a, symbol, price, why, fx, day) {
    const pos = a.positions[symbol];
    if (!pos || Object.values(this.state.pending).some((o) => o.symbol === symbol && o.agent === id)) return;
    const clientOrderId = `ft-${id}-${day}-${++this.state.seq}`;
    this.state.pending[clientOrderId] = { agent: id, symbol, side: 'sell', qty: pos.qty, notionalUsd: 0, rate: fx?.rate ?? null, rateDate: fx?.date ?? null, t: this.now(), day, why };
    this.save();
    this.audit.write({ type: 'live-order', agent: id, side: 'sell', symbol, qty: pos.qty, why, clientOrderId, price });
    try {
      this.applyOrder(clientOrderId, await b.submit({ symbol, side: 'sell', qty: pos.qty, clientOrderId }));
    } catch (e) {
      if (e.status === 422 || e.network) {
        const o = await b.byClientId(clientOrderId).catch(() => null);
        if (o) return this.applyOrder(clientOrderId, o);
        if (e.network) return;
      }
      delete this.state.pending[clientOrderId];
      this.audit.write({ type: 'live-rejected', agent: id, symbol, clientOrderId, reason: b.redact(e.message) });
    }
  }

  /** Check every open order with Alpaca (by its client_order_id) and book what filled. */
  async pollPending(b) {
    for (const id of Object.keys(this.state.pending)) {
      const o = await b.byClientId(id);
      if (o) this.applyOrder(id, o);
      else if (this.now() - this.state.pending[id].t > 10 * 60_000) {
        this.audit.write({ type: 'live-rejected', clientOrderId: id, reason: 'Alpaca has no such order after 10 minutes' });
        delete this.state.pending[id];
      }
    }
  }

  /** Book an order's fills into its agent's sub-ledger once it is final. */
  applyOrder(clientOrderId, o) {
    const pend = this.state.pending[clientOrderId];
    if (!pend || !o) return;
    const final = ['filled', 'canceled', 'expired', 'rejected', 'done_for_day'].includes(o.status);
    if (!final) return;
    delete this.state.pending[clientOrderId];
    const a = this.agent(pend.agent);
    const qty = o.filledQty;
    const px = o.filledAvgPrice;
    if (!(qty > 0) || !(px > 0)) {
      if (pend.side === 'buy') {
        a.day && (a.day.boughtAud -= pend.aud);
        if (!a.positions[pend.symbol]) delete a.plans[pend.symbol];
      }
      this.audit.write({ type: 'live-unfilled', agent: pend.agent, symbol: pend.symbol, clientOrderId, status: o.status });
      return;
    }
    const usd = qty * px;
    if (pend.side === 'buy') {
      const p = (a.positions[pend.symbol] ??= { qty: 0, costUsd: 0, costAud: 0, day: pend.day });
      p.qty = Math.round((p.qty + qty) * 1e9) / 1e9;
      p.costUsd += usd;
      p.costAud += usd / pend.rate; // AUD at fill-time cost: a later rate move frees nothing
      if (a.day) a.day.boughtAud += usd / pend.rate - pend.aud; // the actual fill, not the estimate
    } else {
      const p = a.positions[pend.symbol];
      if (!p) return;
      const share = Math.min(1, qty / p.qty);
      const costAud = p.costAud * share;
      const rate = this.rate()?.rate ?? pend.rate ?? (p.costUsd / p.costAud);
      const proceedsAud = usd / rate;
      a.realizedAud += proceedsAud - costAud;
      this.state.unsettled.push({ agent: pend.agent, aud: proceedsAud, usd, settles: nextBusinessDay(pend.day) });
      if (p.day === pend.day) this.state.dayTrades.push({ day: pend.day, symbol: pend.symbol, agent: pend.agent });
      p.qty = Math.round((p.qty - qty) * 1e9) / 1e9;
      p.costUsd -= p.costUsd * share;
      p.costAud -= costAud;
      if (p.qty <= 1e-9) {
        delete a.positions[pend.symbol];
        delete a.plans[pend.symbol];
      }
    }
    this.audit.write({ type: 'live-fill', agent: pend.agent, side: pend.side, symbol: pend.symbol, qty, price: px, usd: Number(usd.toFixed(4)), clientOrderId, status: o.status });
    const rateNow = pend.rate || this.rate()?.rate;
    const aud = rateNow ? `A$${(usd / rateNow).toFixed(2)}` : `US$${usd.toFixed(2)}`;
    const pnl = pend.side === 'sell' ? ` (agent's live result so far A$${a.realizedAud.toFixed(2)})` : '';
    this.notify('fill', { title: `${pend.agent} ${pend.side === 'buy' ? 'bought' : 'sold'} ${pend.symbol}`, message: `${pend.agent} ${pend.side === 'buy' ? 'bought' : 'sold'} ${pend.symbol} for ${aud} (live)${pnl}.` });
  }

  async manageExit(b, id, a, symbol, list, fx, day) {
    if (!list.length) return;
    const params = this.params(id);
    const i = list.length - 1;
    let plan = a.plans[symbol];
    if (!plan) {
      const r = atr(list, i) || list[i].c * 0.01;
      const avg = a.positions[symbol].costUsd / a.positions[symbol].qty;
      if (this.strategy(id) === 'v11') {
        const exit = loadModel().exit;
        const trailPct = exit.kind === 'atr' ? (exit.stop * r) / avg : exit.stop;
        plan = a.plans[symbol] = { stop: avg * (1 - trailPct), target: null, trailPct, best: avg, maxHold: exit.maxHold, held: 0, signal: 'adopted' };
      } else plan = a.plans[symbol] = { stop: avg - params.stopAtr * r, target: avg + params.targetAtr * r, held: 0, signal: 'adopted' };
      a.lastBarT[symbol] = list[i].t;
    }
    for (const bar of list.filter((x) => x.t > (a.lastBarT[symbol] ?? 0))) {
      a.lastBarT[symbol] = bar.t;
      plan.held++;
      const closing = nyClock(bar.t).minute >= closeMinute(nyClock(bar.t).day) - FLATTEN_LAST;
      let why;
      if (plan.trailPct) {
        // v11, as trained: a close trailPct under the best close since the buy
        plan.best = Math.max(plan.best ?? bar.c, bar.c);
        plan.stop = plan.best * (1 - plan.trailPct);
        why = bar.c < plan.stop ? 'trailing stop' : plan.held >= plan.maxHold ? 'time' : closing ? 'session close' : null;
      } else {
        why = bar.l <= plan.stop ? 'stop' : bar.h >= plan.target ? 'target' : plan.held >= params.maxHold ? 'time' : closing ? 'session close' : null;
      }
      if (why) return this.sell(b, id, a, symbol, bar.c, why, fx, day);
    }
    const nowClock = nyClock(this.now());
    if (nowClock.minute >= closeMinute(nowClock.day) - FLATTEN_LAST) return this.sell(b, id, a, symbol, list[i].c, 'session close', fx, day);
  }

  async haltAgent(b, id, a, reason, fx, day) {
    a.day.halt = reason;
    this.audit.write({ type: 'live-halt', agent: id, reason });
    this.notify('halt', { message: `${id} halted live: ${reason}. Its live positions are being sold.` });
    for (const s of Object.keys(a.positions)) await this.sell(b, id, a, s, null, `halt: ${reason}`, fx, day);
  }

  /** The broker's positions against the sum of the sub-ledgers. '' when they agree. */
  async reconcile(b) {
    const broker = await b.positions();
    const ours = {};
    for (const a of Object.values(this.state.agents)) for (const [s, p] of Object.entries(a.positions)) ours[s] = (ours[s] ?? 0) + p.qty;
    const open = new Set(Object.values(this.state.pending).map((o) => o.symbol));
    for (const s of new Set([...Object.keys(broker), ...Object.keys(ours)])) {
      if (open.has(s)) continue;
      const have = broker[s]?.qty ?? 0;
      if (broker[s] && broker[s].side && broker[s].side !== 'long') return `${s} is a short position at the broker`;
      if (Math.abs(have - (ours[s] ?? 0)) > 1e-6) return `${s}: the broker holds ${have}, the agents' books ${ours[s] ?? 0}`;
    }
    return '';
  }

  /** Close everything and stop live until the owner resumes (kill switch, integrity, total drawdown, account change). */
  async stopAll(reason, b = this.broker()) {
    if (this.state.stopped) return;
    this.state.stopped = { reason, at: this.now() };
    this.audit.write({ type: 'live-stop', reason });
    this.notify('liveStop', { message: `Live trading stopped: ${reason}. Every live position is being closed. Resume needs your password and code.` });
    this.save();
    if (b) {
      try {
        await b.closeAll();
        this.audit.write({ type: 'live-close-all', ok: true });
      } catch (e) {
        this.audit.write({ type: 'live-close-all', ok: false, reason: b.redact(e.message) });
      }
    }
    // the books are emptied once the broker reports the positions gone (the next reconciliation after resume)
    this.save();
  }

  /** Only the owner (password and code checked by the API): clears a stop. Positions are read back from the broker. */
  async resume() {
    const b = this.broker();
    const broker = b ? await b.positions() : {};
    if (Object.keys(broker).length) throw new Error('The live account still holds positions. Wait for the close-all to fill, then resume.');
    for (const a of Object.values(this.state.agents)) {
      a.positions = {};
      a.plans = {};
    }
    this.state.pending = {};
    this.state.stopped = null;
    this.state.peakTotalAud = null;
    this.audit.write({ type: 'live-resume', by: 'owner' });
    this.save();
  }

  /** Symbols held or ordered live, so the host fetches their bars for the exits. */
  heldSymbols() {
    const out = new Set(Object.values(this.state.pending).map((o) => o.symbol));
    for (const a of Object.values(this.state.agents)) for (const s of Object.keys(a.positions)) out.add(s);
    return [...out];
  }

  /** How many symbols an agent holds or is buying live (the host spreads v11's live buys by this). */
  openCount(id) {
    const a = this.state.agents[id];
    return (a ? Object.keys(a.positions).length : 0) + Object.values(this.state.pending).filter((o) => o.agent === id && o.side === 'buy').length;
  }

  status() {
    const en = this.enabled();
    const fx = this.rate();
    return {
      enabled: !!en,
      enabledAt: en?.enabledAt ?? null,
      account: en?.account ?? null,
      limits: en?.limits ?? null,
      stopped: this.state.stopped,
      allHalt: this.state.allHalt,
      lastError: this.state.lastError,
      broker: this.state.account,
      fx,
      dayTrades: this.state.dayTrades.length,
      pending: Object.entries(this.state.pending).map(([id, o]) => ({ id, ...o })),
      agents: Object.entries(this.state.agents).map(([id, a]) => ({
        id,
        realizedAud: a.realizedAud,
        exposureAud: this.exposureAud(a),
        positions: Object.entries(a.positions).map(([symbol, p]) => ({ symbol, qty: p.qty, costUsd: p.costUsd, costAud: p.costAud })),
        halt: a.day?.halt ?? null,
        sitOut: a.sitOut,
        scale: a.scale,
        boughtTodayAud: a.day?.boughtAud ?? 0,
        buysToday: a.day?.buys ?? 0,
      })),
    };
  }
}

/** Why the account no longer qualifies, or ''. */
export function accountProblem(acct, last4) {
  if (last4 && acct.number.slice(-4) !== last4) return `a different account (…${acct.number.slice(-4)}) than the one enabled (…${last4})`;
  if (acct.currency && acct.currency !== 'USD') return `the account currency is ${acct.currency}`;
  if (acct.blocked) return 'the account is blocked for trading';
  if (acct.pdt) return 'the account is flagged as a pattern day trader';
  if (acct.multiplier && acct.multiplier !== '1') return `the account is a margin account (multiplier ${acct.multiplier})`;
  if (acct.shorting) return 'the account allows shorting (margin)';
  return '';
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, file);
}
