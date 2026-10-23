// The owner's Alpaca LIVE key pair (real money), on the paused live-step branch only. Kept in
// DATA_DIR/alpaca-live-keys.json (outside git), never returned by the API and never logged. Only a
// live key (id starting "AK") is accepted. Used only by the live desk after his signed enablement.
import fs from 'node:fs';
import path from 'node:path';
import { AlpacaLive } from './engine/broker/alpaca-live.mjs';

const KEY_ID = /^AK[A-Z0-9]{14,38}$/;
const SECRET = /^[A-Za-z0-9/+=_-]{20,80}$/;

export class LiveKeys {
  constructor({ dataDir, now = Date.now, brokerOpts = {} }) {
    this.file = path.join(dataDir, 'alpaca-live-keys.json');
    Object.assign(this, { now, brokerOpts });
    this.keys = read(this.file);
    this.lastTest = null;
  }

  get set() {
    return !!(this.keys?.keyId && this.keys?.secret);
  }

  status() {
    return { set: this.set, lastTest: this.lastTest, use: 'Real money. Used only after your live enablement, within your limits.' };
  }

  update({ keyId, secret, clear } = {}) {
    if (clear) {
      this.keys = null;
      this.lastTest = null;
      fs.rmSync(this.file, { force: true });
      return this.status();
    }
    const id = String(keyId || '').trim();
    const sec = String(secret || '').trim();
    if (!id || !sec) throw new Error('Enter both the key ID and the secret key.');
    if (!id.startsWith('AK')) throw new Error('That is not a live key (live key IDs start with AK; paper ones with PK).');
    if (!KEY_ID.test(id) || !SECRET.test(sec)) throw new Error('Those do not look like Alpaca keys.');
    this.keys = { keyId: id, secret: sec };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.keys), { mode: 0o600 });
    fs.renameSync(`${this.file}.tmp`, this.file);
    return this.status();
  }

  /** The live broker, or null. Only the live desk calls this. */
  broker() {
    return this.set ? new AlpacaLive({ ...this.keys, ...this.brokerOpts }) : null;
  }

  /** Read the account only (no order). */
  async test() {
    const b = this.broker();
    if (!b) {
      this.lastTest = { at: this.now(), ok: false, message: 'No keys saved.' };
      return this.status();
    }
    try {
      const a = await b.account();
      this.lastTest = { at: this.now(), ok: true, message: `OK: account …${a.number.slice(-4)}, ${a.currency}, status ${a.status}` };
    } catch (e) {
      this.lastTest = { at: this.now(), ok: false, message: b.redact(e.message) };
    }
    return this.status();
  }
}

function read(file) {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    return d?.keyId && d?.secret ? d : null;
  } catch {
    return null;
  }
}
