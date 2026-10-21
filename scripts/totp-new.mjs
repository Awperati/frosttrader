#!/usr/bin/env node
// Make a new TOTP secret for this app's sign-in.
//
//   node scripts/totp-new.mjs [account name]
//
// Prints a random base32 secret and an otpauth:// link. Add the secret to KeePassXC
// (entry -> TOTP -> Set up TOTP -> paste the secret, default settings: 30 s, 6 digits),
// then put it in the server's .env as <APP>_TOTP_SECRET and restart the server.
// Nothing is saved or sent anywhere by this script.
import crypto from 'node:crypto';
import { base32Encode } from '../server/totp.mjs';

const issuer = process.env.TOTP_ISSUER || 'Frost Trader';
const account = process.argv[2] || 'owner';
const secret = base32Encode(crypto.randomBytes(20));
const uri = `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

console.log(`Secret:  ${secret}`);
console.log(`Link:    ${uri}`);
console.log('');
console.log('1. KeePassXC: open the entry for this app, then Entry > TOTP > Set up TOTP, and paste the secret.');
console.log(`2. Server .env: add this line, then restart the server:  FROST_TRADER_TOTP_SECRET=${secret}`);
console.log('Keep the secret private: anyone with it can make codes.');
