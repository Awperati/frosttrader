// Research ideas from the owner's local model (Frost AI), PAPER ONLY and OFF by default.
//
// Once a night, if he has switched it on, the model gets a short stats-only summary: each agent's
// settings, its last walk-forward result, and its trades by signal and exit reason. No ticker, no
// date, no price series, no money settings. It answers with JSON: up to 3 proposals, each a set of
// agent parameters inside PARAM_BOUNDS and a one-line reason. Each proposal is only one more
// candidate in that night's walk-forward, judged by the same fixed rules as every other variant.
//
// The model can't change code, limits, the risk preset, halts, money or live: nothing it says is run,
// and every field is checked (checkProposals); anything outside the schema or the bounds is dropped
// and counted. Its reasons are shown labelled "model's words". The request goes only to this
// computer (127.0.0.1 / localhost): Frost AI's Console gateway (default :8765, with a Frost AI API key)
// or llama-server (:8080). The key is kept in DATA_DIR/llm-key.json, write-only, never logged.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AGENT_IDS, PARAM_BOUNDS } from '../agents/profile.mjs';

export const DEFAULT_URL = 'http://127.0.0.1:8765/v1/chat/completions';
export const MAX_PROPOSALS = 3;
const LOCAL_URL = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{1,5}\/[\w/.-]*$/;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** The stats-only summary the model sees. Symbols and dates are left out on purpose. */
export function summarize({ agents, stats }) {
  return {
    task: 'Suggest parameter values for paper-trading agents. Paper money only.',
    bounds: PARAM_BOUNDS,
    agents: agents.map((a) => ({
      agent: a.id,
      params: a.params,
      lastNight: a.lastResult
        ? { decision: a.lastResult.decision, testTradesCurrent: a.lastResult.current?.n ?? 0, testPnlCurrent: round(a.lastResult.current?.pnl), testTradesBest: a.lastResult.best?.n ?? null, testPnlBest: round(a.lastResult.best?.pnl) }
        : null,
      bySignal: (stats[a.id]?.bySignal || []).map((g) => ({ signal: g.key, trades: g.trades, winRate: round(g.winRate), avg: round(g.avgAud) })),
      byExit: (stats[a.id]?.byExit || []).map((g) => ({ exit: g.key, trades: g.trades, winRate: round(g.winRate), avg: round(g.avgAud) })),
    })),
  };
}
const round = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1000) / 1000);

export const SYSTEM = [
  'You suggest parameter values for automated PAPER trading agents. You never write code.',
  `Answer with JSON only, exactly this shape: {"proposals":[{"agent":"agent-a","params":{"entryScore":0.6,"stopAtr":2,"targetAtr":3,"maxHold":24},"reason":"one short sentence"}]}.`,
  `At most ${MAX_PROPOSALS} proposals. "agent" is one of ${AGENT_IDS.join(', ')}. Every params value must be inside the bounds given. maxHold is a whole number of 5-minute bars.`,
  'Each proposal will be tested on held-out days and only kept if it wins under fixed rules, so propose what the statistics suggest might work better.',
].join(' ');

/**
 * Check the model's answer. Returns { proposals: [{ agent, params, reason }], dropped: [why] }.
 * Only known fields, known agents, finite numbers inside PARAM_BOUNDS; at most MAX_PROPOSALS.
 */
export function checkProposals(text) {
  const dropped = [];
  let data;
  try {
    const m = /\{[\s\S]*\}/.exec(String(text || ''));
    data = JSON.parse(m ? m[0] : '');
  } catch {
    return { proposals: [], dropped: ['the answer was not JSON'] };
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.proposals)) return { proposals: [], dropped: ['no "proposals" list'] };
  const proposals = [];
  for (const [i, p] of data.proposals.entries()) {
    const why = (r) => dropped.push(`proposal ${i + 1}: ${r}`);
    if (proposals.length >= MAX_PROPOSALS) {
      why(`more than ${MAX_PROPOSALS}`);
      continue;
    }
    if (!p || typeof p !== 'object' || !Object.keys(p).every((k) => ['agent', 'params', 'reason'].includes(k))) {
      why('unknown fields');
      continue;
    }
    if (!AGENT_IDS.includes(p.agent)) {
      why(`unknown agent ${JSON.stringify(p.agent)}`);
      continue;
    }
    if (!p.params || typeof p.params !== 'object' || Array.isArray(p.params)) {
      why('no params');
      continue;
    }
    const params = {};
    let ok = true;
    for (const [k, v] of Object.entries(p.params)) {
      const b = PARAM_BOUNDS[k];
      if (!b) {
        why(`"${k}" is not an agent parameter`);
        ok = false;
        break;
      }
      if (typeof v !== 'number' || !Number.isFinite(v) || v < b[0] || v > b[1] || (k === 'maxHold' && !Number.isInteger(v))) {
        why(`${k} ${JSON.stringify(v)} is outside ${b[0]}–${b[1]}`);
        ok = false;
        break;
      }
      params[k] = v;
    }
    if (!ok) continue;
    if (!Object.keys(params).length) {
      why('no params');
      continue;
    }
    proposals.push({ agent: p.agent, params, reason: typeof p.reason === 'string' ? p.reason.replace(/[\r\n]+/g, ' ').slice(0, 200) : '' });
  }
  return { proposals, dropped };
}

