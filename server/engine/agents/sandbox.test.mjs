import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SandboxManager, Sandbox, agentDir } from './sandbox.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ft-sandbox-'));
const DAY = '2026-10-23';
const LIMITS = { maxPositionValue: 25_000, maxPositionPct: 0.25, maxDailyLoss: 2_000, maxTradesPerDay: 30, maxOpenPositions: 8, riskPerTrade: 0.01 };

function twoAgents() {
  const root = tmp();
  const m = new SandboxManager({ rootDir: root, pool: 3000, limits: LIMITS, slippageBps: 0 });
  const a = m.create('agent-a', 1000);
  const b = m.create('agent-b', 1000);
  a.startDay(DAY);
  b.startDay(DAY);
  return { root, m, a, b };
}

test('each agent gets its own folder and its own cash', () => {
  const { root, a, b } = twoAgents();
  assert.ok(fs.existsSync(path.join(root, 'agents', 'agent-a', 'ledger.json')));
  assert.ok(fs.existsSync(path.join(root, 'agents', 'agent-b', 'ledger.json')));
  assert.equal(a.account().cash, 1000);
  assert.equal(b.account().cash, 1000);
});

test("one agent can't spend another's capital", () => {
  const { m, a, b } = twoAgents();
  // A asks for more than its own 1000 although B has 1000 and the pool has 1000 free.
  const r = a.submit({ symbol: 'ABC', side: 'buy', qty: 120, price: 10 });
  assert.equal(r.ok, false);
  // Naming the other agent or account inside the order changes nothing.
  const r2 = a.submit({ symbol: 'ABC', side: 'buy', qty: 120, price: 10, agentId: 'agent-b', account: 'agent-b' });
  assert.equal(r2.ok, false);
  // A legal buy only moves A's cash.
  const ok = a.submit({ symbol: 'ABC', side: 'buy', qty: 20, price: 10, agentId: 'agent-b' });
  assert.equal(ok.ok, true);
  assert.equal(a.account().cash, 800);
  assert.equal(b.account().cash, 1000);
  assert.deepEqual(b.account().positions, {});
  // B can't sell what A holds (no shorting, separate books).
  assert.equal(b.submit({ symbol: 'ABC', side: 'sell', qty: 20, price: 10 }).ok, false);
  assert.equal(a.account().positions.ABC.qty, 20);
  assert.equal(m.summary().agents['agent-b'].cash, 1000);
});

test('the handle reaches nothing but its own sandbox', () => {
  const { a } = twoAgents();
  assert.ok(Object.isFrozen(a));
  assert.deepEqual(Object.keys(a).sort(), ['account', 'id', 'mark', 'startDay', 'submit']);
  for (const v of Object.values(a)) if (typeof v === 'object' && v !== null) assert.fail('handle exposes an object');
  // account() returns a copy: changing it doesn't change the book.
  const acct = a.account();
  acct.cash = 1e9;
  acct.positions.FAKE = { qty: 1000, avg: 1 };
  assert.equal(a.account().cash, 1000);
  assert.equal(a.account().positions.FAKE, undefined);
});

test('allocations never exceed the pool', () => {
  const { m } = twoAgents();
  assert.throws(() => m.create('agent-c', 1001), /capital pool/);
  m.create('agent-c', 1000);
  assert.throws(() => m.create('agent-d', 1), /capital pool/);
  assert.throws(() => m.create('agent-a', 1), /already exists/);
});

test('agent ids that could leave the sandbox root are refused', () => {
  const root = tmp();
  for (const id of ['../agent-b', '..', 'a/b', 'a\\b', 'C:\\x', '/etc', 'Agent', '', 'a'.repeat(33), null, 7]) {
    assert.throws(() => agentDir(root, id), /Bad agent id|outside/, String(id));
  }
  assert.equal(agentDir(root, 'momo-01'), path.resolve(root, 'agents', 'momo-01'));
});

test('a buy may not push exposure past the allocation, even after gains', () => {
  const root = tmp();
  const sb = new Sandbox({ id: 'x', dir: root, allocation: 1000, limits: LIMITS, slippageBps: 0 });
  sb.guard.limits = { ...sb.guard.limits, maxPositionPct: 1 }; // test only: isolate the allocation check
  sb.startDay(DAY);
  assert.equal(sb.submit({ symbol: 'ABC', side: 'buy', qty: 50, price: 10 }).ok, true);
  sb.mark('ABC', 20);
  assert.equal(sb.submit({ symbol: 'ABC', side: 'sell', qty: 50, price: 20 }).ok, true);
  assert.equal(sb.account().cash, 1500); // 500 profit
  const r = sb.submit({ symbol: 'ABC', side: 'buy', qty: 60, price: 20 }); // 1200 > allocation 1000
  assert.equal(r.ok, false);
  assert.match(r.reason, /allocation/);
  assert.equal(sb.submit({ symbol: 'ABC', side: 'buy', qty: 50, price: 20 }).ok, true);
});

test('the gate still runs inside a sandbox: no crypto, no options, kill switch', () => {
  const { m, a, b } = twoAgents();
  assert.equal(a.submit({ symbol: 'BTC/USD', side: 'buy', qty: 1, price: 10 }).ok, false);
  assert.equal(a.submit({ symbol: 'AAPL261218C00150000', side: 'buy', qty: 1, price: 10 }).ok, false);
  assert.equal(a.submit({ symbol: '^GSPC', side: 'buy', qty: 1, price: 10 }).ok, false);
  // The kill switch is the host's: the handle has no way to set or clear it.
  m.sandboxes.get('agent-a').guard.killed = true;
  assert.match(a.submit({ symbol: 'ABC', side: 'buy', qty: 1, price: 10 }).reason, /Kill switch/);
  assert.equal(b.submit({ symbol: 'ABC', side: 'buy', qty: 1, price: 10 }).ok, true);
});

test('a damaged ledger stops only that agent, and its money stays reserved', () => {
  const { root, m, a } = twoAgents();
  a.submit({ symbol: 'ABC', side: 'buy', qty: 10, price: 10 });
  fs.writeFileSync(path.join(root, 'agents', 'agent-b', 'ledger.json'), '{ not json');
  const m2 = new SandboxManager({ rootDir: root, pool: 3000, limits: LIMITS, slippageBps: 0 }).load();
  assert.equal(m2.handle('agent-a').account().cash, 900);
  assert.equal(m2.handle('agent-a').account().positions.ABC.qty, 10);
  assert.throws(() => m2.handle('agent-b'), /stopped/);
  assert.equal(m2.allocated(), 2000); // B's 1000 is not freed for anyone else
  assert.throws(() => m2.create('agent-c', 1001), /capital pool/);
  assert.equal(m.summary().allocated, 2000);
});

test("a ledger can't be swapped for another agent's", () => {
  const { root, a } = twoAgents();
  a.submit({ symbol: 'ABC', side: 'buy', qty: 10, price: 10 });
  fs.copyFileSync(path.join(root, 'agents', 'agent-a', 'ledger.json'), path.join(root, 'agents', 'agent-b', 'ledger.json'));
  const m2 = new SandboxManager({ rootDir: root, pool: 3000, limits: LIMITS }).load();
  assert.throws(() => m2.handle('agent-b'), /Damaged ledger/);
});
