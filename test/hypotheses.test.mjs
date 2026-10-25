// Tests for the local model's research ideas: off by default, a stats-only summary, strict checking of
// its answer, local addresses only, the key write-only, and an idea treated as just one more
// candidate under the same rules. A fake model server; no real model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { ModelIdeas, checkProposals, summarize, MAX_PROPOSALS } from '../server/engine/research/hypotheses.mjs';
import { Research } from '../server/engine/research/nightly.mjs';
import { BarStore } from '../server/engine/research/barstore.mjs';
import { AgentHost } from '../server/engine/agents/host.mjs';
import { createAgentsApi } from '../server/agents-api.mjs';
import { AlpacaKeys } from '../server/alpaca-keys.mjs';
import { DEFAULT_PARAMS } from '../server/engine/agents/profile.mjs';
import { rng } from '../server/engine/stats.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ft-llm-'));
const KEY = 'frost-ai-test-key-0123456789';

async function fakeModel(answer) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ headers: req.headers, body: JSON.parse(body || '{}'), url: req.url });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: typeof answer === 'function' ? answer() : answer } }] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/v1/chat/completions`, seen, close: () => server.close() };
}

test('checking the answer: only known agents and parameters, inside the bounds, at most 3', () => {
  const ok = checkProposals('Sure! {"proposals":[{"agent":"agent-b","params":{"entryScore":0.75,"maxHold":12},"reason":"stop_run trades held long lost money"}]}');
  assert.deepEqual(ok.proposals, [{ agent: 'agent-b', params: { entryScore: 0.75, maxHold: 12 }, reason: 'stop_run trades held long lost money' }]);
  const bad = checkProposals(
    JSON.stringify({
      proposals: [
        { agent: 'agent-z', params: { entryScore: 0.6 } },
        { agent: 'agent-a', params: { entryScore: 0.1 } },
        { agent: 'agent-a', params: { maxDailyLoss: 1000 } },
        { agent: 'agent-a', params: { maxHold: 12.5 } },
        { agent: 'agent-a', params: { stopAtr: 2 }, code: 'rm -rf /' },
        { agent: 'agent-a', params: { stopAtr: '2' } },
        { agent: 'agent-a', params: { stopAtr: 2 } },
        { agent: 'agent-b', params: { stopAtr: 2 } },
        { agent: 'agent-c', params: { stopAtr: 2 } },
        { agent: 'agent-d', params: { stopAtr: 2 } },
      ],
    }),
  );
  assert.equal(bad.proposals.length, MAX_PROPOSALS);
  assert.deepEqual(bad.proposals.map((p) => p.agent), ['agent-a', 'agent-b', 'agent-c']);
  for (const want of [/unknown agent/, /entryScore 0\.1 is outside/, /"maxDailyLoss" is not an agent parameter/, /maxHold 12\.5/, /unknown fields/, /stopAtr "2"/, /more than 3/]) assert.ok(bad.dropped.some((d) => want.test(d)), String(want));
  assert.deepEqual(checkProposals('no json here').dropped, ['the answer was not JSON']);
  assert.deepEqual(checkProposals('{"ideas":[]}').dropped, ['no "proposals" list']);
});

test('the summary is stats only: no ticker, no date, no money settings', () => {
  const s = summarize({
    agents: [{ id: 'agent-a', params: DEFAULT_PARAMS['agent-a'], lastResult: { day: '2026-10-21', decision: 'kept', current: { n: 30, pnl: 0.2 }, best: { n: 31, pnl: 0.3 } } }],
    stats: { 'agent-a': { bySignal: [{ key: 'stop_run', trades: 30, winRate: 0.5, avgAud: 0.01 }], byExit: [{ key: 'target', trades: 15, winRate: 1, avgAud: 0.05 }], bySymbol: [{ key: 'NVDA', trades: 9 }] } },
  });
  const text = JSON.stringify(s);
  assert.ok(!text.includes('NVDA') && !/2026-/.test(text), text);
  assert.ok(!/paperPerAgent|maxDailyLoss|allocation|live/i.test(text));
  assert.equal(s.agents[0].bySignal[0].signal, 'stop_run');
});

test('off by default; local addresses only; the key is write-only and sent as a Bearer header', async () => {
  const dir = tmp();
  const m = new ModelIdeas({ dataDir: dir });
  assert.equal(m.status().enabled, false);
  assert.deepEqual(await m.propose({}), { proposals: [], dropped: [], skipped: 'switched off' });
  assert.throws(() => m.update({ url: 'https://api.example.com/v1/chat/completions' }), /on this computer/);
  assert.throws(() => m.update({ url: 'http://10.0.0.5:8765/v1/chat/completions' }), /on this computer/);
  const fm = await fakeModel('{"proposals":[{"agent":"agent-a","params":{"entryScore":0.7},"reason":"fewer weak entries"}]}');
  try {
    const st = m.update({ enabled: true, url: fm.url, key: KEY });
    assert.equal(st.keySet, true);
    assert.ok(!JSON.stringify(st).includes(KEY));
    assert.ok(!fs.readFileSync(path.join(dir, 'llm.json'), 'utf8').includes(KEY), 'the key is in its own file');
    const r = await m.propose({ agents: [] });
    assert.equal(r.proposals[0].params.entryScore, 0.7);
    assert.equal(fm.seen[0].headers.authorization, `Bearer ${KEY}`);
    assert.equal(fm.seen[0].body.messages[0].role, 'system');
    assert.match(fm.seen[0].body.messages[0].content, /never write code/);
    assert.ok(!JSON.stringify(m.status()).includes(KEY));
    assert.equal((await m.test()).last.ok, true);
  } finally {
    fm.close();
  }
  m.update({ url: 'http://127.0.0.1:1/v1/chat/completions' });
  const down = await m.propose({});
  assert.match(down.error, /Could not reach the local model/);
  assert.ok(!down.error.includes(KEY));
});

test('a night with the model on: its idea is one more candidate under the same rules, its words are labelled', async () => {
  const dir = tmp();
  const spawn = () => Object.assign(new EventEmitter(), { send() {}, kill() {} });
  const host = new AgentHost({ dataDir: dir, getUniverse: () => ['AAA'], getData: () => null, getFx: () => ({ rate: 0.7, date: '2026-10-21' }), now: () => Date.parse('2026-10-21T21:00:00Z'), spawn, log: { warn() {} } });
  const store = new BarStore({ dataDir: dir });
  const r = rng(3);
  const bars = [];
  let p = 100;
  const days = [];
  const d = new Date('2026-09-22T12:00:00Z');
  while (days.length < 15) {
    if (d.getUTCDay() % 6) days.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  for (const day of days) for (let k = 0; k < 78; k++) {
    const o = p;
    p *= 1 + (r() - 0.5) * 0.004;
    bars.push({ t: Date.parse(`${day}T13:30:00Z`) + k * 300000, o, h: Math.max(o, p) * 1.001, l: Math.min(o, p) * 0.999, c: p, v: 1000 });
  }
  store.write('AAA', bars);
  const fm = await fakeModel('{"proposals":[{"agent":"agent-c","params":{"entryScore":0.9,"stopAtr":1.25},"reason":"agent-c stops too wide"}]}');
  try {
    const ideas = new ModelIdeas({ dataDir: dir });
    ideas.update({ enabled: true, url: fm.url });
    const research = new Research({ dataDir: dir, host, ideas, log: { warn() {} } });
    const before = structuredClone(host.settings);
    const out = await research.run('2026-10-21', ['AAA']);
    assert.equal(out.model.proposals, 1);
    assert.equal(out.results['agent-c'].modelIdeas, 1);
    assert.equal(out.results['agent-c'].candidates, 22, 'current + 20 variants + the model\'s one');
    assert.equal(out.results['agent-a'].modelIdeas, 0);
    assert.ok(host.journal.decisions('2026-10-21', 'agent-c').some((x) => /^model's words: agent-c stops too wide/.test(x.text)));
    assert.ok(host.audit.tail(10).some((e) => e.type === 'llm' && e.proposals === 1 && /^[0-9a-f]{64}$/.test(e.promptHash)));
    // nothing outside the parameters moved
    assert.deepEqual(host.settings.preset, before.preset);
    assert.equal(host.settings.paperPerAgent, before.paperPerAgent);
    // the prompt carried no ticker
    assert.ok(!JSON.stringify(fm.seen[0].body).includes('AAA'));
  } finally {
    fm.close();
    host.stop();
  }
});

test('API: /api/llm reads without the key and changes only from this computer', async () => {
  const dir = tmp();
  const spawn = () => Object.assign(new EventEmitter(), { send() {}, kill() {} });
  const host = new AgentHost({ dataDir: dir, getFx: () => ({ rate: 1, date: '2026-10-21' }), spawn, log: { warn() {} } });
  const ideas = new ModelIdeas({ dataDir: dir });
  const api = createAgentsApi({ host, keys: new AlpacaKeys({ dataDir: dir }), ideas });
  const local = { host: '127.0.0.1:8787', 'content-type': 'application/json' };
  await assert.rejects(api.handle('PUT', '/api/llm', { ...local, origin: 'https://evil.example' }, { enabled: true }), (e) => e.status === 403);
  const st = (await api.handle('PUT', '/api/llm', local, { key: KEY, enabled: true })).body;
  assert.equal(st.enabled, true);
  assert.ok(!JSON.stringify((await api.handle('GET', '/api/llm')).body).includes(KEY));
  await assert.rejects(api.handle('PUT', '/api/llm', local, { url: 'https://evil.example/v1' }), (e) => e.status === 400);
  host.stop();
});
