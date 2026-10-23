// The audit log: every proposal, gate decision, fill, halt and kill, one JSON object per line in
// DATA_DIR/audit.jsonl, each line carrying `prev` = sha256 of the line before it, so an edited or
// deleted line breaks the chain (verify). Append-only; nothing secret is written.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const GENESIS = '0'.repeat(64);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

export class AuditLog {
  constructor({ dir, now = Date.now }) {
    this.file = path.join(dir, 'audit.jsonl');
    this.now = now;
    fs.mkdirSync(dir, { recursive: true });
    this.prev = this.lastHash();
  }

  lastHash() {
    if (!fs.existsSync(this.file)) return GENESIS;
    const lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean);
    return lines.length ? sha(lines[lines.length - 1]) : GENESIS;
  }

  /** Append one event: { type, agent?, ... }. Returns the line written. */
  write(event) {
    const line = JSON.stringify({ at: new Date(this.now()).toISOString(), ...event, prev: this.prev });
    fs.appendFileSync(this.file, `${line}\n`);
    this.prev = sha(line);
    return line;
  }

  /** The newest `n` events, newest first. */
  tail(n = 50) {
    if (!fs.existsSync(this.file)) return [];
    const lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-n).reverse().map((l) => JSON.parse(l));
  }

  /** { ok, lines, brokenAt } — brokenAt is the 1-based line whose `prev` doesn't match. */
  verify() {
    if (!fs.existsSync(this.file)) return { ok: true, lines: 0, brokenAt: null };
    const lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean);
    let prev = GENESIS;
    for (let i = 0; i < lines.length; i++) {
      let rec;
      try {
        rec = JSON.parse(lines[i]);
      } catch {
        return { ok: false, lines: lines.length, brokenAt: i + 1 };
      }
      if (rec.prev !== prev) return { ok: false, lines: lines.length, brokenAt: i + 1 };
      prev = sha(lines[i]);
    }
    return { ok: true, lines: lines.length, brokenAt: null };
  }
}
