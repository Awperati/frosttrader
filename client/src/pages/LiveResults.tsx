import { useEffect, useState } from 'react';
import { api, type LiveResults } from '../api';
import { num, tone } from '../format';
import { LiveCurveCard } from './LiveCurve';

// Live (real-money) results: closed P&L in A$ with US$ beside it, per agent and in total, open
// positions, the last 20 live fills and the broker cash. From the live desk's own fills
// (server/engine/live/desk.mjs); nothing here can place or change an order.

const aud = (x: number | null | undefined) => (x == null ? '–' : `${x >= 0 ? '+' : '−'}A$${num(Math.abs(x))}`);
const usd = (x: number | null | undefined) => (x == null ? '–' : `${x >= 0 ? '+' : '−'}US$${num(Math.abs(x))}`);
const time = (t: number) => new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export function LiveResultsCard() {
  const [r, setR] = useState<LiveResults | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let on = true;
    const read = () => api.liveResults().then((x) => on && (setR(x), setErr('')), (e) => on && setErr((e as Error).message));
    void read();
    const t = window.setInterval(read, 30_000);
    return () => {
      on = false;
      window.clearInterval(t);
    };
  }, []);
  if (err) return <p className="small error">{err}</p>;
  if (!r) return <p className="muted small">Loading…</p>;
  const row = (label: string, t: LiveResults['total'], extra?: string) => (
    <tr key={label}>
      <td>{label}</td>
      <td>{t.trades}</td>
      <td>{t.trades ? `${Math.round((t.wins / t.trades) * 100)} %` : '–'}</td>
      <td className={tone(t.pnlAud)}>{aud(t.pnlAud)}</td>
      <td className={tone(t.pnlUsd)}>{usd(t.pnlUsd)}</td>
      <td className="left small">{extra ?? ''}</td>
    </tr>
  );
  return (
    <div>
      <p className="small muted">
        Closed live trades (real money). Today = {r.day}. {r.cash ? `Account cash: US$${num(r.cash.usd)}${r.cash.aud != null ? ` (A$${num(r.cash.aud)})` : ''}.` : 'Account cash not read yet.'}
        {r.stopped ? <b className="error"> Live is stopped: {r.stopped.reason}.</b> : null}
        {r.approx ? ' Some older fills are rebuilt from the audit log, so their A$ is approximate.' : ''}
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Agent</th>
              <th>Closed</th>
              <th>Wins</th>
              <th>P&amp;L A$</th>
              <th>P&amp;L US$</th>
              <th>Open now</th>
            </tr>
          </thead>
          <tbody>
            {r.agents.map((a) => row(`${a.id} today`, a.today, a.positions.length ? a.positions.map((p) => p.symbol).join(', ') : 'nothing open'))}
            {row('All, today', r.today)}
            {r.agents.map((a) => row(`${a.id} since start`, a.total))}
            {row('All, since start', r.total)}
          </tbody>
        </table>
      </div>
      <h4>Live curve</h4>
      <LiveCurveCard />
      <h4>Last live fills</h4>
      {r.lastFills.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Agent</th>
                <th>Side</th>
                <th>Stock</th>
                <th>Amount</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {r.lastFills.map((f, i) => (
                <tr key={`${f.t}-${i}`}>
                  <td>{time(f.t)}</td>
                  <td>{f.agent}</td>
                  <td>{f.side}</td>
                  <td>{f.symbol}</td>
                  <td>{f.aud != null ? `A$${num(f.aud)}` : '–'} <span className="small muted">(US${num(f.usd)})</span></td>
                  <td className={tone(f.pnlAud ?? 0)}>{f.pnlAud != null ? `${aud(f.pnlAud)} (${usd(f.pnlUsd)})` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted small">No live fills yet.</p>
      )}
    </div>
  );
}
