// Historical bars from CSV files: DATA_DIR/bars/<SYMBOL>.csv with a header row and the columns
// t,o,h,l,c,v (t as an ISO time or milliseconds). Any data you have the right to use works.
import fs from 'node:fs';
import path from 'node:path';

export function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const head = lines.shift().toLowerCase().split(',').map((s) => s.trim());
  const col = (names) => head.findIndex((h) => names.includes(h));
  const ix = { t: col(['t', 'time', 'timestamp', 'date']), o: col(['o', 'open']), h: col(['h', 'high']), l: col(['l', 'low']), c: col(['c', 'close']), v: col(['v', 'volume']) };
  if (Object.values(ix).some((n) => n < 0)) throw new Error('CSV needs columns t,o,h,l,c,v');
  return lines
    .map((line) => {
      const f = line.split(',');
      const raw = f[ix.t].trim();
      const t = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
      return { t, o: +f[ix.o], h: +f[ix.h], l: +f[ix.l], c: +f[ix.c], v: +f[ix.v] };
    })
    .filter((b) => Number.isFinite(b.t) && b.c > 0)
    .sort((a, b) => a.t - b.t);
}

export function csvBars(dir, symbols) {
  const out = {};
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir)) {
    const m = f.match(/^([A-Z.]{1,7})\.csv$/i);
    if (!m) continue;
    const s = m[1].toUpperCase();
    if (symbols && !symbols.includes(s)) continue;
    out[s] = parseCsv(fs.readFileSync(path.join(dir, f), 'utf8'));
  }
  return out;
}
