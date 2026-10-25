// Run by boot-smoke.test.mjs inside Electron: Electron's data folders moved to the test's temp folder FIRST (an
// environment variable doesn't move them), so the run never touches %APPDATA%\FrostTrader and has its own
// single-instance lock; then the real launcher (electron/boot.cjs), as the installed app starts.
const { app } = require('electron');
const path = require('path');

const appData = process.env.BOOT_APPDATA;
if (!appData || !path.isAbsolute(appData)) {
  console.log('SELFTEST ' + JSON.stringify({ error: 'BOOT_APPDATA (absolute) is needed' }));
  process.exit(1);
}
app.setPath('appData', appData);
require('../electron/boot.cjs');
