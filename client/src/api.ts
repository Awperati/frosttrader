// Types and calls for the read-only /api/numbers routes (server/numbers-api.mjs).

export type Bar = { t: number; o: number; h: number; l: number; c: number; v: number | null };

export type Quote = {
  t: number;
  last: number;
  open: number;
  prevClose: number | null;
  change: number | null;
  changePct: number | null;
  dayLow: number;
  dayHigh: number;
  volume: number | null;
  low52: number;
  high52: number;
};

export type Labels = { source: string; lastDay: string | null; ageDays: number | null; notice: string; kind: string };

export type WatchlistHook = { status: 'not-set' | 'set'; symbols: string[]; ageMin: number | null; stale: boolean; holders: Record<string, string>; how: string; pricesFrom: string };

export type SymbolRow = { symbol: string; name: string; hasVolume: boolean; quote: Quote; spark: number[]; from: string; to: string };

export type Overview = {
  available: boolean;
  how?: string;
  dataset: { title: string; url: string; licence: string; provenance: string; units: string; rows?: number; from?: string; to?: string; droppedByReason?: Record<string, number>; droppedTotal?: number };
  labels: Labels;
  ranges?: string[];
  symbols: SymbolRow[];
  watchlist: WatchlistHook;
};

export type Stats = {
  from: number;
  to: number;
  bars: number;
  returnPct: number;
  annualReturnPct: number | null;
  meanDailyPct: number;
  volatilityPct: number;
  maxDrawdownPct: number;
  bestDay: { pct: number; t: number };
  worstDay: { pct: number; t: number };
  upDaysPct: number;
};

export type Quality = {
  name: string;
  from: string;
  to: string;
  bars: number;
  withVolume: number;
  longestGap: { days: number; from: string | null; to: string | null };
  dropped: Record<string, number>;
};

export type Detail = {
  symbol: string;
  name: string;
  hasVolume: boolean;
  range: string;
  labels: Labels;
  quote: Quote;
  chart: Bar[];
  chartBars: number;
  stats: Stats | null;
  returns: Record<string, number | null>;
  quality: Quality;
};

export type HistoryPage = { symbol: string; page: number; size: number; pages: number; total: number; rows: Bar[] };

export type TickerPreview = { source: 'paste' | 'csv'; symbols: string[]; rejected: { value: string; reason: string }[]; stored: false };

export type FinvizFetch = { at: number; ok: boolean; error: string | null; reason: string; perUrl: { url: string; rows: number | null; error: string | null }[] };

export type FinvizStatus = {
  urls: string[];
  intervalMin: number;
  intervals: number[];
  tokenSet: boolean;
  inWindow: boolean;
  window: string;
  last: FinvizFetch | null;
  list: { source: 'finviz'; at: number; symbols: string[]; rows: number; dropped: number; rejected: string[]; ageMin: number; stale: boolean } | null;
  note: string | null;
  mirror: { file: string; status: 'idle' | 'ok' | 'foreign' | 'error'; at: number | null; error: string | null; symbols: number; lots: number } | null;
};

export type FinvizUpdate = { urls?: string[]; intervalMin?: number; token?: string; clearToken?: boolean };

