// The JSON store: one file (DATA_DIR/state.json) with the settings and history that must survive
// a restart: the kill switch, the risk limits, the trade tape, finished days and overrides.
// Written whole to a temporary file and renamed over the old one, so a crash never leaves half
// a file.
import fs from 'node:fs';
import path from 'node:path';

export class HttpError extends Error {
  constructor(status, message, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

const EMPTY = { killed: false, killReason: '', limits: null, pendingLimits: null, tape: [], days: [], overrides: [], kills: 0 };
const TAPE_MAX = 500;

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'state.json');
    this.data = structuredClone(EMPTY);
    this.timer = null;
  }

  load() {
    fs.mkdirSync(this.dir, { recursive: true });
    if (fs.existsSync(this.file)) this.data = { ...structuredClone(EMPTY), ...JSON.parse(fs.readFileSync(this.file, 'utf8')) };
    else this.save();
    return this;
  }

  save() {
    clearTimeout(this.timer);
    this.timer = null;
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1));
    fs.renameSync(tmp, this.file);
  }

  /** Save soon (many changes in a burst become one write). */
  touch() {
    this.timer ||= setTimeout(() => this.save(), 1000);
    this.timer.unref?.();
  }

  addTape(e) {
    this.data.tape.push(e);
    if (this.data.tape.length > TAPE_MAX) this.data.tape.splice(0, this.data.tape.length - TAPE_MAX);
    this.touch();
  }
}
