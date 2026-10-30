// The Pi setup (docs/PI.md): the image runs the plain server on loopback, with the data on a volume,
// and a copy with "Run the agents here" off never trades.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanSettings, DEFAULT_SETTINGS, PI_DEFAULT } from '../server/engine/agents/profile.mjs';
import { AgentHost } from '../server/engine/agents/host.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

test('Dockerfile and compose: the headless server, loopback only, data on a volume, no Electron', () => {
  const df = read('Dockerfile');
  assert.match(df, /^FROM node:24-alpine/m);
  assert.match(df, /npm ci --ignore-scripts/, 'Electron\'s binary is never fetched');
  assert.match(df, /CMD \["node", "server\/index\.mjs"\]/);
  assert.match(df, /DATA_DIR=\/data/);
  const dc = read('docker-compose.pi.yml');
  assert.match(dc, /network_mode: host/);
  assert.match(dc, /\.\/data:\/data/);
  assert.match(dc, /restart: unless-stopped/);
  assert.match(dc, /PORT=8795/, '8787 is taken on the Pi by another service');
  assert.ok(!/ports:/.test(dc), 'no port is published');
  assert.match(read('server/app.mjs'), /export const HOST = '127\.0\.0\.1';/, 'the server listens on loopback only');
  for (const line of ['data', 'node_modules', '.env', 'stock_ohlcv']) assert.ok(read('.dockerignore').split(/\r?\n/).includes(line), `${line} stays out of the image`);
});

test('settings: "Run the agents here" is on by default and only a real boolean changes it', () => {
  assert.equal(DEFAULT_SETTINGS.runHere, true);
  assert.equal(cleanSettings({}).runHere, true);
  assert.equal(cleanSettings({ runHere: false }).runHere, false);
  assert.equal(cleanSettings({ runHere: 'no' }).runHere, true);
});

test('settings: the Pi source defaults to the owner\'s Pi and the app can change it', () => {
  assert.deepEqual(DEFAULT_SETTINGS.pi, PI_DEFAULT);
  assert.deepEqual(cleanSettings({}).pi, { sshTarget: 'henwy@pihost', remoteDir: 'frosttrader/data' });
  // the owner can point it elsewhere; a blank folder keeps a sane default; a blank ssh means "no Pi set"
  assert.deepEqual(cleanSettings({ pi: { sshTarget: 'me@box', remoteDir: 'x/y' } }).pi, { sshTarget: 'me@box', remoteDir: 'x/y' });
  assert.equal(cleanSettings({ pi: { sshTarget: 'me@box', remoteDir: '  ' } }).pi.remoteDir, 'frosttrader/data');
  assert.equal(cleanSettings({ pi: { sshTarget: '' } }).pi.sshTarget, '');
});

test('the desktop app defaults a FRESH install to the Pi (settingsDefaults); the Pi/server keep running here', () => {
  const desktop = new AgentHost({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ft-desktop-')), settingsDefaults: { runHere: false }, log: { warn() {} } });
  assert.equal(desktop.settings.runHere, false, 'a fresh desktop install mirrors the Pi');
  const server = new AgentHost({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ft-server-')), log: { warn() {} } });
  assert.equal(server.settings.runHere, true, 'the Pi/server runs agents by default');
});
