// FrostTrader for Windows: the same app as `npm start`, in its own window. The server (server/app.mjs) runs inside
// the app's main process on 127.0.0.1 (8787 when free), with its data in %APPDATA%\FrostTrader\data; the paper
// agents it starts are child processes of the app. Market data comes from Alpaca with the PAPER keys saved in
// Settings (data/alpaca-keys.json); no order is ever sent to Alpaca.
// Closing the window keeps the paper agents running from the tray; the tray's "Quit" stops them and exits.
//
// start.cjs pins the data folder, takes the single-instance lock and runs Dev install's checks, then calls start().
// Nothing here runs on import: start() builds everything in order (server, then window, then tray) so no startup
// code saves or sends anything before what it touches exists.
import { app, BrowserWindow, Menu, Tray, dialog, nativeImage, shell } from 'electron';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server/app.mjs';

const require = createRequire(import.meta.url);
const { appDirs, portsToTry, isOwnPage, isWebLink } = require('./desktop.cjs');

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const ICON = path.join(root, 'build', 'icon.png');
// the boot smoke (FROSTTRADER_SELFTEST): the window and the tray on the saved state; no agents, no Finviz, no
// ~/.ticker.yaml, no git, no network
const SELFTEST = !!process.env.FROSTTRADER_SELFTEST;

let win = null;
let tray = null;
let server = null;
let quitting = false;
let stopped = false;

function show() {
  if (!win) return;
  win.show();
  if (win.isMinimized()) win.restore();
  win.focus();
}

function createWindow(url) {
  Menu.setApplicationMenu(null);
  win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 720,
    minHeight: 520,
    title: 'FrostTrader',
    backgroundColor: '#0b1424',
    icon: ICON,
    show: !process.argv.includes('--hidden'),
    webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, devTools: !app.isPackaged, spellcheck: false },
  });
  const origin = new URL(url).origin;
  win.webContents.setWindowOpenHandler(({ url: to }) => {
    if (isWebLink(to)) shell.openExternal(to);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, to) => {
    if (isOwnPage(to, origin)) return;
    e.preventDefault();
    if (isWebLink(to)) shell.openExternal(to);
  });
  // (the page's own downloads, e.g. Paper portfolio → Export, use Electron's save dialog)
  win.webContents.on('before-input-event', (_e, input) => {
    // Developer tools only in a development run (`npm run desktop`), never in the installed app.
    if (!app.isPackaged && input.type === 'keyDown' && input.control && input.shift && input.key.toLowerCase() === 'i') win.webContents.toggleDevTools();
  });
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
  });
  if (SELFTEST) {
    win.webContents.once('did-finish-load', () =>
      setTimeout(async () => {
        const ui = await win.webContents
          .executeJavaScript("(async () => ({ title: document.title, rendered: (document.getElementById('root') || document.body).innerHTML.length, desktop: !!window.frostTraderDesktop, agents: (await fetch('/api/agents')).status, keysSaved: (await (await fetch('/api/alpaca')).json()).set, text: document.body.innerText.slice(0, 160) }))()")
          .catch((e) => ({ error: String(e) }));
        const run = globalThis.__frostTraderRunning || { from: 'installed' };
        console.log('SELFTEST ' + JSON.stringify({ ...ui, tray: !!tray, port: server?.port, dataDir: server?.dataDir, from: run.from, note: run.note || '' }));
        app.quit();
      }, 3000),
    );
  }
  win.loadURL(url);
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 32, height: 32 }));
  tray.setToolTip('FrostTrader (paper only)');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open FrostTrader', click: show },
      { type: 'separator' },
      { label: 'Quit (stops the paper agents)', click: () => app.quit() },
    ]),
  );
  tray.on('click', () => (win && win.isVisible() && win.isFocused() ? win.hide() : show()));
}

/** The server, the window, then the tray. */
export async function start() {
  await app.whenReady();
  app.setAppUserModelId('au.com.frosttechnology.frosttrader');
  const { dataDir } = appDirs({ appData: app.getPath('appData') });
  try {
    // On the desktop the Pi is the real runner, so a fresh install defaults to "Run agents on: The Pi"
    // (runHere:false). An existing install keeps whatever the owner saved. The Pi/server keep runHere:true.
    // The boot smoke (SELFTEST) keeps the engine default so it renders the local view with no network pull.
    server = await startServer({ dataDir, ports: portsToTry(), agents: !SELFTEST, finviz: !SELFTEST, tickerMirror: !SELFTEST && process.env.TICKER_MIRROR !== '0', settingsDefaults: SELFTEST ? null : { runHere: false } });
  } catch (err) {
    const why = err && err.message ? err.message : String(err);
    if (SELFTEST) console.log('SELFTEST ' + JSON.stringify({ error: `server: ${why}` }));
    else dialog.showErrorBox('FrostTrader could not start', `Its server did not start: ${why}`);
    stopped = true;
    app.exit(1);
    return;
  }
  console.log(`FrostTrader on ${server.url}  data: ${server.dataDir}`);
  createWindow(`${server.url}/`);
  createTray();
}

app.on('second-instance', show);
app.on('window-all-closed', (e) => e.preventDefault());
app.on('before-quit', (e) => {
  quitting = true;
  if (stopped) return;
  e.preventDefault();
  stopped = true;
  // stop the agents and the server, but never hang the quit
  const stop = server ? server.stop() : Promise.resolve();
  Promise.race([stop, new Promise((r) => setTimeout(r, 3000))])
    .catch(() => {})
    .finally(() => app.quit());
});
