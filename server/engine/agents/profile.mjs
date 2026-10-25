// The paper agents' settings: how many run, the paper money each gets, the risk preset and each
// agent's own parameters. Paper only: none of this is a live limit and nothing here enables live.
//
// The paper money is in Australian dollars (the owner: "$10AUD"); the books are in US dollars, at
// each trading day's rate (server/engine/data/fx.mjs).
//
// "Medium" is a starting preset the owner chose by name; its numbers are his to change in Settings.
// Every dollar figure is a share of the agent's allocation, so the halts scale when he raises the
// paper money from $10 to $250.

export const MAX_AGENTS = 4;
export const AGENT_IDS = ['agent-a', 'agent-b', 'agent-c', 'agent-d'];
export const PAPER_MONEY = { min: 5, max: 250, start: 10 }; // AUSTRALIAN dollars per agent (data/fx.mjs converts)

/** The risk preset, as shares of the agent's allocation (or counts). */
export const MEDIUM = Object.freeze({
  name: 'Medium',
  riskPerTrade: 0.0075, // lose at most 0.75 % of the agent's equity if a trade hits its stop
  maxPositionPct: 0.25, // at most 25 % of its equity in one position
  maxOpenPositions: 4,
  maxTradesPerDay: 6, // buys per trading day
  dailyLossPct: 0.03, // the agent stops for the day at a 3 % loss
  drawdownPct: 0.1, // 10 % below its best equity: drawdown halt (automatic, see host.mjs)
  poolDailyLossPct: 0.02, // every agent stops buying for the day at a 2 % loss across all of them
});

/** What Settings may set each preset value to. */
export const PRESET_BOUNDS = Object.freeze({
  riskPerTrade: [0.001, 0.01],
  maxPositionPct: [0.05, 0.25],
  maxOpenPositions: [1, 8],
  maxTradesPerDay: [1, 30],
  dailyLossPct: [0.005, 0.1],
  drawdownPct: [0.02, 0.3],
  poolDailyLossPct: [0.005, 0.1],
});

/** Each agent's strategy parameters and their bounds (the agent may not go outside them). */
export const PARAM_BOUNDS = Object.freeze({
  entryScore: [0.5, 0.95],
  stopAtr: [1, 3],
  targetAtr: [1.5, 5],
  maxHold: [6, 48], // 5-minute bars
});

/** Seeded variants A–D, so the four agents are comparable but not identical. */
export const DEFAULT_PARAMS = Object.freeze({
  'agent-a': { entryScore: 0.6, stopAtr: 2, targetAtr: 3, maxHold: 24 },
  'agent-b': { entryScore: 0.7, stopAtr: 1.5, targetAtr: 3, maxHold: 18 },
  'agent-c': { entryScore: 0.55, stopAtr: 2.5, targetAtr: 4, maxHold: 36 },
  'agent-d': { entryScore: 0.65, stopAtr: 2, targetAtr: 2.5, maxHold: 12 },
});

/**
 * How each agent picks its buys. "signals": the signal pipeline and the parameters above (tuned each
 * night by research/nightly.mjs). "v11": the v11 model (server/engine/models/v11.mjs), which sets its own
 * entry threshold and exit (a 1 % trailing stop, 20 bars at most); its parameters above are not used
 * and the nightly test leaves it alone.
 */
export const STRATEGIES = Object.freeze(['signals', 'v11']);
export const DEFAULT_STRATEGIES = Object.freeze({ 'agent-a': 'signals', 'agent-b': 'signals', 'agent-c': 'signals', 'agent-d': 'v11' });

/**
 * Where the agents' orders go. "sim": each agent's own simulated book only. "alpaca-paper": also sent
 * to the owner's Alpaca PAPER account and booked at Alpaca's fill (broker/alpaca-paper-orders.mjs).
 * Never a live account: there is no such choice.
 */
export const ORDER_MODES = Object.freeze(['sim', 'alpaca-paper']);

export const DEFAULT_SETTINGS = Object.freeze({
  orders: 'sim',
  agentsAtOnce: MAX_AGENTS,
  paperPerAgent: PAPER_MONEY.start,
  preset: MEDIUM,
  params: DEFAULT_PARAMS,
  strategies: DEFAULT_STRATEGIES,
});

const clamp = (v, [lo, hi], fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};
const INTEGER = new Set(['maxOpenPositions', 'maxTradesPerDay', 'maxHold']);

/** Settings as saved or sent by the UI, made safe: every value inside its bounds. */
export function cleanSettings(input = {}, base = DEFAULT_SETTINGS) {
  const out = {
    orders: ORDER_MODES.includes(input.orders) ? input.orders : (base.orders ?? 'sim'),
    agentsAtOnce: Math.round(clamp(input.agentsAtOnce, [1, MAX_AGENTS], base.agentsAtOnce)),
    paperPerAgent: Math.round(clamp(input.paperPerAgent, [PAPER_MONEY.min, PAPER_MONEY.max], base.paperPerAgent) * 100) / 100,
    preset: { name: String(input.preset?.name ?? base.preset.name).slice(0, 20) || 'Medium' },
    params: {},
    strategies: {},
  };
  for (const [k, b] of Object.entries(PRESET_BOUNDS)) {
    const v = clamp(input.preset?.[k], b, base.preset[k]);
    out.preset[k] = INTEGER.has(k) ? Math.round(v) : v;
  }
  for (const id of AGENT_IDS) {
    out.params[id] = {};
    for (const [k, b] of Object.entries(PARAM_BOUNDS)) {
      const v = clamp(input.params?.[id]?.[k], b, (base.params[id] ?? DEFAULT_PARAMS[id])[k]);
      out.params[id][k] = INTEGER.has(k) ? Math.round(v) : v;
    }
    const st = input.strategies?.[id];
    out.strategies[id] = STRATEGIES.includes(st) ? st : (base.strategies?.[id] ?? DEFAULT_STRATEGIES[id]);
  }
  return out;
}

/**
 * The RiskGuard limits for one agent: the preset's shares turned into dollars for its allocation.
 * `scale` (0.5 after a drawdown halt) shrinks the per-trade risk and position size.
 */
export function limitsFor(allocation, preset, scale = 1) {
  return {
    maxPositionValue: allocation * preset.maxPositionPct * scale,
    maxPositionPct: preset.maxPositionPct * scale,
    maxDailyLoss: allocation * preset.dailyLossPct,
    maxTradesPerDay: preset.maxTradesPerDay,
    maxOpenPositions: preset.maxOpenPositions,
    riskPerTrade: preset.riskPerTrade * scale,
  };
}
