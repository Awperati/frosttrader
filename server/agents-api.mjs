// The paper agents and the Alpaca paper keys, for the Paper portfolio screen and Settings. Plain
// functions from a request to { status, body }, like finviz-api.mjs.
//
//   GET  /api/agents               every agent's book, halts, kill state, recent audit events
//   PUT  /api/agents/settings      { agentsAtOnce?, paperPerAgent?, preset?, params? }
//   POST /api/agents/kill          { reason? }   the owner's kill switch
//   POST /api/agents/resume        clears the kill switch and an integrity halt (owner only)
//   GET  /api/alpaca               whether paper keys are saved, the last test. Never a key.
//   PUT  /api/alpaca               { keyId, secret } or { clear: true }   write-only
//   POST /api/alpaca/test          fetch SPY's latest bar once
//
// Changes come only from this computer's own page (checkLocal). Nothing here can enable live trading.
import { HttpError } from './store.mjs';
import { checkLocal } from './finviz-api.mjs';

export function createAgentsApi({ host, keys }) {
  return {
    async handle(method, pathname, headers = {}, body = null) {
      const route = `${method} ${pathname.replace(/\/+$/, '')}`;
      const local = () => checkLocal(headers);
      const bad = (fn) => {
        try {
          return fn();
        } catch (e) {
          throw new HttpError(400, e.message);
        }
      };
      switch (route) {
        case 'GET /api/agents':
          return { status: 200, body: host.status() };
        case 'PUT /api/agents/settings':
          local();
          return { status: 200, body: bad(() => host.updateSettings(body || {})) };
        case 'POST /api/agents/kill':
          local();
          return { status: 200, body: host.kill(typeof body?.reason === 'string' && body.reason.trim() ? body.reason.slice(0, 200) : 'Kill switch pressed') };
        case 'POST /api/agents/resume':
          local();
          return { status: 200, body: host.resume() };
        case 'GET /api/alpaca':
          return { status: 200, body: keys.status() };
        case 'PUT /api/alpaca':
          local();
          return { status: 200, body: bad(() => keys.update(body || {})) };
        case 'POST /api/alpaca/test':
          local();
          return { status: 200, body: await keys.test() };
        default:
          throw new HttpError(404, 'Not found');
      }
    },
  };
}
