// The Frost suite's shared updater (frost-updater): an app runs from a git checkout of its own source and
// updates itself with a pull, so a new version needs no installer. The installed exe stays as the launcher
// (frost-updater/boot.cjs picks the checkout or the built-in copy). Each app passes its own settings
// (frost-updater.config.cjs: name, repository, folders, data folder, build) to createDevUpdate.
// Lifted from Frost AI's own updater (electron/lib/devupdate.cjs, 24 Oct 2026), with everything app-specific
// turned into settings; Frost AI's behaviour is unchanged.
//
//   Update: refuse if the checkout has local changes; git fetch; git pull --ff-only; npm ci only
//   if package.json / package-lock.json changed (or the packages are incomplete), into deps.next and
//   swapped in at the next start, never into the running app's node_modules; the window is built only if
//   its code changed or dist/ is missing (at the next start when the packages changed too); then relaunch.
//   Every launch checks the packages first.
//   Rollback: the launcher marks the commit it is starting; the window loading clears the mark and
//   records it as "last good". A mark still there at the next start (or after the ready timeout) means
//   that commit didn't start: the checkout goes back to the last good commit and the bad one is skipped.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const ghauth = require('./ghauth.cjs');

function createDevUpdate(app) {
const APP = app.appName; // shown in messages: "Frost AI's packages…"

const REPO_URL = app.repoUrl;
const REPO_SLUG = REPO_URL.replace(/^https:\/\/github\.com\//i, '').replace(/\.git$/, '');
const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const roamingAppData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
// the app's default checkout folder, and an older default used when a checkout is already there
const DEFAULT_DIR = app.defaultDir;
const LEGACY_DIR = app.legacyDir || '';
const defaultDir = () => (LEGACY_DIR && fs.existsSync(LEGACY_DIR) ? LEGACY_DIR : DEFAULT_DIR);

/** Is this folder a clone of the app's own repository? Its .git/config names REPO_URL as a remote. */
function isOurClone(dir) {
  try {
    const cfg = fs.readFileSync(path.join(dir, '.git', 'config'), 'utf8');
    const want = REPO_URL.replace(/\.git$/, '').toLowerCase();
    return cfg.split(/\r?\n/).some((l) => {
      const m = /^\s*url\s*=\s*(.+?)\s*$/i.exec(l);
      return !!m && m[1].replace(/\.git$/, '').replace(/\/+$/, '').toLowerCase() === want;
    });
  } catch {
    return false;
  }
}
const READY_TIMEOUT_MS = 20_000;
// the built window's folder, relative to the checkout (config distDir; default dist); a build goes to <dist>.next first
const DIST = String(app.distDir || 'dist').replace(/[\\/]+$/, '');
const DIST_NEXT = `${DIST}.next`;
const DIST_OLD = `${DIST}.old`;

const configFile = () => path.join(app.home(), 'devinstall.json');
// the app's own defaults under the saved settings (config configDefaults; FrostFlow: { auto: true, checkEveryMin: 60 })
const CONFIG_DEFAULTS = app.configDefaults || {};
// Settings → Updates' link to the releases page (config releasesUrl; default the repository's latest release)
const RELEASES_URL = app.releasesUrl || `https://github.com/${REPO_SLUG}/releases/latest`;
const NO_PROMPT = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };

/** { enabled, dir, checkOnLaunch, lastGood, booting: { commit, at } | null, badCommit, lastError } */
function readConfig(file = configFile()) {
  try {
    return { enabled: false, dir: defaultDir(), checkOnLaunch: true, lastGood: '', booting: null, badCommit: '', lastError: '', ...CONFIG_DEFAULTS, ...JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) };
  } catch {
    return { enabled: false, dir: defaultDir(), checkOnLaunch: true, lastGood: '', booting: null, badCommit: '', lastError: '', ...CONFIG_DEFAULTS };
  }
}

function writeConfig(cfg, file = configFile()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, file);
  return cfg;
}

const NEEDED = [app.mainEntry || 'electron/main.cjs', `${DIST}/index.html`, 'node_modules'];

/** What the checkout is missing to start (its main process, its built window, its packages): [] when ready. */
function checkoutMissing(dir) {
  if (!dir) return ['the folder'];
  return NEEDED.filter((p) => !fs.existsSync(path.join(dir, p)));
}

/** Can the checkout start? */
function checkoutReady(dir) {
  return checkoutMissing(dir).length === 0;
}

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * At launch: what is missing, asked up to `tries` times, `gapMs` apart. A virus scanner opening
 * node_modules or dist for the first time can make a check fail for a moment. sleep is for tests.
 */
function checkoutMissingAtLaunch(dir, { tries = 3, gapMs = 300, sleep = pause } = {}) {
  let missing = checkoutMissing(dir);
  for (let i = 1; i < tries && missing.length; i++) {
    sleep(gapMs);
    missing = checkoutMissing(dir);
  }
  return missing;
}

// A packaged (MSIX) Windows app, and every program it starts (a terminal in the Claude desktop
// app, say), gets a private copy of what it creates under AppData:
// %LOCALAPPDATA%\Packages\<app>\LocalCache\Local|Roaming\… . Inside that app the folder shows at
// its usual path; Frost AI started from the Start menu doesn't see it at all, so a checkout set up
// or rebuilt from there is "not found" at every launch.
const CONTAINED = /[\\/]Packages[\\/][^\\/]+[\\/]LocalCache[\\/](Local|Roaming|LocalLow)[\\/]/i;

/**
 * Where a folder really is on disk: its private copy under Packages\<app>\LocalCache when Windows
 * redirects it for this process, otherwise dir unchanged (links and drive letters are left alone).
 */
function physicalDir(dir, { realpath = fs.realpathSync.native } = {}) {
  if (!dir) return dir;
  try {
    const real = realpath(dir);
    return CONTAINED.test(real) && !CONTAINED.test(path.resolve(dir)) ? real : dir;
  } catch {
    return dir;
  }
}

/**
 * At launch, when dir isn't there: the same folder in an app's private AppData, if it can start.
 * { dir, app } (the most recently built one when several apps have a copy), or null.
 */