export type Preset = { name: string; riskPerTrade: number; maxPositionPct: number; maxOpenPositions: number; maxTradesPerDay: number; dailyLossPct: number; drawdownPct: number; poolDailyLossPct: number };
export type AgentParams = { entryScore: number; stopAtr: number; targetAtr: number; maxHold: number };
export type Strategy = 'signals' | 'v11';
export type AgentSettings = { agentsAtOnce: number; paperPerAgent: number; preset: Preset; params: Record<string, AgentParams>; strategies: Record<string, Strategy> };
export type ModelInfo = { threshold: number; exit: { kind: 'pct' | 'atr'; stop: number; maxHold: number }; universe: string[]; test: { trades: number; win_rate: number; avg_bps: number } | null; testPeriod: string | null; error?: string };
export type Fill = { t: number; symbol: string; side: 'buy' | 'sell'; qty: number; price: number; pnl: number; why: string };
export type AgentView = {
  id: string;
  running: boolean;
  process: boolean;
  allocation: number | null;
  cash: number | null;
  equity: number | null;
  dayPnl: number | null;
  totalPnl: number | null;
  positions: { symbol: string; qty: number; avg: number; price: number; plan: { stop: number; target: number | null; signal: string; trailPct?: number } | null }[];
  halt: { day: string; reason: string; at: number } | null;
  sitOut: number;
  scale: number;
  peak: number | null;
  params: AgentParams;
  strategy: Strategy;
  lastProposals: { symbol: string; signal: string; score: number }[];
  lastDecision: { at: number; symbol: string; ok: boolean; reason: string } | null;
  recentFills: Fill[];
  broken: string | null;
};
export type AuditEvent = { at: string; type: string; agent?: string; symbol?: string; side?: string; reason?: string; why?: string; kind?: string; qty?: number; price?: number; pnl?: number };
export type AgentsStatus = {
  paperOnly: true;
  live: string;
  settings: AgentSettings;
  models?: { v11: ModelInfo };
  currency: string;
  fx: { rate: number; date: string; source: string; ageDays: number } | null;
  usdPerAgent: number | null;
  killed: boolean;
  killReason: string;
  paused: { by: string; at: number } | null;
  integrity: { reason: string; at: number } | null;
  poolPause: { day: string; reason: string } | null;
  marketOpen: boolean;
  lastTick: number | null;
  lastError: string;
  pool: number;
  holders: Record<string, string>;
  agents: AgentView[];
  audit: { ok: boolean; lines: number; brokenAt: number | null; recent: AuditEvent[] };
};
export type Decision = { t: number; day: string; agent: string; kind: 'considered' | 'bought' | 'refused' | 'sold' | 'halt' | 'resume' | 'note'; symbol?: string; text: string };
export type TradeBrief = { symbol: string; signal: string; pnlUsd: number; pnlAud: number | null; exit: string; day: string } | null;
export type Tally = { trades: number; wins: number; winRate: number | null; pnlUsd: number; pnlAud: number; avgAud: number | null; best: TradeBrief; worst: TradeBrief };
export type DaySummary = { day: string; agents: (Tally & { agent: string; halts: string[]; considered: number; refusals: Record<string, number> })[]; all: Tally & { halts: number } };
export type Group = Tally & { key: string };
export type AgentStats = { from: string; agent: string | null; all: Tally; bySignal: Group[]; bySymbol: Group[]; byTime: Group[]; byExit: Group[] };

export type Combined = { n: number; pnl: number; expectancy: number; maxDrawdown: number; maxDrawdownPct: number; last: number };
export type WindowResult = { fit: [string, string]; test: [string, string]; pick: number; pickParams: AgentParams; current: { pnl: number; n: number; maxDrawdown: number }; picked: { pnl: number; n: number; maxDrawdown: number } };
export type ResearchAgent = {
  id: string;
  params: AgentParams;
  lastChangeDay: string | null;
  candidates: { params: AgentParams; from: string; day: string }[];
  lastResult: { day: string; candidates: number; windows: number; decision: string; promotedOk: boolean; current: Combined; best: Combined | null; bestParams: AgentParams | null; promoted: AgentParams | null; perWindow: WindowResult[]; adoptedCandidates: number; modelIdeas?: number; promotedFrom?: string | null } | null;
  nights: { day: string; decision: string; promoted: boolean; current: Combined; best: Combined | null }[];
};
export type ResearchStatus = {
  rules: Record<string, number>;
  lastRun: { day: string; at: number; ok: boolean; ms?: number; requests?: number; newBars?: number; symbols?: number; days?: number; windows?: number; note?: string; error?: string; model?: { proposals: number; dropped: string[]; error: string | null } | null } | null;
  running: boolean;
  agents: ResearchAgent[];
  history: { at: string; day?: string; agent: string; kind: 'promote' | 'rollback'; from: AgentParams; to: AgentParams; reason?: string; rolledBack?: boolean }[];
  adoptions: { at: string; type: 'validation' | 'adoption'; agent: string; finding: string; pass: boolean | null; reasons: string[] }[];
};

