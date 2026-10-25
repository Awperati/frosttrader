// The Windows app's main-process code that runs without Electron: where it keeps its data, which port it takes,
// what the window may load, its updater settings, and the server it starts (server/app.mjs) on a temp folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startServer, listenOn } from '../server/app.mjs';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { appDirs, portsToTry, isOwnPage, isWebLink } = require('../electron/desktop.cjs');

test('data folders: %APPDATA%\\FrostTrader, the server data in its data folder; a test can move both', () => {
  const appData = path.join('C:', 'Users', 'x', 'AppData', 'Roaming');
  assert.deepEqual(appDirs({ appData, env: {} }), { userData: path.join(appData, 'FrostTrader'), dataDir: path.join(appData, 'FrostTrader', 'data') });
  const t = path.resolve(os.tmpdir(), 'ft-home');
  assert.deepEqual(appDirs({ appData, env: { FROSTTRADER_USER_DATA: t } }), { userData: t, dataDir: path.join(t, 'data') });
  assert.equal(appDirs({ appData, env: { FROSTTRADER_DATA_DIR: path.join(t, 'd') } }).dataDir, path.join(t, 'd'));
});

test('ports: 8787 first (the Frost AI connector address), then any free one; a test may fix one', () => {
  assert.deepEqual(portsToTry({}), [8787, 0]);
  assert.deepEqual(portsToTry({ FROSTTRADER_PORT: '0' }), [0]);
  assert.deepEqual(portsToTry({ FROSTTRADER_PORT: '9123' }), [9123]);
  assert.deepEqual(portsToTry({ FROSTTRADER_PORT: 'nope' }), [8787, 0]);
});

test('the window loads only its own server; web links go to the browser', () => {
  const origin = 'http://127.0.0.1:8787';
  assert.equal(isOwnPage('http://127.0.0.1:8787/paper', origin), true);
  assert.equal(isOwnPage('http://127.0.0.1:8788/', origin), false);
  assert.equal(isOwnPage('https://example.com/', origin), false);
  assert.equal(isOwnPage('not a url', origin), false);
  assert.equal(isWebLink('https://finviz.com/'), true);
  assert.equal(isWebLink('file:///C:/Windows'), false);
  assert.equal(isWebLink('javascript:alert(1)'), false);
});

test("the updater settings match this repository's layout", () => {
  process.env.FROSTTRADER_HOME = path.join(os.tmpdir(), 'ft-updater-home');
  const cfg = require('../electron/frost-updater.config.cjs');
  assert.equal(cfg.appName, 'FrostTrader');
  assert.equal(cfg.repoUrl, 'https://github.com/Awperati/frosttrader.git');
  assert.equal(cfg.home(), process.env.FROSTTRADER_HOME);
  assert.ok(fs.existsSync(path.join(root, cfg.mainEntry)), cfg.mainEntry);
  assert.equal(cfg.restartArg, '--frosttrader-restart');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.main, 'electron/boot.cjs');
  assert.equal(pkg.build.productName, 'FrostTrader');
  assert.equal(pkg.build.nsis.artifactName, 'FrostTrader-Setup-${version}.exe');
  // the window builds with client/vite.config.ts into client/dist.next, then is swapped in as client/dist
  const conf = cfg.buildArgs[cfg.buildArgs.indexOf('--config') + 1];
  assert.ok(fs.existsSync(path.join(root, conf)), conf);
  assert.equal(path.join(path.dirname(conf), cfg.buildArgs[cfg.buildArgs.indexOf('--outDir') + 1]), path.join(cfg.distDir + '.next'));
  for (const p of cfg.windowPaths) assert.ok(fs.existsSync(path.join(root, p)), p);
});

const get = (url) =>
  new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });

test('listenOn: the next port when the first is taken', async () => {
  const busy = http.createServer();
  const taken = await listenOn(busy, [0]);
  const s = http.createServer();
  try {
    const got = await listenOn(s, [taken, 0]);
    assert.notEqual(got, taken);
    assert.ok(got > 0);
    await assert.rejects(listenOn(http.createServer(), [taken]), /EADDRINUSE/);
  } finally {
    s.close();
    busy.close();
  }
});

test('startServer: the app server on a temp folder answers, reports its own port to the connector, and stops', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-app-'));
  const s = await startServer({ dataDir, ports: [0], agents: false, finviz: false, tickerMirror: false, log: { error() {} } });
  try {
    assert.ok(s.port > 0);
    assert.equal(s.url, `http://127.0.0.1:${s.port}`);
    assert.equal(s.dataDir, path.resolve(dataDir));
    const agents = await get(`${s.url}/api/agents`);
    assert.equal(agents.status, 200);
    const alpaca = JSON.parse((await get(`${s.url}/api/alpaca`)).body);
    assert.equal(alpaca.set, false, 'no keys in a fresh data folder');
    const conn = JSON.parse((await get(`${s.url}/api/connector`)).body);
    assert.equal(conn.url, `http://127.0.0.1:${s.port}/mcp`);
    assert.equal((await get(`${s.url}/api/nope`)).status, 404);
  } finally {
    await s.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  await assert.rejects(get(`${s.url}/api/agents`));
});

test('startServer needs a data folder, and a taken port fails cleanly', async () => {
  await assert.rejects(startServer({}), /dataDir/);
  const busy = http.createServer();
  const taken = await listenOn(busy, [0]);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-app-'));
  try {
    await assert.rejects(startServer({ dataDir, ports: [taken], agents: false, finviz: false, tickerMirror: false }), /EADDRINUSE/);
  } finally {
    busy.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
