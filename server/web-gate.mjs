// The private website (docs/WEBSITE.md): FrostTrader reached from the owner's phone or PC through his
// Cloudflare tunnel at one hostname, behind Cloudflare Access. OFF unless the server's environment
// sets FROST_TRADER_PUBLIC_HOST (and his sign-in, with a 6-digit code). The server still listens on
// 127.0.0.1 only; cloudflared on the Pi connects to it there.
//
// A request is REMOTE when it came through Cloudflare (a cf-connecting-ip header) or names any Host
// other than this computer. Remote requests:
//   - are refused when the website is off, or name another hostname;
//   - must carry Cloudflare Access's signed token when FROST_TRADER_CF_TEAM and FROST_TRADER_CF_AUD
//     are set (checked here against Access's public keys: a second lock behind Cloudflare);
//   - must come from the website's own page (Origin), with no CORS;
//   - need a signed-in session (Authorization: Bearer, never a cookie, so no CSRF) on every /api route
//     except sign-in; sessions end after 30 minutes idle or 12 hours;
//   - can't reach the Frost AI connector (/mcp);
//   - are rate limited per client address (Cloudflare's header, trusted only from the local tunnel).
// Requests on 127.0.0.1 (the SSH tunnel, the Windows app) work as before.
import crypto from 'node:crypto';
import { HttpError } from './store.mjs';
import { AUTHED } from './finviz-api.mjs';

const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
const LOOPBACK = /^(127\.|::1$|::ffff:127\.)/;
export const SESSION = Object.freeze({ idleMs: 30 * 60_000, maxAgeMs: 12 * 3_600_000 });
export const RATE = Object.freeze({ perMinute: 300 });

export function isRemote(req) {
  return !!req.headers['cf-connecting-ip'] || !LOCAL_HOST.test(String(req.headers.host || ''));
}

/** The client's address: Cloudflare's header only when the request came from the local tunnel. */
export function clientIp(req) {
  const sock = String(req.socket?.remoteAddress || '');
  const cf = String(req.headers['cf-connecting-ip'] || '');
  return LOOPBACK.test(sock) && cf && /^[0-9a-fA-F:.]{2,45}$/.test(cf) ? cf : sock;
}

const b64url = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

export class WebGate {
  /**
   * publicHost: the website's hostname (or '' = off). auth: the owner's sign-in (server/auth.mjs) or null.
   * access: { team, aud } to check Cloudflare Access's token, or null. audit: { write }.
   */
  constructor({ publicHost = '', auth = null, access = null, audit = { write() {} }, fetchImpl = (...a) => globalThis.fetch(...a), now = Date.now }) {
    Object.assign(this, { publicHost: String(publicHost || '').toLowerCase(), auth, access, audit, fetchImpl, now });
    this.hits = new Map(); // ip -> { minute, n }
    this.jwks = null; // { at, keys }
  }

  get on() {
    return !!(this.publicHost && this.auth && this.auth.totp?.enabled);
  }

  status(req) {
    return { website: this.on, remote: isRemote(req), host: this.publicHost || null, accessCheck: !!this.access };
  }

  /**
   * Let a request in, or throw. Returns the headers the routes see: for a signed-in remote request they
   * carry AUTHED (a Symbol: no header from the network can set it), which checkLocal() accepts.
   */
  async admit(req, pathname) {
    if (!isRemote(req)) return { remote: false, headers: req.headers, device: null };
    if (!this.on) throw new HttpError(403, 'The FrostTrader website is off.');
    const host = String(req.headers.host || '').toLowerCase();
    if (host !== this.publicHost) throw new HttpError(421, 'Wrong hostname.');
    this.rateLimit(clientIp(req));
    if (this.access) await this.checkAccess(req);
    if (!pathname.startsWith('/api/') && pathname !== '/mcp') return { remote: true, headers: req.headers, device: null }; // the page itself
    if (pathname === '/mcp') throw new HttpError(403, 'The Frost AI connector works only on this computer.');
    const origin = req.headers.origin;
    if (origin && origin !== `https://${this.publicHost}`) throw new HttpError(403, 'Requests must come from the FrostTrader website itself.');
    if (pathname === '/api/auth/login' || pathname === '/api/auth/status') return { remote: true, headers: req.headers, device: null };
    const m = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(String(req.headers.authorization || ''));
    const device = this.auth.check(m ? m[1] : null);
    return { remote: true, headers: { ...req.headers, [AUTHED]: true }, device };
  }

  rateLimit(ip) {
    const minute = Math.floor(this.now() / 60_000);
    const h = this.hits.get(ip);
    if (!h || h.minute !== minute) this.hits.set(ip, { minute, n: 1 });
    else if (++h.n > RATE.perMinute) throw new HttpError(429, 'Too many requests. Wait a minute.');
    if (this.hits.size > 5000) this.hits.clear();
  }

  /** Cloudflare Access's signed token (RS256): its signature, audience, issuer and expiry. */
  async checkAccess(req) {
    const jwt = String(req.headers['cf-access-jwt-assertion'] || '');
    const parts = jwt.split('.');
    if (parts.length !== 3) throw new HttpError(403, 'Cloudflare Access sign-in required.');
    let head, claims;
    try {
      head = JSON.parse(b64url(parts[0]).toString('utf8'));
      claims = JSON.parse(b64url(parts[1]).toString('utf8'));
    } catch {
      throw new HttpError(403, 'Cloudflare Access token unreadable.');
    }
    if (head.alg !== 'RS256') throw new HttpError(403, 'Cloudflare Access token: wrong algorithm.');
    const keys = await this.accessKeys();
    const jwk = keys.find((k) => k.kid === head.kid);
    if (!jwk) throw new HttpError(403, 'Cloudflare Access token: unknown key.');
    const ok = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), crypto.createPublicKey({ key: jwk, format: 'jwk' }), b64url(parts[2]));
    if (!ok) throw new HttpError(403, 'Cloudflare Access token: bad signature.');
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(this.access.aud)) throw new HttpError(403, 'Cloudflare Access token: another application.');
    if (claims.iss !== `https://${this.access.team}.cloudflareaccess.com`) throw new HttpError(403, 'Cloudflare Access token: another team.');
    if (!(claims.exp * 1000 > this.now())) throw new HttpError(403, 'Cloudflare Access sign-in has expired.');
  }

  async accessKeys() {
    if (this.jwks && this.now() - this.jwks.at < 3_600_000) return this.jwks.keys;
    const res = await this.fetchImpl(`https://${this.access.team}.cloudflareaccess.com/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new HttpError(503, 'Could not read Cloudflare Access keys.');
    const body = await res.json();
    this.jwks = { at: this.now(), keys: Array.isArray(body.keys) ? body.keys : [] };
    return this.jwks.keys;
  }
}

/** The security headers every answer carries (the website and 127.0.0.1 alike). */
export function securityHeaders(remote) {
  return {
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    ...(remote ? { 'strict-transport-security': 'max-age=31536000' } : {}),
  };
}
