// The boot smoke (the owner's rule, 24 Oct 2026): before an installer, start the REAL main process, hidden, on saved
// state in temp folders (Electron's folders moved first: test/electron-boot-main.cjs), and check it renders with no
// crash. FROSTTRADER_SELFTEST keeps it off the agents, Finviz, ~/.ticker.yaml, git and the network. Twice: Dev install
// off, and through the launcher with Dev install on but its checkout missing (the built-in copy starts, says why,
// leaves no mark).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let electron = '';
try {
  electron = require('electron');
} catch {
  /* not installed (or its binary wasn't downloaded): skipped */
}
const { bootSmoke } = await import('../electron/frost-updater/smoke.mjs');

const noDisplay = process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
const write = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
};

/** Saved state as the plain server (npm start) leaves it: keys, a watchlist, four agents mid-day, one paused. */
function seed(dataDir) {
  const now = Date.now();
  // made-up keys in the shape Settings accepts (never real ones); the self-test never calls Alpaca
  write(path.join(dataDir, 'alpaca-keys.json'), { keyId: 'PKBOOTSMOKE000000000', secret: 'bootsmokebootsmokebootsmoke0000' });
  write(path.join(dataDir, 'finviz.json'), { urls: ['https://elite.finviz.com/screener.ashx?v=111&f=sh_avgvol_o500'], intervalMin: 60 });
  write(path.join(dataDir, 'watchlist.json'), { source: 'finviz', at: now - 3_600_000, symbols: ['AAPL', 'MSFT', 'NVDA'], rows: 3, dropped: 0, rejected: [] });
  write(path.join(dataDir, 'allocations.json'), { pool: 4000, agents: { 'agent-a': 1000, 'agent-b': 1000, 'agent-c': 1000, 'agent-d': 1000 } });
  for (const id of ['agent-a', 'agent-b', 'agent-c', 'agent-d']) {
    const positions = id === 'agent-a' ? { AAPL: { qty: 2, avg: 190.5 } } : {};
    write(path.join(dataDir, 'agents', id, 'ledger.json'), { id, allocation: 1000, cash: id === 'agent-a' ? 619 : 1000, positions, prices: { AAPL: 191.2 }, realized: 0, fills: [] });
  }
  write(path.join(dataDir, 'agents-host.json'), { killed: false, killReason: '', killedAt: null, integrity: null, day: null, closedDay: null, poolPause: null, paused: { 'agent-b': { at: now - 600_000, why: 'paused by the owner' } }, lastTick: now - 60_000, lastError: '', agents: {} });
  write(path.join(dataDir, 'agents-settings.json'), {}); // an older version's empty settings
}

test('boot smoke: the real main process renders on saved state, directly and through the launcher, and nothing throws', { skip: !electron ? 'needs Electron' : noDisplay ? 'needs a display' : false, timeout: 300_000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'frosttrader-boot-'));
  const appData = path.join(tmp, 'AppData');
  const home = path.join(appData, 'FrostTrader');
  const dataDir = path.join(home, 'data');
  seed(dataDir);
  if (!fs.existsSync(path.join(root, 'client', 'dist', 'index.html'))) execFileSync(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'client/vite.config.ts', '--logLevel', 'error'], { cwd: root, stdio: 'inherit' });
  // FROSTTRADER_PORT=0: never the owner's 8787 (a running `npm start` may have it)
  const env = { BOOT_APPDATA: appData, FROSTTRADER_HOME: home, FROSTTRADER_SELFTEST: '1', FROSTTRADER_PORT: '0' };
  const args = [...(process.platform === 'linux' ? ['--no-sandbox'] : []), path.join(root, 'test', 'electron-boot-main.cjs'), '--hidden'];
  // every saved file, to check the self-test changed none of them
  const saved = () => fs.readdirSync(dataDir, { recursive: true }).filter((f) => f.endsWith('.json')).sort().map((f) => [f, fs.readFileSync(path.join(dataDir, f), 'utf8')]);
  const before = saved();
  try {
    // 1. Dev install off
    fs.writeFileSync(path.join(home, 'devinstall.json'), JSON.stringify({ enabled: false }));
    const plain = await bootSmoke({ electron, cwd: root, args, env, timeoutMs: 120_000 });
    assert.ok(plain.result, plain.out.slice(-1500));
    assert.equal(plain.result.error, undefined, plain.result.error);
    assert.ok(plain.result.rendered > 100, JSON.stringify(plain.result));
    assert.equal(plain.result.title, 'Frost Trader');
    assert.equal(plain.result.desktop, true, 'the preload marks the page');
    assert.equal(plain.result.agents, 200, 'the server inside the app answers');
    assert.equal(plain.result.keysSaved, true, 'it reads the saved data folder');
    assert.equal(path.resolve(plain.result.dataDir), path.resolve(dataDir));
    assert.equal(plain.result.tray, true);
    assert.deepEqual(plain.errors, []);
    // 2. through the launcher, Dev install on, its checkout gone
    const cfgFile = path.join(home, 'devinstall.json');
    fs.writeFileSync(cfgFile, JSON.stringify({ enabled: true, dir: path.join(tmp, 'no-such-checkout'), auto: true, lastGood: '', booting: null }));
    const viaLauncher = await bootSmoke({ electron, cwd: root, args, env: { ...env, FROSTTRADER_BOOT_CHECKOUT: '1' }, timeoutMs: 120_000 });
    assert.ok(viaLauncher.result, viaLauncher.out.slice(-1500));
    assert.equal(viaLauncher.result.error, undefined, viaLauncher.result.error);
    assert.equal(viaLauncher.result.from, 'installed', 'the built-in copy');
    assert.ok(viaLauncher.result.note, 'with a note saying why');
    assert.ok(viaLauncher.result.rendered > 100);
    assert.deepEqual(viaLauncher.errors, []);
    const after = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    assert.deepEqual([after.enabled, after.booting], [true, null], 'Dev install stays on; no start mark left');
    assert.ok(fs.existsSync(path.join(home, 'Preferences')), "Electron's own files went to the temp folder");
    assert.deepEqual(saved(), before, 'the self-test changed none of the saved files');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