function findContainedCheckout(dir, { local = localAppData, roaming = roamingAppData } = {}) {
  if (!dir) return null;
  const abs = path.resolve(dir);
  if (CONTAINED.test(abs)) return null;
  const under = (base) => {
    const rel = path.relative(base, abs);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : null;
  };
  const where = under(local) ? ['Local', under(local)] : under(roaming) ? ['Roaming', under(roaming)] : null;
  if (!where) return null;
  const packages = path.join(local, 'Packages');
  let apps = [];
  try {
    apps = fs.readdirSync(packages);
  } catch {
    return null;
  }
  let best = null;
  for (const app of apps) {
    const copy = path.join(packages, app, 'LocalCache', where[0], where[1]);
    // only a real clone of the app's repository, never just any folder that happens to be at that path
    if (!fs.existsSync(copy) || checkoutMissing(copy).length || !isOurClone(copy)) continue;
    let at = 0;
    try {
      at = fs.statSync(path.join(copy, DIST, 'index.html')).mtimeMs;
    } catch {
      /* there a moment ago */
    }
    if (!best || at > best.at) best = { dir: copy, app, at };
  }
  return best ? { dir: best.dir, app: best.app } : null;
}

/** The config that runs Dev install from a copy findContainedCheckout found (null: none found). */
function adoptContained(cfg, found) {
  if (!cfg || !found) return null;
  const app = String(found.app).replace(/_[a-z0-9]{13}$/i, ''); // Claude_pzs8sxrjxfjjc → Claude
  return {
    ...cfg,
    dir: found.dir,
    lastError: `${cfg.dir} was only in ${app}'s private AppData (it was set up or rebuilt from a program ${app} started, such as its terminal), so ${APP} started any other way couldn't see it. Dev install now runs that copy: ${found.dir}`,
  };
}

/**
 * What the launcher does at start. It never turns Dev install off: only the person does that, in
 * Settings → Updates. Every fallback to the installed copy is for this launch only.
 *   { load: 'checkout' }
 *   { load: 'checkout', rollbackTo, bad }      the last start of `bad` failed: back to the last good commit
 *   { load: 'bundled' }                        Dev install is off
 *   { load: 'bundled', retry, note }           the checkout isn't ready (missing, or mid-build): next launch tries again
 *   { load: 'bundled', bad, note }             `bad` failed and there is no good one to go back to: skipped until a newer commit
 * head = the checkout's HEAD commit, when known.
 */
function decideBoot(cfg, { ready, head = '', missing = [], othersRunning = false }) {
  if (!cfg || !cfg.enabled) return { load: 'bundled' };
  // the commit marked bad is also the last good one: its window loaded after the rollback (a race, 25 Oct 2026:
  // 65553e1 rolled back to 084150c, then marked good). The bad mark is stale: that commit may run again.
  if (staleBad(cfg)) cfg = { ...cfg, badCommit: '', lastError: '' };
  if (!ready) {
    const what = missing.length ? ` (${missing.map((p) => path.join(cfg.dir || '', p)).join(', ')} not found)` : '';
    return { load: 'bundled', retry: true, missing, note: `The source checkout wasn't ready${what}, so this launch used the installed copy. Dev install is still on.` };
  }
  const short = (c) => String(c).slice(0, 7);
  // another copy is still running (a second launch, or a restart while the old copy closes): the mark is its
  // start, still going, not a failed one. Judging it rolled back a good commit; the lock decides this launch.
  if (cfg.booting && cfg.booting.commit && !othersRunning) {
    // the last start of this commit never reached the window
    if (cfg.lastGood && cfg.lastGood !== cfg.booting.commit) return { load: 'checkout', rollbackTo: cfg.lastGood, bad: cfg.booting.commit };
    return { load: 'bundled', bad: cfg.booting.commit, note: `Commit ${short(cfg.booting.commit)} didn't start and there is no earlier good one, so this launch used the installed copy. The next update with a newer commit tries again.` };
  }
  if (head && cfg.badCommit && head === cfg.badCommit) return { load: 'bundled', note: `Commit ${short(head)} didn't start last time, so this launch used the installed copy. The next update with a newer commit tries again.` };
  return { load: 'checkout' };
}

// ── The start mark, from the checkout's side ──
// The launcher marks each start (booting) and an unfinished mark makes the next start roll back. Two ways
// a good commit was rolled back again and again (24 Oct 2026; HEAD went back to 36b1a86 nine times):
//   - a second launch (Frost AI already running, in the tray since c5d32ae) marks its start, then quits on
//     the single-instance lock without a window, leaving the mark;
//   - a restart's new copy starts while the old one is still closing, loses the lock and quits the same way.
// So a launch that won't open a window clears its own mark, a restart waits for the lock, and the checkout
// marks itself good when its window loads (whatever the installed launcher does).

