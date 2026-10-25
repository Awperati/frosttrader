// The Windows app's small decisions, kept apart from Electron so the tests can check them (test/desktop.test.mjs).
const path = require('path');

/**
 * Where the app keeps things. userData: Electron's folder and devinstall.json (%APPDATA%\FrostTrader, or a test's
 * FROSTTRADER_USER_DATA). dataDir: the server's DATA_DIR inside it (alpaca-keys.json, agents/, watchlist.json, …),
 * or FROSTTRADER_DATA_DIR.
 */
function appDirs({ appData, env = process.env }) {
  const userData = env.FROSTTRADER_USER_DATA ? path.resolve(env.FROSTTRADER_USER_DATA) : path.join(appData, 'FrostTrader');
  const dataDir = env.FROSTTRADER_DATA_DIR ? path.resolve(env.FROSTTRADER_DATA_DIR) : path.join(userData, 'data');
  return { userData, dataDir };
}

/**
 * The ports the server tries, in order: 8787 first, so the Frost AI connector's address
 * (http://127.0.0.1:8787/mcp) stays the same, then any free one (`npm start` may hold 8787).
 * FROSTTRADER_PORT: a fixed port (0: any free one), for a test.
 */
function portsToTry(env = process.env) {
  if (env.FROSTTRADER_PORT !== undefined && env.FROSTTRADER_PORT !== '') {
    const p = Number(env.FROSTTRADER_PORT);
    if (Number.isInteger(p) && p >= 0 && p < 65536) return [p];
  }
  return [8787, 0];
}

/** Whether the window may load url: only the app's own server. Anything else opens in the browser, if http(s). */
function isOwnPage(url, origin) {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

const isWebLink = (url) => /^https?:\/\//i.test(String(url));

module.exports = { appDirs, portsToTry, isOwnPage, isWebLink };
