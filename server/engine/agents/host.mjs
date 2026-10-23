// The host for the paper agents (docs/DESIGN-autonomous-agents.md, stage 1 on paper). PAPER ONLY:
// every agent trades its own SimBroker sandbox; there is no broker order call anywhere here, and the
// live gate stays closed (nothing in this file can open it).
//
// Once a minute in US market hours (tick):
//   1. bars for the watchlist (data/watchlist.json, at most 40 symbols) and anything held, from Alpaca
//      market data with the owner's paper keys;
//   2. exits, run here for every agent's positions: stop, target, time, session close (agents never
//      manage exits, so a crashed agent's positions are still closed);
//   3. halts: an agent's daily loss, its drawdown, the pool's daily loss;
//   4. each running agent (a child process, agent-runner.mjs) gets the bars and answers with buy
//      proposals; each is sized here and passes the RiskGuard and gate check 17 (AGENT_CAPITAL: the
//      watchlist, the symbol lock, the agent's own cash and allocation) before it fills on paper;
//   5. reconciliation: no negative cash, allocations within the pool, no symbol held by two agents.
//      A failure is an integrity halt: everything stops until the owner resumes.
//
// Halts are automatic (the owner: "completely automated"):
//   - daily loss: the agent flattens and stops buying for the rest of the day; it resumes next day;
//   - drawdown (equity this far below its best): it flattens, sits out the rest of that day and the
//     whole next trading day, then resumes at half size with its best equity reset; after 5 trading
//     days without another drawdown halt it is back to full size;
//   - pool daily loss: every agent stops buying for the rest of the day;
//   - 3 malformed messages in a row, or 3 crashes in an hour: that agent stops for the day.
// The owner's KILL (button, API, or a DATA_DIR/KILL file) and an integrity halt are safety switches,
// not halts: everything is flattened and stays stopped until the owner resumes.
//
// Every proposal, decision, fill, halt and kill goes to the audit log (audit.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SandboxManager } from './sandbox.mjs';
import { KnowledgeStore } from './knowledge.mjs';
import { AuditLog } from './audit.mjs';
import { Journal } from './journal.mjs';
import { checkAgentMessage } from './ipc.mjs';
import { AGENT_IDS, DEFAULT_SETTINGS, MAX_AGENTS, cleanSettings, limitsFor } from './profile.mjs';
import { STOCK, agentCapital, positionSize } from '../risk.mjs';
import { atr, nyClock, marketOpen, OPEN_MIN, CLOSE_MIN } from '../stats.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ENGINE_DIR = path.resolve(here, '..');

export const TIMING = Object.freeze({
  noEntryFirst: 15, // minutes after the open
  noEntryLast: 30, // minutes before the close
  flattenLast: 5, // minutes before the close
  answerMs: 15_000, // an agent that hasn't answered by then is skipped this tick
  barsPerSymbol: 80, // bars sent to an agent per symbol
  historyMs: 4 * 86_400_000,
});
export const SIT_OUT_DAYS = 2; // the halted day itself plus the next trading day
export const CLEAN_DAYS_TO_FULL = 5;
export const HALF = 0.5;

/**
 * How an agent child is started: Node's permission model lets it read only the engine's code (extra
 * read paths only for tests), write nothing, start no process; its environment is an allow-list with
 * no key or token in it.
 */
export function childOptions(id, extraRead = []) {
  return {
    execArgv: ['--permission', ...[ENGINE_DIR, ...extraRead].map((p) => `--allow-fs-read=${p}`), '--max-old-space-size=128'],
    env: { AGENT_ID: id, TZ: 'America/New_York', NODE_ENV: 'production' },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    serialization: 'json',
  };
}

export function spawnAgent(id) {
  return fork(path.join(here, 'agent-runner.mjs'), [], childOptions(id));
}

const blankAgent = () => ({ peak: null, sitOut: 0, scale: 1, cleanDays: 0, ddHalts: 0, dayHalt: null, crashes: [], malformed: 0, plans: {}, lastBarT: {}, lastProposals: [], lastDecision: null });

