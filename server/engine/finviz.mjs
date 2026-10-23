// The owner's ticker source: his Finviz Elite screeners, read through Finviz's Screener API export.
//
// Finviz Elite exports any screener as CSV. Take the screener's URL, swap `screener/stocks?` for
// `export/screener?type=stocks&` (ETFs: `type=etf`), and append `&auth=<API token>`. Legacy
// `screener.ashx` / `export.ashx` URLs answer with a 301 to the new path, so redirects are followed,
// but only to Finviz hosts, so the token can never be carried to another site.
//
// The token is a secret. It is entered by the owner in Settings, kept in DATA_DIR (outside git),
// never returned by the API and never logged: every URL or message that leaves this module goes
// through redact(). His Finviz password is never asked for or used.
//
// Finviz allows 10 requests every 5 seconds, shared by his whole Elite account (his browser too).
// This source takes at most 2 per 5 seconds, and one refresh is one request per screener.
//
// When a refresh fails, the last good list stays in use and its age is shown. The list is written
// to DATA_DIR/watchlist.json, which the engine, the agents and the `ticker` mirror read.
import fs from 'node:fs';
import path from 'node:path';
import { STOCK } from './risk.mjs';
import { splitCsvLine, MAX_SYMBOLS } from './watchlist-input.mjs';
import { nyClock } from './stats.mjs';

export const FINVIZ_HOSTS = ['finviz.com', 'elite.finviz.com'];
export const MAX_SCREENERS = 5;
export const RATE = { max: 2, windowMs: 5000 }; // Finviz's limit is 10 per 5 s for the whole account
export const RETRY = { tries: 4, baseMs: 2000, maxMs: 60_000 }; // 429 and 5xx: 2 s, 4 s, 8 s, then give up
export const DEFAULT_INTERVAL_MIN = 15;
export const INTERVALS_MIN = [5, 15, 30, 60];
// Fetch window, New York time, weekdays: from 30 min before the open to 15 min after the close, so
// the list is ready at 09:30 and catches the closing numbers. No holiday calendar: a holiday costs
// at most 30 cheap requests and gives the same list.
export const WINDOW = { from: 9 * 60, to: 16 * 60 + 15 };

/** Hide the token: in any `auth=` query value and anywhere the literal token appears. */
export function redact(text, token = '') {
  let s = String(text ?? '').replace(/([?&]auth=)[^&\s"'<>]*/gi, '$1***');
  if (token && token.length >= 4) s = s.split(token).join('***');
  return s;
}

/**
 * Turn a Finviz screener URL (as copied from the browser) into its export URL, without a token.
 * Returns { url, type, hadToken } or throws an Error with a message for the owner.
 */
export function toExportUrl(input, { hosts = FINVIZ_HOSTS } = {}) {
  let u;
  try {
    u = new URL(String(input || '').trim());
  } catch {
    throw new Error('That is not a web address. Copy the screener URL from the browser bar.');
  }
  const host = u.hostname.toLowerCase();
  if (!hosts.includes(host)) throw new Error('Only finviz.com screener URLs can be used.');
  if (u.protocol !== 'https:' && !(host === '127.0.0.1' || host === 'localhost')) throw new Error('The screener URL must start with https://');
  const hadToken = u.searchParams.has('auth');
  u.searchParams.delete('auth');
  let p = u.pathname.replace(/\/+$/, '').toLowerCase();
  let type = (u.searchParams.get('type') || '').toLowerCase();
  if (p === '/screener/stocks' || p === '/screener.ashx' || p === '/export.ashx') type ||= 'stocks';
  else if (p === '/screener/etf' || p === '/screener/etfs') type = 'etf';
  else if (p !== '/export/screener') throw new Error('That is not a screener URL. Open your screener on Finviz and copy its address.');
  if (type === 'etfs') type = 'etf';
  if (type !== 'stocks' && type !== 'etf') throw new Error('Only stock and ETF screeners can be exported.');
  const params = new URLSearchParams(u.searchParams);
  params.delete('type');
  const out = new URL(`${u.protocol}//${u.host}/export/screener`);
  out.search = `type=${type}${params.toString() ? `&${params}` : ''}`;
  return { url: out.toString(), type, hadToken };
}

/** Read a Finviz export CSV. Returns { rows, columns, tickers }. Throws when it is not a CSV export. */
export function parseFinvizCsv(text) {
  const src = String(text || '').replace(/^﻿/, '');
  if (/^\s*</.test(src)) throw new Error('Finviz sent a web page instead of a CSV. The API token may be wrong or expired.');
  const lines = src.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return { rows: 0, columns: [], tickers: [] };
  const columns = splitCsvLine(lines[0]);
  const col = columns.findIndex((h) => h.toLowerCase() === 'ticker');
  if (col < 0) throw new Error('The CSV from Finviz has no "Ticker" column. Keep the Ticker column in the screener view (or in &c=).');
  const tickers = lines.slice(1).map((l) => (splitCsvLine(l)[col] || '').trim().toUpperCase()).filter(Boolean);
  return { rows: lines.length - 1, columns, tickers };
}

/** A sliding-window limiter: at most `max` starts in any `windowMs`. Shared by every request here. */
export class RateLimiter {
  constructor({ max = RATE.max, windowMs = RATE.windowMs, now = Date.now, sleep = defaultSleep } = {}) {
    Object.assign(this, { max, windowMs, now, sleep });
    this.starts = [];
    this.queue = Promise.resolve();
  }

  /** Resolves when one more request may start. Calls are served in order. */
  acquire() {
    const turn = this.queue.then(async () => {
      for (;;) {
        const t = this.now();
        this.starts = this.starts.filter((s) => t - s < this.windowMs);
        if (this.starts.length < this.max) {
          this.starts.push(t);
          return;
        }
        await this.sleep(this.starts[0] + this.windowMs - t);
      }
    });
    this.queue = turn.catch(() => {});
    return turn;
  }
}

function defaultSleep(ms) {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)).unref?.());
}

