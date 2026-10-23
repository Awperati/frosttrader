// The messages between the host and an agent child process (docs/DESIGN-autonomous-agents.md §1.3).
// An agent may send only these, each checked field by field; anything else is malformed. The host
// never evaluates or imports anything an agent sends, and the agent id comes from which child sent
// the message, never from its body.
import { STOCK } from '../risk.mjs';

export const MAX_PROPOSALS = 10;

/**
 * Check one message from an agent. Returns { ok: true, msg } with only the known fields, or
 * { ok: false, reason }.
 *   { type: 'ready' }
 *   { type: 'proposals', t, items: [{ symbol, action: 'buy', signal, score }] }
 *   { type: 'log', text }
 */
export function checkAgentMessage(m) {
  const bad = (reason) => ({ ok: false, reason });
  if (!m || typeof m !== 'object' || Array.isArray(m)) return bad('not an object');
  const keys = Object.keys(m);
  const only = (...allowed) => keys.every((k) => allowed.includes(k));
  switch (m.type) {
    case 'ready':
      return only('type') ? { ok: true, msg: { type: 'ready' } } : bad('unknown fields');
    case 'log':
      if (!only('type', 'text') || typeof m.text !== 'string') return bad('bad log');
      return { ok: true, msg: { type: 'log', text: m.text.slice(0, 300) } };
    case 'proposals': {
      if (!only('type', 't', 'items') || !Number.isFinite(m.t) || !Array.isArray(m.items)) return bad('bad proposals');
      if (m.items.length > MAX_PROPOSALS) return bad(`more than ${MAX_PROPOSALS} proposals`);
      const items = [];
      for (const p of m.items) {
        if (!p || typeof p !== 'object' || !Object.keys(p).every((k) => ['symbol', 'action', 'signal', 'score'].includes(k))) return bad('unknown proposal fields');
        if (typeof p.symbol !== 'string' || !STOCK.test(p.symbol)) return bad('bad symbol');
        if (p.action !== 'buy') return bad('only buy proposals (exits are the host\'s)');
        if (typeof p.signal !== 'string' || !/^[a-z_]{1,32}$/.test(p.signal)) return bad('bad signal id');
        if (!Number.isFinite(p.score) || p.score < -1 || p.score > 1) return bad('bad score');
        items.push({ symbol: p.symbol, action: 'buy', signal: p.signal, score: p.score });
      }
      return { ok: true, msg: { type: 'proposals', t: m.t, items } };
    }
    default:
      return bad('unknown message type');
  }
}
