// What the paper agents did, in words the owner can read, and the numbers behind it.
//
//   decisions  one plain-language line per decision: considered, bought, refused, sold, halted
//              (DATA_DIR/agents/<id>/decisions-<day>.jsonl, kept 30 days)
//   trades     one record per round trip: signal, entry and exit, P&L in US$ and A$, exit reason
//              (DATA_DIR/agents/<id>/trades.jsonl, kept)
//
// The lines are written by the host from its own facts (scores, prices, checks), never by a model.
// From them: a daily summary per agent, stats by signal / symbol / time of day / exit reason, and
// CSV or JSON exports.
import fs from 'node:fs';
import path from 'node:path';
import { nyClock } from '../stats.mjs';

export const KEEP_DAYS = 30;
const KINDS = ['considered', 'bought', 'refused', 'sold', 'halt', 'resume', 'note'];

const usd = (x) => `US$${Number(x).toFixed(2)}`;
const aud = (x) => `A$${Number(x).toFixed(2)}`;
const signedAud = (x) => `${x >= 0 ? '+' : '−'}A$${Math.abs(x).toFixed(2)}`;
const qtyText = (q) => (q % 1 ? Number(q).toFixed(4) : String(q));

/** Plain-language lines for each kind of decision. `fx` is A$ per US$ inverse: US$ / rate = A$. */
export const say = {
  considered: ({ symbol, why, signal, score, entry }) =>
    why === 'below-entry'
      ? `considered ${symbol}: ${signal} ${score.toFixed(2)} < entry ${entry.toFixed(2)}, skipped`
      : why === 'tell'
        ? `considered ${symbol}: a manipulation tell (${signal} ${score.toFixed(2)}), stayed out`
        : why === 'no-signal'
          ? `considered ${symbol}: no entry signal, skipped`
          : `considered ${symbol}: ${why}`,
  bought: ({ symbol, qty, price, rate, signal, score, stop, target }) =>
    `bought ${qtyText(qty)} ${symbol} at ${usd(price)}${rate ? ` (${aud((qty * price) / rate)})` : ''}: ${signal} ${score.toFixed(2)}; ${target == null ? `trailing stop ${stop.toFixed(2)} (moves up with the best close)` : `stop ${stop.toFixed(2)}, target ${target.toFixed(2)}`}`,
  refused: ({ symbol, reason }) => `refused ${symbol}: ${reason}`,
  sold: ({ symbol, qty, price, why, pnlUsd, rate }) => `sold ${qtyText(qty)} ${symbol} at ${usd(price)} (${why}), ${rate ? signedAud(pnlUsd / rate) : `${pnlUsd >= 0 ? '+' : '−'}${usd(Math.abs(pnlUsd))}`}`,
  halt: ({ reason }) => `halted: ${reason}`,
  resume: ({ reason }) => `resumed: ${reason}`,
  note: ({ text }) => text,
};

export class Journal {
  constructor({ dataDir, now = Date.now }) {
    this.root = path.join(dataDir, 'agents');
    this.now = now;
  }

  dir(id) {
    return path.join(this.root, id);
  }

  /** Write one decision. data: { kind, symbol?, ... } (the text is made here). Returns the record. */
  decide(id, data) {
    if (!KINDS.includes(data.kind)) throw new Error(`unknown decision kind ${data.kind}`);
    const t = this.now();
    const day = nyClock(t).day;
    const rec = { t, day, agent: id, ...data, text: say[data.kind](data) };
    fs.mkdirSync(this.dir(id), { recursive: true });
    fs.appendFileSync(path.join(this.dir(id), `decisions-${day}.jsonl`), `${JSON.stringify(rec)}\n`);
    return rec;
  }

  /** Record a finished round trip. */
  trade(id, rec) {
    fs.mkdirSync(this.dir(id), { recursive: true });
    fs.appendFileSync(path.join(this.dir(id), 'trades.jsonl'), `${JSON.stringify({ agent: id, ...rec })}\n`);
  }

  /** Decisions of one day (newest first), for one agent or all. */
  decisions(day, agent = null, ids = []) {
    const out = [];
    for (const id of agent ? [agent] : ids) out.push(...readLines(path.join(this.dir(id), `decisions-${day}.jsonl`)));
    return out.sort((a, b) => b.t - a.t);
  }

