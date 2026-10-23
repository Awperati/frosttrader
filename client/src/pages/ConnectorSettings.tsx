import { useEffect, useState } from 'react';
import { api, type ConnectorStatus } from '../api';

// Settings → Frost AI connector (server/connector.mjs): the MCP address to add in Frost AI and a token,
// shown once. Read tools plus stop/start/kill; resuming after a kill stays on this screen's Paper
// portfolio only.

const when = (t: string | null) => (t ? new Date(t).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'never');

export function ConnectorCard() {
  const [st, setSt] = useState<ConnectorStatus | null>(null);
  const [token, setToken] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.connector().then(setSt, (e) => setErr((e as Error).message));
  }, []);
  async function run(fn: () => Promise<ConnectorStatus>) {
    setBusy(true);
    setErr('');
    try {
      const s = await fn();
      setSt(s);
      setToken(s.token || '');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!st) return <div className="panel">{err ? <p className="error">{err}</p> : <p className="muted">Loading…</p>}</div>;
  return (
    <section className="panel finviz" aria-labelledby="conn-h">
      <h2 id="conn-h">Frost AI connector</h2>
      <p className="small muted">
        Lets Frost AI read how the paper agents are doing (status, today's summary, stats, the decision log, research) and stop, start or kill them. It can't resume after a kill, change settings,
        money or live. In Frost AI, add an MCP server with this address and the token as its key.
      </p>
      <label className="field">
        <span>Address</span>
        <input readOnly value={st.url} onFocus={(e) => e.target.select()} />
      </label>
      {token ? (
        <label className="field">
          <span>Token (shown once: copy it now)</span>
          <input readOnly value={token} onFocus={(e) => e.target.select()} spellCheck={false} />
          <span className="small muted">Paste it as the server's key in Frost AI. FrostTrader keeps only a fingerprint of it.</span>
        </label>
      ) : (
        <p className="small">{st.set ? `A token is set (made ${when(st.created)}, last used ${when(st.lastUsed)}).` : 'No token yet: the connector refuses every request.'}</p>
      )}
      <div className="row">
        <button onClick={() => (!st.set || window.confirm('Make a new token? The old one stops working.')) && run(api.newConnectorToken)} disabled={busy}>
          {st.set ? 'Make a new token' : 'Make a token'}
        </button>
        {st.set && (
          <button onClick={() => run(api.revokeConnector)} disabled={busy}>
            Turn off (remove token)
          </button>
        )}
      </div>
      {err && <p className="error small">{err}</p>}
    </section>
  );
}
