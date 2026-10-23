import { useEffect, useState } from 'react';
import { api, type AgentStats, type DaySummary, type Decision, type Group, type Tally } from '../api';
import { num, signed, tone } from '../format';

// Reading the paper agents' behaviour (server/engine/agents/journal.mjs): the day's summary, the
// plain-language decision log, stats per agent, and exports. The lines come from the host's own facts.

const AGENTS = ['agent-a', 'agent-b', 'agent-c', 'agent-d'];
/** Today in New York (the trading day), as YYYY-MM-DD. */
export const nyToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const time = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const rate = (r: number | null) => (r == null ? '–' : `${Math.round(r * 100)} %`);
const aud = (x: number | null | undefined) => (x == null ? '–' : `${x >= 0 ? '+' : '−'}A$${num(Math.abs(x))}`);

function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let live = true;
    setErr('');
    fn().then((d) => live && setData(d), (e) => live && setErr((e as Error).message));
    return () => {
      live = false;
    };
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return { data, err };
}

export function DaySummaryCard({ day }: { day: string }) {
  const { data, err } = useLoad(() => api.summary(day), [day]);
  if (err) return <p className="error small">{err}</p>;
  if (!data) return <p className="muted small">Loading…</p>;
  const row = (label: string, t: Tally, extra?: { halts: string[] | number; considered?: number; refusals?: Record<string, number> }) => (
    <tr key={label}>
      <td>{label}</td>
      <td>{t.trades}</td>
      <td>{rate(t.winRate)}</td>
      <td className={tone(t.pnlAud)}>{aud(t.pnlAud)}</td>
      <td className={tone(t.pnlUsd)}>{signed(t.pnlUsd)}</td>
      <td>{t.best ? `${t.best.symbol} ${aud(t.best.pnlAud)}` : '–'}</td>
      <td>{t.worst ? `${t.worst.symbol} ${aud(t.worst.pnlAud)}` : '–'}</td>
      <td>{extra ? (Array.isArray(extra.halts) ? extra.halts.length : extra.halts) : ''}</td>
      <td className="left small">{extra?.refusals ? Object.entries(extra.refusals).map(([k, n]) => `${k} ${n}`).join(' · ') || '–' : ''}</td>
    </tr>
  );
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Agent</th>
            <th>Trades</th>
            <th>Wins</th>
            <th>P&amp;L A$</th>
            <th>P&amp;L US$</th>
            <th>Best</th>
            <th>Worst</th>
            <th>Halts</th>
            <th>Refused by</th>
          </tr>
        </thead>
        <tbody>
          {data.agents.map((a) => row(a.agent, a, a))}
          {row('All', data.all, { halts: data.all.halts })}
        </tbody>
      </table>
    </div>
  );
}

export function DecisionLog({ day }: { day: string }) {
  const [agent, setAgent] = useState('');
  const [kinds, setKinds] = useState<'all' | 'trades' | 'no-considered'>('no-considered');
  const { data, err } = useLoad(() => api.decisions(day, agent), [day, agent]);
  const list = (data?.decisions || []).filter((d: Decision) => (kinds === 'all' ? true : kinds === 'trades' ? d.kind === 'bought' || d.kind === 'sold' : d.kind !== 'considered'));
  return (
    <div>
      <div className="toolbar">
        <select value={agent} onChange={(e) => setAgent(e.target.value)} aria-label="Agent">
          <option value="">All agents</option>
          {AGENTS.map((a) => (
            <option key={a}>{a}</option>
          ))}
        </select>
        <select value={kinds} onChange={(e) => setKinds(e.target.value as typeof kinds)} aria-label="Which decisions">
          <option value="no-considered">Trades, refusals and halts</option>
          <option value="trades">Trades only</option>
          <option value="all">Everything, including what it passed on</option>
        </select>
      </div>
      {err && <p className="error small">{err}</p>}
      {!data ? (
        <p className="muted small">Loading…</p>
      ) : list.length ? (
        <ul className="decisions">
          {list.map((d, i) => (
            <li key={i} className={`decision ${d.kind}`}>
              <span className="muted">{time(d.t)}</span> <b>{d.agent}</b> {d.text}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">No decisions on {day}{agent ? ` for ${agent}` : ''}.</p>
      )}
    </div>
  );
}

function GroupTable({ title, rows }: { title: string; rows: Group[] }) {
  return (
    <div className="panel">
      <h3>{title}</h3>
      {rows.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{title.replace('By ', '')}</th>
                <th>Trades</th>
                <th>Wins</th>
                <th>P&amp;L A$</th>
                <th>Average A$</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td>{r.key}</td>
                  <td>{r.trades}</td>
                  <td>{rate(r.winRate)}</td>
                  <td className={tone(r.pnlAud)}>{aud(r.pnlAud)}</td>
                  <td className={tone(r.avgAud)}>{aud(r.avgAud)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted small">No trades yet.</p>
      )}
    </div>
  );
}

export function StatsView() {
  const [agent, setAgent] = useState('');
  const [days, setDays] = useState(30);
  const { data, err } = useLoad<AgentStats>(() => api.stats(agent, days), [agent, days]);
  return (
    <div>
      <div className="toolbar">
        <select value={agent} onChange={(e) => setAgent(e.target.value)} aria-label="Agent">
          <option value="">All agents</option>
          {AGENTS.map((a) => (
            <option key={a}>{a}</option>
          ))}
        </select>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Period">
          {[7, 30, 90, 365].map((d) => (
            <option key={d} value={d}>
              Last {d} days
            </option>
          ))}
        </select>
      </div>
      {err && <p className="error small">{err}</p>}
      {data && (
        <>
          <p className="small">
            Since {data.from}: {data.all.trades} trades, {rate(data.all.winRate)} won, <span className={tone(data.all.pnlAud)}>{aud(data.all.pnlAud)}</span>. Past results only; not a forecast.
          </p>
          <div className="stats-grid">
            <GroupTable title="By signal" rows={data.bySignal} />
            <GroupTable title="By exit" rows={data.byExit} />
            <GroupTable title="By time (New York, entry)" rows={data.byTime} />
            <GroupTable title="By symbol" rows={data.bySymbol} />
          </div>
        </>
      )}
    </div>
  );
}

export function ExportLinks({ day }: { day: string }) {
  const [from, setFrom] = useState(day);
  const [to, setTo] = useState(day);
  const link = (what: 'trades' | 'decisions' | 'days', format: 'csv' | 'json') => (
    <a className="button-link" href={api.exportUrl(what, format, from, to)} download>
      {what} .{format}
    </a>
  );
  return (
    <div className="export">
      <label className="field inline">
        <span>From</span>
        <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
      </label>
      <label className="field inline">
        <span>to</span>
        <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
      </label>
      <div className="row">
        {link('trades', 'csv')} {link('decisions', 'csv')} {link('days', 'csv')} {link('trades', 'json')} {link('decisions', 'json')}
      </div>
      <p className="small muted">At most 31 days per file. Decisions are kept 30 days; trades are kept.</p>
    </div>
  );
}
