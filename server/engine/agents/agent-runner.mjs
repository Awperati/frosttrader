// One paper agent, run by the host as a child process with Node's permission model: it may read
// only the engine's code, write nothing, start no process, and its environment holds no key.
// It gets bars over IPC each tick and answers with buy proposals from the signal pipeline and its own
// parameters. Everything else (sizing, the gate, fills, exits, halts) is the host's.
import { evaluateAll, SIGNALS } from '../signals/index.mjs';

const id = process.env.AGENT_ID || 'agent';

function propose({ t, params, bars, held }) {
  const items = [];
  for (const [symbol, list] of Object.entries(bars || {})) {
    if (!Array.isArray(list) || list.length < 20 || held?.includes(symbol)) continue;
    const i = list.length - 1;
    const sigs = evaluateAll(list, i, {}, SIGNALS);
    if (sigs.some((s) => s.score <= -0.5)) continue; // a manipulation tell: stay out
    const best = sigs.filter((s) => s.kind === 'entry').sort((a, b) => b.score - a.score)[0];
    if (best && best.score >= params.entryScore) items.push({ symbol, action: 'buy', signal: best.id, score: Math.round(best.score * 1000) / 1000 });
  }
  items.sort((a, b) => b.score - a.score);
  return { type: 'proposals', t, items: items.slice(0, 10) };
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
