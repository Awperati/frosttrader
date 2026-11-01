// The overseer: one pass after the close (docs/DESIGN-autonomous-agents.md §3.5), PAPER ONLY.
// It reads files the host already wrote (the journal, the audit log), applies the demotion rules fixed
// in code, and writes one plain-language report per day per agent: what it did, what was refused or
// halted, and a verdict (fine / watch / demoted / retired) with the reason.
//
// It uses no model, starts no process or timer (the host's onDayEnd calls run()), and never places or
// cancels an order. Its only effects: an agent's paper tier (active / reduced / retired), kept in
// DATA_DIR/overseer/state.json, and the audit log lines that say so. Every change can be undone.
//
// Rules (§3.5, for paper; a demotion is one of):
//   - a drawdown halt (the audit log's halt of kind "drawdown");
//   - the last 30 round trips, all newer than the last such demotion, average a loss.
// 1 demotion: tier "reduced" (half size, the same cap the drawdown halt uses) for 10 trading days.
// 2 demotions in 60 trading days: "retired" (not run any more, kept for the record).
// A gate bypass or integrity event that names an agent in the audit log: "retired" at once.
import fs from 'node:fs';
import path from 'node:path';
import { nyClock } from '../stats.mjs';
import { US_CLOSURES } from '../usMarketCalendar.mjs';
import { AGENT_IDS } from './profile.mjs';

export const RULES = Object.freeze({
  windowDays: 60, // trading days in which demotions count
  retireAfter: 2, // demotions in the window
  expectancyTrades: 30, // round trips judged together
  watchTrades: 10, // fewer than this: too early to judge
  reducedDays: 10, // trading days a demoted agent stays at reduced size
  reducedScale: 0.5,
});
export const TIERS = Object.freeze(['active', 'reduced', 'retired']);
const BYPASS_TYPES = new Set(['gate-bypass', 'integrity-agent']);

const isTradingDay = (d) => {
  const wd = new Date(`${d}T12:00:00Z`).getUTCDay();
  return wd !== 0 && wd !== 6 && !US_CLOSURES.has(d);
};

/** The trading day n trading days after (n > 0) or before (n < 0) `day`. */
export function shiftTradingDays(day, n) {
  const step = n < 0 ? -1 : 1;
  const d = new Date(`${day}T12:00:00Z`);
  for (let left = Math.abs(n); left > 0; ) {
    d.setUTCDate(d.getUTCDate() + step);
    if (isTradingDay(d.toISOString().slice(0, 10))) left--;
  }
  return d.toISOString().slice(0, 10);
}

const aud = (x) => (x == null ? '' : `${x >= 0 ? '+' : '−'}A$${Math.abs(x).toFixed(2)}`);
const usd = (x) => `${x >= 0 ? '+' : '−'}US$${Math.abs(x).toFixed(2)}`;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

export class Overseer {
  /** host: the AgentHost (journal, audit, sandbox, applyTiers). Attaches itself as host.tiers. */
  constructor({ dataDir, host, now = Date.now, rules = RULES, log = console }) {
    Object.assign(this, { host, now, rules, log });
    this.dir = path.join(dataDir, 'overseer');
    this.stateFile = path.join(this.dir, 'state.json');
    this.state = { lastRun: null, agents: {}, ...(readJson(this.stateFile) || {}) };
    for (const id of AGENT_IDS) this.agent(id);
    host.tiers = this;
    host.applyTiers?.();
  }

  agent(id) {
    const a = (this.state.agents[id] ??= { tier: 'active', reducedUntil: null, demotions: [], changes: [] });
    return a;
  }

  tierOf(id) {
    return this.agent(id).tier;
  }

  /** The cap on the agent's size from its tier (the host takes the smaller of this and its own scale). */
  cap(id) {
    return this.tierOf(id) === 'reduced' ? this.rules.reducedScale : 1;
  }