export type LlmStatus = { enabled: boolean; url: string; model: string; keySet: boolean; note: string; last: { at: number; ok: boolean; test?: boolean; proposals?: { agent: string; params: Partial<AgentParams>; reason: string }[]; dropped?: string[]; error?: string; answer?: string } | null };

export type ConnectorStatus = { url: string; set: boolean; created: string | null; lastUsed: string | null; token?: string; shownOnce?: boolean };

export type AlpacaStatus = { set: boolean; lastTest: { at: number; ok: boolean; message: string } | null; use: string };

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body as T;
}

const sym = (s: string) => encodeURIComponent(s);
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export const api = {
  overview: () => call<Overview>('/api/numbers'),
  detail: (symbol: string, range: string) => call<Detail>(`/api/numbers/${sym(symbol)}?range=${encodeURIComponent(range)}`),
  history: (symbol: string, page: number, size = 25) => call<HistoryPage>(`/api/numbers/${sym(symbol)}/history?page=${page}&size=${size}`),
  previewTickers: (text: string) =>
    call<TickerPreview>('/api/numbers/watchlist/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) }),
  finviz: () => call<FinvizStatus>('/api/finviz'),
  agents: () => call<AgentsStatus>('/api/agents'),
  saveAgents: (u: Partial<AgentSettings> & { preset?: Partial<Preset>; params?: Record<string, Partial<AgentParams>> }) => call<AgentsStatus>('/api/agents/settings', json('PUT', u)),
  kill: (reason?: string) => call<AgentsStatus>('/api/agents/kill', json('POST', { reason })),
  resume: () => call<AgentsStatus>('/api/agents/resume', json('POST', {})),
  decisions: (day: string, agent = '') => call<{ day: string; decisions: Decision[] }>(`/api/agents/decisions?${new URLSearchParams({ day, ...(agent ? { agent } : {}), limit: '500' })}`),
  summary: (day: string) => call<DaySummary>(`/api/agents/summary?day=${day}`),
  stats: (agent = '', days = 30) => call<AgentStats>(`/api/agents/stats?${new URLSearchParams({ days: String(days), ...(agent ? { agent } : {}) })}`),
  exportUrl: (what: 'trades' | 'decisions' | 'days', format: 'csv' | 'json', from: string, to: string) => `/api/agents/export?${new URLSearchParams({ what, format, from, to })}`,
  connector: () => call<ConnectorStatus>('/api/connector'),
  newConnectorToken: () => call<ConnectorStatus>('/api/connector/token', json('POST', {})),
  revokeConnector: () => call<ConnectorStatus>('/api/connector/revoke', json('POST', {})),
  pauseBuying: () => call<AgentsStatus>('/api/agents/pause', json('POST', {})),
  unpauseBuying: () => call<AgentsStatus>('/api/agents/unpause', json('POST', {})),
  llm: () => call<LlmStatus>('/api/llm'),
  saveLlm: (u: { enabled?: boolean; url?: string; model?: string; key?: string; clearKey?: boolean }) => call<LlmStatus>('/api/llm', json('PUT', u)),
  testLlm: () => call<LlmStatus>('/api/llm/test', json('POST', {})),
  research: () => call<ResearchStatus>('/api/research'),
  runResearch: () => call<unknown>('/api/research/run', json('POST', {})),
  rollback: (agent: string) => call<ResearchStatus>('/api/research/rollback', json('POST', { agent })),
  alpaca: () => call<AlpacaStatus>('/api/alpaca'),
  saveAlpaca: (u: { keyId?: string; secret?: string; clear?: boolean }) => call<AlpacaStatus>('/api/alpaca', json('PUT', u)),
  testAlpaca: () => call<AlpacaStatus>('/api/alpaca/test', json('POST', {})),
  saveFinviz: (u: FinvizUpdate) => call<FinvizStatus>('/api/finviz', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(u) }),
  testFinviz: () => call<FinvizStatus>('/api/finviz/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
};