export class AgentHost {
  /**
   * getUniverse(): the watchlist symbols. getData(): an AlpacaData client, or null without keys.
   * getFx(): today's AUD → USD rate { rate, date, source } (data/fx.mjs), or null; refreshFx() updates it.
   * spawn(id): a child process (tests can pass a fake).
   */
  constructor({ dataDir, getUniverse = () => [], getData = () => null, getFx = () => null, refreshFx = async () => {}, onDayEnd = () => {}, now = Date.now, spawn = spawnAgent, log = console }) {
    Object.assign(this, { dataDir, getUniverse, getData, getFx, refreshFx, onDayEnd, now, spawn, log });
    this.settingsFile = path.join(dataDir, 'agents-settings.json');
    this.stateFile = path.join(dataDir, 'agents-host.json');
    this.killFile = path.join(dataDir, 'KILL');
    this.settings = cleanSettings(readJson(this.settingsFile) || {}, DEFAULT_SETTINGS);
    this.state = { killed: false, killReason: '', killedAt: null, integrity: null, day: null, closedDay: null, poolPause: null, paused: null, lastTick: null, lastError: '', agents: {}, ...(readJson(this.stateFile) || {}) };
    for (const id of AGENT_IDS) this.state.agents[id] = { ...blankAgent(), ...(this.state.agents[id] || {}) };
    this.audit = new AuditLog({ dir: dataDir, now });
    this.knowledge = new KnowledgeStore({ dir: path.join(dataDir, 'knowledge') });
    this.manager = this.openSandboxes();
    for (const id of AGENT_IDS) this.applyLimits(id);
    this.children = new Map(); // id -> { proc, waiting }
    this.timer = null;
    this.busy = null;
    this.barCache = {}; // symbol -> recent 5-minute bars, oldest first
    this.refusedAt = new Map();
    this.consideredAt = new Map();
    this.journal = new Journal({ dataDir, now });
  }

  // ── sandboxes ──────────────────────────────────────────────

  /**
   * The paper money per agent in US dollars: the owner's AUD amount × today's rate, to the cent. The
   * AUD amount is the cap; the rate only moves the US-dollar figure. null without a rate.
   */
  usdPerAgent() {
    const fx = this.getFx();
    return fx?.rate > 0 ? Math.floor(this.settings.paperPerAgent * fx.rate * 100) / 100 : null;
  }

  openSandboxes() {
    // without a rate yet, the books open at the AUD figure and are set right at the first trading day
    const first = this.usdPerAgent() ?? this.settings.paperPerAgent;
    const pool = first * MAX_AGENTS;
    const m = new SandboxManager({ rootDir: this.dataDir, pool, fractional: true, slippageBps: 5 });
    if (fs.existsSync(m.allocationsFile)) m.load();
    for (const id of AGENT_IDS) {
      if (!m.sandboxes.has(id) && !m.broken.has(id)) {
        if (fs.existsSync(path.join(this.dataDir, 'agents', id))) {
          // a folder without an allocation entry (a crash between the two writes): set it aside
          fs.renameSync(path.join(this.dataDir, 'agents', id), path.join(this.dataDir, 'agents', `${id}.aside-${Date.now()}`));
        }
        if (m.unallocated() < first) m.setPool(m.allocated() + first);
        m.create(id, first);
      }
    }
    return m;
  }

  sandbox(id) {
    return this.manager.sandboxes.get(id) || null;
  }

  running() {
    return AGENT_IDS.slice(0, this.settings.agentsAtOnce).filter((id) => this.sandbox(id));
  }

  /** Which agent holds each symbol (the symbol lock). */
  holders() {
    const out = {};
    for (const [id, sb] of this.manager.sandboxes) for (const s of Object.keys(sb.broker.positions)) out[s] ??= id;
    return out;
  }

  // ── settings, kill ─────────────────────────────────────────

  /** New settings from the owner. A new paper amount applies at the next trading day (when flat). */
  updateSettings(input) {
    const merged = { ...this.settings, ...input, preset: { ...this.settings.preset, ...(input?.preset || {}) }, params: { ...this.settings.params } };
    for (const id of AGENT_IDS) merged.params[id] = { ...this.settings.params[id], ...(input?.params?.[id] || {}) };
    this.settings = cleanSettings(merged, this.settings);
    writeJson(this.settingsFile, this.settings);
    this.audit.write({ type: 'settings', settings: this.settings });
    for (const id of this.running()) this.applyLimits(id);
    for (const [id] of this.children) if (!this.running().includes(id)) this.stopChild(id);
    return this.status();
  }

