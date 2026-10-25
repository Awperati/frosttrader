// The read-only API behind the "Stock numbers" view. Plain functions from a request to
// { status, body }, so tests call them directly without opening a socket.
//
//   GET  /api/numbers                         the dataset's labels and every symbol's latest quote
//   GET  /api/numbers/<SYMBOL>?range=1Y       chart bars, stats and returns for one symbol
//   GET  /api/numbers/<SYMBOL>/history?page=0&size=25
//                                             a page of daily OHLC history, newest first
//   POST /api/numbers/watchlist/preview       { text } -> the tickers a paste or Finviz CSV
//                                             export would give. Checked only, never stored.
//   POST /api/numbers/dataset/download        download the index dataset from Hugging Face into
//                                             DATA_DIR/datasets (this computer only)
//
// Nothing here can place an order: the module imports no broker.
import { HttpError } from './store.mjs';
import { DATASET, datasetPath, datasetProblem, downloadIndexDataset, isoDay, loadIndexDataset } from './engine/data/indexes.mjs';
import { checkLocal } from './finviz-api.mjs';
import { RANGES, ageDays, compress, historyPage, quote, rangeReturns, seriesStats, sliceRange } from './engine/numbers.mjs';
import { parseTickers } from './engine/watchlist-input.mjs';

export const NOTICE = 'Paper only. Not financial advice.';

const fmtDay = (t) => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

export function createNumbersApi({ dataDir, file = datasetPath(dataDir), now = () => Date.now(), watchlist = () => null, fetchImpl } = {}) {
  const dataset = () => loadIndexDataset(file);
  let downloading = null;

  function labels(ds) {
    const lastT = ds?.quality.lastT ?? null;
    return {
      source: ds ? `Historical dataset, ends ${fmtDay(lastT)}` : 'No dataset loaded',
      lastDay: lastT == null ? null : isoDay(lastT),
      ageDays: ageDays(lastT, now()),
      notice: NOTICE,
      kind: 'Daily index levels (indices cannot be traded in this app)',
    };
  }

  function overview() {
    const ds = dataset();
    if (!ds) {
      return {
        available: false,
        dataset: { ...DATASET, path: file },
        labels: labels(null),
        how: `Press "Download the dataset" to fetch ${DATASET.file} (about 4 MB) from Hugging Face into ${file}.`,
        problem: datasetProblem(file),
        symbols: [],
        watchlist: watchlistHook(watchlist()),
      };
    }
    const symbols = Object.values(ds.series)
      .map((s) => ({
        symbol: s.symbol,
        name: s.name,
        hasVolume: s.hasVolume,
        quote: quote(s.bars),
        spark: s.bars.slice(-60).map((b) => b.c),
        from: isoDay(s.bars[0].t),
        to: isoDay(s.bars[s.bars.length - 1].t),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const q = ds.quality;
    return {
      available: true,
      dataset: { ...ds.meta, rows: ds.rows, from: q.from, to: q.to, droppedByReason: q.droppedByReason, droppedTotal: q.droppedTotal },
      labels: labels(ds),
      ranges: Object.keys(RANGES),
      symbols,
      watchlist: watchlistHook(watchlist()),
    };
  }

  function series(symbol) {
    const ds = dataset();
    if (!ds) throw new HttpError(404, 'The index dataset is not downloaded yet');
    const s = ds.series[symbol];
    if (!s) throw new HttpError(404, `Unknown symbol ${symbol}`);
    return { ds, s };
  }

  function detail(symbol, range) {
    const { ds, s } = series(symbol);
    const r = Object.hasOwn(RANGES, range) ? range : '1Y';
    const bars = sliceRange(s.bars, r);
    return {
      symbol,
      name: s.name,
      hasVolume: s.hasVolume,
      range: r,
      labels: labels(ds),
      quote: quote(s.bars),
      chart: compress(bars, 260),
      chartBars: bars.length,
      stats: seriesStats(bars),
      returns: rangeReturns(s.bars),
      quality: ds.quality.perSymbol[symbol],
    };
  }

  function history(symbol, page, size) {
    const { s } = series(symbol);
    return { symbol, ...historyPage(s.bars, page, size) };
  }

  return {
    overview,
    detail,
    history,
    /** Route one request. Returns { status, body } or throws HttpError. */
    async handle(method, pathname, query = new URLSearchParams(), body = null, headers = {}) {
      const parts = pathname.replace(/^\/api\/numbers\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
      if (method === 'GET' && parts.length === 0) return { status: 200, body: overview() };
      if (method === 'POST' && parts[0] === 'watchlist' && parts[1] === 'preview' && parts.length === 2) {
        const text = body && typeof body.text === 'string' ? body.text : '';
        if (text.length > 100_000) throw new HttpError(413, 'That list is too long');
        return { status: 200, body: { ...parseTickers(text), stored: false } };
      }
      if (method === 'POST' && parts[0] === 'dataset' && parts[1] === 'download' && parts.length === 2) {
        checkLocal(headers);
        if (downloading) throw new HttpError(409, 'A download is already running');
        downloading = downloadIndexDataset(file, fetchImpl ? { fetchImpl } : {});
        try {
          const got = await downloading;
          return { status: 200, body: { ok: true, saved: got, overview: overview() } };
        } catch (e) {
          throw new HttpError(502, `The download failed: ${e.message}`);
        } finally {
          downloading = null;
        }
      }
      if (method === 'GET' && parts.length === 1) return { status: 200, body: detail(parts[0], query.get('range') || '1Y') };
      if (method === 'GET' && parts.length === 2 && parts[1] === 'history') return { status: 200, body: history(parts[0], query.get('page'), query.get('size')) };
      throw new HttpError(404, 'Not found');
    },
  };
}

/** What the view shows for the owner's own symbols: his Finviz Elite screeners once they have been fetched. */
export function watchlistHook(finviz = null) {
  const list = finviz?.list;
  return {
    status: list?.symbols?.length ? 'set' : 'not-set',
    symbols: list?.symbols || [],
    ageMin: list ? list.ageMin : null,
    stale: !!list?.stale,
    holders: finviz?.holders || {}, // symbol -> the paper agent holding it
    how: 'Add your Finviz Elite screener URL and API token in Settings, or paste tickers to check them. Frost Trader never logs in to or scrapes Finviz.',
    pricesFrom: 'Prices for your symbols need a licensed source, such as your broker\'s market-data API (Alpaca). Not set up yet.',
  };
}
