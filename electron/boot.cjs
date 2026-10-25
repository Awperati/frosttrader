// The launcher: the installed FrostTrader.exe starts here. With Dev install on (the default) it runs FrostTrader from
// its source checkout (updated with a git pull); otherwise, or if that can't start, the copy built into the app. The
// logic is the suite's shared updater (frost-updater/boot.cjs).
const path = require('path');
const { app } = require('electron');

let updater = null;
try {
  updater = require('./devupdate.cjs');
} catch {
  /* no launcher logic: just the built-in copy */
}
// a development run (npm run desktop) is the working tree itself, never the configured checkout
const dev = () => !app.isPackaged && !process.env.FROSTTRADER_BOOT_CHECKOUT;
require('./frost-updater/boot.cjs').launch({ updater, bundledMain: path.join(__dirname, 'start.cjs'), runGlobal: '__frostTraderRun', dev });