  applyLimits(id) {
    const sb = this.sandbox(id);
    if (sb) sb.setLimits(limitsFor(sb.allocation, this.settings.preset, this.state.agents[id].scale));
  }

  /** The owner's kill switch: flatten everything, stop every agent, until the owner resumes. */
  kill(reason = 'Kill switch pressed') {
    if (!this.state.killed) {
      this.state.killed = true;
      this.state.killReason = reason;
      this.state.killedAt = this.now();
      this.flattenAll('kill switch');
      for (const id of [...this.children.keys()]) this.stopChild(id);
      this.audit.write({ type: 'kill', reason });
      this.save();
    }
    return this.status();
  }

  /** Only the owner (Settings, this computer): clears the kill switch and an integrity halt. */
  /**
   * Stop new buys (exits and halts keep running): from the Frost AI connector's "stop" or Settings.
   * Not the kill switch: nothing is sold, and unpauseBuying() undoes it.
   */
  pauseBuying(by = 'owner') {
    if (!this.state.paused) {
      this.state.paused = { by, at: this.now() };
      this.audit.write({ type: 'pause', by });
      this.save();
    }
    return this.status();
  }

  /** Undo pauseBuying(). It does not clear the kill switch or an integrity halt: only resume() does, from FrostTrader's own screen. */
  unpauseBuying(by = 'owner') {
    if (this.state.paused) {
      this.state.paused = null;
      this.audit.write({ type: 'unpause', by });
      this.save();
    }
    return this.status();
  }

  resume() {
    fs.rmSync(this.killFile, { force: true });
    const was = { killed: this.state.killed, integrity: this.state.integrity };
    this.state.killed = false;
    this.state.killReason = '';
    this.state.integrity = null;
    this.audit.write({ type: 'resume', was });
    this.save();
    return this.status();
  }

  flattenAll(why) {
    for (const [id, sb] of this.manager.sandboxes) this.flatten(id, sb, why);
  }

  flatten(id, sb, why) {
    for (const [symbol, p] of Object.entries(sb.broker.positions)) this.sell(id, sb, symbol, sb.broker.prices[symbol] ?? p.avg, this.now(), why);
    if (this.state.agents[id]) this.state.agents[id].plans = {};
  }

  /** What the agent looked at and passed on: one line per symbol and reason, at most every 30 minutes. */
  logConsidered(id, list) {
    const entry = this.settings.params[id].entryScore;
    for (const c of list) {
      const key = `${id}|${c.symbol}|${c.why}|${c.score == null ? '' : Math.round(c.score * 10)}`;
      if (this.now() - (this.consideredAt.get(key) ?? 0) < 30 * 60_000) continue;
      this.consideredAt.set(key, this.now());
      this.journal.decide(id, { kind: 'considered', symbol: c.symbol, why: c.why, signal: c.signal, score: c.score, entry });
    }
    if (this.consideredAt.size > 5000) this.consideredAt.clear();
  }

  // ── children ───────────────────────────────────────────────

  ensureChild(id) {
    if (this.children.has(id)) return this.children.get(id);
    const proc = this.spawn(id);
    const c = { proc, waiting: null };
    proc.on('message', (raw) => this.onMessage(id, raw));
    proc.on('exit', (code) => this.onExit(id, code));
    proc.on('error', () => {});
    this.children.set(id, c);
    return c;
  }

  stopChild(id) {
    const c = this.children.get(id);
    if (!c) return;
    this.children.delete(id);
    c.waiting?.resolve(null);
    try {
      c.proc.kill();
    } catch {
      /* already gone */
    }
  }

  onMessage(id, raw) {
    const a = this.state.agents[id];
    const v = checkAgentMessage(raw);
    if (!v.ok) {
      a.malformed++;
      this.audit.write({ type: 'malformed', agent: id, reason: v.reason, inARow: a.malformed });
      if (a.malformed >= 3) this.haltForDay(id, '3 malformed messages in a row');
      return;
    }
    a.malformed = 0;
    if (v.msg.type === 'log') this.audit.write({ type: 'agent-log', agent: id, text: v.msg.text });
    if (v.msg.type === 'proposals') {
      const c = this.children.get(id);
      if (c?.waiting && c.waiting.t === v.msg.t) {
        c.waiting.resolve(v.msg);
        c.waiting = null;
      }
    }
  }

