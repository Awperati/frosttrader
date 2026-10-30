// pi-mirror: the source resolution, the secret-safe remote command, and the sync state machine
// (success, failure keeps the last good data, single-flight) — all with a fake pull, no network, no Pi.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { piSource, remoteTarCmd, createPiMirror, PULL, NEVER } from './pi-mirror.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pi-mirror-'));

test('piSource: env wins, then pi-source.json, else null; default remote dir', () => {
  const d = tmp();
  assert.equal(piSource({ env: {}, dataDir: d }), null);
  fs.writeFileSync(path.join(d, 'pi-source.json'), JSON.stringify({ sshTarget: 'henwy@pihost' }));
  assert.deepEqual(piSource({ env: {}, dataDir: d }), { sshTarget: 'henwy@pihost', remoteDir: 'frosttrader/data' });
  assert.deepEqual(piSource({ env: { FROSTTRADER_PI_SSH: 'a@b', FROSTTRADER_PI_DIR: 'x/y' }, dataDir: d }), { sshTarget: 'a@b', remoteDir: 'x/y' });
});

test('the remote command never pulls the secret files and excludes them by name', () => {
  // the allowlist itself must not contain any key/token file
  assert.ok(!PULL.includes('alpaca-keys.json') && !PULL.includes('finviz-token.json'));
  assert.deepEqual(NEVER, ['alpaca-keys.json', 'finviz-token.json']);
  const cmd = remoteTarCmd('frosttrader/data');
  assert.match(cmd, /--exclude=alpaca-keys\.json/);
  assert.match(cmd, /--exclude=finviz-token\.json/);
  // the allowlisted data files are tarred; no key/token appears as a pulled path
  assert.match(cmd, /agents-host\.json/);
  assert.match(cmd, /ls -d .*audit\.jsonl/);
  assert.ok(!/ (alpaca-keys|finviz-token)\.json[^.]/.test(cmd.replace(/--exclude=\S+/g, '')), 'no secret file is a pulled argument');
});

test('configured reflects whether a source is set', () => {
  assert.equal(createPiMirror({ dataDir: tmp(), source: null }).configured, false);
  assert.equal(createPiMirror({ dataDir: tmp(), source: { sshTarget: 'a@b', remoteDir: 'd' } }).configured, true);
});

test('sync success records synced time + reachable; failure keeps the last good data', async () => {
  const d = tmp();
  let clock = 1000;
  let mode = 'ok';
  const pull = async ({ dir }) => {
    if (mode === 'fail') throw new Error('ssh down');
    fs.writeFileSync(path.join(dir, 'agents-host.json'), '{"ok":true}');
  };
  const m = createPiMirror({ dataDir: d, source: { sshTarget: 'a@b', remoteDir: 'r' }, now: () => clock, pull, log: {} });

  let st = await m.sync();
  assert.equal(st.everSynced, true);
  assert.equal(st.syncedAt, 1000);
  assert.equal(st.error, null);
  assert.equal(st.reachable, true);
  assert.ok(fs.existsSync(path.join(m.dir, 'agents-host.json')), 'mirror has the pulled file');

  // a later failure: error recorded, reachable false, but the last good data + syncedAt stay
  mode = 'fail';
  clock = 2000;
  st = await m.sync();
  assert.equal(st.error, 'ssh down');
  assert.equal(st.reachable, false);
  assert.equal(st.everSynced, true, 'still have a prior good sync');
  assert.equal(st.syncedAt, 1000, 'keeps the last good time, not the failed one');
  assert.ok(fs.existsSync(path.join(m.dir, 'agents-host.json')), 'the last good mirror is not wiped');
});

test('a source-less mirror never syncs and reports not reachable', async () => {
  const m = createPiMirror({ dataDir: tmp(), source: null, log: {} });
  const st = await m.sync();
  assert.equal(st.everSynced, false);
  assert.equal(st.syncedAt, null);
});

test('sync is single-flight: overlapping calls share one pull', async () => {
  const d = tmp();
  let calls = 0;
  let release;
  const gate = new Promise((r) => (release = r));
  const pull = async () => {
    calls++;
    await gate;
  };
  const m = createPiMirror({ dataDir: d, source: { sshTarget: 'a@b', remoteDir: 'r' }, pull, log: {} });
  const a = m.sync();
  const b = m.sync();
  release();
  await Promise.all([a, b]);
  assert.equal(calls, 1, 'the second sync joined the first');
});
