// The owner's one-time live enablement (docs/DESIGN-autonomous-agents.md §1.6), in Australian dollars.
//
// Live trading is OFF until the owner, on this computer's Settings screen, signs in again with his
// password and 6-digit code, confirms every limit below one by one, and types "TRADE LIVE <last 4 of
// the account>". Only that request writes DATA_DIR/owner/live-enablement.json, and the file is signed
// (HMAC) with a key derived from his password: an agent, a model, or a hand edit can't make or change
// a valid one, and a changed password voids it. No default opens live.
//
// The limits he answered "proposed limit is great" to are LIVE_PROPOSED. He may set any of them
// lower; none can go above LIVE_HARD, which is fixed in code.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** His confirmed limits, in AUD. */
export const LIVE_PROPOSED = Object.freeze({
  perAgentAud: 10, // live money per agent
  totalAud: 40, // all agents together, of his A$1,000
  perOrderAud: 2.5,
  buysPerDay: 6, // per agent
  perAgentDayAud: 20, // bought per agent per day
  allDayAud: 80, // bought by all agents per day
  agentDailyLossAud: 0.3, // that agent stops for the day
  allDailyLossAud: 0.8, // every agent stops for the day
  agentDrawdownAud: 1, // that agent: automatic sit-out, back at half size (as on paper)
  totalDrawdownAud: 4, // all live trading stops until the owner resumes
});

/** The furthest any limit can ever go, whatever a file says. */
export const LIVE_HARD = Object.freeze({
  perAgentAud: 250,
  totalAud: 1000,
  perOrderAud: 62.5,
  buysPerDay: 10,
  perAgentDayAud: 500,
  allDayAud: 2000,
  agentDailyLossAud: 7.5,
  allDailyLossAud: 20,
  agentDrawdownAud: 25,
  totalDrawdownAud: 100,
});

export const LIMIT_LABELS = Object.freeze({
  perAgentAud: 'Live money per agent',
  totalAud: 'Total live money (all agents)',
  perOrderAud: 'Largest order',
  buysPerDay: 'Buys per agent per day',
  perAgentDayAud: 'Bought per agent per day',
  allDayAud: 'Bought by all agents per day',
  agentDailyLossAud: 'Daily loss per agent (it stops for the day)',
  allDailyLossAud: 'Daily loss, all agents (all stop for the day)',
  agentDrawdownAud: 'Drawdown per agent (sits out a day, back at half size)',
  totalDrawdownAud: 'Total drawdown (live stops until you resume)',
});

/** Limits made safe: each a positive number no higher than LIVE_HARD; missing ones take the proposal. */
export function cleanLiveLimits(input = {}) {
  const out = {};
  for (const [k, hard] of Object.entries(LIVE_HARD)) {
    const v = Number(input[k]);
    out[k] = Number.isFinite(v) && v > 0 ? Math.min(v, hard) : LIVE_PROPOSED[k];
    if (k === 'buysPerDay') out[k] = Math.max(1, Math.floor(out[k]));
  }
  out.totalAud = Math.min(out.totalAud, out.perAgentAud * 4);
  return out;
}

export const phraseFor = (accountNumber) => `TRADE LIVE ${String(accountNumber || '').slice(-4)}`;

const canonical = (rec) => JSON.stringify({ v: rec.v, enabledAt: rec.enabledAt, account: rec.account, limits: rec.limits, confirmed: rec.confirmed, rate: rec.rate });

export class Enablement {
  /** keyFor(): a secret derived from the owner's password (server/auth.mjs), or null when sign-in isn't set up. */
  constructor({ dataDir, keyFor = () => null, now = Date.now }) {
    this.dir = path.join(dataDir, 'owner');
    this.file = path.join(this.dir, 'live-enablement.json');
    Object.assign(this, { keyFor, now });
  }

  sign(rec) {
    const key = this.keyFor();
    if (!key) throw new Error('Owner sign-in is not set up (FROST_TRADER_PASSWORD and FROST_TRADER_TOTP_SECRET in .env).');
    return crypto.createHmac('sha256', key).update(canonical(rec)).digest('hex');
  }

  /** The valid enablement, or null (none, damaged, edited, or signed with another password). */
  read() {
    let rec;
    try {
      rec = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return null;
    }
    try {
      const want = this.sign(rec);
      if (typeof rec.sig !== 'string' || rec.sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(rec.sig), Buffer.from(want))) return null;
    } catch {
      return null;
    }
    return { ...rec, limits: cleanLiveLimits(rec.limits) };
  }

  /** Write a new enablement. Only the owner's enable request calls this, after every check passed. */
  write({ account, limits, confirmed, rate }) {
    const rec = { v: 1, enabledAt: new Date(this.now()).toISOString(), account: String(account).slice(-4), limits: cleanLiveLimits(limits), confirmed: [...confirmed].sort(), rate };
    rec.sig = this.sign(rec);
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(rec, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    return this.read();
  }

  /** Lower limits now (never raise): re-signed with the same key. */
  lower(patch) {
    const cur = this.read();
    if (!cur) throw new Error('Live trading is not enabled.');
    const next = { ...cur.limits };
    for (const [k, v] of Object.entries(patch || {})) {
      if (!(k in LIVE_HARD)) continue;
      const n = Number(v);
      if (!(n > 0)) throw new Error(`${LIMIT_LABELS[k]} must be above zero.`);
      if (n > cur.limits[k]) throw new Error(`${LIMIT_LABELS[k]} can only be lowered here. Raising it means enabling again.`);
      next[k] = n;
    }
    return this.write({ account: cur.account, limits: next, confirmed: cur.confirmed, rate: cur.rate });
  }

  /** Switch live off: the file is kept beside, renamed, for the record. */
  revoke(reason) {
    if (!fs.existsSync(this.file)) return;
    fs.renameSync(this.file, path.join(this.dir, `live-enablement.revoked-${new Date(this.now()).toISOString().replace(/[:.]/g, '-')}.json`));
    fs.writeFileSync(path.join(this.dir, 'last-revoke.txt'), String(reason || '').slice(0, 200));
  }
}