function retryAfterMs(res, attempt) {
  const h = Number(res.headers.get('retry-after'));
  const base = Number.isFinite(h) && h > 0 ? h * 1000 : RETRY.baseMs * 2 ** attempt;
  return Math.min(base, RETRY.maxMs);
}

/** True inside the fetch window (weekdays, New York time). */
export function inFetchWindow(t) {
  const c = nyClock(t);
  return c.weekday !== 'Sat' && c.weekday !== 'Sun' && c.minute >= WINDOW.from && c.minute < WINDOW.to;
}

/**
 * Fetch one export URL with the token: rate limited, redirects followed to allowed hosts only,
 * 429/5xx retried with backoff. Returns the CSV text. Errors carry no token.
 */
export async function fetchExport(exportUrl, token, { fetchImpl = globalThis.fetch, limiter, hosts = FINVIZ_HOSTS, sleep = defaultSleep, timeoutMs = 20_000 } = {}) {
  if (!token) throw new Error('No Finviz API token is saved.');
  const first = new URL(exportUrl);
  first.searchParams.set('auth', token);
  let lastErr = null;
  for (let attempt = 0; attempt < RETRY.tries; attempt++) {
    let url = first;
    let res;
    try {
      for (let hops = 0; ; hops++) {
        await limiter.acquire();
        res = await fetchImpl(url.toString(), { redirect: 'manual', headers: { accept: 'text/csv' }, signal: AbortSignal.timeout(timeoutMs) });
        if (res.status < 300 || res.status >= 400) break;
        const loc = res.headers.get('location');
        if (!loc || hops >= 4) throw new Error(`Finviz redirected too many times (HTTP ${res.status}).`);
        const next = new URL(loc, url);
        if (!hosts.includes(next.hostname.toLowerCase())) throw new Error('Finviz redirected to another site. Stopped, so the token was not sent there.');
        if (!next.searchParams.has('auth')) next.searchParams.set('auth', token);
        url = next;
      }
    } catch (e) {
      if (e?.name === 'TimeoutError' || e?.name === 'AbortError' || e instanceof TypeError) {
        lastErr = new Error(redact(`Could not reach Finviz: ${e.message}`, token));
        await sleep(Math.min(RETRY.baseMs * 2 ** attempt, RETRY.maxMs));
        continue;
      }
      throw new Error(redact(e.message, token));
    }
    if (res.ok) return await res.text();
    if (res.status === 429 || res.status >= 500) {
      lastErr = new Error(res.status === 429 ? 'Finviz says too many requests (HTTP 429).' : `Finviz had a server error (HTTP ${res.status}).`);
      if (attempt < RETRY.tries - 1) await sleep(retryAfterMs(res, attempt));
      continue;
    }
    if (res.status === 401 || res.status === 403) throw new Error(`Finviz refused the API token (HTTP ${res.status}). Check it in Settings.`);
    throw new Error(`Finviz answered HTTP ${res.status}.`);
  }
  throw lastErr || new Error('Finviz could not be reached.');
}

const EMPTY_SETTINGS = { urls: [], intervalMin: DEFAULT_INTERVAL_MIN };

/**
 * The scheduled source. Settings (screener URLs, interval) live in DATA_DIR/finviz.json, the token
 * in DATA_DIR/finviz-token.json, the list in DATA_DIR/watchlist.json.
 */
export class FinvizSource {
  constructor({ dataDir, fetchImpl = (...a) => globalThis.fetch(...a), now = Date.now, sleep = defaultSleep, limiter, hosts = FINVIZ_HOSTS, log = console } = {}) {
    Object.assign(this, { dataDir, fetchImpl, now, sleep, hosts, log });
    this.limiter = limiter || new RateLimiter({ now, sleep });
    this.files = {
      settings: path.join(dataDir, 'finviz.json'),
      token: path.join(dataDir, 'finviz-token.json'),
      watchlist: path.join(dataDir, 'watchlist.json'),
    };
    this.settings = { ...EMPTY_SETTINGS, ...readJson(this.files.settings) };
    this.token = String(readJson(this.files.token)?.token || '');
    this.list = readJson(this.files.watchlist); // the last good list, or null
    this.last = null; // { at, ok, error, perUrl: [{ rows, error }] }
    this.busy = null;
    this.timer = null;
  }

