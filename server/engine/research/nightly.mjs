// The nightly research loop (docs/DESIGN-autonomous-agents.md §3, stage 2), PAPER ONLY. After the
// close, for each agent:
//
//   1. candidates: its current parameters, 20 variants inside PARAM_BOUNDS (10 neighbours of the
//      current values, 10 seeded at random), and any finding from another agent it has validated
//      and adopted (knowledge.mjs);
//   2. walk-forward over the stored bars: fit on 10 trading days, test on the next 5, stepping 5.
//      In each window the candidate with the most P&L on the FIT days is picked; it is then judged
//      only on the TEST days that follow;
//   3. promotion, by rules fixed in code (nobody votes, the model included): a variant replaces the
//      agent's parameters only if it was picked in every window, made at least MIN_TRADES trades on
//      the test days, beat the current parameters there by at least 1 % of the agent's money, had no
//      bigger drawdown, and did no worse in the most recent window; and the agent's parameters have
//      not changed in the last 7 days.
//
// Every promotion is written to DATA_DIR/research/history.jsonl and the audit log, and can be undone
// with one click (rollback). A promoted variant is published to the knowledge store; another agent
// re-tests it on its own replay (passesValidation) before it may adopt it, and an adopted finding
// is only ever a candidate in that agent's next night, never a direct change.
import fs from 'node:fs';
import path from 'node:path';
import { BarStore } from './barstore.mjs';
import { replay, signalCache } from './replay.mjs';
import { PARAM_BOUNDS, AGENT_IDS } from '../agents/profile.mjs';
import { rng } from '../stats.mjs';

export const RULES = Object.freeze({
  fitDays: 10,
  testDays: 5,
  stepDays: 5,
  minDays: 15, // fewer stored trading days: no evaluation yet
  variants: 20,
  minTrades: 30, // on the test days
  marginShare: 0.01, // of the agent's money (US$)
  changeEveryDays: 7,
});
const STEP = { entryScore: 0.05, stopAtr: 0.25, targetAtr: 0.25, maxHold: 3 };
const DAY_MS = 86_400_000;

const key = (p) => `${p.entryScore}|${p.stopAtr}|${p.targetAtr}|${p.maxHold}`;
const round = (k, v) => (k === 'maxHold' ? Math.round(v) : Math.round(v * 100) / 100);
const clampParam = (k, v) => round(k, Math.min(PARAM_BOUNDS[k][1], Math.max(PARAM_BOUNDS[k][0], v)));

/** Up to `n` distinct variants of `cur`, inside the bounds: neighbours first, then seeded random ones. */
export function variants(cur, n, seed) {
  const out = new Map();
  for (const k of Object.keys(STEP)) {
    for (const d of [-1, 1]) {
      const v = { ...cur, [k]: clampParam(k, cur[k] + d * STEP[k]) };
      if (key(v) !== key(cur)) out.set(key(v), v);
    }
  }
  const r = rng(seed);
  let guard = 0;
  while (out.size < n && guard++ < n * 20) {
    const v = {};
    for (const [k, [lo, hi]] of Object.entries(PARAM_BOUNDS)) v[k] = clampParam(k, lo + r() * (hi - lo));
    if (key(v) !== key(cur)) out.set(key(v), v);
  }
  return [...out.values()].slice(0, n);
}

/** The walk-forward windows over a sorted list of days: [{ fit: Set, test: Set }]. */
export function windows(days, rules = RULES) {
  const out = [];
  for (let k = 0; k + rules.fitDays + rules.testDays <= days.length; k += rules.stepDays) {
    out.push({ fit: new Set(days.slice(k, k + rules.fitDays)), test: new Set(days.slice(k + rules.fitDays, k + rules.fitDays + rules.testDays)) });
  }
  return out;
}

/**
 * Walk-forward for one agent: which candidate wins each window on its fit days, and every candidate's
 * result on each window's test days. Returns { picks: [index], tests: [[result per window] per candidate] }.
 */
export function walkForward({ bars, cache, candidates, preset, allocation, wins }) {
  const tests = candidates.map(() => []);
  const picks = [];
  for (const w of wins) {
    let best = 0;
    let bestPnl = -Infinity;
    candidates.forEach((params, ci) => {
      const fit = replay({ bars, cache, params, preset, allocation, days: w.fit });
      if (fit.pnl > bestPnl + 1e-12) {
        bestPnl = fit.pnl;
        best = ci;
      }
      tests[ci].push(replay({ bars, cache, params, preset, allocation, days: w.test }));
    });
    picks.push(best);
  }
  return { picks, tests };
}

const combine = (list) => {
  const n = list.reduce((s, r) => s + r.n, 0);
  const pnl = list.reduce((s, r) => s + r.pnl, 0);
  return { n, pnl, expectancy: n ? pnl / n : 0, maxDrawdown: Math.max(0, ...list.map((r) => r.maxDrawdown)), maxDrawdownPct: Math.max(0, ...list.map((r) => r.maxDrawdownPct)), last: list.at(-1)?.pnl ?? 0 };
};