/** A bad mark for the commit that is also the last good one, from a rollback: its window did load (stale). */
function staleBad(cfg) {
  return !!(cfg && cfg.badCommit && cfg.badCommit === cfg.lastGood && /didn't start: went back to/.test(String(cfg.lastError || '')));
}

/** The window of this launch loaded: the commit is good, the mark goes (and a bad mark on this commit with it). */
function startedOk(run, file = configFile()) {
  if (!run || run.from !== 'checkout' || !run.commit) return false;
  const cfg = readConfig(file);
  const wasBad = cfg.badCommit === run.commit;
  if (cfg.lastGood === run.commit && !cfg.booting && !wasBad) return false;
  writeConfig({ ...cfg, booting: null, lastGood: run.commit, ...(wasBad ? { badCommit: '', lastError: rollbackNote(cfg) ? '' : cfg.lastError } : {}) }, file);
  return true;
}

/** This launch quits without a window (another Frost AI is running): take its own mark away, nobody else's. */
function notStarted(run, file = configFile()) {
  if (!run || run.from !== 'checkout' || !run.commit) return false;
  const cfg = readConfig(file);
  if (!cfg.booting || cfg.booting.commit !== run.commit) return false;
  writeConfig({ ...cfg, booting: null }, file);
  return true;
}

/** Added to a restart's command line, so the new copy waits for the old one to close instead of quitting. */
const RESTART_ARG = app.restartArg || `--${String(APP).toLowerCase().replace(/[^a-z0-9]+/g, '-')}-restart`;
const withoutRestartArg = (args) => args.filter((a) => a !== RESTART_ARG);

/** Ask for the single-instance lock until the other copy has closed (true), or give up after `ms` (false). */
function waitForLock(app, { ms = 10_000, every = 250, setTimer = setTimeout, now = Date.now } = {}) {
  const until = now() + ms;
  return new Promise((resolve) => {
    const tryLock = () => {
      if (app.requestSingleInstanceLock()) return resolve(true);
      if (now() >= until) return resolve(false);
      setTimer(tryLock, every);
    };
    tryLock();
  });
}

/**
 * How long the launcher waits for the window: 60 s, or 180 s when an update staged new packages (the first
 * start swaps them in, and a virus scanner reads every new file). 20 s was too short for both.
 */
function readyTimeoutMs(dir) {
  return dir && fs.existsSync(path.join(dir, 'deps.next')) ? 180_000 : 60_000;
}

/** A note for the window when this launch isn't the newest commit because the last one didn't start ('' when not). */
function rollbackNote(cfg) {
  return cfg && cfg.badCommit && /didn't start: went back to/.test(String(cfg.lastError || '')) ? String(cfg.lastError) : '';
}

/** The config to save after decideBoot (null: nothing changes). Never touches `enabled`. */
function configAfterBoot(cfg, decision) {
  if (staleBad(cfg) && !decision.rollbackTo && !decision.bad) return { ...cfg, badCommit: '', lastError: '' }; // healed
  if (decision.rollbackTo) return { ...cfg, booting: null, badCommit: decision.bad, lastError: `Commit ${String(decision.bad).slice(0, 7)} didn't start: went back to ${String(decision.rollbackTo).slice(0, 7)}.` };
  if (decision.bad) return { ...cfg, booting: null, badCommit: decision.bad, lastError: decision.note };
  return null;
}

// ── Packages (node_modules) ──
// Windows locks the native files a running Frost AI has loaded (node-pty's conpty.node and others).
// npm ci empties node_modules first, so run against the node_modules the app is using it died
// part-way and left a partial folder: every MCP server then failed with "Cannot find module".
// So packages are never installed into a node_modules that may be in use:
//   - an update installs them into deps.next (a copy of package.json + package-lock.json) and checks
//     them there; the next launch swaps deps.next/node_modules in before anything loads from it
//     (prepareCheckout), and builds the window then if the update needed both;
//   - every launch checks the checkout's packages (modulesMissing) before loading it, repairs them
//     once with npm ci if they are incomplete (nothing has loaded them yet), and otherwise uses the
//     installed copy and says what is missing.
const STAGE = 'deps.next';
const READY = 'ready.json';

/** What the app loads from node_modules at run time, beside each package.json dependency. */
const RUNTIME_PATHS = app.runtimePaths || []; // what the app loads from node_modules at run time, beside package.json's dependencies

const readJsonFile = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
};

const inside = (parent, p) => {
  const rel = path.relative(parent, p);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};

/** The file `spec` loads from dir's own node_modules ('' when it doesn't resolve there). */
function resolveFrom(dir, spec) {
  try {
    const p = require.resolve(spec, { paths: [dir] });
    // Node also looks in parent folders' node_modules; only this checkout's own counts. Resolutions are
    // cached per process, so the file must still be there too.
    return inside(path.join(dir, 'node_modules'), p) && fs.existsSync(p) ? p : '';
  } catch {
    return '';
  }
}

/**
 * What dir's node_modules lacks for Frost AI to run: [] when complete. Checks that npm finished
 * (node_modules/.package-lock.json, written last), that it matches package-lock.json and every package
 * it lists is on disk, that each package.json dependency is there, and the deep paths the app loads.
 */
function modulesMissing(dir, { resolve = resolveFrom, paths = RUNTIME_PATHS } = {}) {
  if (!dir) return ['the folder'];
  const nm = path.join(dir, 'node_modules');
  if (!fs.existsSync(nm)) return ['node_modules'];
  const out = [];
  const hidden = readJsonFile(path.join(nm, '.package-lock.json'));
  if (!hidden) out.push('node_modules/.package-lock.json (npm never finished installing)');
  const pkg = readJsonFile(path.join(dir, 'package.json')) || {};
  for (const name of Object.keys(pkg.dependencies || {})) {
    // a package may export only subpaths (the MCP SDK does), so its own package.json counts too
    if (!resolve(dir, name) && !fs.existsSync(path.join(nm, name, 'package.json'))) out.push(name);
  }
  for (const spec of paths) if (!resolve(dir, spec) && !out.includes(spec)) out.push(spec);
  const lock = readJsonFile(path.join(dir, 'package-lock.json'));
  if (hidden && hidden.packages) {
    const diffs = [];
    if (lock && lock.packages) {
      for (const [key, want] of Object.entries(lock.packages)) {
        if (!key.startsWith('node_modules/') || !want || want.link) continue;
        const have = hidden.packages[key];
        // optional (other platforms') and dev-only packages may be left out
        if (!have) {
          if (!want.optional && !want.dev && !want.devOptional) diffs.push(`${key.slice(13)} (not installed)`);
        } else if (want.version && have.version && want.version !== have.version) diffs.push(`${key.slice(13)} (${have.version} installed, ${want.version} wanted)`);
      }
    }
    for (const [key, have] of Object.entries(hidden.packages)) {
      if (!key.startsWith('node_modules/') || !have || have.link) continue;
      if (!fs.existsSync(path.join(dir, key, 'package.json'))) diffs.push(`${key.slice(13)} (folder missing)`);
    }
    out.push(...diffs.slice(0, 8));
    if (diffs.length > 8) out.push(`${diffs.length - 8} more packages`);
  }
  return out;
}

const repairCommand = (dir) => `cd /d "${dir}" && set ELECTRON_SKIP_BINARY_DOWNLOAD=1 && npm ci`;

/** Ask the next launch to reinstall the checkout's packages (an MCP server found its package missing, say). */
function requestRepair(why, file = configFile()) {
  try {
    const cfg = readConfig(file);
    if (!cfg.needsRepair) writeConfig({ ...cfg, needsRepair: String(why || 'requested').slice(0, 300) }, file);
  } catch {
    /* best effort: the launch check finds it anyway */
  }
}

const sha1 = (file) => {
  try {
    return require('crypto').createHash('sha1').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return '';
  }
};

/** Packages an update installed beside the checkout, waiting for the next launch: { lock, build } or null. */
function stagedInstall(dir) {
  const ready = readJsonFile(path.join(dir, STAGE, READY));
  return ready && fs.existsSync(path.join(dir, STAGE, 'node_modules')) ? ready : null;
}

/** Mark that the window must be built at the next launch, after the staged packages are swapped in. */
function markBuildAtLaunch(dir) {
  const file = path.join(dir, STAGE, READY);
  const ready = readJsonFile(file);
  if (ready) fs.writeFileSync(file, JSON.stringify({ ...ready, build: true }, null, 2));
}

/**
 * Install the checkout's packages into dir/deps.next, never into dir/node_modules (the running app's).
 * Checked there before it is marked ready; a failed install leaves the working node_modules alone.
 */
