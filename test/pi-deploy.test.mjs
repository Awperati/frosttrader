// The Pi setup (docs/PI.md): the image runs the plain server on loopback, with the data on a volume,
// and a copy with "Run the agents here" off never trades.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanSettings, DEFAULT_SETTINGS } from '../server/engine/agents/profile.mjs';

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
