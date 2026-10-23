import { useEffect, useState } from 'react';
import { api, type AgentsStatus, type AgentView } from '../api';
import { num, signed, tone } from '../format';

// Paper portfolio: one card per paper agent (server/engine/agents/host.mjs), the kill switch state and
// the latest audit events. Paper money only; live trading is closed.

const time = (t: number | string | null | undefined) => (t == null ? '–' : new Date(t).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' }));
const money = (x: number | null | undefined) => (x == null ? '–' : `$${num(x)}`);
const qty = (q: number) => num(q, q % 1 ? 4 : 0);

export function Portfolio() {
  const [st, setSt] = useState<AgentsStatus | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    const load = () => api.agents().then((s) => live && (setSt(s), setErr('')), (e) => live && setErr((e as Error).message));
    load();
    const t = setInterval(load, 15_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);

  async function resume() {
    if (!window.confirm('Resume the paper agents? They start again at the next tick in market hours.')) return;
    setBusy(true);
    try {
      setSt(await api.resume());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!st) return <div className="panel">{err ? <p className="error">{err}</p> : <p className="muted">Loading…</p>}</div>;
  const stopped = st.killed || !!st.integrity;
  const total = st.agents.reduce((s, a) => s + (a.equity ?? 0), 0);
  const day = st.agents.reduce((s, a) => s + (a.dayPnl ?? 0), 0);

  return (
    <div className="portfolio">
      <div className={`banner ${stopped ? 'banner-bad' : ''}`}>
        <b>Paper money only.</b> {st.live}. {st.agents.filter((a) => a.running).length} of 4 agents set to run, ${num(st.settings.paperPerAgent)} each.
        <span className="sep">·</span>
        {st.marketOpen ? 'US market open' : 'US market closed'}
        <span className="sep">·</span>
        last tick {time(st.lastTick)}
        {st.lastError && <div className="notice small">{st.lastError}</div>}
        {st.poolPause && <div className="notice small">All agents stopped buying for today: {st.poolPause.reason}.</div>}
        {stopped && (
          <div className="error small">
            {st.killed ? `Kill switch on: ${st.killReason}.` : `Integrity halt: ${st.integrity?.reason}.`} Everything was sold and every agent is stopped until you resume.{' '}
            <button onClick={resume} disabled={busy}>
              Resume
            </button>
          </div>
        )}
      </div>
      <div className="facts">
        <div>
          <dt>Paper equity, all agents</dt>
          <dd>{money(total)}</dd>
        </div>
        <div>
          <dt>Today</dt>
          <dd className={tone(day)}>{signed(day)}</dd>
        </div>
        <div>
          <dt>Audit log</dt>
          <dd className={st.audit.ok ? '' : 'down'}>{st.audit.ok ? `${st.audit.lines} events, chain intact` : `broken at line ${st.audit.brokenAt}`}</dd>
        </div>
      </div>
      <div className="agent-grid">
        {st.agents.map((a) => (
          <AgentCard key={a.id} a={a} />
        ))}
      </div>
      <div className="panel">
        <h3>Recent events</h3>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Event</th>
                <th>Agent</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {st.audit.recent.map((e, i) => (
                <tr key={i}>
                  <td>{time(e.at)}</td>
                  <td>{e.type}{e.side ? ` ${e.side}` : ''}</td>
                  <td>{e.agent ?? '–'}</td>
                  <td className="left">{[e.symbol, e.qty != null ? qty(e.qty) : '', e.price != null ? `@ ${num(e.price)}` : '', e.pnl != null ? `P&L ${signed(e.pnl)}` : '', e.why, e.reason, e.kind].filter(Boolean).join(' · ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function AgentCard({ a }: { a: AgentView }) {
  const state = a.broken ? `Broken: ${a.broken}` : !a.running ? 'Not running (Settings → agents at once)' : a.halt ? `Halted today: ${a.halt.reason}` : a.sitOut > 0 ? `Sitting out after a drawdown halt (${a.sitOut} more trading day${a.sitOut === 1 ? '' : 's'})` : a.scale < 1 ? `Running at ${a.scale * 100} % size after a drawdown halt` : 'Running';
  return (
    <section className="panel agent">
      <div className="agent-head">
        <h3>{a.id}</h3>
        <span className={`pill ${a.halt || a.broken ? 'bad' : a.running ? 'ok' : ''}`}>{state}</span>
      </div>
      <dl className="facts">
        <div>
          <dt>Allocation</dt>
          <dd>{money(a.allocation)}</dd>
        </div>
        <div>
          <dt>Equity</dt>
          <dd>{money(a.equity)}</dd>
        </div>
        <div>
          <dt>Cash</dt>
          <dd>{money(a.cash)}</dd>
        </div>
        <div>
          <dt>Today</dt>
          <dd className={tone(a.dayPnl)}>{signed(a.dayPnl)}</dd>
        </div>
        <div>
          <dt>Since start</dt>
          <dd className={tone(a.totalPnl)}>{signed(a.totalPnl)}</dd>
        </div>
      </dl>
      <p className="small muted">
        Entry score {a.params.entryScore} · stop {a.params.stopAtr} ATR · target {a.params.targetAtr} ATR · max hold {a.params.maxHold} bars
      </p>
      {a.positions.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Qty</th>
                <th>Avg</th>
                <th>Last</th>
                <th>Stop</th>
                <th>Target</th>
              </tr>
            </thead>
            <tbody>
              {a.positions.map((p) => (
                <tr key={p.symbol}>
                  <td>{p.symbol}</td>
                  <td>{qty(p.qty)}</td>
                  <td>{num(p.avg)}</td>
                  <td className={tone(p.price - p.avg)}>{num(p.price)}</td>
                  <td>{p.plan ? num(p.plan.stop) : '–'}</td>
                  <td>{p.plan ? num(p.plan.target) : '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="small muted">No open positions.</p>
      )}
      {a.lastDecision && (
        <p className="small">
          Last decision {time(a.lastDecision.at)}: {a.lastDecision.symbol} {a.lastDecision.ok ? 'bought' : 'refused'} ({a.lastDecision.reason})
        </p>
      )}
      {!!a.recentFills.length && (
        <p className="small muted">
          Recent: {a.recentFills.map((f) => `${f.side} ${qty(f.qty)} ${f.symbol} @ ${num(f.price)}${f.side === 'sell' ? ` (${signed(f.pnl)})` : ''}`).join(' · ')}
        </p>
      )}
    </section>
  );
}