async function stageInstall(dir, exec, { build = false } = {}) {
  const stage = path.join(dir, STAGE);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  for (const f of ['package.json', 'package-lock.json', '.npmrc']) if (fs.existsSync(path.join(dir, f))) fs.copyFileSync(path.join(dir, f), path.join(stage, f));
  try {
    // the launcher brings its own Electron, so the checkout doesn't download one
    await exec('npm', ['ci', '--no-audit', '--no-fund'], { cwd: stage, env: { ELECTRON_SKIP_BINARY_DOWNLOAD: '1' } });
    const missing = modulesMissing(stage);
    if (missing.length) throw new Error(`The new packages didn't install completely (missing: ${missing.join(', ')}).`);
  } catch (err) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw err;
  }
  fs.writeFileSync(path.join(stage, READY), JSON.stringify({ lock: sha1(path.join(dir, 'package-lock.json')), build, at: Date.now() }, null, 2));
}

/** stageInstall for launch time, with a synchronous runner: { ok, code, out }; a failure leaves node_modules alone. */
function stageInstallSync(dir, runner) {
  const stage = path.join(dir, STAGE);
  try {
    fs.rmSync(stage, { recursive: true, force: true });
    fs.mkdirSync(stage, { recursive: true });
    for (const f of ['package.json', 'package-lock.json', '.npmrc']) if (fs.existsSync(path.join(dir, f))) fs.copyFileSync(path.join(dir, f), path.join(stage, f));
  } catch (err) {
    return { ok: false, code: -1, out: err.message };
  }
  const r = runner('npm', ['ci', '--no-audit', '--no-fund'], { cwd: stage, env: { ELECTRON_SKIP_BINARY_DOWNLOAD: '1' } });
  const missing = r.ok ? modulesMissing(stage) : [];
  if (!r.ok || missing.length) {
    fs.rmSync(stage, { recursive: true, force: true });
    return r.ok ? { ok: false, code: 0, out: `The packages didn't install completely (missing: ${missing.slice(0, 8).join(', ')}).` } : r;
  }
  fs.writeFileSync(path.join(stage, READY), JSON.stringify({ lock: sha1(path.join(dir, 'package-lock.json')), build: false, at: Date.now() }, null, 2));
  return r;
}

/**
 * npm and npx are .cmd files on Windows and need a shell. Node 24 warns (DEP0190) when an argument list is passed
 * with shell: true, so the shell gets one line. The arguments are the updater's own (never typed text); one with a
 * space or a shell character is quoted.
 */
function shellLine(cmd, args) {
  return [cmd, ...args.map((a) => (/^[\w@%+=:,./\\-]+$/.test(String(a)) ? String(a) : `"${String(a).replace(/"/g, '""')}"`))].join(' ');
}

/** Run a program and wait for it (launch time, before the checkout loads). { ok, code, out }. */
function runSync(cmd, args, { cwd, env, log = () => {} } = {}) {
  const shell = process.platform === 'win32' && ['npm', 'npx'].includes(cmd);
  const opts = { cwd, env: { ...process.env, ...env }, windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60 * 1000 };
  const r = shell ? require('child_process').spawnSync(shellLine(cmd, args), { ...opts, shell }) : require('child_process').spawnSync(cmd, args, opts);
  const out = `${r.stdout || ''}${r.stderr || ''}${r.error ? r.error.message : ''}`;
  log(out);
  return { ok: r.status === 0 && !r.error, code: r.status, out };
}

// ── The window's build (dist) ──
// A dist/ older than the checkout runs an old window against a newer main process: on 23 Oct the
// window had no quit dialog yet, so closing Frost AI did nothing. Each build records the commit it was
// built from (dist/build.json); a launch rebuilds when the window's files changed since.
const BUILD_STAMP = 'build.json';
const WINDOW_PATHS = app.windowPaths || ['src', 'shared', 'public', 'index.html', 'vite.config.ts', 'package-lock.json'];
const BUILD_ARGS = app.buildArgs || ['vite', 'build', '--outDir', DIST_NEXT, '--emptyOutDir']; // npx …, into <dist>.next

