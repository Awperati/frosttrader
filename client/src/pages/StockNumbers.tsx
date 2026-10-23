// The "Stock numbers" view, stage 0: read-only numbers from a historical dataset.
// A symbol list on the left, the selected symbol's chart, history and stats on the right.
// Nothing here predicts anything or places an order.
import { useEffect, useMemo, useState } from 'react';
import { api, type Detail, type HistoryPage, type Overview, type SymbolRow, type TickerPreview } from '../api';
import { PriceChart, Sparkline } from '../components/PriceChart';
import { age, compact, day, num, pct, plainPct, signed, tone } from '../format';

const RANGES = ['1M', '3M', '1Y', 'All'];

export function StockNumbers() {
  const [ov, setOv] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    api
      .overview()
      .then((o) => {
        setOv(o);
        setSelected((s) => s ?? o.symbols.find((x) => x.symbol === '^GSPC')?.symbol ?? o.symbols[0]?.symbol ?? null);
      })
      .catch((e) => setError(e.message));
  }, []);

  const list = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (ov?.symbols ?? []).filter((s) => !q || s.symbol.toLowerCase().includes(q) || s.name.toLowerCase().includes(q));
  }, [ov, filter]);

  if (error) return <div className="panel error">Could not load the numbers: {error}</div>;
  if (!ov) return <div className="panel muted">Loading…</div>;

  return (
    <div className="numbers">
      <DataBanner ov={ov} />
      {!ov.available ? (
        <div className="panel">
          <h2>No dataset yet</h2>
          <p>{ov.how}</p>
        </div>
      ) : (
        <div className="numbers-grid">
          <aside className="panel symbols">
            <div className="symbols-head">
              <h2>Indices</h2>
              <span className="muted small">{ov.symbols.length} from the dataset</span>
            </div>
            <input className="search" placeholder="Filter by name or symbol" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter symbols" />
            <ul className="symbol-list">
              {list.map((s) => (
                <SymbolItem key={s.symbol} s={s} active={s.symbol === selected} onPick={() => setSelected(s.symbol)} />
              ))}
              {!list.length && <li className="muted small pad">No match.</li>}
            </ul>
            <WatchlistPanel hook={ov.watchlist} />
          </aside>
          <section className="detail">{selected ? <DetailPane symbol={selected} /> : <div className="panel muted">Pick a symbol.</div>}</section>
        </div>
      )}
    </div>
  );
}

function DataBanner({ ov }: { ov: Overview }) {
  const l = ov.labels;
  return (
    <div className="banner" role="note">
      <div>
        <strong>{l.source}</strong>
        <span className="sep">·</span>
        <span>Data age: {age(l.ageDays)}</span>
        <span className="sep">·</span>
        <span>{l.kind}</span>
      </div>
      <div className="small muted">
        Source:{' '}
        <a href={ov.dataset.url} target="_blank" rel="noreferrer noopener">
          {ov.dataset.title}
        </a>{' '}
        on Hugging Face, licence {ov.dataset.licence}. {ov.dataset.provenance} {ov.dataset.units}
        {ov.dataset.droppedTotal ? ` ${ov.dataset.droppedTotal} rows were left out (holidays with no prices, or bad rows).` : ''}
      </div>
      <div className="small notice">{l.notice}</div>
    </div>
  );
}

function SymbolItem({ s, active, onPick }: { s: SymbolRow; active: boolean; onPick: () => void }) {
  const q = s.quote;
  return (
    <li>
      <button className={`symbol ${active ? 'active' : ''}`} onClick={onPick} aria-pressed={active} title={`${s.name} (${s.symbol}), last day ${day(q.t)}`}>
        <span className="sym-name">
          <b>{s.name}</b>
          <span className="muted small">{s.symbol}</span>
        </span>
        <Sparkline values={s.spark} />
        <span className="sym-q">
          <b>{num(q.last)}</b>
          <span className={`small ${tone(q.change)}`}>{pct(q.changePct)}</span>
        </span>
      </button>
    </li>
  );
}