/**
 * The promotion decision for one agent (candidate 0 is its current parameters). Pure.
 * Returns { promote: index | null, reason, current, best }.
 */
export function decide({ picks, tests, allocation, lastChangeDay, today, rules = RULES }) {
  const cur = combine(tests[0]);
  const chosen = picks.length && picks.every((p) => p === picks[0]) ? picks[0] : null;
  const keep = (reason, best = null) => ({ promote: null, reason, current: cur, best });
  if (!picks.length) return keep('not enough stored days for a walk-forward window');
  if (chosen === null) return keep('no single candidate won every window');
  if (chosen === 0) return keep('the current settings won on the fit days');
  const best = combine(tests[chosen]);
  if (best.n < rules.minTrades) return keep(`the best variant made ${best.n} test trades (needs ${rules.minTrades})`, best);
  if (best.pnl - cur.pnl < allocation * rules.marginShare) return keep(`the best variant beat the current settings by US$${(best.pnl - cur.pnl).toFixed(2)} on the test days (needs US$${(allocation * rules.marginShare).toFixed(2)})`, best);
  if (best.maxDrawdown > cur.maxDrawdown + 1e-9) return keep('the best variant had a bigger drawdown', best);
  if (best.last < cur.last) return keep('the best variant did worse in the most recent window', best);
  if (lastChangeDay && (Date.parse(`${today}T12:00:00Z`) - Date.parse(`${lastChangeDay}T12:00:00Z`)) / DAY_MS < rules.changeEveryDays) return keep(`settings changed on ${lastChangeDay}; at most one change every ${rules.changeEveryDays} days`, best);
  return { promote: chosen, reason: `won every window; test P&L US$${best.pnl.toFixed(2)} vs US$${cur.pnl.toFixed(2)} over ${best.n} trades, drawdown no bigger, held up in the last window`, current: cur, best };
}

export class Research {
  /** host: the AgentHost (settings, audit, journal, knowledge). getData(): Alpaca market data or null. */
  constructor({ dataDir, host, getData = () => null, now = Date.now, rules = RULES, log = console }) {
    Object.assign(this, { host, getData, now, rules, log });
    this.dir = path.join(dataDir, 'research');
    this.stateFile = path.join(this.dir, 'state.json');
    this.historyFile = path.join(this.dir, 'history.jsonl');
    this.store = new BarStore({ dataDir });
    this.state = { lastRun: null, agents: {}, ...(readJson(this.stateFile) || {}) };
    this.running = null;
  }

  agentState(id) {
    return (this.state.agents[id] ??= { lastChangeDay: null, candidates: [], lastResult: null });
  }

