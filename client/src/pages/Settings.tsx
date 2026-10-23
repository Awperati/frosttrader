import { useEffect, useState } from 'react';
import { api, type AlpacaStatus, type FinvizStatus } from '../api';
import { AgentsCard } from './AgentsSettings';

// Settings: the Finviz Elite card, the Alpaca paper keys card and the paper agents card. Token and
// key fields are write-only: the server never sends them back, so the fields start empty and only
// say whether something is saved.
export function Settings() {
  return (
    <div className="settings">
      <FinvizCard />
      <AlpacaCard />
      <AgentsCard />
    </div>
  );
}

function AlpacaCard() {
  const [st, setSt] = useState<AlpacaStatus | null>(null);
  const [keyId, setKeyId] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => {
    api.alpaca().then(setSt, (e) => setErr((e as Error).message));
  }, []);
  async function run(label: string, fn: () => Promise<AlpacaStatus>) {
    setBusy(label);
    setErr('');
    try {
      setSt(await fn());
      if (label === 'save') {
        setKeyId('');
        setSecret('');
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy('');
    }
  }
  if (!st) return <div className="panel">{err ? <p className="error">{err}</p> : <p className="muted">Loading…</p>}</div>;
  return (
    <section className="panel finviz" aria-labelledby="alpaca-h">
      <h2 id="alpaca-h">Alpaca paper keys</h2>
      <p className="small muted">{st.use} Use your PAPER key pair (the key ID starts with PK); a live key is refused. From Alpaca: Paper Trading → API Keys.</p>
      <label className="field">
        <span>Key ID</span>
        <input type="password" value={keyId} onChange={(e) => setKeyId(e.target.value)} autoComplete="off" spellCheck={false} placeholder={st.set ? 'Saved. Type a new pair to replace it.' : 'PK…'} />
      </label>
      <label className="field">
        <span>Secret key</span>
        <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" spellCheck={false} />
        <span className="small muted">{st.set ? 'A key pair is saved on this computer. It is never shown again.' : 'No keys saved yet: the agents wait for market data.'}</span>
      </label>
      <div className="row">
        <button onClick={() => run('save', () => api.saveAlpaca({ keyId, secret }))} disabled={!!busy || !keyId.trim() || !secret.trim()}>
          {busy === 'save' ? 'Saving…' : 'Save'}
        </button>
        <button onClick={() => run('test', api.testAlpaca)} disabled={!!busy || !st.set}>
          {busy === 'test' ? 'Testing…' : 'Test'}
        </button>
        {st.set && (
          <button onClick={() => run('clear', () => api.saveAlpaca({ clear: true }))} disabled={!!busy}>
            Remove keys
          </button>
        )}
      </div>
      {err && <p className="error small">{err}</p>}
      {st.lastTest && <p className={`small ${st.lastTest.ok ? 'up' : 'error'}`}>Test {when(st.lastTest.at)}: {st.lastTest.message}</p>}
    </section>
  );
}