export class ModelIdeas {
  constructor({ dataDir, fetchImpl = (...a) => globalThis.fetch(...a), now = Date.now, timeoutMs = 120_000 }) {
    Object.assign(this, { fetchImpl, now, timeoutMs });
    this.file = path.join(dataDir, 'llm.json');
    this.keyFile = path.join(dataDir, 'llm-key.json');
    this.settings = { enabled: false, url: DEFAULT_URL, model: '', ...(readJson(this.file) || {}) };
    this.key = String(readJson(this.keyFile)?.key || '');
    this.last = null; // { at, ok, proposals, dropped, error, promptHash }
  }

  status() {
    return { enabled: this.settings.enabled, url: this.settings.url, model: this.settings.model, keySet: !!this.key, last: this.last, note: 'Off by default. Paper only: ideas are tested under the same fixed rules; the model never changes code, limits, money or live.' };
  }

  update({ enabled, url, model, key, clearKey } = {}) {
    if (url !== undefined) {
      const u = String(url).trim();
      if (!LOCAL_URL.test(u)) throw new Error('The model address must be on this computer, e.g. http://127.0.0.1:8765/v1/chat/completions');
      this.settings.url = u;
    }
    if (model !== undefined) {
      const m = String(model).trim();
      if (!/^[\w./:-]{0,100}$/.test(m)) throw new Error('That model name has odd characters.');
      this.settings.model = m;
    }
    if (enabled !== undefined) this.settings.enabled = enabled === true;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.settings, null, 1));
    if (clearKey) {
      this.key = '';
      fs.rmSync(this.keyFile, { force: true });
    } else if (key !== undefined && String(key).trim()) {
      const k = String(key).trim();
      if (!/^[\x21-\x7e]{8,300}$/.test(k)) throw new Error('That does not look like an API key.');
      this.key = k;
      fs.writeFileSync(this.keyFile, JSON.stringify({ key: k }), { mode: 0o600 });
    }
    return this.status();
  }

  redact(s) {
    return this.key && this.key.length >= 4 ? String(s).split(this.key).join('***') : String(s);
  }

  async chat(system, user, maxTokens = 800) {
    const body = { messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature: 0.2, max_tokens: maxTokens, stream: false, ...(this.settings.model ? { model: this.settings.model } : {}) };
    let res;
    try {
      res = await this.fetchImpl(this.settings.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(this.key ? { authorization: `Bearer ${this.key}` } : {}) },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new Error(this.redact(`Could not reach the local model: ${e.message}`));
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(this.redact(`The local model answered HTTP ${res.status}${data?.error?.message ? `: ${data.error.message}` : ''}`));
    return String(data?.choices?.[0]?.message?.content ?? '');
  }

  /** Settings → Test: a tiny request; OK when the model answers at all. */
  async test() {
    try {
      const out = await this.chat('Answer with JSON only.', 'Reply with {"ok":true}', 50);
      this.last = { at: this.now(), ok: true, test: true, answer: out.slice(0, 80) };
    } catch (e) {
      this.last = { at: this.now(), ok: false, test: true, error: e.message };
    }
    return this.status();
  }

  /** The night's ideas, or [] when switched off. Never throws. */
  async propose(summary) {
    if (!this.settings.enabled) return { proposals: [], dropped: [], skipped: 'switched off' };
    const user = JSON.stringify(summary);
    const promptHash = sha(SYSTEM + user);
    try {
      const out = await this.chat(SYSTEM, user);
      const checked = checkProposals(out);
      this.last = { at: this.now(), ok: true, proposals: checked.proposals, dropped: checked.dropped, promptHash, answerHash: sha(out) };
      return { ...checked, promptHash };
    } catch (e) {
      this.last = { at: this.now(), ok: false, error: e.message, promptHash };
      return { proposals: [], dropped: [], error: e.message, promptHash };
    }
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}
