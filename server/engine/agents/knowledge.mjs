// The shared knowledge store: how agents swap findings without touching each other's books.
//
//   publish(agentId, finding)            an agent shares a claim with its evidence
//   recordValidation(id, agentId, res)   an agent re-tests someone's finding on ITS OWN sandbox data;
//                                        pass/fail is decided here, by passesValidation(), not by the agent
//   adopt(id, agentId)                   allowed only after that same agent's passing validation; returns a
//                                        copy of the params for a new CANDIDATE version of the adopter
//   verify()                             checks the hash chain (an edited or deleted line breaks it)
//
// The agentId arguments come from the host (the authenticated channel an agent talks on), never from
// the body of an agent's message. Nothing here writes any agent's config: adopt() only returns values.
// Storage: DATA_DIR/knowledge/findings.jsonl, append-only, one JSON object per line, each with `prev`
// = sha256 of the line before it.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AGENT_ID } from './sandbox.mjs';

export const KINDS = ['params', 'signal-note', 'refuted', 'lesson'];
const PARAM_KEY = /^[a-zA-Z][a-zA-Z0-9]{0,31}$/;
const GENESIS = '0'.repeat(64);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** The rule a re-test must meet before an agent may adopt a finding. Fixed in code. */
export const VALIDATION_RULES = Object.freeze({
  minTrades: 30, // round trips in the agent's own out-of-sample data
  minCostBps: 5, // the test must have charged at least this much slippage
  minEdge: 0, // expectancy must beat the agent's own baseline by more than this (dollars per trade)
  maxDrawdownPct: 20,
  splits: Object.freeze(['validate', 'holdout', 'forward']), // never 'train'
});

/**
 * result: { trades, expectancy, baselineExpectancy, costBps, maxDrawdownPct, split }.
 * Returns { pass, reasons }: every failed rule is listed.
 */
export function passesValidation(result, rules = VALIDATION_RULES) {
  const r = result || {};
  const reasons = [];
  const num = (v) => typeof v === 'number' && Number.isFinite(v);
  if (!rules.splits.includes(r.split)) reasons.push(`split must be one of ${rules.splits.join(', ')}`);
  if (!num(r.trades) || r.trades < rules.minTrades) reasons.push(`needs at least ${rules.minTrades} trades`);
  if (!num(r.costBps) || r.costBps < rules.minCostBps) reasons.push(`needs costs of at least ${rules.minCostBps} bps`);
  if (!num(r.expectancy) || r.expectancy <= 0) reasons.push('expectancy after costs must be above zero');
  if (!num(r.baselineExpectancy) || !num(r.expectancy) || r.expectancy - r.baselineExpectancy <= rules.minEdge) reasons.push('must beat the agent\'s own baseline');
  if (!num(r.maxDrawdownPct) || r.maxDrawdownPct > rules.maxDrawdownPct) reasons.push(`drawdown must be at most ${rules.maxDrawdownPct} %`);
  return { pass: reasons.length === 0, reasons };
}

function checkAgent(agentId) {
  if (typeof agentId !== 'string' || !AGENT_ID.test(agentId)) throw new Error(`Bad agent id: ${JSON.stringify(agentId)}`);
}

/** Only flat, finite numbers under simple names: a finding can't carry code, nested objects or limits. */
function cleanParams(p) {
  if (p === undefined) return {};
  if (typeof p !== 'object' || p === null || Array.isArray(p)) throw new Error('params must be an object');
  const out = {};
  for (const [k, v] of Object.entries(p)) {
    if (!PARAM_KEY.test(k)) throw new Error(`Bad param name: ${k}`);
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`Param ${k} must be a finite number`);
    out[k] = v;
  }
  if (Object.keys(out).length > 32) throw new Error('Too many params');
  return out;
}

export class KnowledgeStore {
  constructor({ dir, rules = VALIDATION_RULES }) {
    this.dir = dir;
    this.file = path.join(dir, 'findings.jsonl');
    this.rules = rules;
    this.lines = [];
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(this.file)) this.lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  lastHash() {
    if (!this.lines.length) return GENESIS;
    return sha(JSON.stringify(this.lines[this.lines.length - 1]));
  }

  append(rec) {
    const line = { seq: this.lines.length + 1, at: new Date().toISOString(), ...rec, prev: this.lastHash() };
    fs.appendFileSync(this.file, JSON.stringify(line) + '\n');
    this.lines.push(line);
    return line;
  }

  findings() {
    return this.lines.filter((l) => l.type === 'finding');
  }

  finding(id) {
    return this.lines.find((l) => l.type === 'finding' && l.id === id) || null;
  }

  publish(agentId, f) {
    checkAgent(agentId);
    if (!f || typeof f !== 'object') throw new Error('Finding must be an object');
    if (!KINDS.includes(f.kind)) throw new Error(`kind must be one of ${KINDS.join(', ')}`);
    if (typeof f.claim !== 'string' || f.claim.length < 10 || f.claim.length > 400) throw new Error('claim must be 10 to 400 characters');
    const params = cleanParams(f.params);
    const evidence = f.evidence && typeof f.evidence === 'object' ? structuredClone(f.evidence) : {};
    const provenance = f.provenance && typeof f.provenance === 'object' ? structuredClone(f.provenance) : {};
    const id = 'f-' + sha(JSON.stringify([agentId, f.kind, f.claim, params, evidence, this.lines.length])).slice(0, 16);
    this.append({ type: 'finding', id, agentId, kind: f.kind, claim: f.claim, params, evidence, provenance });
    return id;
  }

  recordValidation(findingId, agentId, result) {
    checkAgent(agentId);
    if (!this.finding(findingId)) throw new Error(`No finding ${findingId}`);
    const verdict = passesValidation(result, this.rules);
    this.append({ type: 'validation', findingId, agentId, result: structuredClone(result ?? null), pass: verdict.pass, reasons: verdict.reasons });
    return verdict;
  }

  validations(findingId, agentId) {
    return this.lines.filter((l) => l.type === 'validation' && l.findingId === findingId && (!agentId || l.agentId === agentId));
  }

  /** Params for a new candidate version of agentId. Throws unless agentId itself validated it and passed. */
  adopt(findingId, agentId) {
    checkAgent(agentId);
    const f = this.finding(findingId);
    if (!f) throw new Error(`No finding ${findingId}`);
    if (f.kind !== 'params') throw new Error('Only params findings can be adopted');
    if (!this.validations(findingId, agentId).some((v) => v.pass)) throw new Error(`${agentId} has not validated ${findingId} on its own data`);
    this.append({ type: 'adoption', findingId, agentId, as: 'candidate' });
    return { params: structuredClone(f.params), from: findingId, tier: 'paper' };
  }

  /** Re-read the file and check every line's prev hash. Returns { ok, badSeq? }. */
  verify() {
    const lines = fs.existsSync(this.file) ? fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean) : [];
    let prev = GENESIS;
    for (let n = 0; n < lines.length; n++) {
      let rec;
      try {
        rec = JSON.parse(lines[n]);
      } catch {
        return { ok: false, badSeq: n + 1 };
      }
      if (rec.prev !== prev || rec.seq !== n + 1) return { ok: false, badSeq: n + 1 };
      prev = sha(JSON.stringify(rec));
    }
    return { ok: true };
  }
}
