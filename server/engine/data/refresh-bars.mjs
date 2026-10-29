// Keep the training bars fresh without the manual .cmd: fetch the latest 5-minute IEX bars that come
// after the newest bar already saved, append them, backing the file up first. Market-data only
// (AlpacaData, server/alpaca-keys.mjs); there is no order call here. One source of truth: the file at
// DATA_DIR/ALL_STOCKS_5m_iex.csv, the same file a retrain reads. Works on the PC and in the Pi
// container (DATA_DIR=/data). Exposed to the agents through the connector's refresh_bars tool; the
// .cmd stays as a manual fallback onto the same file.
//
// Safety rails: rate-limited (at most once every 5 minutes), skipped when the newest bar is under one
// 5-minute interval old, and single-flight (a lock file stops two appends running at once). The merge
// is a pure, testable function (mergeInto) so the non-network behaviour needs no key and no network.
import fs from 'node:fs';
import path from 'node:path';

export const BARS_CSV = 'ALL_STOCKS_5m_iex.csv';
export const COLS = ['ticker', 'timestamp', 'open', 'high', 'low', 'close', 'volume'];
export const INTERVAL_MS = 5 * 60_000;
export const MIN_REFRESH_MS = 5 * 60_000;
const STALE_LOCK_MS = 10 * 60_000;

/** A pandas-style UTC stamp: "2026-04-01 13:30:00+00:00" (matches scripts/append_fresh_bars.py). */
export function fmtTs(ms) {
  return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '+00:00');
}
/** Parse either "2026-04-01 13:30:00+00:00" or an ISO "…T…Z" to epoch ms. */
export function parseTs(s) {
  const raw = String(s).trim();
  return /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw.replace(' ', 'T'));
}
const numCell = (x) => (Number.isFinite(x) ? String(x) : '');

/** Rows of the ALL_STOCKS CSV as { ticker, t(ms), cells:[o,h,l,c,v as strings] }, header checked. */
export function parseRows(text) {
  const lines = String(text).trim().split(/\r?\n/);
  if (!lines.length || !lines[0]) return [];
  const head = lines.shift().split(',').map((s) => s.trim().toLowerCase());
  for (const c of COLS) if (!head.includes(c)) throw new Error(`the bars CSV is missing the "${c}" column`);
  const ix = Object.fromEntries(COLS.map((c) => [c, head.indexOf(c)]));
  const rows = [];
  for (const line of lines) {
    if (!line) continue;
    const f = line.split(',');
    const t = parseTs(f[ix.timestamp]);
    const ticker = String(f[ix.ticker] || '').trim();
    if (!ticker || !Number.isFinite(t)) continue;
    rows.push({ ticker, t, cells: [f[ix.open], f[ix.high], f[ix.low], f[ix.close], f[ix.volume]].map((s) => String(s).trim()) });
  }
  return rows;
}

/**
 * Merge new bars into the CSV text: keep every old row, add new ones, dedup on ticker+timestamp (the
 * new copy wins, as the Python merge does with keep="last"), sort by ticker then time. Pure.
 * newBars: [{ ticker, t(ms), o, h, l, c, v }]. Returns { text, counts }.
 */
export function mergeInto(oldText, newBars) {
  const old = parseRows(oldText);
  const map = new Map(); // `${ticker}\u0000${t}` -> { ticker, t, cells }
  const key = (r) => `${r.ticker}\u0000${r.t}`;
  for (const r of old) map.set(key(r), r);
  for (const b of newBars) {
    if (!b.ticker || !Number.isFinite(b.t)) continue;
    map.set(key(b), { ticker: b.ticker, t: b.t, cells: [b.o, b.h, b.l, b.c, b.v].map(numCell) });
  }
  const rows = [...map.values()].sort((a, b) => (a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : a.t - b.t));
  const body = rows.map((r) => [r.ticker, fmtTs(r.t), ...r.cells].join(','));
  const text = [COLS.join(','), ...body].join('\n') + '\n';
  const ts = rows.map((r) => r.t);
  return {
    text,
    counts: {
      old: old.length,
      total: rows.length,
      added: rows.length - old.length,
      start: ts.length ? fmtTs(Math.min(...ts)) : '',
      end: ts.length ? fmtTs(Math.max(...ts)) : '',
    },
  };
}

