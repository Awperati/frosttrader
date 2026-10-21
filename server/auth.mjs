// Sign-in: one password, one token per device.
// Password checks use async scrypt, so sign-ins never freeze the server, and only
// a couple run at once (a short queue waits for them). Wrong attempts lock out one
// address; when they pile up from everywhere, every sign-in is slowed down (never
// refused), so spreading guesses over many addresses doesn't help, and nobody can
// shut the owner out.
// Devices are signed out after 30 days without use, a year after signing in, and
// all at once when the password changes.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { HttpError } from './store.mjs';

const scrypt = promisify(crypto.scrypt);
const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

export const LIMITS = {
  perIp: 8, // wrong attempts from one address before it is locked out...
  ipLock: 15 * 60_000, // ...for this long
  window: 10 * 60_000, // wrong attempts from everyone, counted over this long...
  slow: [[50, 5_000], [20, 3_000]], // ...this many or more: every sign-in waits this long before it is checked
  inFlight: 2, // password checks running at once
  queue: 20, // sign-ins waiting for a check; more at once get a 503
  tracked: 10_000, // addresses remembered at most
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Where the Cloudflare Tunnel's connections come from: this machine, or Docker's bridge
// networks (the host's connections to a published port appear from the bridge gateway).
export const DEFAULT_TRUSTED_PROXIES = '127.0.0.1/32,::1/128,172.16.0.0/12';

/** Parse a comma list of ranges ("172.16.0.0/12", "::1/128", or a bare address). Bad entries are skipped, never trusted. */
export function trustedProxies(spec = DEFAULT_TRUSTED_PROXIES) {
  const list = new net.BlockList();
  const ranges = [];
  const bad = [];
  for (const range of String(spec).split(',').map((s) => s.trim()).filter(Boolean)) {
    const [ip, bits, extra] = range.split('/');
    const type = net.isIPv6(ip) ? 'ipv6' : 'ipv4';
    const max = type === 'ipv6' ? 128 : 32;
    if (!net.isIP(ip) || extra !== undefined || (bits !== undefined && !(/^\d{1,3}$/.test(bits) && Number(bits) <= max))) {
      bad.push(range);
      continue;
    }
    list.addSubnet(ip, bits === undefined ? max : Number(bits), type);
    ranges.push(range);
  }
  return { list, ranges, bad };
}

/**
 * The visitor's address, for the lockout. cf-connecting-ip is believed only when the
 * connection itself comes from a trusted proxy range; anyone else could send that header
 * to dodge the lockout (or lock someone else out), so their socket address counts.
 */
export function clientIp(req, trusted = trustedProxies().list) {
  const peer = String(req.socket?.remoteAddress || '').replace(/^::ffff:/i, ''); // IPv4 on a dual-stack socket
  const fwd = req.headers['cf-connecting-ip'];
  const proxy = net.isIP(peer) !== 0 && trusted.check(peer, net.isIPv6(peer) ? 'ipv6' : 'ipv4');
  return proxy && fwd ? String(fwd).trim() : peer;
}

const DAY = 24 * 3600_000;
export const DEVICE_IDLE = 30 * DAY; // signed out after this long without use
export const DEVICE_MAX_AGE = 365 * DAY; // and this long after signing in, however busy

export class Auth {
  constructor(dataDir, password, totp, { now = () => Date.now(), wait = sleep, limits = {} } = {}) {
    const dir = path.resolve(dataDir);
    this.file = path.join(dir, 'devices.json');
    this.totp = totp;
    this.now = now;
    this.wait = wait;
    this.limits = { ...LIMITS, ...limits };
    this.failures = new Map(); // ip -> { n, until }, oldest first
    this.wrong = []; // times of the latest wrong attempts from every address
    this.checking = 0; // password checks in flight
    this.queued = []; // sign-ins waiting for one to finish
    this.devices = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : [];

    // auth.json remembers a salt and a short fingerprint of the password, so a new
    // password signs every device out. Only 16 bits are kept: enough to notice a change
    // (one in 65,536 goes unnoticed), far too few to confirm a guess from a stolen backup.
    // With no auth.json yet (first start after upgrading) devices stay signed in.
    const markFile = path.join(dir, 'auth.json');
    let mark = null;
    try {
      mark = JSON.parse(fs.readFileSync(markFile, 'utf8'));
    } catch {}
    this.salt = /^[0-9a-f]{32}$/.test(mark?.salt) ? Buffer.from(mark.salt, 'hex') : crypto.randomBytes(16);
    this.pwHash = crypto.scryptSync(password, this.salt, 32);
    const check = this.pwHash.subarray(0, 2).toString('hex');
    if (mark?.check !== check) {
      if (mark && this.devices.length) {
        console.log(`The password changed: signed out ${this.devices.length} device(s)`);
        this.devices = [];
        this.save();
      }
      fs.writeFileSync(markFile, JSON.stringify({ salt: this.salt.toString('hex'), check }), { mode: 0o600 });
    }
    this.sweep();
    if (totp.enabled) {
      // Devices that signed in before two-factor was switched on must sign in again.
      const before = this.devices.length;
      this.devices = this.devices.filter((d) => d.mfa === true);
      if (this.devices.length !== before) {
        this.save();
        console.log(`Two-factor sign-in: signed out ${before - this.devices.length} device(s) that signed in without a code`);
      }
    }
  }

  save() {
    fs.writeFileSync(this.file, JSON.stringify(this.devices, null, 1), { mode: 0o600 });
  }

  async login(ip, body) {
    this.refuseIfLocked(ip);
    const delay = this.slowdown(this.now());
    if (delay) {
      await this.wait(delay);
      this.refuseIfLocked(ip); // its tries may have run out while it waited
    }
    await this.slot();
    let ok;
    try {
      ok = crypto.timingSafeEqual(await scrypt(String(body.password ?? ''), this.salt, 32), this.pwHash);
    } finally {
      this.release();
    }
    if (!ok) this.fail(ip, 'Wrong password');
    if (this.totp.enabled) {
      const code = String(body.code ?? '').replace(/\s+/g, '');
      if (!code) throw new HttpError(401, 'Enter the 6-digit code from your authenticator', { code_required: true });
      if (!this.totp.check(code)) this.fail(ip, 'Wrong code', { code_required: true });
    }
    this.failures.delete(ip);
    const token = crypto.randomBytes(32).toString('base64url');
    const at = new Date(this.now()).toISOString();
    const dev = { id: crypto.randomBytes(6).toString('hex'), name: String(body.device || 'Device').slice(0, 60), hash: hashToken(token), created: at, lastSeen: at, ...(this.totp.enabled ? { mfa: true } : {}) };
    this.devices.push(dev);
    this.save();
    return { token, deviceId: dev.id };
  }

  refuseIfLocked(ip) {
    const f = this.failures.get(ip);
    if (f && f.n >= this.limits.perIp && f.until > this.now()) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
  }

  /** Count a wrong attempt against this address and against everyone, then refuse. */
  fail(ip, message, extra) {
    const now = this.now();
    const f = this.failures.get(ip);
    this.failures.delete(ip); // set again below, so the map stays oldest first
    this.failures.set(ip, { n: (f && f.until > now ? f.n : 0) + 1, until: now + this.limits.ipLock });
    if (this.failures.size > this.limits.tracked) this.prune();
    // only the newest few are needed to know whether the busiest threshold is reached
    this.wrong = [...this.wrong.filter((t) => now - t < this.limits.window), now].slice(-Math.max(...this.limits.slow.map(([n]) => n)));
    throw new HttpError(401, message, extra);
  }

  /** How long every sign-in waits before it is checked (0 = none), from the wrong attempts in the last window. */
  slowdown(now) {
    const recent = this.wrong.filter((t) => now - t < this.limits.window).length;
    for (const [n, ms] of [...this.limits.slow].sort((a, b) => b[0] - a[0])) if (recent >= n) return ms;
    return 0;
  }

  /** Wait for a free password-check slot. Only a short queue waits; beyond it, 503. */
  async slot() {
    if (this.checking < this.limits.inFlight) {
      this.checking++;
      return;
    }
    if (this.queued.length >= this.limits.queue) throw new HttpError(503, 'Busy checking other sign-ins. Try again in a moment.');
    await new Promise((resolve) => this.queued.push(resolve)); // release() hands its slot over
  }

  release() {
    const next = this.queued.shift();
    if (next) next();
    else this.checking--;
  }

  /** Forget lockouts that have run out, and the oldest ones if too many addresses are tracked. */
  prune() {
    const now = this.now();
    for (const [ip, f] of this.failures) if (f.until <= now) this.failures.delete(ip);
    for (const ip of this.failures.keys()) {
      if (this.failures.size <= this.limits.tracked) break;
      this.failures.delete(ip);
    }
  }

  /** The device a bearer token belongs to, or a 401. */
  check(token) {
    if (!token) throw new HttpError(401, 'Sign in required');
    const hh = hashToken(token);
    const dev = this.devices.find((d) => d.hash === hh);
    if (!dev) throw new HttpError(401, 'This device was signed out');
    const now = this.now();
    if (this.expired(dev, now)) {
      this.revoke(dev.id);
      throw new HttpError(401, 'This device was signed out');
    }
    if (now - Date.parse(dev.lastSeen) > 60_000) {
      dev.lastSeen = new Date(now).toISOString();
      this.save();
    }
    return dev;
  }

  expired(d, now) {
    // written as "not fresh" so a missing or broken date counts as expired
    return !(now - Date.parse(d.lastSeen) <= DEVICE_IDLE && now - Date.parse(d.created) <= DEVICE_MAX_AGE);
  }

  /** Drop expired devices. */
  sweep() {
    const now = this.now();
    const keep = this.devices.filter((d) => !this.expired(d, now));
    if (keep.length === this.devices.length) return;
    this.devices = keep;
    this.save();
  }

  list(currentId) {
    this.sweep();
    return this.devices.map((d) => ({ id: d.id, name: d.name, created: d.created, lastSeen: d.lastSeen, current: d.id === currentId }));
  }

  revoke(id) {
    this.devices = this.devices.filter((d) => d.id !== id);
    this.save();
  }
}
