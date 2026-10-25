// The owner's Alpaca PAPER key pair: market data (server/engine/data/alpaca-data.mjs), and paper orders
// when Settings → Paper agents → Orders is "Alpaca paper account" (engine/broker/alpaca-paper-orders.mjs).
// Entered in Settings, kept in DATA_DIR/alpaca-keys.json (outside git), never returned by the API and
// never logged. A live key pair (key id starting "AK") is refused: these keys feed paper agents only.
import fs from 'node:fs';
import path from 'node:path';
import { AlpacaData } from './engine/data/alpaca-data.mjs';

const KEY_ID = /^[A-Z0-9]{16,40}$/;
const SECRET = /^[A-Za-z0-9/+=_-]{20,80}$/;

export class AlpacaKeys {
  constructor({ dataDir, now = Date.now, dataOpts = {} }) {
    this.file = path.join(dataDir, 'alpaca-keys.json');
    this.now = now;
    this.dataOpts = dataOpts; // tests: a fake server
    this.keys = read(this.file);
    this.lastTest = null; // { at, ok, message }
  }

  get set() {
    return !!(this.keys?.keyId && this.keys?.secret);
  }

  /** What the UI may see: whether keys are saved and the last test. Never a key. */
  status() {
    return { set: this.set, lastTest: this.lastTest, use: 'Market data (IEX bars), and paper orders on your Alpaca PAPER account only if you switch them on under Paper agents. Never a live account.' };
  }

  /** Save { keyId, secret } (both together), or { clear: true }. */
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
    if (id.startsWith('AK')) throw new Error('That is a live-trading key (it starts with AK). Use your PAPER key pair (it starts with PK).');
    if (!KEY_ID.test(id) || !SECRET.test(sec)) throw new Error('Those do not look like Alpaca keys.');
    this.keys = { keyId: id, secret: sec };
    this.lastTest = null;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.keys), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    return this.status();
  }

  /** A market-data client with the saved keys, or null. */
  client() {
    return this.set ? new AlpacaData({ ...this.keys, ...this.dataOpts }) : null;
  }

  /** Settings → Test: fetch SPY's latest bar once. */
  async test() {
    const c = this.client();
    if (!c) {
      this.lastTest = { at: this.now(), ok: false, message: 'No keys saved.' };
      return this.status();
    }
    try {
      const b = await c.latest('SPY');
      this.lastTest = { at: this.now(), ok: !!b, message: b ? `OK: SPY ${b.c} at ${new Date(b.t).toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'Alpaca answered without a bar.' };
    } catch (e) {
      this.lastTest = { at: this.now(), ok: false, message: c.redact(e.message) };
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
