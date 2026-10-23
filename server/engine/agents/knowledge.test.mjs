import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KnowledgeStore, passesValidation } from './knowledge.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ft-knowledge-'));
const GOOD = { split: 'validate', trades: 80, expectancy: 1.2, baselineExpectancy: 0.3, costBps: 5, maxDrawdownPct: 9 };
const FINDING = {
  kind: 'params',
  claim: 'stop_run entries with entryScore 0.7 when spx_above_200d',
  params: { entryScore: 0.7, stopAtr: 2.5 },
  evidence: { dataset: 'alpaca-iex/5Min', split: 'validate', trades: 142, expectancy: 1.8 },
};

test('a finding is adopted only after the adopter passes validation on its own data', () => {
  const k = new KnowledgeStore({ dir: tmp() });
  const id = k.publish('agent-a', FINDING);
  // The finder's own evidence doesn't count for agent-b.
  assert.throws(() => k.adopt(id, 'agent-b'), /has not validated/);
  // A failing re-test doesn't unlock it.
  const bad = k.recordValidation(id, 'agent-b', { ...GOOD, trades: 12 });
  assert.equal(bad.pass, false);
  assert.throws(() => k.adopt(id, 'agent-b'), /has not validated/);
  // Another agent's passing validation doesn't unlock it for agent-b either.
  assert.equal(k.recordValidation(id, 'agent-c', GOOD).pass, true);
  assert.throws(() => k.adopt(id, 'agent-b'), /has not validated/);
  // agent-b's own pass does.
  assert.equal(k.recordValidation(id, 'agent-b', GOOD).pass, true);
  const got = k.adopt(id, 'agent-b');
  assert.deepEqual(got, { params: { entryScore: 0.7, stopAtr: 2.5 }, from: id, tier: 'paper' });
  // The returned params are a copy, not the stored finding.
  got.params.entryScore = 99;
  assert.equal(k.finding(id).params.entryScore, 0.7);
});

test('validation rules: each one can fail on its own', () => {
  assert.equal(passesValidation(GOOD).pass, true);
  const cases = [
    { split: 'train' },
    { trades: 29 },
    { costBps: 0 },
    { expectancy: -0.1, baselineExpectancy: -0.5 },
    { expectancy: 0.3 }, // equal to baseline
    { maxDrawdownPct: 21 },
    { trades: NaN },
    { expectancy: '5' },
  ];
  for (const c of cases) assert.equal(passesValidation({ ...GOOD, ...c }).pass, false, JSON.stringify(c));
  assert.equal(passesValidation(null).pass, false);
});

test('findings carry plain numbers only: no code, nested objects or bad names', () => {
  const k = new KnowledgeStore({ dir: tmp() });
  assert.throws(() => k.publish('agent-a', { ...FINDING, params: { entryScore: '0.7' } }), /finite number/);
  assert.throws(() => k.publish('agent-a', { ...FINDING, params: { limits: { maxDailyLoss: 1e9 } } }), /finite number/);
  assert.throws(() => k.publish('agent-a', { ...FINDING, params: { __proto__x: 1 } }), /Bad param name/);
  assert.throws(() => k.publish('agent-a', { ...FINDING, params: { x: Infinity } }), /finite number/);
  assert.throws(() => k.publish('agent-a', { ...FINDING, kind: 'order' }), /kind/);
  assert.throws(() => k.publish('agent-a', { ...FINDING, claim: 'short' }), /claim/);
  assert.throws(() => k.publish('../agent-b', FINDING), /Bad agent id/);
  const id = k.publish('agent-a', { ...FINDING, kind: 'lesson', params: undefined });
  k.recordValidation(id, 'agent-b', GOOD);
  assert.throws(() => k.adopt(id, 'agent-b'), /Only params/);
});

test('the store is a hash chain that survives a reload and catches edits', () => {
  const dir = tmp();
  const k = new KnowledgeStore({ dir });
  const id = k.publish('agent-a', FINDING);
  k.recordValidation(id, 'agent-b', GOOD);
  k.adopt(id, 'agent-b');
  assert.deepEqual(k.verify(), { ok: true });
  const k2 = new KnowledgeStore({ dir });
  assert.equal(k2.lines.length, 3);
  assert.equal(k2.adopt(id, 'agent-b').from, id); // validation persisted
  assert.deepEqual(k2.verify(), { ok: true });
  // Flip agent-b's failing-to-passing history by editing a line: the chain breaks.
  const file = path.join(dir, 'findings.jsonl');
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines[0] = lines[0].replace('"entryScore":0.7', '"entryScore":0.9');
  fs.writeFileSync(file, lines.join('\n'));
  assert.equal(k2.verify().ok, false);
});
