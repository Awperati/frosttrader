// The hook for the owner's own symbols (his Finviz watchlist), stage 0.
//
// The main source is his Finviz Elite screeners, fetched with his API token (server/engine/finviz.mjs).
// This module is the manual path: it never fetches anything. He brings the symbols, one of two ways:
//   - paste: tickers separated by commas, spaces, semicolons or new lines ("AAPL, MSFT NVDA");
//   - export: the CSV from Finviz's export button (Finviz Elite). Only the "Ticker" column is
//     read; every other column is ignored and nothing else from the file is kept.
//
// This module only reads and checks the list. Storing it (DATA_DIR/watchlist.json), checking each
// symbol against the broker's asset list and the "additions apply next trading day" rule belong
// to server/engine/watchlist.mjs, planned in docs/DESIGN-llm-automation.md section 3.
// Prices for these symbols will come from a licensed source (the broker's market-data API), never
// from scraping.
import { STOCK } from './risk.mjs';

export const MAX_SYMBOLS = 40; // the engine's existing cap

export function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/**
 * Read a pasted list or a CSV export. Returns
 *   { source: 'paste' | 'csv', symbols: [...], rejected: [{ value, reason }] }
 * Symbols are upper-cased, de-duplicated and kept in the order given, at most MAX_SYMBOLS.
 */
export function parseTickers(text) {
  const src = String(text || '').replace(/^﻿/, '').trim();
  const lines = src.split(/\r?\n/);
  const head = splitCsvLine(lines[0] || '').map((h) => h.toLowerCase());
  const col = head.findIndex((h) => h === 'ticker' || h === 'symbol');
  let values;
  let source;
  if (col >= 0 && head.length > 1) {
    source = 'csv';
    values = lines.slice(1).filter((l) => l.trim()).map((l) => splitCsvLine(l)[col] || '');
  } else {
    source = 'paste';
    values = src.split(/[\s,;]+/).filter((s) => s && !/^(ticker|symbol)$/i.test(s));
  }
  const symbols = [];
  const rejected = [];
  for (const raw of values) {
    const s = raw.trim().toUpperCase().replace(/^\$/, '');
    if (!s) continue;
    if (!STOCK.test(s)) rejected.push({ value: raw, reason: 'not a US stock ticker (indices, options and crypto are not allowed)' });
    else if (symbols.includes(s)) continue;
    else if (symbols.length >= MAX_SYMBOLS) rejected.push({ value: raw, reason: `more than ${MAX_SYMBOLS} symbols` });
    else symbols.push(s);
  }
  return { source, symbols, rejected };
}
