// The stock-market index dataset: daily bars for about 32 major indices in one CSV file.
//
//   Source:  Hugging Face, pettah/global-top-Index-exploring-trends-in-stock-Market,
//            file Stock_Market_Indexes.csv (MIT on the dataset card; the card says the numbers
//            were scraped from Yahoo Finance, so treat them as third-party data for local use).
//   Where:   DATA_DIR/datasets/Stock_Market_Indexes.csv (git-ignored, never committed).
//   Columns: Date,Name,Symbol,Open,High,Low,Close,Adj Close,Volume
//            Date is DD-MM-YYYY. Prices are index points in the index's own currency (the file
//            does not say which). Volume is a whole number or "-" when Yahoo had none.
//
// This is a separate loader on purpose: the generic csv.mjs reads one file per symbol with
// Date.parse, which would read 02-04-2024 as 4 February and drop 25-04-2024 as NaN. Here dates
// are read day-first and stamped at 00:00 UTC of that calendar day.
//
// Rows are checked, never silently fixed:
//   - "no prices": every price is "-" (exchange holidays the scrape kept). Dropped.
//   - "bad numbers": some price is not a positive number, or high < low, or open or close
//     sits outside the high-low range. Dropped.
//   - "spike": the close jumps more than 50 % from the day before and jumps back more than
//     50 % the day after (MERVAL on 14 Jul 2022 reads 5,184 between two days near 104,000).
//     Dropped.
//   - "duplicate": a second row for the same symbol and day. The first one is kept.
// Every dropped row is listed in quality.dropped with its reason, so the UI can say so.
import fs from 'node:fs';
import path from 'node:path';

export const DATASET = {
  id: 'hf-indexes',
  title: 'Global stock market indexes (daily)',
  file: 'Stock_Market_Indexes.csv',
  url: 'https://huggingface.co/datasets/pettah/global-top-Index-exploring-trends-in-stock-Market',
  download: 'https://huggingface.co/datasets/pettah/global-top-Index-exploring-trends-in-stock-Market/resolve/main/Stock_Market_Indexes.csv',
  licence: 'MIT (as stated by the uploader on the dataset card)',
  provenance: 'Scraped from Yahoo Finance by the uploader. Not a licensed market-data feed.',
  units: 'Index points, in each index\'s own currency (not stated in the file).',
  kind: 'index',
};

const COLUMNS = ['date', 'name', 'symbol', 'open', 'high', 'low', 'close', 'adj close', 'volume'];
const SPIKE = 0.5;

/** Default location of the downloaded file. */
export function datasetPath(dataDir) {
  return path.join(dataDir, 'datasets', DATASET.file);
}

/** "05-04-2024" -> ms at 00:00 UTC on 5 April 2024, or NaN. */
export function parseDayFirst(s) {
  const m = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(String(s).trim());
  if (!m) return NaN;
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  // Reject 31-02-2024 and the like instead of rolling over into March.
  return back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d ? t : NaN;
}

export const isoDay = (t) => new Date(t).toISOString().slice(0, 10);

/**
 * The file's symbols have lost Yahoo's caret ("GSPC", "DJI", "VIX"), and bare like that several
 * look like US stock tickers and would pass the risk guard's STOCK check. Every index symbol is
 * therefore given a leading "^" here ("^GSPC"), so it can never be mistaken for a tradable stock.
 * sourceSymbol keeps the file's spelling.
 */
export function indexSymbol(raw) {
  const s = String(raw || '').trim().toUpperCase();
  return s ? (s.startsWith('^') ? s : `^${s}`) : '';
}

/**
 * Parse the whole CSV text.
 * Returns { columns, rows, series: { SYMBOL: { symbol, name, hasVolume, bars } }, quality }.
 * A bar is { t, o, h, l, c, v } like everywhere else in the engine; v is null when the file has
 * no volume for that day. Bars are oldest first.
 */
