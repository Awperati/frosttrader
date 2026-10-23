// Tests for the nightly research loop: variants, walk-forward windows, the fixed promotion rules,
// replay without look-ahead, the bar store's request cost, promotion with rollback, and gated
// knowledge adoption. Synthetic bars, fake market data, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { variants, windows, decide, walkForward, Research, RULES } from '../server/engine/research/nightly.mjs';
import { replay, signalCache } from '../server/engine/research/replay.mjs';
import { BarStore } from '../server/engine/research/barstore.mjs';
import { PARAM_BOUNDS, DEFAULT_PARAMS, MEDIUM } from '../server/engine/agents/profile.mjs';
import { AgentHost } from '../server/engine/agents/host.mjs';
import { KnowledgeStore } from '../server/engine/agents/knowledge.mjs';
import { rng, nyClock } from '../server/engine/stats.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ft-research-'));
const MIN = 60_000;

/** Weekdays from a start date, as YYYY-MM-DD. */
function tradingDays(start, n) {
  const out = [];
  const d = new Date(`${start}T12:00:00Z`);
  while (out.length < n) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/** Regular-hours 5-minute bars (13:30–19:55 UTC = 09:30–15:55 New York in October), a random walk with stop-run flushes. */
function synth(days, seed, price = 100) {
  const r = rng(seed);
  const out = [];
  let p = price;
  for (const day of days) {
    const open = Date.parse(`${day}T13:30:00Z`);
    for (let k = 0; k < 78; k++) {
      const o = p;
      p *= 1 + (r() - 0.5) * 0.004;
      let l = Math.min(o, p) * (1 - r() * 0.001);
      const h = Math.max(o, p) * (1 + r() * 0.001);
      let v = 1000 + r() * 200;
      if (k > 35 && r() < 0.03) {
        // a stop run: a poke under the recent lows on heavy volume, closing back up
        const low = Math.min(...out.slice(-30).map((b) => b.l));
        l = low * 0.993;
        p = Math.max(p, low * 1.002);
        v = 6000;
      }
      out.push({ t: open + k * 5 * MIN, o, h: Math.max(h, p), l, c: p, v });
    }
  }
  return out;
}

test('variants: distinct, inside the bounds, seeded, never the current settings', () => {
  const cur = DEFAULT_PARAMS['agent-a'];
  const v = variants(cur, 20, 7);
  assert.equal(v.length, 20);
  assert.equal(new Set(v.map((x) => JSON.stringify(x))).size, 20);
  for (const x of v) {
    for (const [k, [lo, hi]] of Object.entries(PARAM_BOUNDS)) assert.ok(x[k] >= lo && x[k] <= hi, `${k} ${x[k]}`);
    assert.notDeepEqual(x, cur);
  }
  assert.deepEqual(variants(cur, 20, 7), v, 'same seed, same variants');
  assert.ok(v.slice(0, 8).every((x) => Object.keys(cur).filter((k) => x[k] !== cur[k]).length === 1), 'neighbours first: one step in one parameter');
});

test('windows: fit 10 trading days, test the next 5, step 5; none until 15 days are stored', () => {
  const days = tradingDays('2026-09-01', 20);
  const w = windows(days);
  assert.equal(w.length, 2);
  assert.deepEqual([...w[0].test], days.slice(10, 15));
  assert.deepEqual([...w[1].fit], days.slice(5, 15));
  assert.deepEqual([...w[1].test], days.slice(15, 20));
  for (const x of w) for (const d of x.test) assert.ok(!x.fit.has(d), 'test days are never fit days');
  assert.equal(windows(days.slice(0, 14)).length, 0);
});

test('promotion rules, fixed in code', () => {
  const r = (pnl, n, dd = 1, last = pnl / 2) => [{ pnl: pnl - last, n: n / 2, maxDrawdown: dd, maxDrawdownPct: dd * 10 }, { pnl: last, n: n / 2, maxDrawdown: dd, maxDrawdownPct: dd * 10 }];
  const base = { allocation: 10, lastChangeDay: null, today: '2026-10-21' };
  const ok = decide({ ...base, picks: [1, 1], tests: [r(0.1, 40), r(0.5, 40)] });
  assert.equal(ok.promote, 1);
  assert.match(ok.reason, /won every window/);
  assert.match(decide({ ...base, picks: [1, 2], tests: [r(0, 40), r(1, 40), r(1, 40)] }).reason, /no single candidate/);
  assert.match(decide({ ...base, picks: [0, 0], tests: [r(0, 40), r(1, 40)] }).reason, /current settings won/);
  assert.match(decide({ ...base, picks: [1, 1], tests: [r(0, 40), r(1, 20)] }).reason, /20 test trades/);
  assert.match(decide({ ...base, picks: [1, 1], tests: [r(0.1, 40), r(0.15, 40)] }).reason, /needs US\$0\.10/);
  assert.match(decide({ ...base, picks: [1, 1], tests: [r(0, 40, 1), r(1, 40, 2)] }).reason, /bigger drawdown/);
  assert.match(decide({ ...base, picks: [1, 1], tests: [r(-0.55, 40), r(-0.41, 40)] }).reason, /lost money on the test days/, 'a variant that only loses less is kept out');
  assert.match(decide({ ...base, picks: [1, 1], tests: [r(0, 40, 1, 0.4), r(1, 40, 1, 0.1)] }).reason, /most recent window/);
  assert.match(decide({ ...base, lastChangeDay: '2026-10-16', picks: [1, 1], tests: [r(0.1, 40), r(0.5, 40)] }).reason, /at most one change every 7 days/);
  assert.equal(decide({ ...base, lastChangeDay: '2026-10-14', picks: [1, 1], tests: [r(0.1, 40), r(0.5, 40)] }).promote, 1);
  assert.match(decide({ ...base, picks: [], tests: [[]] }).reason, /not enough stored days/);
});

test('replay: deterministic, trades on the synthetic stop runs, and never looks ahead', () => {
  const days = tradingDays('2026-09-01', 12);
  const bars = { AAA: synth(days, 1), BBB: synth(days, 2, 50) };
  const cache = signalCache(bars);
  const params = { ...DEFAULT_PARAMS['agent-c'], entryScore: 0.5 };
  const run = () => replay({ bars, cache, params, preset: MEDIUM, allocation: 10, days: new Set(days.slice(2, 8)) });
  const a = run();
  assert.deepEqual(run(), a);
  assert.ok(a.n > 0, `made ${a.n} trades`);
  // the same days with every later bar removed (and a different future) give the same result
  const cut = Date.parse(`${days[8]}T00:00:00Z`);
  const past = Object.fromEntries(Object.entries(bars).map(([s, l]) => [s, l.filter((b) => b.t < cut)]));
  const other = Object.fromEntries(Object.entries(past).map(([s, l]) => [s, [...l, ...synth(days.slice(8), 99, l.at(-1).c)]]));
  for (const b of [past, other]) assert.deepEqual(replay({ bars: b, cache: signalCache(b), params, preset: MEDIUM, allocation: 10, days: new Set(days.slice(2, 8)) }), a);
});

test('bar store: a first night fetches ~45 days in one request, later nights only what is new; regular hours, finished bars', async () => {
  const dir = tmp();
  const store = new BarStore({ dataDir: dir });
  const days = tradingDays('2026-09-01', 40);
  const all = synth(days, 3);
  const calls = [];
  const data = {
    requests: 0,
    bars: async (symbols, { start }) => {
      data.requests++;
      calls.push(start);
      return Object.fromEntries(symbols.map((s) => [s, [...all.filter((b) => b.t >= start && b.t < now), { t: Date.parse(`${days[0]}T12:00:00Z`), o: 1, h: 1, l: 1, c: 1, v: 1 }]]));
    },
  };
  let now = Date.parse(`${days[35]}T21:00:00Z`);
  let r = await store.update(data, ['AAA'], now);
  assert.equal(data.requests, 1);
  assert.ok(r.newBars > 0);
  const kept = store.read('AAA');
  assert.equal(new Set(kept.map((b) => nyClock(b.t).day)).size, 30, 'the last 30 trading days');
  assert.ok(kept.every((b) => nyClock(b.t).minute >= 570 && nyClock(b.t).minute < 960), 'regular hours only');
  now = Date.parse(`${days[36]}T21:00:00Z`);
  r = await store.update(data, ['AAA'], now);
  assert.equal(data.requests, 2);
  assert.equal(r.newBars, 78, 'one new day');
  assert.ok(calls[1] > now - 2 * 86_400_000);
  assert.throws(() => store.file('../x'), /bad symbol/);
});

function makeHost(dir) {
  const spawn = () => {
    const p = new EventEmitter();
    p.send = () => {};
    p.kill = () => {};
    return p;
  };
  return new AgentHost({ dataDir: dir, getUniverse: () => ['AAA', 'BBB'], getData: () => null, getFx: () => ({ rate: 0.7, date: '2026-10-21' }), now: () => Date.parse('2026-10-21T21:00:00Z'), spawn, log: { warn() {} } });
}

test('a night\'s run on stored bars: windows, a result per agent, the request count; promotion and one-click rollback', async () => {
  const dir = tmp();
  const host = makeHost(dir);
  const days = tradingDays('2026-09-22', 20);
  const store = new BarStore({ dataDir: dir });
  store.write('AAA', synth(days, 11));
  store.write('BBB', synth(days, 12, 40));
  const research = new Research({ dataDir: dir, host, now: () => Date.parse('2026-10-21T21:00:00Z'), log: { warn() {} } });
  const out = await research.run('2026-10-19', ['AAA', 'BBB']);
  assert.equal(out.ok, true);
  assert.equal(out.windows, 2);
  assert.equal(out.requests, 0, 'no keys: no requests');
  assert.equal(Object.keys(out.results).length, 4);
  for (const r of Object.values(out.results)) assert.equal(r.candidates, RULES.variants + 1);
  assert.ok(host.audit.tail(5).some((e) => e.type === 'research'));
  // promotion and rollback, as the rules would do it
  const from = host.settings.params['agent-a'];
  const to = { ...from, entryScore: 0.75 };
  research.promote('agent-a', from, to, { reason: 'test', best: { pnl: 1, n: 40, expectancy: 0.025, maxDrawdownPct: 2 }, current: { pnl: 0 } }, '2026-10-19');
  assert.equal(host.settings.params['agent-a'].entryScore, 0.75);
  assert.equal(research.status().history[0].kind, 'promote');
  assert.ok(host.knowledge.findings().some((f) => f.kind === 'params' && f.agentId === 'agent-a'), 'published for the others to re-test');
  const st = research.rollback('agent-a');
  assert.deepEqual(host.settings.params['agent-a'], from);
  assert.equal(st.history[0].kind, 'rollback');
  assert.equal(st.history[1].rolledBack, true);
  assert.throws(() => research.rollback('agent-a'), /No change to roll back/);
  host.stop();
});

test('knowledge: another agent adopts a finding only after it passes its own re-test, and only as a candidate', () => {
  const dir = tmp();
  const host = makeHost(dir);
  const days = tradingDays('2026-09-22', 20);
  const bars = { AAA: synth(days, 21), BBB: synth(days, 22, 60) };
  const cache = signalCache(bars);
  const wins = windows(days);
  const research = new Research({ dataDir: dir, host, log: { warn() {} } });
  host.knowledge.publish('agent-a', { kind: 'params', claim: 'agent-a settings that won a walk-forward', params: { entryScore: 0.55, stopAtr: 2, targetAtr: 3, maxHold: 24 }, evidence: {} });
  // the real rules: 30 trades on its own test days are rarely met on this little data, so nobody adopts
  research.validateFindings(bars, cache, wins, '2026-10-19');
  const f = host.knowledge.findings()[0];
  assert.equal(host.knowledge.validations(f.id, 'agent-b').length, 1, 'agent-b re-tested it');
  const passedB = host.knowledge.validations(f.id, 'agent-b')[0].pass;
  assert.equal(research.agentState('agent-b').candidates.length, passedB ? 1 : 0);
  assert.equal(host.knowledge.validations(f.id, 'agent-a').length, 0, 'its author does not re-test its own');
  for (const id of ['agent-b', 'agent-c', 'agent-d']) assert.equal(research.agentState(id).candidates.length, host.knowledge.validations(f.id, id)[0].pass ? 1 : 0);
  // a re-test that passes (forced here, the data is too small to decide): the finding becomes a
  // candidate for the next night, not a change
  host.knowledge = new KnowledgeStore({ dir: path.join(dir, 'k2') });
  host.knowledge.recordValidation = (fid, aid, result) => {
    host.knowledge.append({ type: 'validation', findingId: fid, agentId: aid, result, pass: true, reasons: [] });
    return { pass: true, reasons: [] };
  };
  host.knowledge.publish('agent-a', { kind: 'params', claim: 'agent-a settings that won a walk-forward', params: { entryScore: 0.55 }, evidence: {} });
  const before = structuredClone(host.settings.params);
  research.validateFindings(bars, cache, wins, '2026-10-19');
  assert.ok(research.agentState('agent-c').candidates.length >= 1);
  assert.ok(host.knowledge.lines.some((l) => l.type === 'adoption' && l.agentId === 'agent-c'), 'the adoption is recorded');
  assert.equal(research.agentState('agent-c').candidates.at(-1).params.entryScore, 0.55);
  assert.deepEqual(host.settings.params, before, 'adoption changes nobody\'s settings by itself');
  host.stop();
});

test('walk-forward picks on fit days and judges on test days', () => {
  const days = tradingDays('2026-09-22', 15);
  const bars = { AAA: synth(days, 31) };
  const cache = signalCache(bars);
  const wins = windows(days);
  const candidates = [DEFAULT_PARAMS['agent-a'], { ...DEFAULT_PARAMS['agent-a'], entryScore: 0.95 }];
  const wf = walkForward({ bars, cache, candidates, preset: MEDIUM, allocation: 10, wins });
  assert.equal(wf.picks.length, 1);
  assert.equal(wf.tests.length, 2);
  assert.ok(wf.picks[0] === 0 || wf.picks[0] === 1);
  for (const list of wf.tests) {
    assert.equal(list.length, wins.length);
    for (const tr of list[0].trades) assert.ok(wins[0].test.has(nyClock(tr.exitT).day), 'judged on test days only');
  }
});