function DetailPane({ symbol }: { symbol: string }) {
  const [range, setRange] = useState('1Y');
  const [kind, setKind] = useState<'candle' | 'line'>('candle');
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    setError('');
    api
      .detail(symbol, range)
      .then((x) => live && setD(x))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [symbol, range]);

  if (error) return <div className="panel error">{error}</div>;
  if (!d || d.symbol !== symbol) return <div className="panel muted">Loading {symbol}…</div>;
  const q = d.quote;
  const perBar = d.chart.length ? Math.round(d.chartBars / d.chart.length) : 1;

  return (
    <>
      <div className="panel">
        <div className="detail-head">
          <div>
            <h2>{d.name}</h2>
            <div className="muted small">
              {d.symbol} · last day in the data {day(q.t)} · index points
            </div>
          </div>
          <div className="last">
            <span className="big">{num(q.last)}</span>
            <span className={tone(q.change)}>
              {signed(q.change)} ({pct(q.changePct)})
            </span>
          </div>
        </div>
        <dl className="facts">
          <div>
            <dt>Day range</dt>
            <dd>
              {num(q.dayLow)} – {num(q.dayHigh)}
            </dd>
          </div>
          <div>
            <dt>Open</dt>
            <dd>{num(q.open)}</dd>
          </div>
          <div>
            <dt>Previous close</dt>
            <dd>{num(q.prevClose)}</dd>
          </div>
          <div>
            <dt>52-week range</dt>
            <dd>
              {num(q.low52)} – {num(q.high52)}
            </dd>
          </div>
          <div>
            <dt>Volume</dt>
            <dd>{d.hasVolume ? compact(q.volume) : <span className="muted">not in the data</span>}</dd>
          </div>
        </dl>
        <div className="toolbar">
          <div className="seg" role="group" aria-label="Range">
            {RANGES.map((r) => (
              <button key={r} className={r === d.range ? 'on' : ''} onClick={() => setRange(r)} aria-pressed={r === d.range}>
                {r}
              </button>
            ))}
          </div>
          <div className="seg" role="group" aria-label="Chart type">
            <button className={kind === 'candle' ? 'on' : ''} onClick={() => setKind('candle')} aria-pressed={kind === 'candle'}>
              Candles
            </button>
            <button className={kind === 'line' ? 'on' : ''} onClick={() => setKind('line')} aria-pressed={kind === 'line'}>
              Line
            </button>
          </div>
        </div>
        <PriceChart bars={d.chart} kind={kind} showVolume={d.hasVolume} label={`${d.name}, ${d.range}`} />
        <div className="small muted">
          {d.chartBars} trading days{perBar > 1 ? `; each candle merges about ${perBar} days to fit` : ''}. Range counted back from the last day in the data, not from today.
        </div>
      </div>
      <StatsPanel d={d} />
      <HistoryTable symbol={symbol} hasVolume={d.hasVolume} />
    </>
  );
}

function StatsPanel({ d }: { d: Detail }) {
  const s = d.stats;
  const g = d.quality;
  return (
    <div className="panel">
      <h3>Basic stats ({d.range})</h3>
      <p className="small muted">Describes the past only. Index levels, no costs, no dividends unless the index itself includes them.</p>
      <dl className="facts">
        {RANGES.map((r) => (
          <div key={r}>
            <dt>Return {r}</dt>
            <dd className={tone(d.returns[r])}>{pct(d.returns[r])}</dd>
          </div>
        ))}
      </dl>
      {s && (
        <dl className="facts">
          <div>
            <dt>Return per year</dt>
            <dd>{s.annualReturnPct == null ? <span className="muted">range too short</span> : pct(s.annualReturnPct)}</dd>
          </div>
          <div>
            <dt>Volatility (yearly)</dt>
            <dd>{plainPct(s.volatilityPct)}</dd>
          </div>
          <div>
            <dt>Max drawdown</dt>
            <dd>{pct(-s.maxDrawdownPct, 1)}</dd>
          </div>
          <div>
            <dt>Best day</dt>
            <dd>
              {pct(s.bestDay.pct)} <span className="muted small">{day(s.bestDay.t)}</span>
            </dd>
          </div>
          <div>
            <dt>Worst day</dt>
            <dd>
              {pct(s.worstDay.pct)} <span className="muted small">{day(s.worstDay.t)}</span>
            </dd>
          </div>
          <div>
            <dt>Up days</dt>
            <dd>{plainPct(s.upDaysPct)}</dd>
          </div>
        </dl>
      )}
      <p className="small muted">
        Data for {d.symbol}: {day(g.from)} to {day(g.to)}, {g.bars} days
        {g.longestGap.days > 4 ? `, longest gap ${g.longestGap.days} days (${day(g.longestGap.from)} to ${day(g.longestGap.to)})` : ''}
        {Object.keys(g.dropped).length ? `; left out: ${Object.entries(g.dropped).map(([k, v]) => `${v} ${k}`).join(', ')}` : ''}.
      </p>
    </div>
  );
}

