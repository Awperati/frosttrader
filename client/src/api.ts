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
  problem?: string;
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
export type OrderMode = 'sim' | 'alpaca-paper';
export type AgentSettings = { live?: Record<string, boolean>; runHere: boolean; orders: OrderMode; agentsAtOnce: number; paperPerAgent: number; preset: Preset; params: Record<string, AgentParams>; strategies: Record<string, Strategy> };
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
  live?: boolean;
  paperDays?: number;
  paperDaysNeeded?: number;
  lastProposals: { symbol: string; signal: string; score: number }[];
  lastDecision: { at: number; symbol: string; ok: boolean; reason: string } | null;
  recentFills: Fill[];
  broken: string | null;
};
export type AuditEvent = { at: string; type: string; agent?: string; symbol?: string; side?: string; reason?: string; why?: string; kind?: string; qty?: number; price?: number; pnl?: number };
export type AgentsStatus = {
  paperOnly: true;
  live: { enabled: boolean; note?: string; stopped?: { reason: string } | null };
  settings: AgentSettings;
  orders?: OrderMode;
  account?: { foreign: string[]; checkedAt: number | null } | null;
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

export type LiveLimits = { perAgentAud: number; totalAud: number; perOrderAud: number; buysPerDay: number; perAgentDayAud: number; allDayAud: number; agentDailyLossAud: number; allDailyLossAud: number; agentDrawdownAud: number; totalDrawdownAud: number };
export type LiveStatus = {
  enabled: boolean;
  enabledAt: string | null;
  account: string | null;
  limits: LiveLimits | null;
  stopped: { reason: string; at: number } | null;
  lastError: string;
  broker: { number: string; cash: number } | null;
  agents: { id: string; positions: { symbol: string }[]; boughtTodayAud: number }[];
  keys: { set: boolean; lastTest: { at: number; ok: boolean; message: string } | null };
  signInReady: boolean;
  proposed: LiveLimits;
  hard: LiveLimits;
  labels: Record<keyof LiveLimits, string>;
  phrase: string;
  funding: string;
};

export type NotifyStatus = { on: boolean; enabled: boolean; server: string; topicSet: boolean; priorities: Record<string, number>; labels: Record<string, string>; lastError: string; counts: { sent: number; failed: number; dropped: number } };

export type AlpacaStatus = { set: boolean; lastTest: { at: number; ok: boolean; message: string } | null; use: string };

// The private website's session token (server/web-gate.mjs), sent as a header, never as a cookie.
// On this computer there is none and none is needed.
const TOKEN_KEY = 'ft-session';
const session = {
  get: () => {
    try {
      return window.sessionStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set: (t: string | null) => {
    try {
      if (t) window.sessionStorage.setItem(TOKEN_KEY, t);
      else window.sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      /* private mode: signed in for this page only */
    }
  },
};
export const SIGN_IN_EVENT = 'ft-sign-in-required';

// An error from a non-2xx response: keeps the HTTP status and the parsed JSON body (e.g. { runningOnPi,
// syncError } on the Pi view's 503), so callers can show the right message instead of a bare string.
export type ApiError = Error & { status?: number; info?: { runningOnPi?: boolean; syncError?: string | null; error?: string } };

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const token = session.get();
  const headers = new Headers(init?.headers);
  if (token) headers.set('authorization', `Bearer ${token}`);
  const res = await fetch(url, { ...init, headers });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 && url !== '/api/auth/login') {
    session.set(null);
    window.dispatchEvent(new Event(SIGN_IN_EVENT));
  }
  if (!res.ok) {
    // Carry the status and the parsed body so a caller can tell a benign state (e.g. the Pi view
    // still syncing: 503 with runningOnPi + no syncError) from a real failure, instead of only a string.
    const e = new Error(body.error || `HTTP ${res.status}`) as ApiError;
    e.status = res.status;
    e.info = body;
    throw e;
  }
  return body as T;
}

export type AuthStatus = { website: boolean; remote: boolean; host: string | null; accessCheck: boolean; signedIn: boolean };

const sym = (s: string) => encodeURIComponent(s);
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export type PiStatus = {
  runningOnPi: boolean;
  configured: boolean;
  everSynced: boolean;
  syncedAt: number | null;
  error: string | null;
  reachable: boolean | null;
  source: { sshTarget: string; remoteDir: string } | null;
};

export const api = {
  pi: () => call<PiStatus>('/api/pi'),
  piSync: () => call<PiStatus>('/api/pi/sync', json('POST', {})),
  overview: () => call<Overview>('/api/numbers'),
  downloadDataset: () => call<{ ok: true; saved: { rows: number; symbols: number; from: string; to: string }; overview: Overview }>('/api/numbers/dataset/download', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
  detail: (symbol: string, range: string) => call<Detail>(`/api/numbers/${sym(symbol)}?range=${encodeURIComponent(range)}`),
  history: (symbol: string, page: number, size = 25) => call<HistoryPage>(`/api/numbers/${sym(symbol)}/history?page=${page}&size=${size}`),
  previewTickers: (text: string) =>
    call<TickerPreview>('/api/numbers/watchlist/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) }),
  finviz: () => call<FinvizStatus>('/api/finviz'),
  agents: () => call<AgentsStatus>('/api/agents'),
  authStatus: () => call<AuthStatus>('/api/auth/status'),
  signIn: async (password: string, code: string) => {
    const r = await call<{ token: string }>('/api/auth/login', json('POST', { password, code }));
    session.set(r.token);
  },
  signOut: async () => {
    await call<{ ok: true }>('/api/auth/logout', json('POST', {})).catch(() => {});
    session.set(null);
  },
  live: () => call<LiveStatus>('/api/live'),
  notify: () => call<NotifyStatus>('/api/notify'),
  saveNotify: (u: { server?: string; topic?: string; enabled?: boolean; priorities?: Record<string, number> }) => call<NotifyStatus>('/api/notify', json('PUT', u)),
  testNotify: () => call<NotifyStatus>('/api/notify/test', json('POST', {})),
  saveLiveKeys: (keyId: string, secret: string) => call<LiveStatus>('/api/live/keys', json('PUT', { keyId, secret })),
  testLiveKeys: () => call<LiveStatus>('/api/live/keys/test', json('POST', {})),
  enableLive: (b: { password: string; code: string; phrase: string; limits: LiveLimits; confirmed: string[]; cashAccount: boolean }) => call<LiveStatus>('/api/live/enable', json('POST', b)),
  lowerLive: (limits: LiveLimits) => call<LiveStatus>('/api/live/lower', json('POST', { limits })),
  disableLive: () => call<LiveStatus>('/api/live/disable', json('POST', {})),
  resumeLive: (password: string, code: string) => call<LiveStatus>('/api/live/resume', json('POST', { password, code })),
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