  save() {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 1));
  }

  history(limit = 50) {
    try {
      return fs.readFileSync(this.historyFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).slice(-limit).reverse();
    } catch {
      return [];
    }
  }

  /** Run once for the trading day `day` (after its close). Never throws; returns the run's summary. */
  run(day, universe) {
    this.running ||= this.#run(day, universe)
      .catch((e) => {
        this.state.lastRun = { day, at: this.now(), ok: false, error: String(e?.message || e) };
        this.log.warn?.(`research: ${this.state.lastRun.error}`);
        return this.state.lastRun;
      })
      .finally(() => {
        this.running = null;
        this.save();
      });
    return this.running;
  }

  async #run(day, universe) {
    const started = this.now();
    const data = this.getData();
    let requests = 0;
    let update = null;
    if (data) {
      const before = data.requests ?? 0;
      update = await this.store.update(data, universe, this.now());
      requests = (data.requests ?? 0) - before;
    }
    const { bars, days } = this.store.load(universe);
    const wins = windows(days, this.rules);
    const cache = signalCache(bars);
    const preset = this.host.settings.preset;
    const results = {};
    for (const [n, id] of AGENT_IDS.entries()) {
      const allocation = this.host.sandbox(id)?.allocation ?? 10;
      const a = this.agentState(id);
      const current = this.host.settings.params[id];
      const adopted = a.candidates.filter((c) => key(c.params) !== key(current));
      const candidates = [current, ...variants(current, this.rules.variants, hashSeed(`${day}|${id}|${n}`)), ...adopted.map((c) => c.params)];
      const wf = wins.length ? walkForward({ bars, cache, candidates, preset, allocation, wins }) : { picks: [], tests: candidates.map(() => []) };
      const d = decide({ ...wf, allocation, lastChangeDay: a.lastChangeDay, today: day, rules: this.rules });
      results[id] = { candidates: candidates.length, windows: wins.length, decision: d.reason, current: d.current, best: d.best, promoted: d.promote != null ? candidates[d.promote] : null };
      if (d.promote != null) this.promote(id, current, candidates[d.promote], d, day);
      a.lastResult = { day, ...results[id] };
      a.candidates = adopted.filter((c) => key(c.params) !== key(candidates[d.promote ?? 0])).slice(-5);
    }
    if (wins.length) this.validateFindings(bars, cache, wins, day);
    this.state.lastRun = { day, at: this.now(), ok: true, ms: this.now() - started, requests, newBars: update?.newBars ?? 0, symbols: Object.keys(bars).length, days: days.length, windows: wins.length, note: data ? '' : 'No Alpaca paper keys: evaluated the bars already stored (none yet on a first night).' };
    this.host.audit.write({ type: 'research', day, requests, windows: wins.length, promoted: Object.entries(results).filter(([, r]) => r.promoted).map(([id]) => id) });
    return { ...this.state.lastRun, results };
  }

  promote(id, from, to, d, day) {
    this.host.updateSettings({ params: { [id]: to } });
    const rec = { at: new Date(this.now()).toISOString(), day, agent: id, kind: 'promote', from, to, reason: d.reason, current: d.current, best: d.best };
    this.append(rec);
    this.agentState(id).lastChangeDay = day;
    this.host.audit.write({ type: 'research-promote', agent: id, from, to, reason: d.reason });
    this.host.journal.decide(id, { kind: 'note', text: `new settings from the nightly test: entry ${to.entryScore}, stop ${to.stopAtr} ATR, target ${to.targetAtr} ATR, max hold ${to.maxHold} (was ${from.entryScore}, ${from.stopAtr}, ${from.targetAtr}, ${from.maxHold}): ${d.reason}` });
    try {
      this.host.knowledge.publish(id, {
        kind: 'params',
        claim: `${id}'s settings that won the walk-forward of ${day}: test P&L US$${d.best.pnl.toFixed(2)} over ${d.best.n} trades`,
        params: to,
        evidence: { day, testTrades: d.best.n, testPnl: d.best.pnl, testExpectancy: d.best.expectancy, maxDrawdownPct: d.best.maxDrawdownPct, split: 'validate', costBps: 5 },
        provenance: { source: 'nightly walk-forward', from },
      });
    } catch (e) {
      this.log.warn?.(`research: knowledge: ${e.message}`);
    }
  }

  /** Other agents re-test each published params finding on their own replay; a pass makes it a candidate. */
  validateFindings(bars, cache, wins, day) {
    const findings = this.host.knowledge.findings().filter((f) => f.kind === 'params');
    for (const id of AGENT_IDS) {
      const allocation = this.host.sandbox(id)?.allocation ?? 10;
      const current = this.host.settings.params[id];
      for (const f of findings) {
        if (f.agentId === id || this.host.knowledge.validations(f.id, id).length) continue;
        const params = { ...current, ...f.params };
        const test = (p) => combine(wins.map((w) => replay({ bars, cache, params: p, preset: this.host.settings.preset, allocation, days: w.test })));
        const mine = test(params);
        const base = test(current);
        const verdict = this.host.knowledge.recordValidation(f.id, id, { trades: mine.n, expectancy: mine.expectancy, baselineExpectancy: base.expectancy, costBps: 5, maxDrawdownPct: mine.maxDrawdownPct, split: 'validate' });
        if (verdict.pass) {
          const adopted = this.host.knowledge.adopt(f.id, id);
          this.agentState(id).candidates.push({ params: { ...current, ...adopted.params }, from: f.id, day });
          this.host.journal.decide(id, { kind: 'note', text: `re-tested ${f.agentId}'s settings (${f.id}) on its own replay and passed: they compete in its next nightly test` });
        }
      }
    }
  }

  /** One click: back to the settings before the latest promotion of this agent. */
  rollback(id) {
    const last = this.history(500).find((h) => h.agent === id && h.kind === 'promote' && !h.rolledBack);
    if (!last) throw new Error(`No change to roll back for ${id}.`);
    this.host.updateSettings({ params: { [id]: last.from } });
    this.append({ at: new Date(this.now()).toISOString(), agent: id, kind: 'rollback', from: last.to, to: last.from, of: last.at });
    // mark the promotion as rolled back (rewrite the small history file)
    const all = this.history(100_000).reverse().map((h) => (h.at === last.at && h.agent === id && h.kind === 'promote' ? { ...h, rolledBack: true } : h));
    fs.writeFileSync(this.historyFile, all.map((h) => JSON.stringify(h)).join('\n') + '\n');
    this.host.audit.write({ type: 'research-rollback', agent: id, to: last.from });
    this.host.journal.decide(id, { kind: 'note', text: `settings rolled back to entry ${last.from.entryScore}, stop ${last.from.stopAtr} ATR, target ${last.from.targetAtr} ATR, max hold ${last.from.maxHold} (owner)` });
    return this.status();
  }

  append(rec) {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.appendFileSync(this.historyFile, `${JSON.stringify(rec)}\n`);
  }

  status() {
    return {
      rules: this.rules,
      lastRun: this.state.lastRun,
      running: !!this.running,
      agents: AGENT_IDS.map((id) => ({ id, params: this.host.settings.params[id], ...this.agentState(id) })),
      history: this.history(30),
    };
  }
}

function hashSeed(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}
