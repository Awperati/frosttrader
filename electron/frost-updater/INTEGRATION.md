# Adopting frost-updater in an app (FrostFlow, FrostNotes, FrostBook, FrostBeat)

The reference integration is Frost AI (Awperati/frostmind). Read its files named below before you start.

## 1. Vendor the package

Copy `electron/frost-updater/` from frostmind main **unchanged** into your app (Electron apps: `electron/frost-updater/`;
FrostBeat uses `desktop/frost-updater/`). Don't edit it: `MANIFEST.json` must match. Add the vendored test:

```js
// test/frost-updater-vendored.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
const { check } = await import('../electron/frost-updater/manifest.mjs');
test('the vendored frost-updater matches its MANIFEST', () => assert.deepEqual(check(), []));
```

A fix the package needs goes to frostmind's copy (or the canonical repo, once it exists), then gets re-copied everywhere.

## 2. The app's config: `electron/frost-updater.config.cjs`

See frostmind's `electron/frost-updater.config.cjs`. Keys: `appName`, `repoUrl`, `defaultDir` (outside AppData,
e.g. `~/FrostFlow/src`), `legacyDir` (an older default if your app had one, else ''), `home()` (the folder that holds
`devinstall.json`: your app's data folder; keep the existing one, never rename it), `mainEntry`, `restartArg`
(`--<app>-restart`), `runtimePaths` (deep paths your main process loads from node_modules beyond package.json's
dependencies, e.g. a native module), optional `windowPaths`, `buildArgs`, `auth`.

Then `electron/lib/devupdate.cjs` (or wherever your app keeps it):
`module.exports = require('../frost-updater/devupdate.cjs').createDevUpdate(require('../frost-updater.config.cjs'));`

FrostFlow already has an older copy (electron/lib/devupdate.cjs, electron/boot.cjs, updatecheck.cjs): replace them with
the shim above and keep every export your code uses (the shared one is a superset of Frost AI's; compare yours).

## 3. The launcher

`package.json` "main" → `electron/boot.cjs`:

```js
const path = require('path');
let updater = null;
try { updater = require('./lib/devupdate.cjs'); } catch { /* just the built-in copy */ }
require('./frost-updater/boot.cjs').launch({ updater, bundledMain: path.join(__dirname, 'main.cjs'), runGlobal: '__<app>Run' });
```

## 4. The main process (copy frostmind's `electron/main.cjs`, first block and the start-up block)

1. First thing, before anything loads from node_modules: the **single-instance lock** (without it: `notStarted(run)`,
   and if `process.argv` has `RESTART_ARG`, `waitForLock(app, { ms: 15_000 })` then relaunch without the flag; else quit),
   then `preflight(run, { mainFile })` and its `relaunch` / `fallback` handling (incl. patching an old installed copy's
   `update`). `run` = `global.__<app>Run`.
2. When the window first loads: `startedOk(run)`.
3. "Restart now": `app.relaunch({ args: [...withoutRestartArg(process.argv.slice(1)), RESTART_ARG] })`.
4. Settings → Updates (IPC/RPC): status (`readConfig`, `checkoutInfo`, `rollbackNote`), configure (`writeConfig` with
   `physicalDir`), jobs `setup` / `update` (never both at once), and `UpdateCheck` hourly while running from the checkout.
5. List your main process's methods (Frost AI: rpc `app.rpcs`) and use `web/caps.ts` so a window newer than its main
   process hides what's missing and shows "Restart to finish updating".

## 5. Tests and the boot smoke (the owner's rule)

- Your existing tests pass unchanged; add the vendored test; adapt any test that read the old files' source.
- A **boot smoke** test with `smoke.mjs` `bootSmoke({ electron, cwd, env })`: the real main process, hidden, a temp
  data folder seeded like an older version left it (old settings, saved state your startup code touches), and it must
  print its self-test line with no crash. Frost AI's `test/boot-smoke.test.mjs` and FrostBeat's are examples.
- Green-only: full suite + typecheck + build with fail 0 on the exact rebased commit; 3 suites at once to catch load flakes.

## 6. The switch-over installer

The launcher lives in the installed app, so each app needs ONE new installer for the shared launcher to take over.
Before tagging: the boot smoke on the exact commit. Tag only with the owner's OK (the rebrand OK covers it: confirm with
Top Dog). Report: branch, tip, test counts, and what the owner must do (install once; Settings → Updates → Dev install).

## 7. New in 1.1.0

- `autoDecision(cfg, { running, ready, busy, now })` → `{ action: 'setup' | 'enable' | 'none', reason }`: Dev install on
  by default. An installed (not portable, not dev) app runs it about a minute after start: `setup` → run the setup job in
  the background and record `autoSetupAt` first (a failed setup waits `AUTO_RETRY_MS`, a day); after it succeeds and
  `checkoutReady`, write `enabled: true, auto: true`; `enable` → write that at once. No restart notice: the next start
  runs the checkout. Switching Dev install off in Settings saves `auto: false`, and it stays off. A failure's note is
  the job's `lastError`, shown in Settings → Updates only. (FrostBeat's desktop/main.cjs autoDevInstall is an example.)
- `checkForUpdate({ dir, cfg })` → `{ available, behind, from, to, skippedBad? }` (fetch only) and `checkState(result,
  { error })` for a "Check for updates" button; `rollBack({ dir, bad, good })` for a manual roll back.
- `RELEASES_URL` (config `releasesUrl`), `NO_PROMPT`, `gitNetwork` exported.
- Config `distDir` when the window isn't built into `<repo>/dist`; config `configDefaults` for app defaults.
- `planSteps` also rebuilds the window for a change under the app's `windowPaths`.
- `launch({ ..., dev })`: `dev` true (or a function) skips the checkout, for `npm run desktop` or a dev server URL.
- npm/npx run through the shell as one quoted line: no DEP0190 warning on Node 24.

The canonical copy is the private repository Awperati/frost-updater: change it there, then re-copy it into each app
unchanged (the MANIFEST test checks the copy).
