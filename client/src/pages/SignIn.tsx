import { useState } from 'react';
import { api } from '../api';

// The private website's sign-in (server/web-gate.mjs): his FrostTrader password and the 6-digit code.
// On this computer (127.0.0.1) FrostTrader needs no sign-in, and this screen never shows.
export function SignIn({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      await api.signIn(password, code);
      setPassword('');
      setCode('');
      onDone();
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="signin">
      <form className="panel" onSubmit={submit}>
        <h1>
          <span aria-hidden="true">❄</span> Frost Trader
        </h1>
        <p className="small muted">Sign in with your FrostTrader password and the 6-digit code. You are signed out after 30 minutes without use.</p>
        <label className="field">
          <span>Password</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" autoFocus />
        </label>
        <label className="field">
          <span>6-digit code</span>
          <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" />
        </label>
        <button type="submit" disabled={busy || !password || code.length !== 6}>
          {busy ? 'Checking…' : 'Sign in'}
        </button>
        {err ? <p className="small error">{err}</p> : null}
      </form>
    </main>
  );
}
