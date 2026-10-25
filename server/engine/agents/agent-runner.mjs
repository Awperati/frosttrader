// One paper agent, run by the host as a child process with Node's permission model: it may read
// only the engine's code, write nothing, start no process, and its environment holds no key.
// It gets bars over IPC each tick and answers with buy proposals from the signal pipeline and its own
// parameters. Everything else (sizing, the gate, fills, exits, halts) is the host's.
import { evaluateAll, SIGNALS } from '../signals/index.mjs';
import { featuresAt, loadModel, score, tradable } from '../models/v11.mjs';

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

/**
 * The v11 model's buys. `context` holds about two weeks of bars for the model's 38 stocks (its market
 * features need all of them); only watchlist stocks (`bars`) that are also among the 38 can be bought.
 */
function proposeV11({ t, bars, context, held }) {
  const model = loadModel();
  const rows = featuresAt(context || {});
  const newest = Math.max(...Object.values(rows).map((r) => r?.t ?? 0));
  const items = [];
  const considered = [];
  for (const symbol of Object.keys(bars || {})) {
    if (held?.includes(symbol) || !model.universe.includes(symbol)) continue;
    const row = rows[symbol];
    if (!row || row.t !== newest || !tradable(row)) {
      considered.push({ symbol, why: 'few-bars' });
      continue;
    }
    if (row.bar_of_day < model.entryBars[0] || row.bar_of_day > model.entryBars[1]) continue;
    const p = score(model, row);
    if (p >= model.threshold) items.push({ symbol, action: 'buy', signal: 'model_v11', score: r3(p) });
    else considered.push({ symbol, why: 'below-entry', signal: 'model_v11', score: r3(p) });
  }
  items.sort((a, b) => b.score - a.score);
  return { type: 'proposals', t, items: items.slice(0, 10), considered: considered.slice(0, 40) };
}

process.on('message', (m) => {
  if (m?.type !== 'tick') return;
  try {
    process.send(m.strategy === 'v11' ? proposeV11(m) : propose(m));
  } catch (e) {
    process.send({ type: 'log', text: `${id}: ${e.message}` });
    process.send({ type: 'proposals', t: m.t, items: [] });
  }
});
process.send({ type: 'ready' });
