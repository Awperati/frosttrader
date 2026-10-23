// A read-only mirror of Frost Trader's watchlist and paper positions into ~/.ticker.yaml, for the
// `ticker` terminal app (achannarasappa/ticker v5.3.0, installed with WinGet).
//
// ticker's config keys used (from its README): `watchlist` (symbols), `lots` (symbol, quantity,
// unit_cost: shown as positions with gain or loss), `show-fundamentals` (open, previous close, day
// range), `show-tags` (how delayed each quote is), `show-positions`, `show-summary`, `sort: user`
// (keep Frost Trader's order) and `interval`. Prices, change and % change against the previous close,
// and the green/red/neutral colouring are ticker's own default display. Volume is not one of its
// options, and it cannot show how old Frost Trader's list is: that goes into a comment in the file.
//
// Ownership: Frost Trader owns only the lines between its two markers and rewrites them when the
// list or the positions change. Everything outside the markers is the owner's and is kept as is.
// A ~/.ticker.yaml that Frost Trader did not write is backed up once and never changed: the mirror
// waits for the owner's OK (status 'foreign'). Nothing secret goes in the file: symbols and numbers only.
//
// ticker reads its config when it starts, so a running ticker shows a change after a restart.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readWatchlist } from './finviz.mjs';
import { AGENT_ID } from './agents/sandbox.mjs';

export const START = '# >>> Frost Trader: managed block, rewritten automatically. Edit outside it. >>>';
export const END = '# <<< Frost Trader: end of managed block <<<';
export const BACKUP_SUFFIX = '.frosttrader-backup';

// Written once, when Frost Trader creates the file. The owner may change these lines.
const PREFS = [
  '# ~/.ticker.yaml for the `ticker` app. Frost Trader mirrors its watchlist and PAPER positions here.',
  '# The lines between the Frost Trader markers are rewritten automatically; everything else is yours.',
  'show-summary: true',
  'show-positions: true',
  'show-fundamentals: true # open, previous close, day range',
  'show-tags: true # how delayed each quote is',
  'show-separator: true',
  'sort: user # Frost Trader\'s order: positions first, then the watchlist',
  'interval: 15 # seconds between quote refreshes',
];

/** Yahoo (ticker's default source) writes share classes with a dash: BRK.B -> BRK-B. */
export const yahooSymbol = (s) => String(s).toUpperCase().replace(/\./g, '-');

const SAFE = /^[A-Z0-9][A-Z0-9-]{0,11}$/;
const num = (n) => Number(Number(n).toFixed(6)).toString();
const stamp = (t) => new Date(t).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

/** Every agent's paper positions, from DATA_DIR/agents/<id>/ledger.json. Damaged ledgers are skipped. */
export function readPaperLots(dataDir) {
  const base = path.join(dataDir, 'agents');
  let ids = [];
  try {
    ids = fs.readdirSync(base).filter((d) => AGENT_ID.test(d)).sort();
  } catch {
    return [];
  }
  const lots = [];
  for (const id of ids) {
    let d;
    try {
      d = JSON.parse(fs.readFileSync(path.join(base, id, 'ledger.json'), 'utf8'));
    } catch {
      continue;
    }
    for (const [sym, p] of Object.entries(d?.positions || {})) {
      if (Number.isFinite(p?.qty) && p.qty !== 0 && Number.isFinite(p?.avg)) lots.push({ agent: id, symbol: sym, qty: p.qty, avg: p.avg });
    }
  }
  return lots;
}

/** The managed block's text, markers included. */
export function managedBlock({ list, lots, now }) {
  const out = [START];
  if (list) out.push(`# Watchlist: Finviz Elite screeners, fetched ${stamp(list.at)}${list.stale ? ' (the last fetch failed: this is the last good list)' : ''}.`);
  else out.push('# Watchlist: none yet (Settings -> Finviz Elite in Frost Trader).');
  out.push(`# Positions: PAPER only (Frost Trader agent sandboxes). Mirrored ${stamp(now)}.`);
  const symbols = [...new Set((list?.symbols || []).map(yahooSymbol).filter((s) => SAFE.test(s)))];
  if (symbols.length) {
    out.push('watchlist:');
    for (const s of symbols) out.push(`  - "${s}"`);
  }
  const good = lots.filter((l) => SAFE.test(yahooSymbol(l.symbol)));
  if (good.length) {
    out.push('lots:');
    for (const l of good) {
      out.push(`  - symbol: "${yahooSymbol(l.symbol)}" # paper, agent ${l.agent}`);
      out.push(`    quantity: ${num(l.qty)}`);
      out.push(`    unit_cost: ${num(l.avg)}`);
    }
  }
  out.push(END);
  return out.join('\n');
}

/** Replace the managed block in `text`, or return null when the file has no (or a broken) block. */
export function replaceBlock(text, block) {
  const a = text.indexOf(START);
  const b = text.indexOf(END);
  if (a < 0 || b < a || text.indexOf(START, a + 1) >= 0) return null;
  return text.slice(0, a) + block + text.slice(b + END.length);
}

export class TickerMirror {
  constructor({ dataDir, home = os.homedir(), now = Date.now, log = console, list = () => readWatchlist(dataDir) } = {}) {
    Object.assign(this, { dataDir, now, log, list });
    this.file = path.join(home, '.ticker.yaml');
    this.state = { status: 'idle', at: null, error: null, symbols: 0, lots: 0 };
    this.timer = null;
  }

  /** Write the mirror if anything changed. Returns status(). Never throws. */
  sync() {
    try {
      const list = this.list();
      const lots = readPaperLots(this.dataDir);
      const old = fs.existsSync(this.file) ? fs.readFileSync(this.file, 'utf8') : null;
      // Compare without the "Mirrored <time>" line, so an unchanged list is not rewritten every minute.
      const block = managedBlock({ list, lots, now: this.now() });
      let next;
      if (old === null) next = `${PREFS.join('\n')}\n${block}\n`;
      else {
        next = replaceBlock(old, block);
        if (next === null) {
          this.backupOnce(old);
          this.state = { status: 'foreign', at: this.now(), error: `${this.file} was not written by Frost Trader, so it was left alone (backup: ${this.file}${BACKUP_SUFFIX}).`, symbols: 0, lots: 0 };
          return this.status();
        }
      }
      const counts = { symbols: (block.match(/^ {2}- "/gm) || []).length, lots: lots.length };
      if (old !== null && strip(old) === strip(next)) {
        this.state = { ...this.state, status: 'ok', error: null, ...counts };
        return this.status();
      }
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, next);
      fs.renameSync(tmp, this.file);
      this.state = { status: 'ok', at: this.now(), error: null, ...counts };
    } catch (e) {
      this.state = { ...this.state, status: 'error', error: e.message };
      this.log.warn?.(`ticker mirror: ${e.message}`);
    }
    return this.status();
  }

  backupOnce(text) {
    const bak = this.file + BACKUP_SUFFIX;
    if (!fs.existsSync(bak)) fs.writeFileSync(bak, text);
  }

  status() {
    return { file: this.file, ...this.state };
  }

  /** Re-check once a minute (paper positions change without telling us). */
  start(checkMs = 60_000) {
    this.sync();
    this.timer = setInterval(() => this.sync(), checkMs);
    this.timer.unref?.();
    return this;
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
}

const strip = (s) => s.replace(/^# Positions: PAPER only.*$/m, '');
