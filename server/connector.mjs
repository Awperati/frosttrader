// The Frost AI connector: an MCP server inside FrostTrader at http://127.0.0.1:8787/mcp, so the owner
// can ask Frost AI "how did the agents do today?". PAPER ONLY.
//
// Tools: read-only (status, today's summary, stats, the decision log, the nightly research), plus
// stop (no new buys; exits keep running), start (undo stop) and kill (the kill switch: sell
// everything, stop every agent). Resuming after a kill is NOT a connector tool: only FrostTrader's own
// screen on this computer can do that. Nothing here touches limits, money, settings or live.
//
// Access: a token FrostTrader makes on request (Settings → Frost AI connector), shown once, kept only
// as a SHA-256 hash in DATA_DIR/connector.json. Every request needs "Authorization: Bearer <token>",
// must come to this computer's address, and is refused from a web page of another site (Origin). At
// most 60 requests a minute. Every tool call goes to the audit log.
//
// Protocol: MCP over Streamable HTTP (JSON-RPC 2.0 in a POST, answered with plain JSON): initialize,
// notifications/initialized, ping, tools/list, tools/call.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HttpError } from './store.mjs';
import { AGENT_IDS } from './engine/agents/profile.mjs';
import { nyClock } from './engine/stats.mjs';

export const PROTOCOL = '2025-06-18';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export class ConnectorToken {
  constructor({ dataDir, now = Date.now }) {
    this.file = path.join(dataDir, 'connector.json');
    this.now = now;
    this.rec = readJson(this.file);
  }

  /** Make a new token (the old one stops working). Returns it once; only its hash is kept. */
  create() {
    const token = `ftc_${crypto.randomBytes(32).toString('base64url')}`;
    this.rec = { hash: sha(token), created: new Date(this.now()).toISOString(), lastUsed: null };
    this.save();
    return token;
  }

  revoke() {
    this.rec = null;
    fs.rmSync(this.file, { force: true });
  }

  save() {
    fs.writeFileSync(this.file, JSON.stringify(this.rec), { mode: 0o600 });
  }

  /** Is this the token? Timing-safe; notes when it was last used (at most once a minute). */
  check(token) {
    if (!this.rec?.hash || !token) return false;
    const a = Buffer.from(sha(String(token)), 'hex');
    const b = Buffer.from(this.rec.hash, 'hex');
    const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (ok && (!this.rec.lastUsed || this.now() - Date.parse(this.rec.lastUsed) > 60_000)) {
      this.rec.lastUsed = new Date(this.now()).toISOString();
      this.save();
    }
    return ok;
  }

  status() {
    return { set: !!this.rec, created: this.rec?.created ?? null, lastUsed: this.rec?.lastUsed ?? null };
  }
}

