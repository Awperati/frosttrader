import { useEffect, useState } from 'react';
import { api, type NotifyStatus } from '../api';

// Settings → Phone alerts (ntfy). Off until a topic is set. The topic is write-only: whoever knows it
// can read the alerts, so it is never shown again (server/notify.mjs).
export function AlertsCard() {
  const [st, setSt] = useState<NotifyStatus | null>(null);
  const [server, setServer] = useState('');
  const [topic, setTopic] = useState('');
  const [prio, setPrio] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => {
    api.notify().then((s) => (setSt(s), setServer(s.server), setPrio(s.priorities)), (e) => setErr((e as Error).message));
  }, []);
  async function run(label: string, fn: () => Promise<NotifyStatus>, done = '') {
    setBusy(label);
    setErr('');
    setMsg('');
    try {
      const s = await fn();
      setSt(s);
      setPrio(s.priorities);
      setTopic('');
      setMsg(done);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy('');
    }
  }
  if (!st) return <div className="panel">{err ? <p className="error">{err}</p> : <p className="muted">Loading…</p>}</div>;
  return (
    <section className="panel finviz" aria-labelledby="alerts-h">
      <h2 id="alerts-h">Phone alerts (ntfy)</h2>
      <p className="small muted">
        {st.on ? 'On.' : st.topicSet ? 'Off (switched off below).' : 'Off: no topic yet.'} Alerts go to the ntfy app on your phone: kill switch, live stops and halts,
        watchdog restarts, each live fill, live on/off, a website sign-in from a new place, and a summary after each US close. They never contain keys or
        account numbers. A failed alert never stops trading.
      </p>
      <label className="field">
        <span>ntfy server</span>
        <input value={server} onChange={(e) => setServer(e.target.value)} spellCheck={false} />
      </label>
      <label className="field">
        <span>Topic (write-only)</span>
        <input type="password" value={topic} onChange={(e) => setTopic(e.target.value)} autoComplete="off" spellCheck={false} placeholder={st.topicSet ? 'Set. Type a new one to replace it.' : 'made on the Pi by scripts/pi-alerts-setup.sh'} />
      </label>
      <div className="preset-grid">
        {Object.entries(st.labels).map(([k, label]) => (
          <label key={k} className="field">
            <span>{label}</span>
            <select value={prio[k]} onChange={(e) => setPrio({ ...prio, [k]: Number(e.target.value) })}>
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {['', 'min', 'low', 'default', 'high', 'urgent'][n]}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <div className="row">
        <button onClick={() => run('save', () => api.saveNotify({ server, ...(topic ? { topic } : {}), priorities: prio }), 'Saved.')} disabled={!!busy}>
          Save
        </button>
        <button onClick={() => run('test', () => api.testNotify(), 'Sent: check your phone.')} disabled={!!busy || !st.on}>
          Send a test
        </button>
        <button onClick={() => run('toggle', () => api.saveNotify({ enabled: !st.enabled }))} disabled={!!busy || !st.topicSet}>
          {st.enabled ? 'Switch alerts off' : 'Switch alerts on'}
        </button>
      </div>
      {st.lastError ? <p className="small error">Last failure: {st.lastError}</p> : null}
      {msg ? <p className="small up">{msg}</p> : null}
      {err ? <p className="small error">{err}</p> : null}
    </section>
  );
}
