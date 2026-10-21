// Time-based one-time passwords (RFC 6238: HMAC-SHA1, 30 s steps, 6 digits), no dependencies.
// Works with KeePassXC, KeePassDX, Google Authenticator, Aegis and the like.
//
//   const totp = createTotp(process.env.APP_TOTP_SECRET)   // base32 secret, or '' to switch off
//   totp.enabled                                         // true when a secret is set
//   totp.check('123456')                                 // true once per code (replays refused)
import crypto from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Decode(s) {
  const clean = String(s).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('The TOTP secret must be base32 (letters A-Z and digits 2-7).');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

// The 6-digit code for one 30-second step.
export function codeAt(key, step) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', key).update(msg).digest();
  const o = h[h.length - 1] & 0xf;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, '0');
}

export function createTotp(secret, { now = () => Date.now(), window = 1 } = {}) {
  if (!secret) return { enabled: false, check: () => true };
  const key = base32Decode(secret);
  if (key.length < 10) throw new Error('The TOTP secret is too short (use at least 16 base32 characters).');
  let lastStep = -1; // each code works once, so a code seen over someone's shoulder can't be reused
  return {
    enabled: true,
    check(code) {
      const c = String(code ?? '').replace(/\s/g, '');
      if (!/^\d{6}$/.test(c)) return false;
      const step = Math.floor(now() / 30_000);
      // Allow one step either side for clock drift between the phone and the server.
      for (let d = -window; d <= window; d++) {
        const s = step + d;
        if (s <= lastStep) continue;
        if (crypto.timingSafeEqual(Buffer.from(codeAt(key, s)), Buffer.from(c))) {
          lastStep = s;
          return true;
        }
      }
      return false;
    },
  };
}
