import { useEffect, useState } from 'react';
import { api, type AgentParams, type AgentSettings, type ModelInfo, type Preset, type Strategy } from '../api';

// Settings → Paper agents: how many run, the paper money each gets, the risk preset ("Medium", his
// choice of name, numbers his to change) and each agent's own parameters. Paper only: none of these
// are live limits, and nothing here can enable live trading. The server clamps every value
// (server/engine/agents/profile.mjs).

const PRESET_FIELDS: { key: keyof Omit<Preset, 'name'>; label: string; pct?: boolean; help: string }[] = [
  { key: 'riskPerTrade', label: 'Risk per trade', pct: true, help: 'of the agent’s equity, lost if a trade hits its stop' },
  { key: 'maxPositionPct', label: 'Largest position', pct: true, help: 'of the agent’s equity in one stock' },
  { key: 'maxOpenPositions', label: 'Open positions at most', help: 'per agent' },
  { key: 'maxTradesPerDay', label: 'Buys a day at most', help: 'per agent' },
  { key: 'dailyLossPct', label: 'Daily loss halt', pct: true, help: 'of its money: it stops for the day, back next day' },
  { key: 'drawdownPct', label: 'Drawdown halt', pct: true, help: 'below its best: sits out a day, returns at half size' },
  { key: 'poolDailyLossPct', label: 'All-agents daily loss halt', pct: true, help: 'of all the paper money: every agent stops buying for the day' },
];
const PARAM_FIELDS: { key: keyof AgentParams; label: string; step: number }[] = [
  { key: 'entryScore', label: 'Entry score', step: 0.05 },
  { key: 'stopAtr', label: 'Stop (ATR)', step: 0.25 },
  { key: 'targetAtr', label: 'Target (ATR)', step: 0.25 },
  { key: 'maxHold', label: 'Max hold (bars)', step: 1 },
];