  save() {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 1));
  }

  /** Audit events that count against an agent: [{ key, day, kind, reason }]. */
  auditEvents(id, from) {
    const out = [];
    let lines = [];
    try {
      lines = fs.readFileSync(this.host.audit.file, 'utf8').split('\n').filter(Boolean);
    } catch {
      return out;
    }
    for (const l of lines) {
      if (!l.includes(id)) continue;
      let e;
      try {
        e = JSON.parse(l);
      } catch {
        continue;
      }
      if (e.agent !== id) continue;
      const day = nyClock(Date.parse(e.at)).day;
      if (day < from) continue;
      if (e.type === 'halt' && e.kind === 'drawdown') out.push({ key: `dd|${e.at}`, day, kind: 'drawdown', reason: `a drawdown halt on ${day}` });
      else if (BYPASS_TYPES.has(e.type)) out.push({ key: `bp|${e.at}`, day, kind: 'bypass', reason: `${e.type} on ${day}${e.reason ? `: ${e.reason}` : ''}` });
    }
    return out;
  }

  /** Run once for the trading day `day` (after its close). Idempotent for a day. Returns the report. */
  run(day) {
    const ids = AGENT_IDS;
    const from = shiftTradingDays(day, -(this.rules.windowDays - 1));
    const summary = this.host.journal.summary(day, ids);
    const agents = ids.map((id) => this.judge(id, day, from, summary.agents.find((x) => x.agent === id)));
    const text = [`Overseer report for ${day}`, ...agents.map((a) => a.text)].join('\n');
    const report = { day, at: this.now(), paperOnly: true, text, agents };
    fs.mkdirSync(path.join(this.dir, 'reports'), { recursive: true });
    fs.writeFileSync(path.join(this.dir, 'reports', `${day}.json`), JSON.stringify(report, null, 1));
    this.state.lastRun = { day, at: this.now() };
    this.save();
    this.host.applyTiers?.();
    this.host.audit.write({ type: 'overseer-report', day, verdicts: Object.fromEntries(agents.map((a) => [a.agent, a.verdict])) });
    return report;
  }

  judge(id, day, from, sum) {
    const st = this.agent(id);
    const rules = this.rules;
    const added = [];
    const known = new Set(st.demotions.map((d) => d.key));
    for (const e of this.auditEvents(id, from)) if (!known.has(e.key)) added.push(e);
    // the last N round trips, all of them newer than the last expectancy demotion
    const trades = this.host.journal.trades([id]).slice(-rules.expectancyTrades);
    const mark = Math.max(0, ...st.demotions.filter((d) => d.kind === 'expectancy').map((d) => d.exitT));
    const avg = trades.length ? trades.reduce((s, t) => s + t.pnlUsd, 0) / trades.length : null;
    if (trades.length >= rules.expectancyTrades && avg < 0 && trades.every((t) => t.exitT > mark)) {
      added.push({ key: `exp|${trades.at(-1).exitT}`, day, kind: 'expectancy', exitT: trades.at(-1).exitT, reason: `its last ${rules.expectancyTrades} trades averaged ${usd(avg)} each` });
    }
    st.demotions.push(...added);
    const live = st.demotions.filter((d) => !d.undone && d.day >= from);
    const from_ = st.tier;
    let to = st.tier;
    let why = '';
    if (st.tier !== 'retired') {
      const bypass = live.find((d) => d.kind === 'bypass');
      if (bypass) [to, why] = ['retired', `a gate bypass or integrity problem named it (${bypass.reason})`];
      else if (live.length >= rules.retireAfter) [to, why] = ['retired', `${plural(live.length, 'demotion')} in ${rules.windowDays} trading days: ${live.map((d) => d.reason).join('; ')}`];
      else if (added.length) [to, why] = ['reduced', added.map((d) => d.reason).join('; ')];
      else if (st.tier === 'reduced' && st.reducedUntil && day >= st.reducedUntil) [to, why] = ['active', `${rules.reducedDays} trading days at reduced size passed with no new demotion`];
    }
    if (to !== from_) {
      st.tier = to;
      st.reducedUntil = to === 'reduced' ? shiftTradingDays(day, rules.reducedDays) : null;
      st.changes.push({ at: new Date(this.now()).toISOString(), day, from: from_, to, reason: why, keys: added.map((d) => d.key), undone: false });
      st.changes = st.changes.slice(-50);
      this.host.audit.write({ type: 'overseer-tier', agent: id, from: from_, to, reason: why, day });
      this.host.journal.decide(id, { kind: 'note', text: `overseer: ${from_} → ${to}: ${why}` });
    }

    // the verdict and the words
    const s = sum || { trades: 0, wins: 0, pnlAud: 0, pnlUsd: 0, halts: [], considered: 0, refusals: {} };
    const refused = Object.values(s.refusals).reduce((a, b) => a + b, 0);
    const bought = this.host.journal.decisions(day, id).filter((d) => d.kind === 'bought').length;
    let verdict;
    let reason;
    if (st.tier === 'retired') [verdict, reason] = ['retired', st.changes.findLast((c) => c.to === 'retired')?.reason ?? 'retired'];
    else if (st.tier === 'reduced') [verdict, reason] = ['demoted', `it runs at half size until ${st.reducedUntil}: ${st.changes.findLast((c) => c.to === 'reduced')?.reason ?? ''}`];
    else if (s.halts.length) [verdict, reason] = ['watch', `it was halted today (${s.halts.join('; ')})`];
    else if (live.length) [verdict, reason] = ['watch', `1 demotion in the last ${rules.windowDays} trading days (${live[0].reason}); a second retires it`];
    else if (trades.length >= rules.watchTrades && avg < 0) [verdict, reason] = ['watch', `its last ${trades.length} trades averaged ${usd(avg)} each`];
    else [verdict, reason] = ['fine', trades.length < rules.watchTrades ? `only ${plural(trades.length, 'trade')} so far, too few to judge` : 'nothing against it'];
    const did = s.trades || bought ? `${plural(bought, 'buy')}, ${plural(s.trades, 'sale')}, ${s.wins} won, ${aud(s.pnlAud)} (${usd(s.pnlUsd)})` : 'made no trades';
    const refs = refused ? `Refused ${plural(refused, 'buy')} (${Object.entries(s.refusals).map(([k, n]) => `${k} ${n}`).join(', ')}).` : 'Nothing refused.';
    const text = `${id}: ${did}. Looked at ${s.considered} symbols. ${refs}${s.halts.length ? ` Halted: ${s.halts.join('; ')}.` : ''} Verdict: ${verdict}, because ${reason}.`;
    return { agent: id, tier: st.tier, verdict, reason, trades: s.trades, wins: s.wins, bought, pnlAud: s.pnlAud, pnlUsd: s.pnlUsd, considered: s.considered, refused, refusals: s.refusals, halts: s.halts, text };
  }

  /** Put the agent's tier back to what it was before the latest change. Like the nightly rollback. */
  undo(id) {
    const st = this.agent(id);
    const c = st.changes.findLast((x) => !x.undone);
    if (!c) throw new Error(`No overseer change to undo for ${id}.`);
    c.undone = true;
    for (const d of st.demotions) if (c.keys.includes(d.key)) d.undone = true;
    st.tier = c.from;
    st.reducedUntil = c.from === 'reduced' ? st.reducedUntil : null;
    this.save();
    this.host.applyTiers?.();
    this.host.audit.write({ type: 'overseer-undo', agent: id, from: c.to, to: c.from, of: c.at });
    this.host.journal.decide(id, { kind: 'note', text: `overseer: ${c.to} → ${c.from} (owner undid it)` });
    return this.status();
  }

  report(day) {
    return readJson(path.join(this.dir, 'reports', `${day}.json`));
  }

  /** The newest report's day, or null. */
  latestDay() {
    try {
      return fs.readdirSync(path.join(this.dir, 'reports')).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => f.slice(0, 10)).sort().at(-1) ?? null;
    } catch {
      return null;
    }
  }

  status(day = null) {
    const d = day ?? this.latestDay();
    return {
      paperOnly: true,
      rules: this.rules,
      lastRun: this.state.lastRun,
      tiers: AGENT_IDS.map((id) => ({ id, tier: this.tierOf(id), reducedUntil: this.agent(id).reducedUntil, demotions: this.agent(id).demotions.filter((x) => !x.undone), changes: this.agent(id).changes.slice(-5).reverse() })),
      report: d ? this.report(d) : null,
    };
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}