const when = (t: number) => new Date(t).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function age(min: number) {
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.floor(h / 24)} days ago`;
}

function FinvizCard() {
  const [st, setSt] = useState<FinvizStatus | null>(null);
  const [urls, setUrls] = useState('');
  const [token, setToken] = useState('');
  const [intervalMin, setIntervalMin] = useState(15);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');

  function take(s: FinvizStatus) {
    setSt(s);
    setUrls(s.urls.join('\n'));
    setIntervalMin(s.intervalMin);
    if (s.note) setNote(s.note);
  }

  useEffect(() => {
    api.finviz().then(take, (e) => setErr((e as Error).message));
  }, []);

  async function run(label: string, fn: () => Promise<FinvizStatus>) {
    setBusy(label);
    setErr('');
    setNote('');
    try {
      take(await fn());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  const save = () =>
    run('save', async () => {
      const s = await api.saveFinviz({ urls: urls.split(/\r?\n/), intervalMin, ...(token.trim() ? { token: token.trim() } : {}) });
      setToken('');
      return s;
    });

  if (!st) return <div className="panel">{err ? <p className="error">{err}</p> : <p className="muted">Loading…</p>}</div>;

  const last = st.last;
  return (
    <section className="panel finviz" aria-labelledby="finviz-h">
      <h2 id="finviz-h">Finviz Elite</h2>
      <p className="small muted">
        Your screeners become the watchlist. Frost Trader reads them through Finviz's Screener API export every {st.intervalMin} minutes ({st.window}). Only ticker names are read. Your
        Finviz password is never needed.
      </p>

      <label className="field">
        <span>Screener URLs, one per line</span>
        <textarea rows={3} value={urls} onChange={(e) => setUrls(e.target.value)} placeholder="https://elite.finviz.com/screener/stocks?v=111&f=…" spellCheck={false} />
        <span className="small muted">Open your screener on Finviz and copy the address from the browser bar. Up to 5.</span>
      </label>

      <label className="field">
        <span>API token</span>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          placeholder={st.tokenSet ? 'Saved. Type a new one to replace it.' : 'Paste the token from Finviz → Elite → API'}
        />
        <span className="small muted">{st.tokenSet ? 'A token is saved on this computer. It is never shown again.' : 'No token saved yet.'}</span>
      </label>

      <label className="field inline">
        <span>Fetch every</span>
        <select value={intervalMin} onChange={(e) => setIntervalMin(Number(e.target.value))}>
          {st.intervals.map((n) => (
            <option key={n} value={n}>
              {n} minutes
            </option>
          ))}
        </select>
      </label>

      <div className="row">
        <button onClick={save} disabled={!!busy}>
          {busy === 'save' ? 'Saving…' : 'Save'}
        </button>
        <button onClick={() => run('test', api.testFinviz)} disabled={!!busy || !st.tokenSet || !st.urls.length} title={!st.tokenSet || !st.urls.length ? 'Save a screener URL and a token first' : 'Fetch every screener once now'}>
          {busy === 'test' ? 'Testing…' : 'Test'}
        </button>
        {st.tokenSet && (
          <button onClick={() => run('clear', () => api.saveFinviz({ clearToken: true }))} disabled={!!busy}>
            Remove token
          </button>
        )}
      </div>
      {err && <p className="error small">{err}</p>}
      {note && <p className="notice small">{note}</p>}

      <div className="finviz-status small">
        {last ? (
          <p className={last.ok ? 'up' : 'error'}>
            Last fetch {when(last.at)} ({last.reason}): {last.ok ? `OK, ${last.perUrl.map((p) => p.rows).join(' + ')} rows` : last.error}
          </p>
        ) : (
          <p className="muted">Not fetched yet.</p>
        )}
        {st.list ? (
          <p className={st.list.stale ? 'notice' : ''}>
            {st.list.stale ? 'Using the last good list' : 'Watchlist'}: {st.list.symbols.length} symbols, fetched {age(st.list.ageMin)}
            {st.list.dropped > 0 ? ` (${st.list.dropped} more not used: the cap is 40)` : ''}. {st.list.symbols.join(', ')}
          </p>
        ) : (
          <p className="muted">No watchlist yet.</p>
        )}
        {st.mirror && (
          <p className={st.mirror.status === 'ok' ? 'muted' : 'notice'}>
            ticker app ({st.mirror.file}): {st.mirror.status === 'ok' ? `mirrored ${st.mirror.symbols} symbols and ${st.mirror.lots} paper positions${st.mirror.at ? `, last written ${when(st.mirror.at)}` : ''}. Restart ticker to see changes.` : st.mirror.error || 'not written yet.'}
          </p>
        )}
        <p className="muted">{st.inWindow ? 'Inside the fetch window now.' : 'Outside the fetch window now, so no scheduled fetches.'}</p>
      </div>
    </section>
  );
}