const S = (props, required = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
const agentProp = { type: 'string', enum: AGENT_IDS, description: 'One agent; leave out for all.' };

export const TOOLS = [
  { name: 'frosttrader_status', description: 'Paper agents now: kill switch, paused, market open, each agent running or halted, equity and today\'s P&L (US$), last error.', inputSchema: S({}), annotations: { readOnlyHint: true } },
  { name: 'frosttrader_today', description: 'The summary of a trading day (New York): trades, win rate, P&L in A$ and US$, best and worst, halts, refusals, per agent and for all.', inputSchema: S({ day: { type: 'string', description: 'YYYY-MM-DD; today if left out.' } }), annotations: { readOnlyHint: true } },
  { name: 'frosttrader_stats', description: 'Results by signal, symbol, half hour and exit reason over the last N days. Past results only.', inputSchema: S({ agent: agentProp, days: { type: 'integer', minimum: 1, maximum: 365 } }), annotations: { readOnlyHint: true } },
  { name: 'frosttrader_decisions', description: 'The plain-language decision log of a day: what each agent bought, sold, refused, and why.', inputSchema: S({ day: { type: 'string' }, agent: agentProp, limit: { type: 'integer', minimum: 1, maximum: 100 }, include_passes: { type: 'boolean', description: 'Also the symbols it looked at and passed on.' } }), annotations: { readOnlyHint: true } },
  { name: 'frosttrader_research', description: 'The last nightly research: each agent\'s decision and the rule behind it, recent setting changes.', inputSchema: S({}), annotations: { readOnlyHint: true } },
  { name: 'frosttrader_stop', description: 'Stop new buys for all paper agents. Exits and halts keep running; nothing is sold. Undo with frosttrader_start.', inputSchema: S({}), annotations: { readOnlyHint: false, destructiveHint: false } },
  { name: 'frosttrader_start', description: 'Undo frosttrader_stop. Does not clear the kill switch (only FrostTrader\'s own screen can).', inputSchema: S({}), annotations: { readOnlyHint: false, destructiveHint: false } },
  { name: 'frosttrader_kill', description: 'The kill switch: sell every paper position and stop every agent until the owner resumes on FrostTrader\'s own screen.', inputSchema: S({ reason: { type: 'string', maxLength: 200 } }, ['reason']), annotations: { readOnlyHint: false, destructiveHint: true } },
];

export function createConnector({ host, research = null, token, now = Date.now, limitPerMin = 60 }) {
  const hits = [];
  const today = () => nyClock(now()).day;
  const dayArg = (v) => {
    if (v == null || v === '') return today();
    if (typeof v !== 'string' || !DAY.test(v)) throw rpcError(-32602, 'day must be YYYY-MM-DD');
    return v;
  };
  const agentArg = (v) => {
    if (v == null || v === '') return null;
    if (!AGENT_IDS.includes(v)) throw rpcError(-32602, `agent must be one of ${AGENT_IDS.join(', ')}`);
    return v;
  };
  const r2 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);

  const tools = {
    frosttrader_status() {
      const st = host.status();
      return {
        paperOnly: true,
        live: st.live,
        killed: st.killed ? st.killReason : false,
        integrityHalt: st.integrity?.reason ?? false,
        paused: st.paused ? `since ${new Date(st.paused.at).toISOString()} (by ${st.paused.by})` : false,
        marketOpen: st.marketOpen,
        lastTick: st.lastTick ? new Date(st.lastTick).toISOString() : null,
        lastError: st.lastError || null,
        paperPerAgentAud: st.settings.paperPerAgent,
        agents: st.agents.map((a) => ({ agent: a.id, running: a.running, halt: a.halt?.reason ?? null, sitOutDays: a.sitOut, size: a.scale, equityUsd: r2(a.equity), todayUsd: r2(a.dayPnl), sinceStartUsd: r2(a.totalPnl), positions: a.positions.map((p) => ({ symbol: p.symbol, qty: p.qty, avg: r2(p.avg), last: r2(p.price) })) })),
      };
    },
    frosttrader_today: (a) => host.journal.summary(dayArg(a.day), AGENT_IDS),
    frosttrader_stats: (a) => {
      const days = a.days == null ? 30 : a.days;
      if (!Number.isInteger(days) || days < 1 || days > 365) throw rpcError(-32602, 'days must be 1 to 365');
      return host.journal.stats(AGENT_IDS, { agent: agentArg(a.agent), days });
    },
    frosttrader_decisions: (a) => {
      const limit = a.limit == null ? 50 : a.limit;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw rpcError(-32602, 'limit must be 1 to 100');
      const day = dayArg(a.day);
      const list = host.journal.decisions(day, agentArg(a.agent), AGENT_IDS).filter((d) => a.include_passes === true || d.kind !== 'considered');
      return { day, decisions: list.slice(0, limit).map((d) => ({ at: new Date(d.t).toISOString(), agent: d.agent, text: d.text })) };
    },
    frosttrader_research: () => {
      if (!research) return { note: 'Research is not running on this server.' };
      const st = research.status();
      return { lastRun: st.lastRun, agents: st.agents.map((x) => ({ agent: x.id, settings: x.params, lastNight: x.lastResult ? { day: x.lastResult.day, decision: x.lastResult.decision } : null })), recentChanges: st.history.slice(0, 10) };
    },
    frosttrader_stop: () => (host.pauseBuying('Frost AI connector'), { stopped: 'new buys are stopped; exits keep running' }),
    frosttrader_start: () => {
      const st = host.unpauseBuying('Frost AI connector');
      return st.killed || st.integrity ? { started: false, why: 'The kill switch or an integrity halt is on: only FrostTrader\'s own screen can resume.' } : { started: 'new buys allowed again' };
    },
    frosttrader_kill: (a) => {
      if (typeof a.reason !== 'string' || !a.reason.trim()) throw rpcError(-32602, 'reason is required');
      const st = host.kill(`Frost AI connector: ${a.reason.slice(0, 200)}`);
      return { killed: st.killed, note: 'Everything was sold and every agent stopped. Resume on FrostTrader\'s own screen.' };
    },
  };

  /** One HTTP request to /mcp. Returns { status, body } (body null for 202). Throws HttpError for access problems. */
  async function handle(method, headers = {}, body = null) {
    if (!LOCAL_HOST.test(String(headers.host || ''))) throw new HttpError(403, 'The connector answers only on this computer');
    const origin = headers.origin;
    if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(origin)) throw new HttpError(403, 'Not from a web page of another site');
    const auth = /^Bearer\s+(\S+)$/i.exec(String(headers.authorization || ''))?.[1];
    if (!token.check(auth)) throw new HttpError(401, 'A valid connector token is required (Settings → Frost AI connector)');
    const t = now();
    while (hits.length && t - hits[0] > 60_000) hits.shift();
    if (hits.length >= limitPerMin) throw new HttpError(429, 'Too many requests');
    hits.push(t);
    if (method === 'GET') throw new HttpError(405, 'This MCP server answers POST only (no event stream)');
    if (method !== 'POST') throw new HttpError(405, 'Method not allowed');
    const msgs = Array.isArray(body) ? body : [body];
    const out = [];
    for (const m of msgs) {
      const r = await one(m);
      if (r) out.push(r);
    }
    if (!out.length) return { status: 202, body: null };
    return { status: 200, body: Array.isArray(body) ? out : out[0] };
  }

  async function one(m) {
    if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return { jsonrpc: '2.0', id: m?.id ?? null, error: { code: -32600, message: 'Invalid request' } };
    const notification = m.id === undefined;
    try {
      let result;
      switch (m.method) {
        case 'initialize':
          result = { protocolVersion: PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'frosttrader', title: 'Frost Trader (paper agents)', version: '0.1.0' }, instructions: 'Paper trading only. Read tools report the agents; stop/start/kill control them. Resuming after a kill is only on FrostTrader\'s own screen.' };
          break;
        case 'notifications/initialized':
        case 'notifications/cancelled':
          return null;
        case 'ping':
          result = {};
          break;
        case 'tools/list':
          result = { tools: TOOLS };
          break;
        case 'tools/call': {
          const name = m.params?.name;
          const args = m.params?.arguments ?? {};
          const tool = TOOLS.find((x) => x.name === name);
          if (!tool) throw rpcError(-32602, `Unknown tool ${name}`);
          if (typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some((k) => !(k in tool.inputSchema.properties))) throw rpcError(-32602, 'Unknown arguments');
          host.audit.write({ type: 'connector', tool: name, args: Object.keys(args) });
          const data = await tools[name](args);
          result = { content: [{ type: 'text', text: JSON.stringify(data, null, 1) }], structuredContent: data, isError: false };
          break;
        }
        default:
          throw rpcError(-32601, `Method not found: ${m.method}`);
      }
      return notification ? null : { jsonrpc: '2.0', id: m.id, result };
    } catch (e) {
      if (notification) return null;
      if (e.rpc) return { jsonrpc: '2.0', id: m.id, error: { code: e.code, message: e.message } };
      // a tool that failed: reported as a tool error, not a protocol error
      return { jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true } };
    }
  }

  return { handle, tools: TOOLS };
}

function rpcError(code, message) {
  const e = new Error(message);
  e.rpc = true;
  e.code = code;
  return e;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}
