// The Settings card "Finviz Elite": plain functions from a request to { status, body }, like
// numbers-api.mjs, so tests call them without a socket.
//
//   GET  /api/finviz            screener URLs, interval, whether a token is saved, last fetch, list
//   PUT  /api/finviz            { urls?, intervalMin?, token?, clearToken? }  token is write-only
//   POST /api/finviz/test       fetch every screener once now, return the row counts
//   Each answer also carries `mirror`: the ~/.ticker.yaml mirror's status (server/engine/ticker-mirror.mjs).
//
// No response ever carries the token. Changes are taken only from this machine's own page: the
// Host must be local and any Origin must match it (stops other websites and DNS rebinding).
import { HttpError } from './store.mjs';

const LOCAL = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

/** Throw unless the request came from Frost Trader's own page on this machine. */
export function checkLocal(headers = {}) {
  const host = String(headers.host || '');
  if (!LOCAL.test(host)) throw new HttpError(403, 'Settings can only be changed from this computer');
  const origin = headers.origin;
  if (origin && origin !== `http://${host}`) throw new HttpError(403, 'Settings can only be changed from Frost Trader itself');
  if (!/^application\/json\b/i.test(String(headers['content-type'] || ''))) throw new HttpError(415, 'Send JSON');
}

export function createFinvizApi({ source, mirror = null }) {
  const withMirror = (st) => ({ ...st, mirror: mirror ? mirror.status() : null });
  return {
    async handle(method, pathname, headers = {}, body = null) {
      const rest = pathname.replace(/^\/api\/finviz\/?/, '');
      if (method === 'GET' && rest === '') return { status: 200, body: withMirror(source.status()) };
      if (method === 'PUT' && rest === '') {
        checkLocal(headers);
        try {
          return { status: 200, body: withMirror(source.update(body || {})) };
        } catch (e) {
          throw new HttpError(400, e.message);
        }
      }
      if (method === 'POST' && rest === 'test') {
        checkLocal(headers);
        return { status: 200, body: withMirror(await source.refresh('test')) };
      }
      throw new HttpError(404, 'Not found');
    },
  };
}