  /** Save settings. `token` replaces the saved token; `clearToken` removes it. Returns status(). */
  update({ urls, intervalMin, token, clearToken } = {}) {
    if (urls !== undefined) {
      if (!Array.isArray(urls)) throw new Error('urls must be a list');
      const clean = urls.map((s) => String(s || '').trim()).filter(Boolean);
      if (clean.length > MAX_SCREENERS) throw new Error(`At most ${MAX_SCREENERS} screeners.`);
      const out = [];
      for (const s of clean) {
        let ex;
        try {
          ex = toExportUrl(s, { hosts: this.hosts });
        } catch (e) {
          throw new Error(`${redact(s)}: ${e.message}`);
        }
        if (!out.includes(ex.url)) out.push(ex.url);
        // A pasted URL with auth= in it: the token part is dropped and never stored with the URL.
        if (ex.hadToken && !token && !this.token) this.pendingNote = 'The token in that URL was not saved. Paste it into the token field instead.';
      }
      this.settings.urls = out;
    }
    if (intervalMin !== undefined) {
      const n = Number(intervalMin);
      if (!INTERVALS_MIN.includes(n)) throw new Error(`The interval must be one of ${INTERVALS_MIN.join(', ')} minutes.`);
      this.settings.intervalMin = n;
    }
    writeJson(this.files.settings, this.settings);
    if (clearToken) {
      this.token = '';
      fs.rmSync(this.files.token, { force: true });
    } else if (token !== undefined && String(token).trim()) {
      const t = String(token).trim();
      if (!/^[A-Za-z0-9_-]{8,128}$/.test(t)) throw new Error('That does not look like a Finviz API token (letters, digits, - and _ only).');
      this.token = t;
      writeJson(this.files.token, { token: t }, 0o600);
    }
    return this.status();
  }

  /** Fetch every screener once. On success the list is replaced; on failure the last good list stays. */
  refresh(reason = 'scheduled') {
    this.busy ||= this.#refresh(reason).finally(() => {
      this.busy = null;
    });
    return this.busy;
  }

  async #refresh(reason) {
    const at = this.now();
    const perUrl = [];
    try {
      if (!this.settings.urls.length) throw new Error('No screener URL is saved.');
      if (!this.token) throw new Error('No Finviz API token is saved.');
      const symbols = [];
      const rejected = [];
      let rows = 0;
      for (const url of this.settings.urls) {
        try {
          const csv = await fetchExport(url, this.token, { fetchImpl: this.fetchImpl, limiter: this.limiter, hosts: this.hosts, sleep: this.sleep });
          const parsed = parseFinvizCsv(csv);
          perUrl.push({ url, rows: parsed.rows, error: null });
          rows += parsed.rows;
          for (const s of parsed.tickers) {
            if (!STOCK.test(s)) rejected.push(s);
            else if (!symbols.includes(s)) symbols.push(s);
          }
        } catch (e) {
          perUrl.push({ url, rows: null, error: redact(e.message, this.token) });
          throw e;
        }
      }
      const kept = symbols.slice(0, MAX_SYMBOLS);
      this.list = { source: 'finviz', at, symbols: kept, rows, dropped: symbols.length - kept.length, rejected: rejected.slice(0, 50) };
      writeJson(this.files.watchlist, this.list);
      this.last = { at, ok: true, error: null, reason, perUrl };
    } catch (e) {
      const error = redact(e.message, this.token);
      this.last = { at, ok: false, error, reason, perUrl };
      this.log.warn?.(`Finviz refresh failed: ${error}`);
    }
    return this.status();
  }

  /** What the UI may see. Never the token. */
  status() {
    const t = this.now();
    const note = this.pendingNote || null;
    this.pendingNote = null;
    return {
      urls: this.settings.urls,
      intervalMin: this.settings.intervalMin,
      intervals: INTERVALS_MIN,
      tokenSet: !!this.token,
      inWindow: inFetchWindow(t),
      window: 'Weekdays 09:00–16:15 New York time',
      last: this.last,
      list: this.list ? { ...this.list, ageMin: Math.floor((t - this.list.at) / 60_000), stale: !this.last?.ok && !!this.last } : null,
      note,
    };
  }

  /** The symbols the engine and agents use. Empty until the first good fetch. */
  symbols() {
    return this.list?.symbols || [];
  }

  /** Check once a minute; refresh when the interval has passed inside the window, or when there is no list yet. */
  start(checkMs = 60_000) {
    const tick = () => {
      const t = this.now();
      if (!this.settings.urls.length || !this.token || this.busy) return;
      const lastAt = this.last?.at ?? 0;
      const due = t - lastAt >= this.settings.intervalMin * 60_000;
      if ((inFetchWindow(t) && due) || (!this.list && !this.last)) this.refresh();
    };
    tick();
    this.timer = setInterval(tick, checkMs);
    this.timer.unref?.();
    return this;
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
}

/** Read the saved list (DATA_DIR/watchlist.json) without starting the source. */
export function readWatchlist(dataDir) {
  return readJson(path.join(dataDir, 'watchlist.json'));
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, data, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1), mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}
