// Live trading (REAL money) for the Settings "Live trading" card. Everything here changes only from
// this computer's own page (checkLocal: through the SSH tunnel on the Pi), and the steps that open or
// re-open live also need the owner's password and 6-digit code (server/auth.mjs).
//
//   GET  /api/live                 the desk's status, keys set or not, the proposed and hard limits, the phrase hint
//   PUT  /api/live/keys            { keyId, secret } (AK… only) or { clear: true }   write-only, never returned or logged
//   POST /api/live/keys/test       read the account once (no order)
//   POST /api/live/enable          { password, code, phrase, limits, confirmed: [every limit key] }
//   POST /api/live/lower           { limits }   lower only, no step-up needed (the safe direction)
//   POST /api/live/disable         switch live off: the enablement is set aside and every live position closed
//   POST /api/live/resume          { password, code }   after a stop (kill switch, integrity, drawdown)
//
// Claude never calls these with real keys; the owner types his own.
import { HttpError } from './store.mjs';
import { checkLocal, AUTHED } from './finviz-api.mjs';
import { LIVE_HARD, LIVE_PROPOSED, LIMIT_LABELS, cleanLiveLimits, phraseFor } from './engine/live/enablement.mjs';
import { accountProblem } from './engine/live/desk.mjs';

export function createLiveApi({ desk, keys, enablement, auth = null, getFx = () => null }) {
  const stepUp = async (ip, body) => {
    if (!auth) throw new HttpError(403, 'Owner sign-in is not set up on this server (FROST_TRADER_PASSWORD and FROST_TRADER_TOTP_SECRET in its .env). See docs/LIVE.md.');
    await auth.verify(ip, body || {});
  };
  const status = () => ({
    ...desk.status(),
    keys: keys.status(),
    signInReady: !!auth,
    proposed: LIVE_PROPOSED,
    hard: LIVE_HARD,
    labels: LIMIT_LABELS,
    phrase: 'TRADE LIVE followed by the last 4 digits of your live account number',
    funding: 'You fund the account yourself: an international USD wire from your bank, per Alpaca\'s instructions. Your bank charges its own fee for each wire.',
  });
  return {
    async handle(method, pathname, headers = {}, body = null, ip = '') {
      const route = `${method} ${pathname.replace(/\/+$/, '')}`;
      if (route !== 'GET /api/live') checkLocal(headers);
      switch (route) {
        case 'GET /api/live':
          return { status: 200, body: status() };
        case 'PUT /api/live/keys':
          // live keys are typed only on this computer (or through the SSH tunnel), never over the website
          if (headers[AUTHED] === true) throw new HttpError(403, 'Save live keys from your PC through the SSH tunnel, not over the website.');
          try {
            keys.update(body || {});
          } catch (e) {
            throw new HttpError(400, e.message);
          }
          return { status: 200, body: status() };
        case 'POST /api/live/keys/test':
          await keys.test();
          return { status: 200, body: status() };
        case 'POST /api/live/enable': {
          await stepUp(ip, body);
          const b = keys.broker();
          if (!b) throw new HttpError(400, 'Save your live keys first.');
          let acct;
          try {
            acct = await b.account();
          } catch (e) {
            throw new HttpError(502, b.redact(e.message));
          }
          if (acct.status && acct.status !== 'ACTIVE') throw new HttpError(400, `The live account's status is ${acct.status}, not ACTIVE.`);
          const problem = accountProblem(acct, null);
          if (problem) throw new HttpError(400, `Live stays off: ${problem}.`);
          const want = phraseFor(acct.number);
          if (String(body?.phrase || '').trim() !== want) throw new HttpError(400, 'The phrase does not match. Type TRADE LIVE and the last 4 digits of your live account number.');
          const confirmed = Array.isArray(body?.confirmed) ? body.confirmed.filter((k) => k in LIVE_HARD) : [];
          const missing = Object.keys(LIVE_HARD).filter((k) => !confirmed.includes(k));
          if (missing.length) throw new HttpError(400, `Confirm every limit first: ${missing.map((k) => LIMIT_LABELS[k]).join(', ')}.`);
          // the owner (27 Oct 2026) chose a cash account: he confirms it from Alpaca's dashboard, or live stays off
          if (body?.cashAccount !== true) throw new HttpError(400, 'Confirm that Alpaca\'s dashboard shows this live account as a CASH account. A margin account is refused.');
          const fx = getFx();
          enablement.write({ account: acct.number, limits: cleanLiveLimits(body?.limits || {}), confirmed, rate: fx ? { rate: fx.rate, date: fx.date } : null, cashAccount: true });
          desk.audit.write({ type: 'live-enable', account: acct.number.slice(-4), limits: enablement.read()?.limits });
          // after a stop or an earlier switch-off: a fresh enablement clears it once the account holds nothing
          if (desk.state.stopped) await desk.resume().catch(() => {});
          return { status: 200, body: status() };
        }
        case 'POST /api/live/lower':
          try {
            enablement.lower(body?.limits || {});
          } catch (e) {
            throw new HttpError(400, e.message);
          }
          desk.audit.write({ type: 'live-lower', limits: enablement.read()?.limits });
          return { status: 200, body: status() };
        case 'POST /api/live/disable':
          await desk.stopAll('the owner switched live off');
          enablement.revoke('owner switched live off');
          desk.audit.write({ type: 'live-disable' });
          return { status: 200, body: status() };
        case 'POST /api/live/resume':
          await stepUp(ip, body);
          try {
            await desk.resume();
          } catch (e) {
            throw new HttpError(400, e.message);
          }
          return { status: 200, body: status() };
        default:
          throw new HttpError(404, 'Not found');
      }
    },
  };
}