const gitTry = (dir, args) => {
  try {
    return execFileSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
};

/** Record the commit the window in outDir was built from. */
function stampBuild(dir, outDir, { git = gitTry } = {}) {
  const commit = git(dir, ['rev-parse', 'HEAD']) || '';
  try {
    fs.writeFileSync(path.join(outDir, BUILD_STAMP), JSON.stringify({ commit, at: Date.now() }, null, 2));
  } catch {
    /* the next launch rebuilds */
  }
}

/**
 * Whether dir/dist is older than the checkout's window files. Not a git checkout, or git missing: false
 * (nothing to compare). A build without a stamp (before this check) counts by time: older than the last
 * commit that changed the window's files.
 */
function distStale(dir, { git = gitTry } = {}) {
  const index = path.join(dir, DIST, 'index.html');
  if (!fs.existsSync(index)) return true;
  const last = git(dir, ['log', '-1', '--format=%H %ct', '--', ...WINDOW_PATHS]);
  if (!last) return false;
  const [commit, ct] = last.split(' ');
  const stamp = readJsonFile(path.join(dir, DIST, BUILD_STAMP));
  if (stamp && stamp.commit) {
    if (stamp.commit === commit) return false;
    // built from that commit or a later one
    return git(dir, ['merge-base', '--is-ancestor', commit, stamp.commit]) === null;
  }
  return fs.statSync(index).mtimeMs < Number(ct) * 1000;
}

/** buildWindow for launch time: builds into dist.next with a synchronous runner, then swaps it in. */
function buildWindowSync(dir, runner, { git = gitTry } = {}) {
  const r = runner('npx', BUILD_ARGS, { cwd: dir });
  if (!r.ok || !fs.existsSync(path.join(dir, DIST_NEXT, 'index.html'))) throw new Error(`The window didn't build (exit ${r.code}).`);
  stampBuild(dir, path.join(dir, DIST_NEXT), { git });
  const old = path.join(dir, DIST_OLD);
  const dist = path.join(dir, DIST);
  fs.rmSync(old, { recursive: true, force: true });
  if (fs.existsSync(dist)) fs.renameSync(dist, old);
  fs.renameSync(path.join(dir, DIST_NEXT), dist);
  fs.rmSync(old, { recursive: true, force: true });
}

/** Swap staged packages in. Only at launch, before anything is loaded from node_modules. */
function swapStaged(dir, { rename = fs.renameSync } = {}) {
  const ready = stagedInstall(dir);
  if (!ready) return { swapped: false };
  const stage = path.join(dir, STAGE);
  const nm = path.join(dir, 'node_modules');
  const old = path.join(dir, 'node_modules.old');
  // packages staged for an older package-lock.json (a later pull or a rollback changed it) don't fit
  if (ready.lock !== sha1(path.join(dir, 'package-lock.json'))) {
    fs.rmSync(stage, { recursive: true, force: true });
    return { swapped: false, stale: true, build: !!ready.build };
  }
  fs.rmSync(old, { recursive: true, force: true });
  let moved = false;
  try {
    if (fs.existsSync(nm)) {
      rename(nm, old);
      moved = true;
    }
    rename(path.join(stage, 'node_modules'), nm);
  } catch (err) {
    // something still holds the old folder: put it back and try at the next launch
    if (moved && !fs.existsSync(nm)) {
      try {
        rename(old, nm);
      } catch {
        /* the check below decides */
      }
    }
    return { swapped: false, error: err.message, build: !!ready.build };
  }
  fs.rmSync(stage, { recursive: true, force: true });
  try {
    fs.rmSync(old, { recursive: true, force: true });
  } catch {
    /* removed at the next swap */
  }
  return { swapped: true, build: !!ready.build };
}

/**
 * At launch, before the checkout is loaded: swap in staged packages (and build the window if that
 * update needed it), check the packages, and repair them ONCE with npm ci if they are incomplete or a
 * repair was asked for. Synchronous. Returns { ok, did: [...], missing, note }; with ok false the
 * launcher uses the installed copy, shows note, and never marks the commit good.
 * runner(cmd, args, { cwd, env }) → { ok, code, out } (injectable for tests).
 */
function prepareCheckout(dir, opts = {}) {
  const l = tryLock(dir);
  if (!l.ok) {
    // another program is updating this checkout: start with the packages as they are (never swap or repair now)
    const missing = (opts.check || modulesMissing)(dir);
    const note = lockedText(l.holder);
    return missing.length ? { ok: false, did: [], missing, note: `${note} Its packages aren't complete yet, so this launch used the installed copy.` } : { ok: true, did: [`left the packages as they are: ${note}`], missing: [] };
  }
  try {
    return prepareCheckoutLocked(dir, opts);
  } finally {
    l.release();
  }
}

function prepareCheckoutLocked(dir, { cfg = {}, runner = runSync, check = modulesMissing, rename, repair = true, stale = distStale } = {}) {
  const did = [];
  let build = false;
  const swap = swapStaged(dir, { rename });
  if (swap.swapped) did.push('swapped in the new packages');
  build = !!swap.build;
  // (staged packages that no longer fit, or couldn't be swapped in, leave node_modules as it was: the
  // check compares it with package-lock.json, so an out-of-date one is repaired below)
  let missing = check(dir);
  const asked = cfg.needsRepair || '';
  let repairNote = '';
  if (!repair && missing.length) repairNote = ' The automatic repair failed at the last start too.';
  else if (missing.length || asked) {
    // never npm ci into dir/node_modules, even here: another Frost AI (in the tray), its servers or a virus
    // scanner can hold files there, and npm ci empties the folder first. On 24 Oct that left node_modules
    // half deleted (ENOTEMPTY on highlight.js). Install beside it, check it, then swap it in.
    did.push('repaired the packages (npm ci beside the checkout, then swapped in)');
    const r = stageInstallSync(dir, runner);
    if (r.ok) {
      const s = swapStaged(dir, { rename });
      if (!s.swapped) repairNote = ` The repaired packages are ready in ${path.join(dir, STAGE)} but couldn't be swapped in (${s.error || 'they no longer fit'}): something still holds the old node_modules. They go in at the next start.`;
    } else repairNote = ` The automatic repair (npm ci into ${STAGE}) failed (exit ${r.code}): ${String(r.out || '').trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 300)} The packages that were there are untouched.`;
    build = build || (r.ok && !fs.existsSync(path.join(dir, DIST, 'index.html')));
    missing = check(dir);
  }
  if (missing.length) {
    return {
      ok: false,
      did,
      missing,
      note: `${APP}'s packages in ${path.join(dir, 'node_modules')} are incomplete (missing: ${missing.join(', ')}), so this launch used the installed copy.${repairNote} To repair it by hand, close ${APP} and run: ${repairCommand(dir)}`,
    };
  }
  // a window older than the checkout (an update that pulled but didn't build) is rebuilt here
  if (!build && stale(dir)) build = true;
  if (build) {
    try {
      buildWindowSync(dir, runner);
      did.push('built the window');
    } catch (err) {
      // the previous build is still in dist: the checkout can start, the next update rebuilds
      did.push(`window build failed: ${err.message}`);
    }
  }
  return { ok: true, did, missing: [] };
}


// ── One update at a time per checkout, across processes (1.2.0) ──
// The app itself and Frost Launcher both update the same checkout (each on launch and every hour). Two pulls, or
// a pull while a launch swaps packages in, would break it. A lock file in the checkout's .git folder (never seen
// by git status) holds the PID and who took it; a lock whose process is gone, or older than 30 minutes, is stale.
const LOCK_FILE = 'frost-updater.lock';
const LOCK_STALE_MS = 30 * 60_000;
class UpdateLocked extends Error {}
const lockPath = (dir) => path.join(dir, '.git', LOCK_FILE);
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // alive, someone else's
  }
}

/** Take the checkout's update lock now, or say who holds it: { ok, release() } | { ok: false, holder }. Never waits. */
function tryLock(dir, { by = APP, now = Date.now, alive = pidAlive } = {}) {
  const none = { ok: true, release: () => {} };
  if (!dir || !fs.existsSync(path.join(dir, '.git'))) return none; // nothing cloned yet: nobody else can be in it
  const f = lockPath(dir);
  const mine = JSON.stringify({ pid: process.pid, by, at: now() });
  for (let i = 0; i < 2; i++) {
    try {
      fs.writeFileSync(f, mine, { flag: 'wx' });
      return {
        ok: true,
        release: () => {
          try {
            if (fs.readFileSync(f, 'utf8') === mine) fs.unlinkSync(f);
          } catch {
            /* gone already */
          }
        },
      };
    } catch (err) {
      if (err.code !== 'EEXIST') return none; // .git not writable: no lock rather than no update
      let holder = null;
      try {
        holder = JSON.parse(fs.readFileSync(f, 'utf8'));
      } catch {
        holder = null;
      }
      if (holder && holder.pid && alive(holder.pid) && now() - (holder.at || 0) < LOCK_STALE_MS) return { ok: false, holder };
      try {
        fs.unlinkSync(f); // stale: its process is gone, or it is half an hour old
      } catch {
        /* someone else just did */
      }
    }
  }
  return { ok: false, holder: { by: 'another program' } };
}

