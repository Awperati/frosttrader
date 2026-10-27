import { useEffect, useState } from 'react';
import { api, type LiveLimits, type LiveStatus } from '../api';

// Settings → Live trading (REAL money). Off until the owner saves his live key pair, checks the
// account, confirms every limit and types the phrase with his password and code. The server checks
// everything again (server/live-api.mjs); this card only collects his input. Keys are write-only.

export function LiveCard() {
  const [st, setSt] = useState<LiveStatus | null>(null);
  const [keyId, setKeyId] = useState('');
  const [secret, setSecret] = useState('');
  const [limits, setLimits] = useState<LiveLimits | null>(null);
  const [confirmed, setConfirmed] = useState<string[]>([]);
  const [phrase, setPhrase] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [agents, setAgents] = useState<Record<string, boolean> | null>(null);

  useEffect(() => {
    api.live().then((s) => (setSt(s), setLimits(s.limits ?? s.proposed)), (e) => setErr((e as Error).message));
    api.agents().then((a) => setAgents(a.settings.live ?? null), () => {});
  }, []);

  async function run(label: string, fn: () => Promise<LiveStatus>) {
    setBusy(label);
    setErr('');
    try {
      const s = await fn();
      setSt(s);
      setLimits(s.limits ?? s.proposed);
      if (label === 'keys') (setKeyId(''), setSecret(''));
      if (label === 'enable' || label === 'resume') (setPassword(''), setCode(''), setPhrase(''));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function saveAgents(next: Record<string, boolean>) {
    setErr('');
    try {
      const a = await api.saveAgents({ live: next });
      setAgents(a.settings.live ?? null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  if (!st || !limits) return <div className="panel">{err ? <p className="error">{err}</p> : <p className="muted">Loading…</p>}</div>;
  const keys = Object.keys(st.hard) as (keyof LiveLimits)[];
  const toggle = (k: string) => setConfirmed((c) => (c.includes(k) ? c.filter((x) => x !== k) : [...c, k]));

  return (
    <section className="panel finviz live-card" aria-labelledby="live-h">
      <h2 id="live-h">Live trading (real money)</h2>
      <p className="small">
        <b>{st.enabled ? `On since ${new Date(st.enabledAt!).toLocaleString()} for account …${st.account}.` : 'Off.'}</b>{' '}
        {st.stopped ? <span className="error">Stopped: {st.stopped.reason}. Resume below once the account holds nothing.</span> : null}
      </p>
      <p className="small muted">{st.funding} Live buys are by dollar amount (fractional), regular hours only, inside your limits; exits, halts and the kill switch work as on paper. Nothing here is advice.</p>
      {st.lastError ? <p className="small error">{st.lastError}</p> : null}

      <h3>1. Live key pair</h3>
      <p className="small muted">Your LIVE key pair from Alpaca (the key ID starts with AK). Saved only on this computer, never shown again, never in a log.</p>
      <label className="field">
        <span>Key ID</span>
        <input type="password" value={keyId} onChange={(e) => setKeyId(e.target.value)} autoComplete="off" spellCheck={false} placeholder={st.keys.set ? 'Saved. Type a new pair to replace it.' : 'AK…'} />
      </label>
      <label className="field">
        <span>Secret key</span>
        <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" spellCheck={false} />
      </label>
      <div className="row">
        <button onClick={() => run('keys', () => api.saveLiveKeys(keyId, secret))} disabled={!!busy || !keyId || !secret}>
          Save keys
        </button>
        <button onClick={() => run('test', () => api.testLiveKeys())} disabled={!!busy || !st.keys.set}>
          Check the account (no order)
        </button>
      </div>
      {st.keys.lastTest ? <p className={`small ${st.keys.lastTest.ok ? 'up' : 'error'}`}>{st.keys.lastTest.message}</p> : null}

      {!st.enabled ? (
        <>
          <h3>2. Your limits (Australian dollars)</h3>
          <p className="small muted">Tick each one to confirm it. You can lower them later at any time; raising one means switching live on again.</p>
          <div className="preset-grid">
            {keys.map((k) => (
              <label key={k} className="field">
                <span>
                  <input type="checkbox" checked={confirmed.includes(k)} onChange={() => toggle(k)} aria-label={`confirm ${st.labels[k]}`} /> {st.labels[k]}
                </span>
                <input type="number" min={0} step={k === 'buysPerDay' ? 1 : 0.05} max={st.hard[k]} value={limits[k]} onChange={(e) => setLimits({ ...limits, [k]: Number(e.target.value) })} />
                <span className="small muted">at most {st.hard[k]}</span>
              </label>
            ))}
          </div>
          <h3>3. Switch it on</h3>
          {!st.signInReady ? <p className="small error">This server has no owner sign-in yet (FROST_TRADER_PASSWORD and FROST_TRADER_TOTP_SECRET). See docs/LIVE.md.</p> : null}
          <label className="field">
            <span>Type: {st.phrase}</span>
            <input value={phrase} onChange={(e) => setPhrase(e.target.value)} autoComplete="off" spellCheck={false} placeholder="TRADE LIVE 1234" />
          </label>
          <div className="field-row">
            <label className="field">
              <span>Your FrostTrader password</span>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
            </label>
            <label className="field">
              <span>6-digit code</span>
              <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" />
            </label>
          </div>
          <div className="row">
            <button className="danger" onClick={() => window.confirm('Switch LIVE trading on? Agents you choose will trade with real money, inside these limits.') && run('enable', () => api.enableLive({ password, code, phrase, limits, confirmed }))} disabled={!!busy || !st.keys.set || confirmed.length !== keys.length || !phrase || !password}>
              {busy === 'enable' ? 'Checking…' : 'Switch live trading on'}
            </button>
          </div>
        </>
      ) : (
        <>
          <h3>Your limits</h3>
          <div className="preset-grid">
            {keys.map((k) => (
              <label key={k} className="field">
                <span>{st.labels[k]}</span>
                <input type="number" min={0} step={k === 'buysPerDay' ? 1 : 0.05} max={st.limits![k]} value={limits[k]} onChange={(e) => setLimits({ ...limits, [k]: Number(e.target.value) })} />
              </label>
            ))}
          </div>
          <div className="row">
            <button onClick={() => run('lower', () => api.lowerLive(limits))} disabled={!!busy}>
              Save lower limits
            </button>
            <button className="danger" onClick={() => window.confirm('Switch live off? Every live position is sold now.') && run('disable', () => api.disableLive())} disabled={!!busy}>
              Switch live off (closes every live position)
            </button>
          </div>
          <h3>Which agents trade live</h3>
          <p className="small muted">An agent switched to live also trades with real money, inside the limits above. It keeps trading on paper too.</p>
          <div className="row">
            {agents
              ? Object.entries(agents).map(([id, on]) => (
                  <label key={id} className="check">
                    <input type="checkbox" checked={on} onChange={(e) => (!e.target.checked || window.confirm(`Let ${id} trade with real money?`)) && saveAgents({ ...agents, [id]: e.target.checked })} /> {id}
                  </label>
                ))
              : null}
          </div>
          {st.stopped ? (
            <>
              <h3>Resume live</h3>
              <div className="field-row">
                <label className="field">
                  <span>Your FrostTrader password</span>
                  <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
                </label>
                <label className="field">
                  <span>6-digit code</span>
                  <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" />
                </label>
              </div>
              <button onClick={() => window.confirm('Resume LIVE trading after the stop? Check the reason above first.') && run('resume', () => api.resumeLive(password, code))} disabled={!!busy || !password}>
                Resume live
              </button>
            </>
          ) : null}
          <p className="small muted">
            Live today: {st.agents.map((a) => `${a.id} ${a.positions.length} held, A$${a.boughtTodayAud.toFixed(2)} bought`).join(' · ') || 'no live trades yet'}.
            {st.broker ? ` Account …${st.broker.number}: cash US$${Number(st.broker.cash).toFixed(2)}.` : ''}
          </p>
        </>
      )}
      {err ? <p className="small error">{err}</p> : null}
    </section>
  );
}
