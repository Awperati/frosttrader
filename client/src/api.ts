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
export type AgentSettings = { agentsAtOnce: number; paperPerAgent: number; preset: Preset; params: Record<string, AgentParams> };
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
  positions: { symbol: string; qty: number; avg: number; price: number; plan: { stop: number; target: number; signal: string } | null }[];
  halt: { day: string; reason: string; at: number } | null;
  sitOut: number;
  scale: number;
  peak: number | null;
  params: AgentParams;
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
  currency: string;
  fx: { rate: number; date: string; source: string; ageDays: number } | null;
  usdPerAgent: number | null;
  killed: boolean;
  killReason: string;
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
  alpaca: () => call<AlpacaStatus>('/api/alpaca'),
  saveAlpaca: (u: { keyId?: string; secret?: string; clear?: boolean }) => call<AlpacaStatus>('/api/alpaca', json('PUT', u)),
  testAlpaca: () => call<AlpacaStatus>('/api/alpaca/test', json('POST', {})),
  saveFinviz: (u: FinvizUpdate) => call<FinvizStatus>('/api/finviz', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(u) }),
  testFinviz: () => call<FinvizStatus>('/api/finviz/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
};