const lockedText = (holder) => `${(holder && holder.by) || 'Another program'} is updating ${APP} right now. It is tried again later by itself.`;

/** Run fn holding the checkout's lock; UpdateLocked when another process holds it. */
async function withUpdateLock(dir, fn, by) {
  const l = tryLock(dir, by ? { by } : undefined);
  if (!l.ok) throw new UpdateLocked(lockedText(l.holder));
  try {
    return await fn();
  } finally {
    l.release();
  }
}

/** Which slow steps an update needs, from the files the pull changes. */
function planSteps(changed, { nodeModules = true, dist = true } = {}) {
  const files = (changed || []).map((f) => f.replace(/\\/g, '/'));
  const install = !nodeModules || files.some((f) => f === 'package-lock.json' || f === 'package.json');
  // the usual window files, and the app's own windowPaths (FrostFlow's window imports server/)
  const inWindow = (f) => f !== 'package-lock.json' && WINDOW_PATHS.some((w) => f === w || f.startsWith(`${w.replace(/\/+$/, '')}/`));
  const build = !dist || install || files.some((f) => /^(src|shared|public)\//.test(f) || ['index.html', 'vite.config.ts', 'vite.config.js', 'tsconfig.json'].includes(f) || inWindow(f));
  return { install, build };
}

/** Run a program in the checkout, streaming its output to log(text). Resolves its stdout. */
function run(cmd, args, { cwd, log = () => {}, env } = {}) {
  return new Promise((resolve, reject) => {
    const win = process.platform === 'win32';
    // npm and npx are .cmd files on Windows, which need a shell (the arguments are fixed, never user text)
    const shell = win && ['npm', 'npx'].includes(cmd);
    const opts = { cwd, env: { ...process.env, ...env }, windowsHide: true };
    const p = shell ? spawn(shellLine(cmd, args), { ...opts, shell }) : spawn(cmd, args, opts);
    let out = '';
    const take = (d) => {
      const s = d.toString('utf8');
      out += s;
      log(s);
    };
    p.stdout.on('data', take);
    p.stderr.on('data', (d) => log(d.toString('utf8')));
    p.on('error', (e) => reject(new Error(`${cmd}: ${e.message}`)));
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} ${args.join(' ')} failed (exit ${code})`))));
  });
}

/**
 * Build the window into dist.next, then swap it in. Vite empties its output folder first, so
 * building straight into dist left a moment with no dist/index.html: a launch then found the
 * checkout "not built" and turned Dev install off.
 */
async function buildWindow(dir, exec) {
  const next = path.join(dir, DIST_NEXT);
  const old = path.join(dir, DIST_OLD);
  const dist = path.join(dir, DIST);
  await exec('npx', BUILD_ARGS);
  if (!fs.existsSync(path.join(next, 'index.html'))) throw new Error(`The build made no ${DIST_NEXT}/index.html.`);
  stampBuild(dir, next);
  fs.rmSync(old, { recursive: true, force: true });
  if (fs.existsSync(dist)) fs.renameSync(dist, old);
  fs.renameSync(next, dist);
  fs.rmSync(old, { recursive: true, force: true });
}

const gitOut = (dir, args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true }).trim();

/**
 * The sign-in for the git commands that reach GitHub (clone, fetch, pull). The repository is private
 * and the updater runs with no window to type into, so git's own helper (Git Credential Manager) can't
 * ask. The owner's GitHub CLI login is used for that one command: a token from `gh auth token`, handed
 * to git through GIT_CONFIG_* environment entries (github.cjs gitEnv), with every other helper switched
 * off for it. His git config is not changed and the token is not stored or logged.
 * Returns { env, login } ('' login when gh isn't installed or signed in: git then runs with prompts off).
 */
const githubAuth = app.auth || ghauth.githubAuth;

/** A git command that reaches GitHub, with that sign-in; a plain message when it can't sign in. */
async function gitNetwork(exec, args, auth) {
  const a = await auth();
  try {
    return await exec('git', args, { env: a.env });
  } catch (err) {
    if (!a.login) throw new Error(`${err.message}. ${APP} couldn't sign in to GitHub for the update: the GitHub CLI isn't signed in on this PC. Run \`gh auth login\` once, then try again.`);
    throw new Error(`${err.message} (signed in to GitHub as ${a.login} through the GitHub CLI; check that account can read ${REPO_SLUG}).`);
  }
}

/** The commit a checkout is on: { commit, short, date, branch } (or null). */
function checkoutInfo(dir) {
  try {
    const [commit, date] = gitOut(dir, ['log', '-1', '--format=%H|%cI']).split('|');
    return { commit, short: commit.slice(0, 7), date, branch: gitOut(dir, ['rev-parse', '--abbrev-ref', 'HEAD']) };
  } catch {
    return null;
  }
}

class LocalChanges extends Error {}

/**
 * Pull the latest version into the checkout and rebuild what changed.
 * Returns { upToDate } or { from, to, install, build }. Never touches %APPDATA%.
 */
/** Pull and rebuild what changed, holding the checkout's lock (lockBy: who, for the other program's message). */
function update(opts = {}) {
  return withUpdateLock(opts.dir, () => updateLocked(opts), opts.lockBy);
}

