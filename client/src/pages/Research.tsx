import { useEffect, useState } from 'react';
import { api, type AgentParams, type ResearchAgent, type ResearchStatus } from '../api';
import { num, signed, tone } from '../format';

// The nightly research (server/engine/research/nightly.mjs): what ran, each agent's current settings
// against the best variant in every walk-forward window, what was promoted or kept and the rule that
// decided, re-tests and adoptions between agents, and a Rollback for each change. Paper only.

const p = (x: AgentParams | null | undefined) => (x ? `entry ${x.entryScore} · stop ${x.stopAtr} · target ${x.targetAtr} · hold ${x.maxHold}` : '–');
const when = (t: number | string) => new Date(t).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const usd = (x: number | null | undefined) => (x == null ? '–' : `${signed(x)}`);

export function ResearchView() {
  const [st, setSt] = useState<ResearchStatus | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const load = () => api.research().then(setSt, (e) => setErr((e as Error).message));
  useEffect(() => {
    load();
  }, []);

  async function act(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    setErr('');
    try {
      await fn();
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  if (!st) return <div className="panel">{err ? <p className="error">{err}</p> : <p className="muted">Loading…</p>}</div>;
  const run = st.lastRun;
  const latestChange = (agent: string) => st.history.find((h) => h.agent === agent && h.kind === 'promote' && !h.rolledBack);

  return (
    <div className="research">
      <div className="panel">
        <h3>Nightly research</h3>
        <p className="small muted">
          After each US close every agent's settings compete with {st.rules.variants} variants on the last {st.rules.fitDays + st.rules.testDays}+ trading days: picked on {st.rules.fitDays} days, judged on the next {st.rules.testDays}. A variant
          replaces the settings only by fixed rules, at most once every {st.rules.changeEveryDays} days. Paper only; past results, not a forecast.
        </p>
        {run ? (
          <p className="small">
            Last run {when(run.at)} for {run.day}: {run.ok ? `${run.symbols} symbols, ${run.days} trading days stored, ${run.windows} windows, ${run.requests} Alpaca request${run.requests === 1 ? '' : 's'} (${run.newBars} new bars), ${((run.ms ?? 0) / 1000).toFixed(1)} s` : `failed: ${run.error}`}
            {run.model ? `. Local model: ${run.model.error ? `not reached (${run.model.error})` : `${run.model.proposals} idea${run.model.proposals === 1 ? '' : 's'} tested${run.model.dropped.length ? `, ${run.model.dropped.length} dropped by the checks` : ''}`}` : ''}
            {run.note ? `. ${run.note}` : ''}
          </p>
        ) : (
          <p className="small muted">Not run yet. It runs by itself after the next close.</p>
        )}
        <div className="row">
          <button onClick={() => act('run', api.runResearch)} disabled={!!busy || st.running}>
            {busy === 'run' || st.running ? 'Running…' : 'Run now'}
          </button>
        </div>
        {err && <p className="error small">{err}</p>}
      </div>

      <div className="agent-grid">
        {st.agents.map((a) => (
          <AgentResearch key={a.id} a={a} canRollback={!!latestChange(a.id)} busy={!!busy} onRollback={() => window.confirm(`Roll ${a.id} back to its settings before the last change?`) && act('rollback', () => api.rollback(a.id))} />
        ))}
      </div>

      <div className="panel">
        <h3>Changes</h3>
        {st.history.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Agent</th>
                  <th>Change</th>
                  <th>From</th>
                  <th>To</th>
                  <th>Why</th>
                </tr>
              </thead>
              <tbody>
                {st.history.map((h, i) => (
                  <tr key={i}>
                    <td>{when(h.at)}</td>
                    <td>{h.agent}</td>
                    <td>{h.kind === 'promote' ? (h.rolledBack ? 'promoted (rolled back)' : 'promoted') : 'rolled back'}</td>
                    <td className="left small">{p(h.from)}</td>
                    <td className="left small">{p(h.to)}</td>
                    <td className="left small">{h.reason ?? 'owner'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="small muted">No changes yet.</p>
        )}
      </div>

      <div className="panel">
        <h3>Re-tests and adoptions between agents</h3>
        {st.adoptions.length ? (
          <ul className="decisions">
            {st.adoptions.map((x, i) => (
              <li key={i} className="decision">
                <span className="muted">{when(x.at)}</span> <b>{x.agent}</b>{' '}
                {x.type === 'adoption' ? `adopted ${x.finding} as a candidate for its next night` : x.pass ? `re-tested ${x.finding}: passed` : `re-tested ${x.finding}: not adopted (${x.reasons.join('; ')})`}
              </li>
            ))}
          </ul>
        ) : (
          <p className="small muted">None yet. When one agent's settings are promoted, the others re-test them on their own replay before they may adopt them.</p>
        )}
      </div>
    </div>
  );
}

function AgentResearch({ a, canRollback, busy, onRollback }: { a: ResearchAgent; canRollback: boolean; busy: boolean; onRollback: () => void }) {
  const r = a.lastResult;
  return (
    <section className="panel agent">
      <div className="agent-head">
        <h3>{a.id}</h3>
        <span className={`pill ${r?.promotedOk ? 'ok' : ''}`}>{r ? (r.promotedOk ? 'new settings' : 'kept') : 'not run'}</span>
      </div>
      <p className="small">Now: {p(a.params)}</p>
      {a.lastChangeDay && <p className="small muted">Last change {a.lastChangeDay}.</p>}
      {r && (
        <>
          <p className="small">
            <b>{r.day}:</b> {r.decision}. {r.candidates} candidates{r.adoptedCandidates ? `, ${r.adoptedCandidates} adopted from other agents` : ''}{r.modelIdeas ? `, ${r.modelIdeas} from the local model` : ''}.{r.promotedFrom === 'model' ? " The winner was the model's idea, tested like any other." : ''}
          </p>
          {r.bestParams && <p className="small muted">Best variant: {p(r.bestParams)}</p>}
          {!!r.perWindow.length && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Test days</th>
                    <th>Picked</th>
                    <th>Current US$</th>
                    <th>Picked US$</th>
                    <th>Trades</th>
                  </tr>
                </thead>
                <tbody>
                  {r.perWindow.map((w, i) => (
                    <tr key={i}>
                      <td>
                        {w.test[0]} – {w.test[1]}
                      </td>
                      <td>{w.pick === 0 ? 'current' : `variant ${w.pick}`}</td>
                      <td className={tone(w.current.pnl)}>{usd(w.current.pnl)}</td>
                      <td className={tone(w.picked.pnl)}>{usd(w.picked.pnl)}</td>
                      <td>
                        {w.current.n} / {w.picked.n}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {r.best && (
            <p className="small muted">
              Test days in total: current {usd(r.current.pnl)} over {r.current.n} trades (drawdown US${num(r.current.maxDrawdown)}); best {usd(r.best.pnl)} over {r.best.n} (drawdown US${num(r.best.maxDrawdown)}).
            </p>
          )}
        </>
      )}
      {!!a.nights.length && (
        <details>
          <summary className="small">Last {a.nights.length} nights</summary>
          <ul className="decisions">
            {a.nights.map((n) => (
              <li key={n.day} className="decision">
                <b>{n.day}</b> {n.promoted ? 'promoted' : 'kept'}: {n.decision}
              </li>
            ))}
          </ul>
        </details>
      )}
      {canRollback && (
        <div className="row">
          <button onClick={onRollback} disabled={busy}>
            Roll back the last change
          </button>
        </div>
      )}
    </section>
  );
}