function HistoryTable({ symbol, hasVolume }: { symbol: string; hasVolume: boolean }) {
  const [page, setPage] = useState(0);
  const [h, setH] = useState<HistoryPage | null>(null);

  useEffect(() => setPage(0), [symbol]);
  useEffect(() => {
    let live = true;
    api.history(symbol, page, 20).then((x) => live && setH(x));
    return () => {
      live = false;
    };
  }, [symbol, page]);

  if (!h || h.symbol !== symbol) return <div className="panel muted">Loading history…</div>;
  return (
    <div className="panel">
      <div className="table-head">
        <h3>Daily history</h3>
        <div className="pager">
          <button onClick={() => setPage(0)} disabled={h.page === 0}>
            Newest
          </button>
          <button onClick={() => setPage(h.page - 1)} disabled={h.page === 0}>
            ‹ Newer
          </button>
          <span className="small muted">
            Page {h.page + 1} of {h.pages}
          </span>
          <button onClick={() => setPage(h.page + 1)} disabled={h.page >= h.pages - 1}>
            Older ›
          </button>
          <button onClick={() => setPage(h.pages - 1)} disabled={h.page >= h.pages - 1}>
            Oldest
          </button>
        </div>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Open</th>
              <th>High</th>
              <th>Low</th>
              <th>Close</th>
              {hasVolume && <th>Volume</th>}
            </tr>
          </thead>
          <tbody>
            {h.rows.map((r) => (
              <tr key={r.t}>
                <td>{day(r.t)}</td>
                <td>{num(r.o)}</td>
                <td>{num(r.h)}</td>
                <td>{num(r.l)}</td>
                <td>{num(r.c)}</td>
                {hasVolume && <td>{r.v == null ? '–' : compact(r.v)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** The hook for the owner's own symbols. It only previews a paste or CSV export; nothing is stored yet. */
function WatchlistPanel({ hook }: { hook: Overview['watchlist'] }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<TickerPreview | null>(null);
  const [err, setErr] = useState('');

  async function check() {
    setErr('');
    try {
      setPreview(await api.previewTickers(text));
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  function onFile(f: File | undefined) {
    if (!f) return;
    f.text().then(setText);
  }

  return (
    <div className="watch">
      <h3>Your symbols</h3>
      <p className="small muted">Not set up yet. {hook.how}</p>
      <p className="small muted">{hook.pricesFrom}</p>
      {!open ? (
        <button onClick={() => setOpen(true)}>Try a paste</button>
      ) : (
        <div className="watch-form">
          <textarea rows={4} placeholder="AAPL, MSFT, NVDA…" value={text} onChange={(e) => setText(e.target.value)} aria-label="Tickers" />
          <div className="row">
            <label className="file">
              Finviz CSV export
              <input type="file" accept=".csv,text/csv" onChange={(e) => onFile(e.target.files?.[0])} />
            </label>
            <button onClick={check} disabled={!text.trim()}>
              Check
            </button>
          </div>
          {err && <p className="error small">{err}</p>}
          {preview && (
            <div className="small">
              <p>
                {preview.symbols.length} ticker{preview.symbols.length === 1 ? '' : 's'} read from the {preview.source === 'csv' ? 'CSV' : 'paste'}: {preview.symbols.join(', ') || '–'}
              </p>
              {!!preview.rejected.length && <p className="muted">Skipped: {preview.rejected.map((r) => `${r.value} (${r.reason})`).join('; ')}</p>}
              <p className="muted">Checked only. Not saved, and no prices are fetched for them in stage 0.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
