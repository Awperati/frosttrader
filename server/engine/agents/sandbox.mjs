// Agent sandboxes: one book of money per trading agent, on the internal paper broker.
//
//   SandboxManager  owned by the host. Holds the capital pool, gives each agent a fixed allocation,
//                   and keeps every agent's files in its own folder DATA_DIR/agents/<agentId>/.
//   Sandbox         one agent's book: its own SimBroker (cash = its allocation), its own RiskGuard,
//                   and its own ledger.json. It can't see any other agent's book.
//   handle(id)      what an agent is given: a frozen object whose methods act on that agent's
//                   sandbox only. It has no reference to the manager, the pool or other agents, and
//                   it ignores any agent id written inside an order.
//
// Paper only. No broker other than the simulator is constructed here.
import fs from 'node:fs';
import path from 'node:path';
import { SimBroker } from '../broker/sim.mjs';
import { RiskGuard, DEFAULT_LIMITS } from '../risk.mjs';

export const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const FILLS_KEPT = 500;

/** The folder for one agent, or a throw if the id could reach outside DATA_DIR/agents/. */
export function agentDir(rootDir, agentId) {
  if (typeof agentId !== 'string' || !AGENT_ID.test(agentId)) throw new Error(`Bad agent id: ${JSON.stringify(agentId)}`);
  const base = path.resolve(rootDir, 'agents');
  const dir = path.resolve(base, agentId);
  if (path.dirname(dir) !== base) throw new Error(`Agent folder outside the sandbox root: ${agentId}`);
  return dir;
}

function writeAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, file);
}

export class Sandbox {
  constructor({ id, dir, allocation, limits = DEFAULT_LIMITS, slippageBps = 5, commission = 0 }) {
    if (!(allocation > 0)) throw new Error('Allocation must be above zero');
    this.id = id;
    this.dir = dir;
    this.allocation = allocation;
    this.broker = new SimBroker({ cash: allocation, slippageBps, commission });
    this.guard = new RiskGuard(limits);
  }

  get ledgerFile() {
    return path.join(this.dir, 'ledger.json');
  }

  account() {
    const a = this.broker.account();
    return { cash: a.cash, equity: a.equity, positions: structuredClone(a.positions), allocation: this.allocation };
  }

  /** Money tied up in positions at cost. A buy may not take this past the allocation, even after gains. */
  exposure() {
    return Object.values(this.broker.positions).reduce((s, p) => s + p.qty * p.avg, 0);
  }

  startDay(key) {
    this.guard.startDay(key, this.broker.equity());
  }

  /**
   * Try an order on this sandbox's own book. Only symbol, side, qty, price and t are read from the
   * order; anything else in it (an agent id, an account, a limit) is ignored.
   * Returns { ok: true, fill } or { ok: false, reason }.
   */
  submit(order) {
    const o = { symbol: order?.symbol, side: order?.side, qty: order?.qty, price: order?.price, t: order?.t ?? Date.now() };
    const acct = this.broker.account();
    const verdict = this.guard.check(o, acct);
    if (!verdict.ok) return { ok: false, reason: verdict.reason };
    if (o.side === 'buy') {
      const value = o.qty * o.price * (1 + this.broker.slippage) + this.broker.commission;
      if (this.exposure() + value > this.allocation + 1e-9) return { ok: false, reason: `Over this agent's allocation ($${this.allocation})` };
    }
    let fill;
    try {
      fill = this.broker.submit({ ...o, why: String(order?.why || '').slice(0, 200) });
    } catch (e) {
      return { ok: false, reason: e.message };
    }
    if (o.side === 'buy') this.guard.recordBuy();
    this.save();
    return { ok: true, fill };
  }

  mark(symbol, price) {
    if (price > 0) this.broker.mark(symbol, price);
  }

  save() {
    const b = this.broker;
    if (b.fills.length > FILLS_KEPT) b.fills.splice(0, b.fills.length - FILLS_KEPT);
    writeAtomic(this.ledgerFile, { id: this.id, allocation: this.allocation, cash: b.cash, positions: b.positions, prices: b.prices, realized: b.realized, fills: b.fills });
  }