  /** Round trips, optionally from day `from` to day `to` (inclusive). */
  trades(ids, { from = '0000-00-00', to = '9999-99-99', agent = null } = {}) {
    const out = [];
    for (const id of agent ? [agent] : ids) out.push(...readLines(path.join(this.dir(id), 'trades.jsonl')).filter((r) => r.day >= from && r.day <= to));
    return out.sort((a, b) => a.exitT - b.exitT);
  }

  /** Decision files older than KEEP_DAYS go. */
  prune(ids) {
    const cut = new Date(this.now() - KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
    for (const id of ids) {
      let files = [];
      try {
        files = fs.readdirSync(this.dir(id));
      } catch {
        continue;
      }
      for (const f of files) {
        const m = /^decisions-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f);
        if (m && m[1] < cut) fs.rmSync(path.join(this.dir(id), f), { force: true });
      }
    }
  }

  /** The day's summary per agent and for all: trades, win rate, P&L, halts, best and worst, refusals. */
  summary(day, ids) {
    const per = ids.map((id) => {
      const trades = this.trades([id], { from: day, to: day });
      const decisions = this.decisions(day, id);
      const refusals = {};
      for (const d of decisions.filter((x) => x.kind === 'refused')) {
        const k = /^(AGENT_CAPITAL|Over|Not enough|Trade limit|Open position|Under the|Kill|Daily loss)/.exec(d.reason)?.[1] ?? d.reason.split(':')[0];
        refusals[k] = (refusals[k] ?? 0) + 1;
      }
      return { agent: id, ...tally(trades), halts: decisions.filter((x) => x.kind === 'halt').map((x) => x.reason), considered: decisions.filter((x) => x.kind === 'considered').length, refusals };
    });
    const all = tally(this.trades(ids, { from: day, to: day }));
    return { day, agents: per, all: { ...all, halts: per.reduce((s, a) => s + a.halts.length, 0) } };
  }

  /** Stats over the last `days` calendar days for one agent (or all): by signal, symbol, half hour, exit. */
  stats(ids, { agent = null, days = 30 } = {}) {
    const from = new Date(this.now() - days * 86_400_000).toISOString().slice(0, 10);
    const trades = this.trades(ids, { agent, from });
    const group = (key) => {
      const g = {};
      for (const t of trades) (g[key(t)] ??= []).push(t);
      return Object.entries(g)
        .map(([k, list]) => ({ key: k, ...tally(list) }))
        .sort((a, b) => b.trades - a.trades);
    };
    const halfHour = (t) => {
      const m = nyClock(t.entryT ?? t.exitT).minute;
      const h = Math.floor(m / 30) * 30;
      return `${String(Math.floor(h / 60)).padStart(2, '0')}:${String(h % 60).padStart(2, '0')}`;
    };
    return { from, agent, all: tally(trades), bySignal: group((t) => t.signal || 'unknown'), bySymbol: group((t) => t.symbol), byTime: group(halfHour).sort((a, b) => a.key.localeCompare(b.key)), byExit: group((t) => t.exit) };
  }
}

/** Trades, wins, win rate, P&L (US$ and A$), average, best, worst. */
export function tally(trades) {
  const n = trades.length;
  const wins = trades.filter((t) => t.pnlUsd > 0).length;
  const pnlUsd = trades.reduce((s, t) => s + t.pnlUsd, 0);
  const pnlAud = trades.reduce((s, t) => s + (t.pnlAud ?? 0), 0);
  const sorted = [...trades].sort((a, b) => a.pnlUsd - b.pnlUsd);
  const brief = (t) => (t ? { symbol: t.symbol, signal: t.signal, pnlUsd: t.pnlUsd, pnlAud: t.pnlAud, exit: t.exit, day: t.day } : null);
  return { trades: n, wins, winRate: n ? wins / n : null, pnlUsd, pnlAud, avgAud: n ? pnlAud / n : null, best: brief(sorted[n - 1]), worst: brief(sorted[0]) };
}

/** CSV for a list of flat records (the columns given, in that order). */
export function toCsv(rows, columns) {
  const cell = (v) => {
    const s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.join(','), ...rows.map((r) => columns.map((c) => cell(r[c])).join(','))].join('\r\n') + '\r\n';
}

export const TRADE_COLUMNS = ['agent', 'day', 'symbol', 'signal', 'qty', 'entryT', 'entry', 'exitT', 'exit', 'exitPrice', 'pnlUsd', 'pnlAud', 'rate'];
export const DECISION_COLUMNS = ['agent', 'day', 't', 'kind', 'symbol', 'text', 'signal', 'score', 'reason', 'qty', 'price'];

function readLines(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}