/** A dated backup beside the file, kept untouched. Returns its path, or null when there's no file yet. */
export function backup(csvPath, now = Date.now) {
  if (!fs.existsSync(csvPath)) return null;
  const stamp = new Date(now()).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '').replace('T', '-');
  const dst = csvPath.replace(/\.csv$/i, '') + `.${stamp}.bak.csv`;
  fs.copyFileSync(csvPath, dst);
  return dst;
}

export class BarsRefresher {
  /**
   * getData(): an AlpacaData client (market data only), or null when no keys are saved.
   * The CSV is DATA_DIR/ALL_STOCKS_5m_iex.csv — the single source of truth the retrain reads.
   */
  constructor({ dataDir, getData, now = Date.now, minRefreshMs = MIN_REFRESH_MS, log = console }) {
    this.csv = path.join(dataDir, BARS_CSV);
    this.lock = this.csv + '.lock';
    Object.assign(this, { getData, now, minRefreshMs, log });
    this.lastRun = 0;
  }

  /** Try to take the single-flight lock, clearing a stale one. True on success. */
  #lockOn() {
    try {
      fs.writeFileSync(this.lock, String(this.now()), { flag: 'wx' });
      return true;
    } catch {
      try {
        if (this.now() - fs.statSync(this.lock).mtimeMs > STALE_LOCK_MS) {
          fs.rmSync(this.lock, { force: true });
          fs.writeFileSync(this.lock, String(this.now()), { flag: 'wx' });
          return true;
        }
      } catch {
        /* lost the race */
      }
      return false;
    }
  }

  /**
   * Fetch and append the newest bars. Returns a plain report (never throws for the normal "nothing to
   * do" cases): { ok, added, old, total, start, end, backup } on a run, or { ok:false, skipped } / an
   * { ok:false, error } message. force skips the rate limit (the manual path); it never skips the lock.
   */
  async refresh({ force = false } = {}) {
    const t = this.now();
    if (!force && t - this.lastRun < this.minRefreshMs) {
      return { ok: false, skipped: 'rate-limited', retryInSec: Math.ceil((this.minRefreshMs - (t - this.lastRun)) / 1000) };
    }
    if (!this.#lockOn()) return { ok: false, skipped: 'another refresh is already running' };
    try {
      this.lastRun = t;
      if (!fs.existsSync(this.csv)) return { ok: false, error: `${this.csv} does not exist yet — copy the bars file into DATA_DIR first.` };
      const oldText = fs.readFileSync(this.csv, 'utf8');
      const rows = parseRows(oldText);
      if (!rows.length) return { ok: false, error: 'the bars file has no rows' };
      const latest = Math.max(...rows.map((r) => r.t));
      const tickers = [...new Set(rows.map((r) => r.ticker))];
      if (t - latest < INTERVAL_MS) return { ok: true, skipped: 'the newest bar is under one 5-minute interval old', newestBar: fmtTs(latest), total: rows.length };
      const data = this.getData?.();
      if (!data) return { ok: false, error: 'No Alpaca paper keys are saved (Settings → Alpaca paper keys).' };
      let got;
      try {
        // a small overlap before the newest bar; the merge dedups it
        got = await data.bars(tickers, { timeframe: '5Min', start: latest - INTERVAL_MS });
      } catch (e) {
        return { ok: false, error: `could not fetch bars: ${data.redact ? data.redact(e.message) : e.message}` };
      }
      const newBars = [];
      for (const [ticker, list] of Object.entries(got || {})) {
        for (const b of list || []) if (Number.isFinite(b.t) && b.t > latest) newBars.push({ ticker, t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
      }
      if (!newBars.length) return { ok: true, added: 0, old: rows.length, total: rows.length, note: 'no new bars since the last one', newestBar: fmtTs(latest) };
      const bak = backup(this.csv, this.now);
      const { text, counts } = mergeInto(oldText, newBars);
      const tmp = this.csv + '.tmp';
      fs.writeFileSync(tmp, text);
      fs.renameSync(tmp, this.csv);
      this.log.log?.(`refresh_bars: +${counts.added} bars (now ${counts.total}); ${counts.start} .. ${counts.end}`);
      return { ok: true, ...counts, backup: bak ? path.basename(bak) : null };
    } finally {
      fs.rmSync(this.lock, { force: true });
    }
  }
}
