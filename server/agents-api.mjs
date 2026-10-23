// The paper agents and the Alpaca paper keys, for the Paper portfolio screen and Settings. Plain
// functions from a request to { status, body }, like finviz-api.mjs.
//
//   GET  /api/agents               every agent's book, halts, kill state, recent audit events
//   PUT  /api/agents/settings      { agentsAtOnce?, paperPerAgent?, preset?, params? }
//   POST /api/agents/kill          { reason? }   the owner's kill switch
//   POST /api/agents/resume        clears the kill switch and an integrity halt (owner only)
//   GET  /api/agents/decisions     ?day=YYYY-MM-DD&agent=&limit=   plain-language decision log
//   GET  /api/agents/summary       ?day=                          the day's summary per agent and for all
//   GET  /api/agents/stats         ?agent=&days=30                by signal, symbol, half hour, exit reason
//   GET  /api/agents/export        ?what=trades|decisions|days&format=csv|json&from=&to=   a download
//   GET  /api/alpaca               whether paper keys are saved, the last test. Never a key.
//   PUT  /api/alpaca               { keyId, secret } or { clear: true }   write-only
//   POST /api/alpaca/test          fetch SPY's latest bar once
//
// Changes come only from this computer's own page (checkLocal). Nothing here can enable live trading.
import { HttpError } from './store.mjs';
import { checkLocal } from './finviz-api.mjs';
import { AGENT_IDS } from './engine/agents/profile.mjs';
import { toCsv, TRADE_COLUMNS, DECISION_COLUMNS } from './engine/agents/journal.mjs';
import { nyClock } from './engine/stats.mjs';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_EXPORT_DAYS = 31;

/** The days from `from` to `to` (inclusive), at most MAX_EXPORT_DAYS. */
function daysBetween(from, to) {
  const out = [];
  const d = new Date(`${from}T12:00:00Z`);
  while (out.length < MAX_EXPORT_DAYS) {
    const k = d.toISOString().slice(0, 10);
    if (k > to) break;
    out.push(k);
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

export function createAgentsApi({ host, keys, now = Date.now }) {
  const today = () => nyClock(now()).day;
  const dayParam = (q, name, fallback) => {
    const v = q.get(name);
    if (v == null || v === '') return fallback;
    if (!DAY.test(v)) throw new HttpError(400, `${name} must be YYYY-MM-DD`);
    return v;
  };
  const agentParam = (q) => {
    const a = q.get('agent');
    if (!a) return null;
    if (!AGENT_IDS.includes(a)) throw new HttpError(400, 'Unknown agent');
    return a;
  };
  return {
    async handle(method, pathname, headers = {}, body = null, query = new URLSearchParams()) {
      const route = `${method} ${pathname.replace(/\/+$/, '')}`;
      const local = () => checkLocal(headers);
      const bad = (fn) => {
        try {
          return fn();
        } catch (e) {
          throw new HttpError(400, e.message);
        }
      };
      switch (route) {
        case 'GET /api/agents':
          return { status: 200, body: host.status() };
        case 'PUT /api/agents/settings':
          local();
          return { status: 200, body: bad(() => host.updateSettings(body || {})) };
        case 'POST /api/agents/kill':
          local();
          return { status: 200, body: host.kill(typeof body?.reason === 'string' && body.reason.trim() ? body.reason.slice(0, 200) : 'Kill switch pressed') };
        case 'POST /api/agents/resume':
          local();
          return { status: 200, body: host.resume() };
        case 'GET /api/agents/decisions': {
          const day = dayParam(query, 'day', today());
          const limit = Math.min(1000, Math.max(1, Number(query.get('limit')) || 200));
          return { status: 200, body: { day, decisions: host.journal.decisions(day, agentParam(query), AGENT_IDS).slice(0, limit) } };
        }
        case 'GET /api/agents/summary':
          return { status: 200, body: host.journal.summary(dayParam(query, 'day', today()), AGENT_IDS) };
        case 'GET /api/agents/stats':
          return { status: 200, body: host.journal.stats(AGENT_IDS, { agent: agentParam(query), days: Math.min(365, Math.max(1, Number(query.get('days')) || 30)) }) };
        case 'GET /api/agents/export': {
          const what = query.get('what') || 'trades';
          const format = query.get('format') === 'json' ? 'json' : 'csv';
          const to = dayParam(query, 'to', today());
          const from = dayParam(query, 'from', to);
          if (from > to) throw new HttpError(400, 'from is after to');
          let rows;
          let columns;
          if (what === 'trades') {
            rows = host.journal.trades(AGENT_IDS, { from, to, agent: agentParam(query) });
            columns = TRADE_COLUMNS;
          } else if (what === 'decisions') {
            rows = daysBetween(from, to).flatMap((d) => host.journal.decisions(d, agentParam(query), AGENT_IDS)).sort((a, b) => a.t - b.t);
            columns = DECISION_COLUMNS;
          } else if (what === 'days') {
            rows = daysBetween(from, to).flatMap((d) => host.journal.summary(d, AGENT_IDS).agents.map((a) => ({ day: d, ...a, best: a.best?.symbol ?? '', worst: a.worst?.symbol ?? '', halts: a.halts.join(' | '), refusals: a.refusals })));
            columns = ['day', 'agent', 'trades', 'wins', 'winRate', 'pnlUsd', 'pnlAud', 'avgAud', 'best', 'worst', 'halts', 'considered', 'refusals'];
          } else throw new HttpError(400, 'what is trades, decisions or days');
          const name = `frosttrader-${what}-${from}${from === to ? '' : `-to-${to}`}.${format}`;
          // spreadsheets get readable times (UTC, ISO); JSON keeps the numbers
          const iso = (t) => (Number.isFinite(t) ? new Date(t).toISOString() : t);
          const csvRows = rows.map((r) => ({ ...r, t: iso(r.t), entryT: iso(r.entryT), exitT: iso(r.exitT) }));
          return { status: 200, body: format === 'json' ? JSON.stringify(rows, null, 1) : toCsv(csvRows, columns), type: format === 'json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8', download: name };
        }
        case 'GET /api/alpaca':
          return { status: 200, body: keys.status() };
        case 'PUT /api/alpaca':
          local();
          return { status: 200, body: bad(() => keys.update(body || {})) };
        case 'POST /api/alpaca/test':
          local();
          return { status: 200, body: await keys.test() };
        default:
          throw new HttpError(404, 'Not found');
      }
    },
  };
}
