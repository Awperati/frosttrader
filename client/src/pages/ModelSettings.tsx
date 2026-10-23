import { useEffect, useState } from 'react';
import { api, type LlmStatus } from '../api';

// Settings → Local model ideas (server/engine/research/hypotheses.mjs). OFF by default. When on, his
// local model (Frost AI on this computer) gets a stats-only summary each night and may propose up to 3
// parameter sets; each is only tested as one more candidate. The key field is write-only.

const when = (t: number) => new Date(t).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export function ModelCard() {
  const [st, setSt] = useState<LlmStatus | null>(null);
  const [url, setUrl] = useState('');
  const [model, setModel] = useState('');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const take = (s: LlmStatus) => {
    setSt(s);
    setUrl(s.url);
    setModel(s.model);
  };
  useEffect(() => {
    api.llm().then(take, (e) => setErr((e as Error).message));
  }, []);
  async function run(label: string, fn: () => Promise<LlmStatus>) {
    setBusy(label);
    setErr('');
    try {
      take(await fn());
      setKey('');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy('');
    }
  }
  if (!st) return <div className="panel">{err ? <p className="error">{err}</p> : <p className="muted">Loading…</p>}</div>;
  const last = st.last;
  return (
    <section className="panel finviz" aria-labelledby="llm-h">
      <h2 id="llm-h">Local model ideas</h2>
      <p className="small muted">
        {st.note} Each night your model sees statistics only (no tickers, dates or money settings) and may suggest up to 3 settings; each is tested on held-out days and kept only if it wins under the fixed
        rules. Its reasons appear in the decision log as "model's words".
      </p>
      <label className="field inline">
        <input type="checkbox" checked={st.enabled} onChange={(e) => run('toggle', () => api.saveLlm({ enabled: e.target.checked }))} disabled={!!busy} style={{ width: 'auto' }} />
        <span>{st.enabled ? 'On: asks the model each night after the close' : 'Off'}</span>
      </label>
      <label className="field">
        <span>Address (on this computer)</span>
        <input value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} placeholder="http://127.0.0.1:8765/v1/chat/completions" />
        <span className="small muted">Frost AI's Console gateway is :8765 (needs a Frost AI API key); llama-server directly is :8080.</span>
      </label>
      <label className="field">
        <span>Model name (optional)</span>
        <input value={model} onChange={(e) => setModel(e.target.value)} spellCheck={false} />
      </label>
      <label className="field">
        <span>Frost AI API key</span>
        <input type="password" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" spellCheck={false} placeholder={st.keySet ? 'Saved. Type a new one to replace it.' : 'Only for the Console gateway'} />
      </label>
      <div className="row">
        <button onClick={() => run('save', () => api.saveLlm({ url, model, ...(key.trim() ? { key: key.trim() } : {}) }))} disabled={!!busy}>
          {busy === 'save' ? 'Saving…' : 'Save'}
        </button>
        <button onClick={() => run('test', api.testLlm)} disabled={!!busy}>
          {busy === 'test' ? 'Testing…' : 'Test'}
        </button>
        {st.keySet && (
          <button onClick={() => run('clear', () => api.saveLlm({ clearKey: true }))} disabled={!!busy}>
            Remove key
          </button>
        )}
      </div>
      {err && <p className="error small">{err}</p>}
      {last && (
        <p className={`small ${last.ok ? '' : 'error'}`}>
          {when(last.at)}: {last.test ? (last.ok ? `the model answered (${last.answer})` : last.error) : last.ok ? `${last.proposals?.length ?? 0} idea(s)${last.dropped?.length ? `; dropped: ${last.dropped.join('; ')}` : ''}` : last.error}
        </p>
      )}
    </section>
  );
}