  onExit(id, code) {
    const c = this.children.get(id);
    if (!c) return; // stopped on purpose
    this.children.delete(id);
    c.waiting?.resolve(null);
    const a = this.state.agents[id];
    const hour = this.now() - 3_600_000;
    a.crashes = [...a.crashes.filter((t) => t > hour), this.now()];
    this.audit.write({ type: 'crash', agent: id, code, inLastHour: a.crashes.length });
    if (a.crashes.length >= 3) this.haltForDay(id, '3 crashes in an hour');
    this.save();
  }

  /** Send a tick to one agent and wait for its proposals (null: no answer in time). */
  ask(id, msg) {
    const c = this.ensureChild(id);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (c.waiting?.t === msg.t) c.waiting = null;
        resolve(null);
      }, TIMING.answerMs);
      timer.unref?.();
      c.waiting = { t: msg.t, resolve: (v) => (clearTimeout(timer), resolve(v)) };
      try {
        c.proc.send(msg);
      } catch {
        c.waiting = null;
        clearTimeout(timer);
        resolve(null);
      }
    });
  }

  // ── halts ──────────────────────────────────────────────────

  haltForDay(id, reason) {
    const a = this.state.agents[id];
    if (a.dayHalt) return;
    a.dayHalt = { day: this.state.day, reason, at: this.now() };
    const sb = this.sandbox(id);
    if (sb) this.flatten(id, sb, `halt: ${reason}`);
    this.stopChild(id);
    this.audit.write({ type: 'halt', agent: id, kind: 'day', reason });
    this.journal.decide(id, { kind: 'halt', reason });
  }

  drawdownHalt(id, equity) {
    const a = this.state.agents[id];
    a.ddHalts++;
    a.sitOut = SIT_OUT_DAYS;
    a.cleanDays = 0;
    this.haltForDay(id, `drawdown: equity ${equity.toFixed(2)} is ${(this.settings.preset.drawdownPct * 100).toFixed(0)} % or more below its best (${a.peak.toFixed(2)})`);
    this.audit.write({ type: 'halt', agent: id, kind: 'drawdown', equity, peak: a.peak, resumes: 'after the next trading day, at half size' });
  }

  integrityHalt(reason) {
    if (this.state.integrity) return;
    this.state.integrity = { reason, at: this.now() };
    this.flattenAll('integrity halt');
    for (const id of [...this.children.keys()]) this.stopChild(id);
    this.audit.write({ type: 'integrity-halt', reason });
  }

  /** Reconcile the books. Returns the problem, or ''. */
  reconcile() {
    const seen = {};
    for (const [id, sb] of this.manager.sandboxes) {
      if (!(sb.broker.cash >= -1e-6)) return `${id} has negative cash`;
      for (const [s, p] of Object.entries(sb.broker.positions)) {
        if (!(p.qty > 0)) return `${id} holds a non-positive quantity of ${s}`;
        if (seen[s]) return `${s} is held by both ${seen[s]} and ${id}`;
        seen[s] = id;
      }
    }
    if (this.manager.allocated() > this.manager.pool + 1e-6) return 'allocations are more than the pool';
    return '';
  }

  // ── the trading day ────────────────────────────────────────

  startDay(day) {
    this.state.day = day;
    this.state.poolPause = null;
    const per = this.usdPerAgent();
    if (per == null) return; // no rate: the tick has already said so and trades nothing
    if (this.manager.pool !== per * MAX_AGENTS && this.manager.allocated() <= per * MAX_AGENTS) this.manager.setPool(per * MAX_AGENTS);
    for (const id of AGENT_IDS) {
      const a = this.state.agents[id];
      const sb = this.sandbox(id);
      if (!sb) continue;
      if (sb.allocation !== per) {
        if (per > sb.allocation && this.manager.unallocated() < per - sb.allocation) this.manager.setPool(this.manager.allocated() + per - sb.allocation);
        if (sb.reallocate(per)) {
          this.manager.saveAllocations();
          this.audit.write({ type: 'allocation', agent: id, allocation: per, aud: this.settings.paperPerAgent, rate: this.getFx()?.rate, rateDate: this.getFx()?.date });
        }
      }
      if (a.dayHalt && a.dayHalt.day !== day) a.dayHalt = null;
      if (a.sitOut > 0) {
        a.sitOut--;
        if (a.sitOut === 0) {
          a.scale = HALF;
          a.peak = sb.broker.equity();
          this.audit.write({ type: 'resume', agent: id, after: 'drawdown halt', scale: HALF });
          this.journal.decide(id, { kind: 'resume', reason: 'after a drawdown halt and a day out, at half size' });
        }
      } else if (a.scale < 1) {
        a.cleanDays++;
        if (a.cleanDays >= CLEAN_DAYS_TO_FULL) {
          a.scale = 1;
          this.audit.write({ type: 'scale', agent: id, scale: 1, reason: `${CLEAN_DAYS_TO_FULL} trading days without a drawdown halt` });
        }
      }
      a.peak ??= sb.broker.equity();
      a.crashes = [];
      a.malformed = 0;
      sb.startDay(day);
      this.applyLimits(id);
    }
    this.audit.write({ type: 'day', day });
  }

  /** After the close: each agent's per-signal round trips go to the knowledge store (adoption is off). */
  endDay(day) {
    this.state.closedDay = day;
    for (const [id, sb] of this.manager.sandboxes) {
      const today = sb.broker.fills.filter((f) => nyClock(f.t).day === day);
      const bySignal = {};
      for (const f of today) {
        const m = /^entry: ([a-z_]+)/.exec(f.why || '');
        if (m && f.side === 'buy') (bySignal[m[1]] ??= { buys: 0 }).buys++;
      }
      const sells = today.filter((f) => f.side === 'sell');
      if (!sells.length) continue;
      const pnl = sells.reduce((s, f) => s + f.pnl, 0);
      try {
        this.knowledge.publish(id, {
          kind: 'signal-note',
          claim: `${day}: ${sells.length} paper exits, P&L ${pnl.toFixed(2)} on $${sb.allocation} (signals: ${Object.keys(bySignal).join(', ') || 'none'})`,
          evidence: { day, exits: sells.length, pnl, bySignal, split: 'forward' },
          provenance: { source: 'paper', params: this.settings.params[id] },
        });
      } catch (e) {
        this.log.warn?.(`knowledge: ${e.message}`);
      }
    }
    this.audit.write({ type: 'day-end', day });
    this.journal.prune(AGENT_IDS);
    // the nightly research run (server/engine/research/nightly.mjs), after the books are closed
    try {
      void this.onDayEnd(day);
    } catch (e) {
      this.log.warn?.(`research: ${e.message}`);
    }
  }

  /** One pass. Returns status(). Never throws. */
  tick() {
    this.busy ||= this.#tick()
      .catch((e) => {
        this.state.lastError = String(e?.message || e);
        this.log.warn?.(`agents: ${this.state.lastError}`);
      })
      .finally(() => {
        this.busy = null;
        this.save();
      });
    return this.busy.then(() => this.status());
  }

  async #tick() {
    const now = this.now();
    if (fs.existsSync(this.killFile) && !this.state.killed) this.kill('KILL file found in the data folder');
    if (this.state.killed || this.state.integrity) return;
    const clock = nyClock(now);
    if (!marketOpen(now)) {
      if (this.state.day && this.state.closedDay !== this.state.day && (clock.day !== this.state.day || clock.minute >= CLOSE_MIN)) this.endDay(this.state.day);
      for (const id of [...this.children.keys()]) this.stopChild(id);
      return;
    }
    await this.refreshFx();
    if (!this.getFx()) {
      this.state.lastError = 'No AUD → US dollar rate yet (or it is over 5 days old): the agents wait.';
      return;
    }
    if (this.state.day !== clock.day) this.startDay(clock.day);
    // after a restart in the middle of a day the books start the day again from their equity now
    for (const [id, sb] of this.manager.sandboxes) {
      if (sb.guard.day?.key !== clock.day) {
        sb.startDay(clock.day);
        this.applyLimits(id);
      }
    }
    const data = this.getData();
    if (!data) {
      this.state.lastError = 'No Alpaca paper keys yet: the agents wait for market data (Settings → Alpaca paper keys).';
      return;
    }
    const universe = new Set(this.getUniverse().filter((s) => STOCK.test(s)).slice(0, 40));
    const held = Object.keys(this.holders());
    const symbols = [...new Set([...universe, ...held])];
    if (!symbols.length) {
      this.state.lastError = 'The watchlist is empty: add a Finviz screener in Settings.';
      return;
    }
    const before = this.reconcile();
    if (before) return this.integrityHalt(before);
    const bars = await this.fetchBars(data, symbols, now);
    this.state.lastError = '';
    this.state.lastTick = now;

    // exits and marks, for every agent (running or not: no position is left unmanaged)
    for (const [id, sb] of this.manager.sandboxes) {
      const a = this.state.agents[id];
      for (const [symbol, list] of Object.entries(bars)) if (list.length) sb.mark(symbol, list[list.length - 1].c);
      for (const symbol of Object.keys(sb.broker.positions)) this.manageExit(id, sb, symbol, bars[symbol] || []);
      // halts
      const eq = sb.broker.equity();
      if (!a.dayHalt && sb.guard.watch(eq)) this.haltForDay(id, sb.guard.day.haltReason);
      a.peak = Math.max(a.peak ?? eq, eq);
      if (!a.dayHalt && a.sitOut === 0 && eq <= a.peak * (1 - this.settings.preset.drawdownPct) + 1e-9) this.drawdownHalt(id, eq);
    }
    const dayPnl = [...this.manager.sandboxes.values()].reduce((s, sb) => s + sb.guard.dayPnl(sb.broker.equity()), 0);
    const poolLimit = this.manager.allocated() * this.settings.preset.poolDailyLossPct;
    if (!this.state.poolPause && dayPnl <= -poolLimit) {
      this.state.poolPause = { day: clock.day, reason: `pool daily loss ${dayPnl.toFixed(2)} reached -${poolLimit.toFixed(2)}` };
      this.audit.write({ type: 'halt', kind: 'pool', reason: this.state.poolPause.reason });
    }

    // entries
    const inWindow = clock.minute >= OPEN_MIN + TIMING.noEntryFirst && clock.minute < CLOSE_MIN - TIMING.noEntryLast;
    if (inWindow && !this.state.poolPause && !this.state.paused) {
      const ids = this.running().filter((id) => !this.state.agents[id].dayHalt && this.state.agents[id].sitOut === 0);
      const sent = {};
      for (const s of universe) if (bars[s]?.length) sent[s] = bars[s].slice(-TIMING.barsPerSymbol);
      const answers = await Promise.all(
        ids.map(async (id) => [id, await this.ask(id, { type: 'tick', t: now, params: this.settings.params[id], bars: sent, held: Object.keys(this.holders()) })]),
      );
      for (const [id, ans] of answers) {
        const items = ans?.items || [];
        this.state.agents[id].lastProposals = items;
        this.logConsidered(id, ans?.considered || []);
        for (const p of items || []) this.enter(id, p, bars[p.symbol] || [], universe);
      }
    }

    const problem = this.reconcile();
    if (problem) this.integrityHalt(problem);
  }

  /**
   * Bars for the symbols: the first time 4 days of history, then only what is new (from 10 minutes
   * before the newest bar held), merged by time and kept to the last 400 per symbol. Only finished
   * bars are returned: a 5-minute bar is final once its start is 5 minutes in the past.
   */
  async fetchBars(data, symbols, now) {
    const fresh = symbols.filter((s) => !this.barCache[s]?.length);
    const known = symbols.filter((s) => this.barCache[s]?.length);
    const got = {};
    const add = (more) => {
      for (const [s, list] of Object.entries(more || {})) (got[s] ||= []).push(...list);
    };
    if (fresh.length) add(await data.bars(fresh, { timeframe: '5Min', start: now - TIMING.historyMs }));
    if (known.length) add(await data.bars(known, { timeframe: '5Min', start: Math.min(...known.map((s) => this.barCache[s].at(-1).t)) - 10 * 60_000 }));
    for (const [s, list] of Object.entries(got)) {
      const byT = new Map((this.barCache[s] || []).map((b) => [b.t, b]));
      for (const b of list) byT.set(b.t, b);
      this.barCache[s] = [...byT.values()].sort((a, b) => a.t - b.t).slice(-400);
    }
    for (const s of Object.keys(this.barCache)) if (!symbols.includes(s)) delete this.barCache[s];
    return Object.fromEntries(symbols.map((s) => [s, (this.barCache[s] || []).filter((b) => b.t + 5 * 60_000 <= now)]));
  }

  manageExit(id, sb, symbol, list) {
    const a = this.state.agents[id];
    const pos = sb.broker.positions[symbol];
    if (!pos || !list.length) return;
    const params = this.settings.params[id];
    const i = list.length - 1;
    let plan = a.plans[symbol];
    if (!plan) {
      const r = atr(list, i) || pos.avg * 0.01;
      plan = a.plans[symbol] = { entry: pos.avg, stop: pos.avg - params.stopAtr * r, target: pos.avg + params.targetAtr * r, held: 0, signal: 'adopted' };
      // a position with no plan (a restart): only bars from now on count
      a.lastBarT[symbol] = Math.max(a.lastBarT[symbol] ?? 0, list[i].t);
    }
    const fresh = list.filter((b) => b.t > (a.lastBarT[symbol] ?? 0));
    for (const b of fresh) {
      a.lastBarT[symbol] = b.t;
      plan.held++;
      const minute = nyClock(b.t).minute;
      let why = null;
      let price = b.c;
      if (b.l <= plan.stop) [why, price] = ['stop', Math.min(b.o, plan.stop)];
      else if (b.h >= plan.target) [why, price] = ['target', Math.max(b.o, plan.target)];
      else if (plan.held >= params.maxHold) why = 'time';
      else if (minute >= CLOSE_MIN - TIMING.flattenLast) why = 'session close';
      if (why) return this.sell(id, sb, symbol, price, b.t, why);
    }
    // nothing new but the session is ending
    if (nyClock(this.now()).minute >= CLOSE_MIN - TIMING.flattenLast) this.sell(id, sb, symbol, list[i].c, this.now(), 'session close');
  }

  sell(id, sb, symbol, price, t, why) {
    const qty = sb.broker.positions[symbol]?.qty;
    if (!qty) return;
    const plan = this.state.agents[id].plans[symbol];
    const avg = sb.broker.positions[symbol].avg;
    const r = sb.submit({ symbol, side: 'sell', qty, price, t, why });
    delete this.state.agents[id].plans[symbol];
    this.audit.write({ type: r.ok ? 'fill' : 'refused', agent: id, side: 'sell', symbol, qty, why, ...(r.ok ? { price: r.fill.price, pnl: r.fill.pnl } : { reason: r.reason }) });
    if (!r.ok) return;
    const rate = this.getFx()?.rate ?? null;
    const pnlAud = rate ? r.fill.pnl / rate : null;
    this.journal.decide(id, { kind: 'sold', symbol, qty, price: r.fill.price, why, pnlUsd: r.fill.pnl, rate });
    this.journal.trade(id, {
      day: nyClock(t).day,
      symbol,
      signal: plan?.signal ?? 'adopted',
      qty,
      entryT: plan?.entryT ?? null,
      entry: plan?.entry ?? avg,
      exitT: t,
      exit: why,
      exitPrice: r.fill.price,
      pnlUsd: r.fill.pnl,
      pnlAud,
      rate,
    });
  }

  enter(id, p, list, universe) {
    const sb = this.sandbox(id);
    const a = this.state.agents[id];
    const decide = (ok, reason, extra = {}) => {
      a.lastDecision = { at: this.now(), symbol: p.symbol, ok, reason };
      // the same refusal for the same agent and symbol is written once every 30 minutes, not every tick
      const key = `${id}|${p.symbol}|${reason}`;
      if (!ok && this.now() - (this.refusedAt.get(key) ?? 0) < 30 * 60_000) return;
      if (!ok) this.refusedAt.set(key, this.now());
      if (!ok) this.journal.decide(id, { kind: 'refused', symbol: p.symbol, signal: p.signal, score: p.score, reason });
      this.audit.write({ type: ok ? 'fill' : 'refused', agent: id, side: 'buy', symbol: p.symbol, signal: p.signal, score: p.score, reason, ...extra });
    };
    if (!sb || a.dayHalt || this.state.killed) return;
    if (!universe.has(p.symbol)) return decide(false, `AGENT_CAPITAL: ${p.symbol} is not on the watchlist`);
    if (p.score < this.settings.params[id].entryScore) return decide(false, 'score under the agent\'s entry score');
    if (list.length < 20) return decide(false, 'not enough bars');
    const b = list[list.length - 1];
    const r = atr(list, list.length - 1);
    if (!(r > 0)) return decide(false, 'no volatility measure (ATR)');
    const params = this.settings.params[id];
    const stop = b.c - params.stopAtr * r;
    const acct = sb.broker.account();
    const qty = positionSize({ equity: acct.equity, cash: acct.cash, price: b.c, stop, limits: sb.guard.limits, fractional: true });
    if (!(qty > 0)) return decide(false, 'size rounds to nothing');
    const order = { symbol: p.symbol, side: 'buy', qty, price: b.c, t: b.t };
    const gate = agentCapital({ agentId: id, order, cash: acct.cash, exposure: sb.exposure(), allocation: sb.allocation, universe, lockedBy: this.holders()[p.symbol] ?? null });
    if (!gate.ok) return decide(false, gate.reason);
    const res = sb.submit({ ...order, why: `entry: ${p.signal} ${p.score.toFixed(2)}` });
    if (!res.ok) return decide(false, res.reason);
    a.plans[p.symbol] = { entry: res.fill.price, stop, target: b.c + params.targetAtr * r, held: 0, signal: p.signal, entryT: b.t };
    a.lastBarT[p.symbol] = b.t;
    this.journal.decide(id, { kind: 'bought', symbol: p.symbol, qty, price: res.fill.price, rate: this.getFx()?.rate ?? null, signal: p.signal, score: p.score, stop, target: a.plans[p.symbol].target });
    decide(true, 'filled on paper', { qty, price: res.fill.price });
  }

  // ── status, timers ─────────────────────────────────────────

  status() {
    const holders = this.holders();
    const agents = AGENT_IDS.map((id) => {
      const sb = this.sandbox(id);
      const a = this.state.agents[id];
      const acct = sb ? sb.broker.account() : null;
      return {
        id,
        running: this.running().includes(id),
        process: this.children.has(id),
        allocation: sb?.allocation ?? null,
        cash: acct?.cash ?? null,
        equity: acct?.equity ?? null,
        dayPnl: sb ? sb.guard.dayPnl(acct.equity) : null,
        totalPnl: sb ? acct.equity - sb.allocation : null,
        positions: sb ? Object.entries(acct.positions).map(([symbol, p]) => ({ symbol, qty: p.qty, avg: p.avg, price: sb.broker.prices[symbol] ?? p.avg, plan: a.plans[symbol] || null })) : [],
        halt: a.dayHalt,
        sitOut: a.sitOut,
        scale: a.scale,
        peak: a.peak,
        params: this.settings.params[id],
        limits: sb?.guard.limits ?? null,
        lastProposals: a.lastProposals,
        lastDecision: a.lastDecision,
        recentFills: sb ? sb.broker.fills.slice(-8).reverse() : [],
        broken: this.manager.broken.get(id) || null,
      };
    });
    return {
      paperOnly: true,
      live: 'Live trading is closed: the owner has not set live limits',
      settings: this.settings,
      currency: 'Paper money is set in AUD; the books and prices are in US dollars.',
      fx: this.getFx(),
      usdPerAgent: this.usdPerAgent(),
      killed: this.state.killed,
      killReason: this.state.killReason,
      paused: this.state.paused,
      integrity: this.state.integrity,
      poolPause: this.state.poolPause,
      marketOpen: marketOpen(this.now()),
      lastTick: this.state.lastTick,
      lastError: this.state.lastError,
      pool: this.manager.pool,
      holders,
      agents,
      audit: { ...this.audit.verify(), recent: this.audit.tail(30) },
    };
  }

  save() {
    writeJson(this.stateFile, this.state);
  }

  start(everyMs = 60_000) {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), everyMs);
    this.timer.unref?.();
    return this;
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    for (const id of [...this.children.keys()]) this.stopChild(id);
  }
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
