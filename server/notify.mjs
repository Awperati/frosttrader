// Phone alerts through ntfy (the owner, 27 Oct 2026: "a. NTFY"). FrostTrader posts short messages to his
// private ntfy topic; the ntfy app on his phone shows them. OFF until a topic is set.
//
// The topic name is the only secret: anyone who knows it can read the alerts. It is generated on the Pi
// (scripts/pi-alerts-setup.sh), shown once, kept in DATA_DIR/notify.json (owner-only permissions), never
// returned by the API, never logged, never committed.
//
// Messages never carry keys, tokens, account numbers or the topic. Sending never blocks or breaks
// trading: every call returns at once, failures are counted and dropped. A runaway loop can't spam:
// at most RATE.burst messages in RATE.windowMs, and the same message only once a minute.
import fs from 'node:fs';
import path from 'node:path';

export const EVENTS = Object.freeze({
  kill: { label: 'Kill switch used', priority: 5, tags: 'rotating_light' },
  liveStop: { label: 'Live trading stopped', priority: 5, tags: 'octagonal_sign' },
  halt: { label: 'An agent halted (live)', priority: 4, tags: 'warning' },
  watchdog: { label: 'Watchdog restart', priority: 4, tags: 'arrows_counterclockwise' },
  fill: { label: 'Live order filled', priority: 3, tags: 'moneybag' },
  liveSwitch: { label: 'Live trading switched on or off', priority: 4, tags: 'electric_plug' },
  newSignIn: { label: 'Website sign-in from a new place', priority: 4, tags: 'key' },
  daily: { label: 'Daily summary after the US close', priority: 2, tags: 'bar_chart' },
  test: { label: 'Test', priority: 3, tags: 'white_check_mark' },
});
export const RATE = Object.freeze({ burst: 20, windowMs: 10 * 60_000, sameMs: 60_000 });
export const DEFAULT_SERVER = 'https://ntfy.sh';
const TOPIC = /^[A-Za-z0-9_-]{16,64}$/;

/** Text safe to send: no account numbers, long digit runs or anything that looks like a key. */
export function sanitize(text) {
  return String(text ?? '')
    .replace(/…\d{2,}/g, '…')
    .replace(/\b(AK|PK)[A-Z0-9]{8,}\b/g, '***')
    .replace(/\b\d{6,}\b/g, '***')
    .slice(0, 1000);
}

export class Notifier {
  constructor({ dataDir, fetchImpl = (...a) => globalThis.fetch(...a), now = Date.now, log = console }) {
    this.file = path.join(dataDir, 'notify.json');
    this.seenFile = path.join(dataDir, 'notify-seen.json');
    Object.assign(this, { fetchImpl, now, log });
    this.settings = { enabled: true, server: DEFAULT_SERVER, topic: '', priorities: {}, ...(read(this.file) || {}) };
    this.sent = []; // send times, for the rate limit
    this.recent = new Map(); // message -> time
    this.lastError = '';
    this.counts = { sent: 0, failed: 0, dropped: 0 };
    this.chain = Promise.resolve();
  }

  get on() {
    return !!(this.settings.enabled && TOPIC.test(this.settings.topic || '') && this.settings.server);
  }

  /** What the Settings card may see. Never the topic. */
  status() {
    const s = this.settings;
    return {
      on: this.on,
      enabled: s.enabled !== false,
      server: s.server,
      topicSet: TOPIC.test(s.topic || ''),
      priorities: Object.fromEntries(Object.entries(EVENTS).filter(([k]) => k !== 'test').map(([k, e]) => [k, s.priorities?.[k] ?? e.priority])),
      labels: Object.fromEntries(Object.entries(EVENTS).filter(([k]) => k !== 'test').map(([k, e]) => [k, e.label])),
      lastError: this.lastError,
      counts: this.counts,
    };
  }

  /** { enabled?, server?, topic?, priorities? } from Settings. The topic is write-only. */
  update(input = {}) {
    const next = { ...this.settings };
    if (typeof input.enabled === 'boolean') next.enabled = input.enabled;
    if (input.server !== undefined) {
      const u = String(input.server).trim().replace(/\/+$/, '');
      if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(u)) throw new Error('The ntfy server must be an https:// address, like https://ntfy.sh');
      next.server = u;
    }
    if (input.topic !== undefined && input.topic !== '') {
      const t = String(input.topic).trim();
      if (!TOPIC.test(t)) throw new Error('The topic must be 16 to 64 letters, digits, - or _ (long and hard to guess).');
      next.topic = t;
    }
    if (input.clearTopic === true) next.topic = '';
    if (input.priorities && typeof input.priorities === 'object') {
      next.priorities = { ...next.priorities };
      for (const [k, v] of Object.entries(input.priorities)) {
        if (!(k in EVENTS)) continue;
        const n = Math.round(Number(v));
        if (n >= 1 && n <= 5) next.priorities[k] = n;
      }
    }
    this.settings = next;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(next, null, 1), { mode: 0o600 });
    fs.renameSync(`${this.file}.tmp`, this.file);
    return this.status();
  }

  /**
   * Queue one alert. Never throws and never waits for the network: returns the promise of this
   * message only for tests and the watchdog (which waits a few seconds before exiting).
   */
  send(event, { title, message }) {
    const e = EVENTS[event];
    if (!e || !this.on) return Promise.resolve(false);
    const body = sanitize(message);
    const now = this.now();
    this.sent = this.sent.filter((t) => now - t < RATE.windowMs);
    const key = `${event}|${body}`;
    if (this.sent.length >= RATE.burst || now - (this.recent.get(key) ?? -Infinity) < RATE.sameMs) {
      this.counts.dropped++;
      return Promise.resolve(false);
    }
    this.sent.push(now);
    this.recent.set(key, now);
    if (this.recent.size > 500) this.recent.clear();
    const priority = this.settings.priorities?.[event] ?? e.priority;
    const p = (this.chain = this.chain.then(() => this.#post({ title: sanitize(title || e.label), body, priority, tags: e.tags })));
    return p;
  }

  async #post({ title, body, priority, tags }) {
    try {
      const res = await this.fetchImpl(`${this.settings.server}/${this.settings.topic}`, {
        method: 'POST',
        headers: { Title: title.replace(/[^\x20-\x7e]/g, ''), Priority: String(priority), Tags: tags, 'Content-Type': 'text/plain; charset=utf-8' },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`ntfy answered HTTP ${res.status}`);
      this.counts.sent++;
      this.lastError = '';
      return true;
    } catch (err) {
      this.counts.failed++;
      // the topic is part of the address: keep it out of the error
      this.lastError = String(err?.message || err).split(this.settings.topic).join('***').slice(0, 200);
      return false;
    }
  }

  /** A sign-in from an address not seen before: true the first time (the list is kept, hashed by nothing: addresses aren't secret). */
  firstTimeFrom(where) {
    const seen = read(this.seenFile) || [];
    if (seen.includes(where)) return false;
    fs.writeFileSync(this.seenFile, JSON.stringify([...seen, where].slice(-200)), { mode: 0o600 });
    return true;
  }
}

function read(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}