  /** Read this sandbox's ledger back. Throws on a missing or damaged file; other sandboxes are unaffected. */
  load() {
    const d = JSON.parse(fs.readFileSync(this.ledgerFile, 'utf8'));
    if (d.id !== this.id || !(Number.isFinite(d.cash) && d.cash >= 0) || typeof d.positions !== 'object' || d.positions === null) throw new Error(`Damaged ledger for ${this.id}`);
    Object.assign(this.broker, { cash: d.cash, positions: d.positions, prices: d.prices || {}, realized: d.realized || 0, fills: d.fills || [] });
    return this;
  }
}

export class SandboxManager {
  /** rootDir: DATA_DIR. pool: total paper capital the agents share out. */
  constructor({ rootDir, pool, limits = DEFAULT_LIMITS, slippageBps = 5 }) {
    if (!(pool > 0)) throw new Error('Capital pool must be above zero');
    this.rootDir = rootDir;
    this.pool = pool;
    this.limits = limits;
    this.slippageBps = slippageBps;
    this.sandboxes = new Map();
    this.broken = new Map(); // agentId -> reason (a damaged ledger stops that agent only)
    this.brokenAllocations = new Map(); // agentId -> allocation still reserved for a broken agent
    fs.mkdirSync(path.join(rootDir, 'agents'), { recursive: true });
  }

  get allocationsFile() {
    return path.join(this.rootDir, 'allocations.json');
  }

  allocated() {
    let s = 0;
    for (const sb of this.sandboxes.values()) s += sb.allocation;
    for (const a of this.brokenAllocations.values()) s += a;
    return s;
  }

  unallocated() {
    return this.pool - this.allocated();
  }

  create(agentId, allocation, opts = {}) {
    const dir = agentDir(this.rootDir, agentId);
    if (this.sandboxes.has(agentId) || fs.existsSync(dir)) throw new Error(`Agent ${agentId} already exists`);
    if (!(allocation > 0)) throw new Error('Allocation must be above zero');
    if (allocation > this.unallocated() + 1e-9) throw new Error(`Over the capital pool ($${allocation} asked, $${this.unallocated()} free)`);
    fs.mkdirSync(dir, { recursive: true });
    const sb = new Sandbox({ id: agentId, dir, allocation, limits: this.limits, slippageBps: this.slippageBps, ...opts });
    sb.save();
    this.sandboxes.set(agentId, sb);
    this.saveAllocations();
    return this.handle(agentId);
  }

  saveAllocations() {
    const out = {};
    for (const [id, sb] of this.sandboxes) out[id] = sb.allocation;
    for (const [id, a] of this.brokenAllocations) out[id] = a;
    writeAtomic(this.allocationsFile, { pool: this.pool, agents: out });
  }

  /** Reload every agent from disk. A damaged ledger marks that agent broken; the others still load. */
  load() {
    const saved = JSON.parse(fs.readFileSync(this.allocationsFile, 'utf8'));
    this.sandboxes.clear();
    this.broken.clear();
    this.brokenAllocations.clear();
    for (const [id, allocation] of Object.entries(saved.agents || {})) {
      try {
        const sb = new Sandbox({ id, dir: agentDir(this.rootDir, id), allocation, limits: this.limits, slippageBps: this.slippageBps });
        this.sandboxes.set(id, sb.load());
      } catch (e) {
        this.broken.set(id, e.message);
        this.brokenAllocations.set(id, allocation); // still counted: its money is not handed to others
      }
    }
    return this;
  }

  /** The capability an agent gets: bound to its own sandbox, nothing else reachable from it. */
  handle(agentId) {
    const sb = this.sandboxes.get(agentId);
    if (!sb) throw new Error(this.broken.has(agentId) ? `Agent ${agentId} is stopped: ${this.broken.get(agentId)}` : `No agent ${agentId}`);
    return Object.freeze({
      id: agentId,
      account: () => sb.account(),
      submit: (order) => sb.submit(order),
      startDay: (key) => sb.startDay(key),
      mark: (symbol, price) => sb.mark(symbol, price),
    });
  }

  /** Host-side reconciliation: every agent's cash and positions, and the pool total. */
  summary() {
    const agents = {};
    for (const [id, sb] of this.sandboxes) agents[id] = sb.account();
    return { pool: this.pool, allocated: this.allocated(), agents, broken: Object.fromEntries(this.broken) };
  }
}
