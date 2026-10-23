import { useEffect, useState } from 'react';
import { api, type AgentParams, type AgentSettings, type Preset } from '../api';

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
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => {
    api.agents().then((st) => setS(st.settings), (e) => setErr((e as Error).message));
  }, []);
  if (!s) return <div className="panel">{err ? <p className="error">{err}</p> : <p className="muted">Loading…</p>}</div>;

  const setPreset = (k: keyof Omit<Preset, 'name'>, v: number) => setS({ ...s, preset: { ...s.preset, [k]: v } });
  const setParam = (id: string, k: keyof AgentParams, v: number) => setS({ ...s, params: { ...s.params, [id]: { ...s.params[id], [k]: v } } });

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
      <div className="field-row">
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
          <span>Paper money per agent ($)</span>
          <input type="number" min={5} max={250} step={5} value={s.paperPerAgent} onChange={(e) => setS({ ...s, paperPerAgent: Number(e.target.value) })} />
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
              {f.pct && (f.key === 'dailyLossPct' || f.key === 'drawdownPct') ? ` ($${((s.preset[f.key] as number) * s.paperPerAgent).toFixed(2)} at $${s.paperPerAgent})` : ''}
            </span>
          </label>
        ))}
      </div>
      <h3>Each agent's settings</h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Agent</th>
              {PARAM_FIELDS.map((f) => (
                <th key={f.key}>{f.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Object.keys(s.params).map((id, i) => (
              <tr key={id} className={i < s.agentsAtOnce ? '' : 'muted'}>
                <td>{id}</td>
                {PARAM_FIELDS.map((f) => (
                  <td key={f.key}>
                    <input className="num" type="number" step={f.step} value={s.params[id][f.key]} onChange={(e) => setParam(id, f.key, Number(e.target.value))} aria-label={`${id} ${f.label}`} />
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
