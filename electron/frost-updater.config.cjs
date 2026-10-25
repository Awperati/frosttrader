// FrostTrader's settings for the Frost suite's shared updater (electron/frost-updater, vendored unchanged from
// Awperati/frost-updater; see its INTEGRATION.md). Dev install, on by default: the installed FrostTrader sets up a git
// checkout of its own source and runs from it, updated with a pull (by itself, and by Frost Launcher every hour).
const os = require('os');
const path = require('path');

const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');

module.exports = {
  appName: 'FrostTrader',
  repoUrl: 'https://github.com/Awperati/frosttrader.git',
  defaultDir: process.env.FROSTTRADER_SRC_DIR || path.join(os.homedir(), 'FrostTrader', 'src'),
  legacyDir: '',
  // devinstall.json lives in the app's data folder (start.cjs pins userData to %APPDATA%\FrostTrader), or a test's own
  home: () => process.env.FROSTTRADER_HOME || path.join(appData, 'FrostTrader'),
  // start.cjs: the lock and the package check, then main.mjs (ESM: its imports would run before any check)
  mainEntry: 'electron/start.cjs',
  restartArg: '--frosttrader-restart',
  runtimePaths: [], // the server and the engine use Node's own modules only
  // the window: the React app in client/ (vite's root, client/vite.config.ts), built into client/dist.next and
  // swapped in as client/dist
  distDir: 'client/dist',
  windowPaths: ['client', 'package-lock.json'],
  buildArgs: ['vite', 'build', '--config', 'client/vite.config.ts', '--outDir', 'dist.next', '--emptyOutDir'],
  configDefaults: { auto: true },
};
