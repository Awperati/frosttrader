// FrostTrader's first steps, before its main process (main.mjs) loads: ESM imports all run first, so the checks that
// must come before anything else loads live here. The data folder is pinned first (the single-instance lock belongs
// to it), then the lock, then Dev install's package check (frost-updater preflight); then main.mjs. Dev install, on
// by default: set up in the background, then updated at launch and every hour (and by Frost Launcher); a new version
// is used from the next start.
const { app } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const du = require('./devupdate.cjs');
const { UpdateCheck } = require('./frost-updater/updatecheck.cjs');
const { appDirs } = require('./desktop.cjs');

// FROSTTRADER_USER_DATA: a test's own data folder, never the owner's
app.setPath('userData', appDirs({ appData: app.getPath('appData') }).userData);
const running = global.__frostTraderRun || { from: 'installed' };
const SELFTEST = !!process.env.FROSTTRADER_SELFTEST;

function start() {
  // One FrostTrader: a restart's new copy waits for the old one to close
  if (!app.requestSingleInstanceLock()) {
    du.notStarted(running);
    if (process.argv.includes(du.RESTART_ARG)) du.waitForLock(app, { ms: 15_000 }).then((ok) => (ok && app.relaunch({ args: du.withoutRestartArg(process.argv.slice(1)) }), app.exit(0)));
    else app.quit();
    return;
  }
  const launcher = require.main && require.main.filename ? require.main.filename : '';
  let pre = { go: true };
  try {
    pre = du.preflight(running, { mainFile: launcher ? path.join(path.dirname(launcher), 'start.cjs') : '' });
  } catch (err) {
    console.warn('[devinstall] package check failed:', err);
  }
  if (!pre.go && pre.relaunch) {
    app.relaunch();
    app.exit(0);
    return;
  }
  if (!pre.go && pre.fallback) {
    global.__frostTraderRun = { from: 'installed', note: pre.note, retry: true };
    require(pre.fallback);
    return;
  }
  // the first window that loads: this commit started (its start mark goes)
  app.once('browser-window-created', (_e, w) => w.webContents.once('did-finish-load', () => du.startedOk(running)));
  global.__frostTraderRunning = running; // main.mjs's self-test reports where it runs from
  import(pathToFileURL(path.join(__dirname, 'main.mjs')).href)
    .then((m) => m.start())
    .catch((err) => {
      console.error(err);
      app.exit(1);
    });
  if (SELFTEST) return; // the boot smoke: no git, no network
  app.whenReady().then(() => {
    if (running.from === 'checkout') {
      if (du.readConfig().checkOnLaunch !== false) setTimeout(() => void job('update'), 8000);
      updateCheck.start();
    } else if (app.isPackaged && !process.env.PORTABLE_EXECUTABLE_FILE) setTimeout(() => void autoDevInstall().catch(() => {}), 60_000);
  });
}

// ── Dev install: the update job (one at a time; Frost Launcher may hold the checkout: then it's busy, not failed) ──
let updating = null;
async function job(kind) {
  if (updating) return { busy: 'An update is already running.' };
  const cfg = du.readConfig();
  updating = kind === 'setup' ? du.setup({ dir: cfg.dir }) : du.update({ dir: cfg.dir, cfg });
  try {
    const r = (await updating) || {};
    if (kind === 'setup') du.writeConfig({ ...du.readConfig(), lastGood: r.commit || '' });
    else if (r.to) du.writeConfig({ ...du.readConfig(), lastError: '' });
    return r;
  } catch (err) {
    if (err instanceof du.UpdateLocked) return { busy: err.message };
    try {
      const c = du.readConfig();
      const e = `The last ${kind} failed: ${err.message}`;
      if (c.lastError !== e) du.writeConfig({ ...c, lastError: e });
    } catch {
      /* best effort */
    }
    return { error: err.message };
  } finally {
    updating = null;
  }
}
const updateCheck = new UpdateCheck({ readConfig: () => du.readConfig(), busy: () => !!updating, quitting: () => false, run: () => job('update') });
/** On by default: the installed app sets its checkout up in the background, then runs from it from the next start. */
async function autoDevInstall() {
  const cfg = du.readConfig();
  const what = du.autoDecision(cfg, { running: running.from, ready: du.checkoutReady(cfg.dir), busy: !!updating }).action;
  if (what === 'enable') return du.writeConfig({ ...cfg, enabled: true, auto: true, lastError: '' });
  if (what !== 'setup') return;
  du.writeConfig({ ...cfg, autoSetupAt: Date.now() });
  const r = await job('setup');
  const c = du.readConfig();
  if (!r.error && !r.busy && c.auto !== false && du.checkoutReady(c.dir)) du.writeConfig({ ...c, enabled: true, auto: true, lastError: '' });
}

start();