export function AgentsCard() {
  const [s, setS] = useState<AgentSettings | null>(null);
  const [fx, setFx] = useState<{ rate: number; date: string; source: string } | null>(null);
  const [v11, setV11] = useState<ModelInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => {
    api.agents().then((st) => (setS(st.settings), setFx(st.fx), setV11(st.models?.v11 ?? null)), (e) => setErr((e as Error).message));
  }, []);
  if (!s) return <div className="panel">{err ? <p className="error">{err}</p> : <p className="muted">Loading…</p>}</div>;

  const setPreset = (k: keyof Omit<Preset, 'name'>, v: number) => setS({ ...s, preset: { ...s.preset, [k]: v } });
  const setParam = (id: string, k: keyof AgentParams, v: number) => setS({ ...s, params: { ...s.params, [id]: { ...s.params[id], [k]: v } } });
  const setStrategy = (id: string, v: Strategy) => setS({ ...s, strategies: { ...s.strategies, [id]: v } });

  async function save() {
    setBusy(true);
    setErr('');
    setMsg('');
    try {
      const st = await api.saveAgents(s!);
      setS(st.settings);
      setMsg('Saved. A new paper amount applies from the next trading day.');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel finviz" aria-labelledby="agents-h">
      <h2 id="agents-h">Paper agents</h2>
      <p className="small muted">Paper money only. These are not live limits, and live trading stays closed. The agents run by themselves; halts clear by themselves.</p>
      <label className="field check">
        <input type="checkbox" checked={s.runHere !== false} onChange={(e) => setS({ ...s, runHere: e.target.checked })} />
        <span>Run the agents here</span>
        <span className="small muted">Turn this off on the PC once the agents run on the Pi, so only one copy trades. Only while no agent holds a position.</span>
      </label>
      <div className="field-row">
        <label className="field">
          <span>Orders</span>
          <select value={s.orders ?? 'sim'} onChange={(e) => setS({ ...s, orders: e.target.value as AgentSettings['orders'] })}>
            <option value="sim">Simulated here only</option>
            <option value="alpaca-paper">Sent to my Alpaca paper account</option>
          </select>
          <span className="small muted">
            {s.orders === 'alpaca-paper'
              ? 'Each buy and sell also goes to your Alpaca PAPER account (play money) and is booked at its real fill. The books are checked against the account every minute; a difference stops everything until you look. Never a live account.'
              : 'Fills are simulated on each agent’s own book. Nothing is sent to Alpaca.'}{' '}
            Switch only while no agent holds a position.
          </span>
        </label>
        <label className="field">
          <span>Agents running at once</span>
          <select value={s.agentsAtOnce} onChange={(e) => setS({ ...s, agentsAtOnce: Number(e.target.value) })}>
            {[1, 2, 3, 4].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Paper money per agent (AUD)</span>
          <input type="number" min={5} max={1000} step={5} value={s.paperPerAgent} onChange={(e) => setS({ ...s, paperPerAgent: Number(e.target.value) })} />
          <span className="small muted">{fx ? `≈ US$${(Math.floor(s.paperPerAgent * fx.rate * 100) / 100).toFixed(2)} at ${fx.rate} (${fx.date}, ${fx.source}). Prices are in US dollars.` : 'No AUD → USD rate yet: the agents wait for one.'}</span>
        </label>
      </div>
      <h3>Risk preset: {s.preset.name} (your choice, not advice)</h3>
      <div className="preset-grid">
        {PRESET_FIELDS.map((f) => (
          <label key={f.key} className="field">
            <span>{f.label}{f.pct ? ' (%)' : ''}</span>
            <input
              type="number"
              step={f.pct ? 0.25 : 1}
              value={f.pct ? Math.round(s.preset[f.key] * 10000) / 100 : s.preset[f.key]}
              onChange={(e) => setPreset(f.key, f.pct ? Number(e.target.value) / 100 : Number(e.target.value))}
            />
            <span className="small muted">
              {f.help}
              {f.pct && (f.key === 'dailyLossPct' || f.key === 'drawdownPct') ? ` (A$${((s.preset[f.key] as number) * s.paperPerAgent).toFixed(2)} at A$${s.paperPerAgent})` : ''}
            </span>
          </label>
        ))}
      </div>
      <h3>Each agent's settings</h3>
      <p className="small muted">
        Strategy “signals” uses the numbers in its row (tuned each night). “v11 model” sets its own buys and exits: it buys when its
        probability is at least {v11?.threshold != null ? v11.threshold.toFixed(3) : '…'}, and sells on a close {v11 ? (v11.exit.kind === 'atr' ? `${v11.exit.stop} ATR` : `${(v11.exit.stop * 100).toFixed(1)} %`) : '…'} under the best
        close since the buy, after {v11?.exit.maxHold ?? 20} bars, or at the close. It can buy any of its 38 stocks, on your watchlist or not
        {v11?.test ? `. Its test (${v11.testPeriod}): ${v11.test.trades} trades, ${(v11.test.win_rate * 100).toFixed(1)} % won, ${v11.test.avg_bps.toFixed(1)} bps a trade after costs; past results, not a forecast` : ''}.
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Agent</th>
              <th>Strategy</th>
              {PARAM_FIELDS.map((f) => (
                <th key={f.key}>{f.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Object.keys(s.params).map((id, i) => (
              <tr key={id} className={i < s.agentsAtOnce ? '' : 'muted'}>
                <td>{id}</td>
                <td>
                  <select value={s.strategies?.[id] ?? 'signals'} onChange={(e) => setStrategy(id, e.target.value as Strategy)} aria-label={`${id} strategy`}>
                    <option value="signals">signals</option>
                    <option value="v11">v11 model</option>
                  </select>
                </td>
                {PARAM_FIELDS.map((f) => (
                  <td key={f.key}>
                    <input className="num" type="number" step={f.step} value={s.params[id][f.key]} onChange={(e) => setParam(id, f.key, Number(e.target.value))} aria-label={`${id} ${f.label}`} disabled={s.strategies?.[id] === 'v11'} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row">
        <button onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
      {msg && <p className="small up">{msg}</p>}
      {err && <p className="small error">{err}</p>}
    </section>
  );
}
