import { useEffect, useState } from 'react';
import { api, type LiveCurve } from '../api';
import { num, tone } from '../format';

// The live curve: running closed live result and the paper agents' running result, both in A$, and the
// live result per day as bars, with the Alpaca account equity beside each day. Pure SVG, no library.

const W = 640;
const aud = (x: number | null | undefined) => (x == null ? '–' : `${x >= 0 ? '+' : '−'}A$${num(Math.abs(x))}`);
const usd = (x: number | null | undefined) => (x == null ? '–' : `${x >= 0 ? '+' : '−'}US$${num(Math.abs(x))}`);

export function LiveCurveCard() {
  const [c, setC] = useState<LiveCurve | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let on = true;
    api.liveCurve().then((x) => on && setC(x), (e) => on && setErr((e as Error).message));
    return () => {
      on = false;
    };
  }, []);
  if (err) return <p className="small error">{err}</p>;
  if (!c) return <p className="muted small">Loading…</p>;
  const pts = c.points;
  if (!pts.length) return <p className="muted small">The live curve starts with the first live trading day.</p>;
  const x = (i: number) => (pts.length === 1 ? W / 2 : 40 + (i / (pts.length - 1)) * (W - 60));
  const series = [pts.map((p) => p.liveCumAud), pts.map((p) => p.paperCumAud)];
  const all = [0, ...series.flat()];
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const H = 170;
  const y = (v: number) => 10 + (1 - (v - lo) / (hi - lo || 1)) * (H - 20);
  const path = (s: number[]) => s.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const maxBar = Math.max(1e-9, ...pts.map((p) => Math.abs(p.liveDayAud)));
  const bw = Math.max(6, Math.min(40, (W - 60) / pts.length - 6));
  return (
    <div>
      <p className="small muted">
        Running result of closed trades in A$ (a day counts when its trades are sold). Live is real money (A$100 per agent); paper is the same four agents on paper money, so its scale differs.
        {c.approx ? ' Older live days are rebuilt from the audit log, so their A$ is approximate.' : ''}
      </p>
      <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="Running live and paper result in A$">
        <line x1="40" x2={W - 20} y1={y(0)} y2={y(0)} stroke="currentColor" strokeOpacity="0.3" />
        <text x="4" y={y(0) + 4} fontSize="10" fill="currentColor">A$0</text>
        <text x="4" y={y(hi) + 4} fontSize="10" fill="currentColor">{num(hi, 0)}</text>
        <text x="4" y={y(lo) + 4} fontSize="10" fill="currentColor">{num(lo, 0)}</text>
        <path d={path(series[1])} fill="none" stroke="currentColor" strokeOpacity="0.45" strokeWidth="2" strokeDasharray="5 4" />
        <path d={path(series[0])} fill="none" stroke="var(--accent, #2a7de1)" strokeWidth="2.5" />
        {pts.map((p, i) => (
          <circle key={p.day} cx={x(i)} cy={y(p.liveCumAud)} r="3" fill="var(--accent, #2a7de1)" />
        ))}
      </svg>
      <p className="small">
        <span style={{ color: 'var(--accent, #2a7de1)' }}>━ live (real money)</span> &nbsp; <span className="muted">╌ paper, same days</span>
      </p>
      <svg viewBox={`0 0 ${W} 90`} className="chart" role="img" aria-label="Live result per day in A$">
        <line x1="40" x2={W - 20} y1="45" y2="45" stroke="currentColor" strokeOpacity="0.3" />
        {pts.map((p, i) => {
          const h = (Math.abs(p.liveDayAud) / maxBar) * 38;
          return <rect key={p.day} x={x(i) - bw / 2} y={p.liveDayAud >= 0 ? 45 - h : 45} width={bw} height={Math.max(1, h)} fill={p.liveDayAud >= 0 ? '#2e9d57' : '#d64545'} />;
        })}
      </svg>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Day</th>
              <th>Live day A$</th>
              <th>Live day US$</th>
              <th>Live total A$</th>
              <th>Paper total A$</th>
              <th>Alpaca account</th>
            </tr>
          </thead>
          <tbody>
            {pts.slice(-14).reverse().map((p) => (
              <tr key={p.day}>
                <td>{p.day}</td>
                <td className={tone(p.liveDayAud)}>{aud(p.liveDayAud)}</td>
                <td className={tone(p.liveDayUsd)}>{usd(p.liveDayUsd)}</td>
                <td className={tone(p.liveCumAud)}>{aud(p.liveCumAud)}</td>
                <td className={tone(p.paperCumAud)}>{aud(p.paperCumAud)}</td>
                <td>{p.brokerEquityUsd != null ? `US$${num(p.brokerEquityUsd)}${p.brokerEquityAud != null ? ` (A$${num(p.brokerEquityAud)})` : ''}` : '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