async function updateLocked({ dir, log = () => {}, runImpl = run, cfg = readConfig(), auth = githubAuth }) {
  const exec = (cmd, args, extra = {}) => runImpl(cmd, args, { cwd: dir, log, ...extra });
  // changed tracked files would be overwritten or block the pull; untracked ones (builds, logs) don't
  const status = (await exec('git', ['status', '--porcelain', '--untracked-files=no'])).trim();
  if (status) throw new LocalChanges('Local changes are present in the checkout, so nothing was pulled. Commit or discard them first.');
  log('Checking for a new version…\n');
  await gitNetwork(exec, ['fetch', '--quiet'], auth);
  const from = (await exec('git', ['rev-parse', 'HEAD'])).trim();
  const to = (await exec('git', ['rev-parse', '@{u}'])).trim();
  if (from === to) return { upToDate: true, from };
  if (cfg.badCommit && cfg.badCommit === to) {
    log(`The newest version (${to.slice(0, 7)}) didn't start last time; staying on ${from.slice(0, 7)} until a newer one arrives.\n`);
    return { upToDate: true, from, skippedBad: to };
  }
  const changed = (await exec('git', ['diff', '--name-only', from, to])).split(/\r?\n/).filter(Boolean);
  await gitNetwork(exec, ['pull', '--ff-only', '--quiet'], auth);
  const lockNow = sha1(path.join(dir, 'package-lock.json'));
  const staged = stagedInstall(dir);
  const stagedFits = !!staged && staged.lock === lockNow;
  // complete packages, or complete ones already waiting in deps.next for this package-lock.json
  const modulesOk = stagedFits || !modulesMissing(dir).length;
  const steps = planSteps(changed, { nodeModules: modulesOk, dist: fs.existsSync(path.join(dir, DIST, 'index.html')) });
  if (stagedFits && changed.some((f) => /^package(-lock)?\.json$/.test(f.replace(/\\/g, '/')))) steps.install = false;
  // never npm ci into dir/node_modules here: this app may be running from it (Windows locks its files)
  if (steps.install) {
    log(`\nPackages changed: installing them beside the checkout (${STAGE}); they are swapped in at the next start…\n`);
    await stageInstall(dir, exec, { build: steps.build });
  }
  // the window needs the new packages to build: built at the next start, after the swap
  const buildAtLaunch = steps.build && (steps.install || stagedFits);
  if (buildAtLaunch) {
    markBuildAtLaunch(dir);
    log('\nThe window is built at the next start, with the new packages.\n');
  } else if (steps.build) {
    log('\nThe window changed: building it…\n');
    try {
      await buildWindow(dir, exec);
    } catch (err) {
      // the packages it builds with are incomplete: the next start repairs them and builds (prepareCheckout)
      if (!modulesMissing(dir).length) throw err;
      requestRepair('the window did not build: packages incomplete');
      throw new Error(`Packages are incomplete; they are repaired at the next start. Restart ${APP}.`);
    }
  }
  log(`\nUpdated ${from.slice(0, 7)} → ${to.slice(0, 7)} (${changed.length} file${changed.length === 1 ? '' : 's'}). Restart to use it.\n`);
  return { from, to, changed: changed.length, ...steps, staged: steps.install || stagedFits, buildAtLaunch };
}

/**
 * First time: clone the source (if the folder isn't a checkout yet), install and build it.
 * inUse: this app is running from dir, so its packages are staged and swapped in at the next start.
 */
/** Clone, install and build, holding the checkout's lock once it exists. */
async function setup(opts = {}) {
  const dir = opts.dir || DEFAULT_DIR;
  if (!fs.existsSync(path.join(dir, '.git'))) return setupLocked(opts); // the clone: nobody else is in it yet
  return withUpdateLock(dir, () => setupLocked(opts), opts.lockBy);
}

async function setupLocked({ dir = DEFAULT_DIR, repoUrl = REPO_URL, log = () => {}, runImpl = run, inUse = false, auth = githubAuth }) {
  if (!fs.existsSync(path.join(dir, '.git'))) {
    if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new Error(`${dir} isn't empty and isn't a git checkout. Pick an empty folder or an existing checkout.`);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    log(`Downloading the source into ${dir}…\n`);
    await gitNetwork((cmd, args, extra) => runImpl(cmd, args, { cwd: path.dirname(dir), log, ...extra }), ['clone', '--quiet', repoUrl, dir], auth);
  }
  const exec = (cmd, args, extra = {}) => runImpl(cmd, args, { cwd: dir, log, ...extra });
  if (inUse) {
    log(`\nInstalling packages beside the running copy (${STAGE}); they are swapped in at the next start…\n`);
    await stageInstall(dir, exec, { build: true });
    log('\nThe window is built at the next start, with the new packages. Restart to finish.\n');
    return checkoutInfo(dir);
  }
  log('\nInstalling packages (npm ci)…\n');
  await exec('npm', ['ci', '--no-audit', '--no-fund'], { env: { ELECTRON_SKIP_BINARY_DOWNLOAD: '1' } });
  const missing = modulesMissing(dir);
  if (missing.length) throw new Error(`npm ci didn't install everything (missing: ${missing.join(', ')}). Run it again: ${repairCommand(dir)}`);
  log('\nBuilding the window…\n');
  await buildWindow(dir, exec);
  log('\nReady. Turn on "Run from the source checkout" and restart.\n');
  return checkoutInfo(dir);
}

/**
 * The checkout's main.cjs calls this first, before anything loads from node_modules. A launcher from
 * before this check (an installed boot.cjs that doesn't run prepareCheckout itself) loads the checkout
 * straight away, so the checkout does it. Returns what to do:
 *   { go: true }                          carry on loading the checkout
 *   { go: false, relaunch: true }         the prep took long enough that the old launcher's 20-second
 *                                         timer would count it as a failed start: restart once instead
 *   { go: false, fallback, note }         the packages are still incomplete after one repair: load the
 *                                         installed copy (fallback = its main.cjs), never mark this commit good
 * Under a launcher that ran prepareCheckout already (run.prepared), it does nothing.
 */
function preflight(run, { dir, file = configFile(), prepare = prepareCheckout, mainFile = '', now = Date.now } = {}) {
  if (!run || run.from !== 'checkout' || run.prepared) return { go: true };
  const where = dir || run.dir;
  const commit = run.commit || '';
  const cfg = readConfig(file);
  // a repair that failed slowly last launch restarted the app (see below): this launch falls back at once
  const skipRepair = !!commit && cfg.repairFailed === commit;
  const prep = prepare(where, { cfg, repair: !skipRepair });
  const after = { ...readConfig(file), needsRepair: '', repairFailed: '' };
  const started = after.booting && after.booting.at ? after.booting.at : now();
  // the old launcher counts a start as failed after 20 seconds without a window
  const slow = prep.did.length > 0 && now() - started > READY_TIMEOUT_MS / 2;
  if (!prep.ok) {
    // the installed copy's main.cjs sits beside the launcher (only when that isn't this checkout's own)
    const fallback = mainFile && !inside(where, mainFile) && fs.existsSync(mainFile) ? mainFile : '';
    if (slow && fallback) {
      // restart once, unmarked (no rollback), and fall back at once then; the launch after tries a repair again
      writeConfig({ ...after, booting: null, lastError: prep.note, repairFailed: commit }, file);
      return { go: false, relaunch: true, note: prep.note, missing: prep.missing };
    }
    writeConfig({ ...after, lastError: prep.note }, file);
    return { go: false, fallback, note: prep.note, missing: prep.missing, lastGood: cfg.lastGood };
  }
  if (slow) {
    // clear the start mark, so the restart isn't taken for a failed start and rolled back
    writeConfig({ ...after, booting: null }, file);
    return { go: false, relaunch: true, did: prep.did };
  }
  if (cfg.needsRepair || cfg.repairFailed) writeConfig(after, file);
  return { go: true, did: prep.did };
}

