// The engine: runs the Trader against a paper broker and keeps the state the dashboard shows.
//
//   mode 'sim'    (no Alpaca keys): replays historical bars from DATA_DIR/bars/*.csv, or made-up
//                 bars when there are none, through the internal simulator, one bar per tick.
//   mode 'alpaca' (keys in .env):   every minute in US market hours, scans for active symbols,
//                 fetches their 5-minute bars and trades the Alpaca paper account.
//
// Either way it is paper money. There is no live mode in v1.
import path from 'node:path';
import { Trader } from './strategy.mjs';
import { SimBroker } from './broker/sim.mjs';
import { AlpacaBroker } from './broker/alpaca.mjs';
import { syntheticBars } from './data/synthetic.mjs';
import { csvBars } from './data/csv.mjs';
import { DEFAULT_LIMITS, HARD_LIMITS, cleanLimits, isTighter } from './risk.mjs';
import { gameState } from './game.mjs';
import { SIGNALS, backtestSignal, describe } from './signals/index.mjs';
import { marketOpen, nyClock } from './stats.mjs';

export class Engine {
  constructor({ store, dataDir, env = {}, tickMs = 400, onChange = () => {} }) {
    this.store = store;
    this.dataDir = dataDir;
    this.tickMs = tickMs;
    this.onChange = onChange;
    this.mode = env.ALPACA_KEY_ID && env.ALPACA_SECRET_KEY ? 'alpaca' : 'sim';
    this.watchlist = String(env.WATCHLIST || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    this.cash = Number(env.SIM_CASH || 10_000);
    this.running = false;
    this.timer = null;
    this.busy = false;
    this.lastError = '';
    this.curve = []; // [t, equity] for the current day
    this.seen = {}; // alpaca: symbol -> time of the last bar handled
    this.broker = this.mode === 'alpaca' ? new AlpacaBroker({ keyId: env.ALPACA_KEY_ID, secret: env.ALPACA_SECRET_KEY, feed: env.ALPACA_FEED || 'iex' }) : new SimBroker({ cash: this.cash });
    this.trader = this.newTrader();
    if (this.mode === 'sim') this.loadSimData(1);
    this.signalStats = null;
  }

  newTrader() {
    const t = new Trader({ broker: this.broker, limits: this.store.data.limits || DEFAULT_LIMITS, onEvent: (e) => this.event(e) });
    t.guard.killed = this.store.data.killed;
    return t;
  }

  loadSimData(seed) {
    const csv = csvBars(path.join(this.dataDir, 'bars'));
    const from = this.simData ? new Date(this.simEnd + 86_400_000) : new Date(Date.UTC(2026, 0, 5));
    this.simSource = Object.keys(csv).length ? 'csv' : 'synthetic';
    this.simData = Object.keys(csv).length ? csv : syntheticBars({ days: 5, seed, from, barMinutes: 5 });
    this.simSeed = seed;
    this.steps = [];
    for (const [s, bars] of Object.entries(this.simData)) bars.forEach((b, i) => this.steps.push([b.t, s, i]));
    this.steps.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : 1));
    this.stepAt = 0;
    this.simEnd = this.steps.length ? this.steps[this.steps.length - 1][0] : Date.now();
  }

  event(e) {
    const entry = { ...e, at: Date.now() };
    this.store.addTape(entry);
    this.changed();
  }

  changed() {
    this.onChange();
  }

  // ── Running ─────────────────────────────────────────────────

  start() {
    if (this.running) return;
    this.running = true;
    const every = this.mode === 'sim' ? this.tickMs : 60_000;
    const run = async () => {
      if (!this.running) return;
      if (!this.busy) {
        this.busy = true;
        try {
          await (this.mode === 'sim' ? this.simStep() : this.alpacaStep());
          this.lastError = '';
        } catch (e) {
          this.lastError = e.message;
          console.error('engine:', e.message);
        }
        this.busy = false;
      }
      this.timer = setTimeout(run, every);
      this.timer.unref?.();
    };
    run();
    this.changed();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.changed();
  }

  async afterBar(t) {
    const day = this.trader.guard.day;
    // A finished day moves from the Trader into the store (for the game and the history).
    while (this.trader.days.length) this.store.data.days.push(this.trader.days.shift());
    if (this.store.data.days.length > 400) this.store.data.days.splice(0, this.store.data.days.length - 400);
    if (this.curveDay !== day?.key) {
      this.curve = [];
      this.curveDay = day?.key;
      this.applyPending(day?.key);
    }
    const acct = await this.trader.account();
    this.curve.push([t, acct.equity]);
    if (this.curve.length > 800) this.curve.splice(0, this.curve.length - 800);
    this.store.touch();
  }

  async simStep() {
    if (this.stepAt >= this.steps.length) {
      if (this.simSource === 'csv') return this.stop();
      this.loadSimData(this.simSeed + 1); // made-up data: keep going with a fresh week
    }
    // One timestamp per tick: every symbol's bar at that time.
    const t = this.steps[this.stepAt][0];
    while (this.stepAt < this.steps.length && this.steps[this.stepAt][0] === t) {
      const [, s, i] = this.steps[this.stepAt++];
      await this.trader.onBar(s, this.simData[s], i);
    }
    await this.afterBar(t);
    this.changed();
  }

  async alpacaStep() {
    const now = Date.now();
    if (!marketOpen(now)) return;
    await this.broker.refresh();
    const scanned = await this.broker.scan().catch(() => []);
    const held = Object.keys((await this.broker.account()).positions);
    const symbols = [...new Set([...this.watchlist, ...held, ...scanned])].slice(0, 40);
    if (!symbols.length) return;
    const bars = await this.broker.bars(symbols, { timeframe: '5Min', start: now - 4 * 86_400_000 });
    for (const [s, list] of Object.entries(bars)) {
      // Only finished bars: the newest one is still forming until its 5 minutes are up.
      const done = list.filter((b) => b.t + 5 * 60_000 <= now);
      const i = done.length - 1;
      if (i < 0 || done[i].t <= (this.seen[s] || 0)) continue;
      this.seen[s] = done[i].t;
      await this.trader.onBar(s, done, i);
    }
    await this.afterBar(now);
    this.changed();
  }

  // ── Kill switch and limits ──────────────────────────────────

  async kill(reason = 'Kill switch pressed') {
    this.trader.guard.killed = true;
    this.store.data.killed = true;
    this.store.data.killReason = reason;
    this.store.data.kills++;
    this.store.save();
    const t = Date.now();
    try {
      if (this.broker.flatten && this.mode === 'alpaca') await this.broker.flatten();
      else await this.trader.flattenAll(this.lastBarTime() ?? t, 'kill switch');
    } catch (e) {
      this.lastError = `Kill switch: trading stopped, but closing positions failed: ${e.message}`;
    }
    this.event({ type: 'kill', t, reason });
    return this.snapshot();
  }

  resume() {
    if (!this.store.data.killed) return this.snapshot();
    this.trader.guard.killed = false;
    this.store.data.killed = false;
    this.store.data.killReason = '';
    this.store.data.overrides.push({ day: this.trader.guard.day?.key || nyClock(Date.now()).day, kind: 'resume' });
    this.store.save();
    this.event({ type: 'resume', t: Date.now() });
    return this.snapshot();
  }

  /** Tighter limits apply now. Looser ones wait for the next trading day, and break the streak. */
  setLimits(input) {
    const current = this.trader.guard.limits;
    const next = cleanLimits(input, current);
    if (isTighter(current, next)) {
      this.trader.guard.limits = next;
      this.store.data.limits = next;
      this.store.data.pendingLimits = null;
    } else {
      this.store.data.pendingLimits = { limits: next, after: this.trader.guard.day?.key || '' };
      this.store.data.overrides.push({ day: this.trader.guard.day?.key || nyClock(Date.now()).day, kind: 'loosen' });
    }
    this.store.save();
    this.changed();
    return this.snapshot();
  }

  applyPending(dayKey) {
    const p = this.store.data.pendingLimits;
    if (!p || !dayKey || dayKey === p.after) return;
    this.trader.guard.limits = p.limits;
    this.store.data.limits = p.limits;
    this.store.data.pendingLimits = null;
    this.store.save();
  }

  lastBarTime() {
    return this.mode === 'sim' && this.stepAt ? this.steps[this.stepAt - 1][0] : null;
  }

  // ── What the dashboard shows ────────────────────────────────

  signals() {
    if (!this.signalStats) {
      // Measured on the replay data in sim mode, and on a fixed made-up set otherwise, until
      // the owner runs a backtest on real history.
      const data = this.mode === 'sim' ? this.simData : syntheticBars({ days: 20, barMinutes: 5 });
      this.signalStats = { source: this.mode === 'sim' ? this.simSource : 'synthetic', stats: Object.fromEntries(SIGNALS.map((s) => [s.id, backtestSignal(s, data)])) };
    }
    return { source: this.signalStats.source, list: SIGNALS.map((s) => ({ ...describe(s), stats: this.signalStats.stats[s.id] })) };
  }

  async snapshot() {
    const acct = await this.trader.account();
    const g = this.trader.guard;
    const prices = this.broker.prices || {};
    const positions = Object.entries(acct.positions).map(([symbol, p]) => {
      const price = prices[symbol] ?? p.avg;
      const plan = this.trader.plans[symbol];
      return { symbol, qty: p.qty, avg: p.avg, price, value: p.qty * price, pnl: (price - p.avg) * p.qty, stop: plan?.stop, target: plan?.target, signal: plan?.signal };
    });
    const d = this.store.data;
    const clockT = this.lastBarTime() ?? Date.now();
    return {
      mode: this.mode,
      broker: this.broker.name,
      paper: true,
      simSource: this.mode === 'sim' ? this.simSource : undefined,
      running: this.running,
      lastError: this.lastError,
      clock: clockT,
      marketOpen: marketOpen(clockT),
      killed: d.killed,
      killReason: d.killReason,
      account: { cash: acct.cash, equity: acct.equity },
      day: g.day ? { key: g.day.key, pnl: g.dayPnl(acct.equity), buys: g.day.buys, halted: g.day.halted, haltReason: g.day.haltReason } : null,
      limits: g.limits,
      hardLimits: HARD_LIMITS,
      pendingLimits: d.pendingLimits,
      positions,
      radar: Object.entries(this.trader.radar).map(([symbol, r]) => ({ symbol, ...r })),
      tape: d.tape.slice(-80).reverse(),
      curve: this.curve,
      game: gameState({ days: d.days, overrides: d.overrides, kills: d.kills, maxTrades: g.limits.maxTradesPerDay }),
    };
  }
}
