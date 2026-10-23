// One paper agent, run by the host as a child process with Node's permission model: it may read
// only the engine's code, write nothing, start no process, and its environment holds no key.
// It gets bars over IPC each tick and answers with buy proposals from the signal pipeline and its own
// parameters. Everything else (sizing, the gate, fills, exits, halts) is the host's.
import { evaluateAll, SIGNALS } from '../signals/index.mjs';

const id = process.env.AGENT_ID || 'agent';

const r3 = (x) => Math.round(x * 1000) / 1000;

/** Buy proposals, and what it looked at and why it passed (for the owner's decision log). */
function propose({ t, params, bars, held }) {
  const items = [];
  const considered = [];
  for (const [symbol, list] of Object.entries(bars || {})) {
    if (!Array.isArray(list) || held?.includes(symbol)) continue;
    if (list.length < 20) {
      considered.push({ symbol, why: 'few-bars' });
      continue;
    }
    const i = list.length - 1;
    const sigs = evaluateAll(list, i, {}, SIGNALS);
    const tell = sigs.filter((s) => s.score <= -0.5).sort((a, b) => a.score - b.score)[0];
    if (tell) {
      considered.push({ symbol, why: 'tell', signal: tell.id, score: r3(tell.score) });
      continue;
    }
    const best = sigs.filter((s) => s.kind === 'entry').sort((a, b) => b.score - a.score)[0];
    if (best && best.score >= params.entryScore) items.push({ symbol, action: 'buy', signal: best.id, score: r3(best.score) });
    else if (best) considered.push({ symbol, why: 'below-entry', signal: best.id, score: r3(best.score) });
    else considered.push({ symbol, why: 'no-signal' });
  }
  items.sort((a, b) => b.score - a.score);
  return { type: 'proposals', t, items: items.slice(0, 10), considered: considered.slice(0, 40) };
}

process.on('message', (m) => {
  if (m?.type !== 'tick') return;
  try {
    process.send(propose(m));
  } catch (e) {
    process.send({ type: 'log', text: `${id}: ${e.message}` });
    process.send({ type: 'proposals', t: m.t, items: [] });
  }
});
process.send({ type: 'ready' });