/**
 * Look for a new version without changing anything: git fetch, then how far behind the checkout is (FrostFlow's
 * Settings → Updates "Check for updates"). { available, behind, from, to, skippedBad? }: a commit that didn't start
 * (badCommit) isn't "available".
 */
/** Look for a new version (fetch only), holding the checkout's lock: another program's update is answered as busy. */
async function checkForUpdate(opts = {}) {
  const l = tryLock(opts.dir, opts.lockBy ? { by: opts.lockBy } : undefined);
  if (!l.ok) return { available: false, behind: 0, from: '', to: '', busy: lockedText(l.holder) };
  try {
    return await checkForUpdateLocked(opts);
  } finally {
    l.release();
  }
}

async function checkForUpdateLocked({ dir, log = () => {}, runImpl = run, cfg = readConfig(), auth = githubAuth }) {
  const exec = (cmd, args, extra = {}) => runImpl(cmd, args, { cwd: dir, log, ...extra });
  await gitNetwork(exec, ['fetch', '--quiet'], auth);
  const from = String(await exec('git', ['rev-parse', 'HEAD'])).trim();
  const to = String(await exec('git', ['rev-parse', '@{u}'])).trim();
  const behind = from === to ? 0 : Number(String(await exec('git', ['rev-list', '--count', `${from}..${to}`])).trim()) || 0;
  if (behind && cfg.badCommit && cfg.badCommit === to) return { available: false, behind, from, to, skippedBad: to };
  return { available: behind > 0, behind, from, to };
}

/** What Settings → Updates shows after a check or an update (an app saves it as lastCheck in devinstall.json). */
function checkState(r, { at = new Date().toISOString(), error = '' } = {}) {
  if (error) return { at, state: 'error', error: String(error).slice(0, 300) };
  r = r || {};
  if (r.to && !r.upToDate && !('available' in r)) return { at, state: 'updated', from: r.from, to: r.to, behind: 0 };
  if (r.available) return { at, state: 'available', from: r.from, to: r.to, behind: r.behind };
  return { at, state: 'up-to-date', from: r.from, to: r.to || r.from, behind: 0 };
}

/**
 * Put the checkout back on the last good commit and rebuild what the bad one changed (a manual "Roll back", or an
 * older installed launcher's rollback call; the shared launcher resets by itself). Packages are installed beside
 * the checkout and swapped in, never into a node_modules something may hold. Returns the steps it needed.
 */
function rollBack(opts = {}) {
  const l = tryLock(opts.dir);
  if (!l.ok) throw new UpdateLocked(lockedText(l.holder));
  try {
    return rollBackLocked(opts);
  } finally {
    l.release();
  }
}

function rollBackLocked({ dir, bad, good, execImpl = execFileSync, runner = runSync }) {
  let changed;
  try {
    changed = String(execImpl('git', ['diff', '--name-only', good, bad], { cwd: dir, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })).split(/\r?\n/).filter(Boolean);
  } catch {
    changed = ['package-lock.json']; // unknown: reinstall and rebuild everything
  }
  execImpl('git', ['reset', '--hard', '--quiet', good], { cwd: dir, windowsHide: true });
  const steps = planSteps(changed);
  if (steps.install && stageInstallSync(dir, runner).ok) swapStaged(dir);
  if (steps.build) {
    try {
      buildWindowSync(dir, runner);
    } catch {
      /* a build that made nothing leaves the previous window in place */
    }
  }
  return steps;
}

/**
 * Dev install on by default (FrostBeat, FrostFlow's "Update automatically", FrostBook): an installed app sets its
 * checkout up by itself, then switches Dev install on (used from the next start). Pure.
 *   cfg      devinstall.json: auto (on unless false: switching Dev install off by hand saves auto: false),
 *            enabled, autoSetupAt (the last automatic setup; after a failure the next try is a day later)
 *   running  'checkout' | 'installed'; ready: the checkout can start; busy: an update job is running
 * → { action: 'setup' | 'enable' | 'none', reason }
 */
const AUTO_RETRY_MS = 24 * 60 * 60_000;
function autoDecision(cfg, { running = 'installed', ready = false, busy = false, now = Date.now() } = {}) {
  if (!cfg || cfg.auto === false) return { action: 'none', reason: 'off' };
  if (running === 'checkout') return { action: 'none', reason: 'running from the checkout already' };
  if (busy) return { action: 'none', reason: 'an update job is running' };
  if (!ready) {
    if (cfg.autoSetupAt && now - cfg.autoSetupAt < AUTO_RETRY_MS) return { action: 'none', reason: 'the last automatic setup was less than a day ago' };
    return { action: 'setup', reason: '' };
  }
  if (!cfg.enabled) return { action: 'enable', reason: '' };
  return { action: 'none', reason: 'ready; the next start runs it' };
}

return {
  APP,
  mainEntry: app.mainEntry || 'electron/main.cjs',
  githubAuth,
  REPO_URL, DEFAULT_DIR, LEGACY_DIR, defaultDir, READY_TIMEOUT_MS, readyTimeoutMs, startedOk, notStarted, RESTART_ARG, withoutRestartArg, waitForLock, rollbackNote, configFile, readConfig, writeConfig, checkoutReady, checkoutMissing, checkoutMissingAtLaunch, physicalDir, isOurClone, findContainedCheckout, adoptContained, decideBoot, configAfterBoot, planSteps, update, setup, checkoutInfo, run, buildWindow, LocalChanges,
  STAGE, RUNTIME_PATHS, modulesMissing, resolveFrom, repairCommand, requestRepair, stagedInstall, stageInstall, swapStaged, prepareCheckout, preflight, runSync, buildWindowSync,
  BUILD_STAMP, WINDOW_PATHS, stampBuild, distStale, staleBad,
  // 1.1.0
  DIST, RELEASES_URL, NO_PROMPT, gitNetwork, shellLine, checkForUpdate, checkState, rollBack, autoDecision, AUTO_RETRY_MS,
  // 1.2.0
  tryLock, withUpdateLock, UpdateLocked, LOCK_FILE, LOCK_STALE_MS,
};
}

module.exports = { createDevUpdate };