export function parseIndexCsv(text) {
  const lines = String(text).replace(/^﻿/, '').trim().split(/\r?\n/);
  const header = (lines.shift() || '').split(',').map((s) => s.trim());
  const lower = header.map((h) => h.toLowerCase());
  const ix = Object.fromEntries(COLUMNS.map((c) => [c, lower.indexOf(c)]));
  const missing = COLUMNS.filter((c) => ix[c] < 0 && c !== 'adj close');
  if (missing.length) throw new Error(`Index CSV is missing columns: ${missing.join(', ')}`);

  const dropped = [];
  const raw = {}; // symbol -> { name, rows: [{ t, o, h, l, c, v, line }] }
  let rows = 0;
  lines.forEach((line, n) => {
    if (!line.trim()) return;
    rows++;
    const f = line.split(',');
    const lineNo = n + 2;
    const symbol = indexSymbol(f[ix.symbol]);
    const t = parseDayFirst(f[ix.date]);
    if (!symbol || !Number.isFinite(t)) return dropped.push({ line: lineNo, symbol, day: f[ix.date], reason: 'bad date or symbol' });
    const prices = [ix.open, ix.high, ix.low, ix.close].map((k) => (f[k] || '').trim());
    if (prices.every((p) => p === '-' || p === '')) return dropped.push({ line: lineNo, symbol, day: isoDay(t), reason: 'no prices' });
    const [o, h, l, c] = prices.map(Number);
    const ok = [o, h, l, c].every((x) => Number.isFinite(x) && x > 0) && h >= l && o <= h * 1.0001 && o >= l * 0.9999 && c <= h * 1.0001 && c >= l * 0.9999;
    if (!ok) return dropped.push({ line: lineNo, symbol, day: isoDay(t), reason: 'bad numbers' });
    const vs = (f[ix.volume] || '').trim();
    const v = /^\d+(\.\d+)?$/.test(vs) ? Number(vs) : null;
    const s = (raw[symbol] ||= { name: (f[ix.name] || '').trim(), rows: [] });
    s.rows.push({ t, o, h, l, c, v, line: lineNo });
  });

  const series = {};
  for (const [symbol, s] of Object.entries(raw)) {
    s.rows.sort((a, b) => a.t - b.t || a.line - b.line);
    const unique = [];
    for (const r of s.rows) {
      if (unique.length && unique[unique.length - 1].t === r.t) dropped.push({ line: r.line, symbol, day: isoDay(r.t), reason: 'duplicate' });
      else unique.push(r);
    }
    const bars = [];
    for (let i = 0; i < unique.length; i++) {
      const prev = bars[bars.length - 1];
      const next = unique[i + 1];
      const r = unique[i];
      if (prev && next) {
        const up = r.c / prev.c - 1;
        const back = next.c / r.c - 1;
        if (Math.abs(up) > SPIKE && Math.abs(back) > SPIKE && Math.sign(up) !== Math.sign(back)) {
          dropped.push({ line: r.line, symbol, day: isoDay(r.t), reason: 'spike' });
          continue;
        }
      }
      bars.push({ t: r.t, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v });
    }
    if (!bars.length) continue;
    series[symbol] = { symbol, sourceSymbol: symbol.slice(1), name: s.name, kind: 'index', hasVolume: bars.some((b) => b.v > 0), bars };
  }

  dropped.sort((a, b) => a.line - b.line);
  return { columns: header, rows, series, quality: qualityReport(series, dropped) };
}

/** Per-symbol date range, gaps and counts, plus the dropped rows. */
export function qualityReport(series, dropped = []) {
  const perSymbol = {};
  let first = Infinity;
  let last = -Infinity;
  for (const [symbol, s] of Object.entries(series)) {
    const b = s.bars;
    let gap = { days: 0, from: null, to: null };
    for (let i = 1; i < b.length; i++) {
      const days = Math.round((b[i].t - b[i - 1].t) / 86_400_000);
      if (days > gap.days) gap = { days, from: isoDay(b[i - 1].t), to: isoDay(b[i].t) };
    }
    const reasons = {};
    for (const d of dropped) if (d.symbol === symbol) reasons[d.reason] = (reasons[d.reason] || 0) + 1;
    perSymbol[symbol] = {
      name: s.name,
      from: isoDay(b[0].t),
      to: isoDay(b[b.length - 1].t),
      bars: b.length,
      withVolume: b.filter((x) => x.v > 0).length,
      longestGap: gap,
      dropped: reasons,
    };
    first = Math.min(first, b[0].t);
    last = Math.max(last, b[b.length - 1].t);
  }
  const byReason = {};
  for (const d of dropped) byReason[d.reason] = (byReason[d.reason] || 0) + 1;
  return {
    symbols: Object.keys(series).length,
    from: Number.isFinite(first) ? isoDay(first) : null,
    to: Number.isFinite(last) ? isoDay(last) : null,
    lastT: Number.isFinite(last) ? last : null,
    droppedByReason: byReason,
    dropped: dropped.slice(0, 200),
    droppedTotal: dropped.length,
    perSymbol,
  };
}

const cache = new Map();

/**
 * Load the dataset from disk once per file (re-read when the file changes).
 * Returns null when the file is not there (the UI then says how to get it).
 */
/**
 * Download the dataset: one HTTPS GET of the CSV from Hugging Face. The columns are checked before
 * anything is saved, and the file is replaced in one step. Returns { path, rows, symbols, from, to }.
 */
export async function downloadIndexDataset(file, { fetchImpl = (...a) => globalThis.fetch(...a), url = DATASET.download, timeoutMs = 120_000 } = {}) {
  let res;
  try {
    res = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new Error(`Could not reach Hugging Face: ${e.message}`);
  }
  if (!res.ok) throw new Error(`Hugging Face answered HTTP ${res.status}`);
  const text = await res.text();
  const parsed = parseIndexCsv(text); // throws if the columns are not what the loader expects
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, text);
  fs.renameSync(`${file}.tmp`, file);
  return { path: file, rows: parsed.rows, symbols: parsed.quality.symbols, from: parsed.quality.from, to: parsed.quality.to };
}

/** Why the dataset file can't be read: '' when it can, else the error code (ENOENT: not there). */
export function datasetProblem(file) {
  try {
    fs.accessSync(file, fs.constants.R_OK);
    return '';
  } catch (e) {
    return e.code || e.message;
  }
}

export function loadIndexDataset(file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.data;
  const parsed = parseIndexCsv(fs.readFileSync(file, 'utf8'));
  const data = { ...parsed, meta: { ...DATASET, path: file, bytes: st.size } };
  cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, data });
  return data;
}

/** { SYMBOL: bars } in the engine's bar format, for the backtest harness. */
export function indexBars(dataset, symbols) {
  const out = {};
  if (!dataset) return out;
  for (const [s, v] of Object.entries(dataset.series)) {
    if (symbols && !symbols.includes(s)) continue;
    out[s] = v.bars.map((b) => ({ ...b, v: b.v ?? 0 }));
  }
  return out;
}
