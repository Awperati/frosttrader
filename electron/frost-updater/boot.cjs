// The launcher of the suite's shared updater: the installed app's exe starts here (its package.json "main"
// points at a two-line boot.cjs that calls launch). With Dev install on (Settings → Updates) it runs the app
// from its source checkout (updated with a git pull); otherwise, or if that can't start, the copy built into the
// app. See devupdate.cjs.
//   launch({ updater, bundledMain, runGlobal })
//     updater      the app's createDevUpdate(...) (null: just the built-in copy)
//     bundledMain  the built-in copy's main process file (absolute path)
//     runGlobal    the global the app's main process reads to know where it runs from (Frost AI: __frostmindRun)
//     dev          optional: true (or a function returning true) for a development run (`npm run desktop`, a dev
//                  server URL): the working tree's own main process starts, never the configured checkout
const { app } = require('electron');
const path = require('path');
const { execFileSync } = require('child_process');

function launch({ updater, bundledMain, runGlobal = '__frostUpdaterRun', dev = false }) {
  const du = (typeof dev === 'function' ? dev() : dev) ? null : updater;
  const RUN = runGlobal;
  function startBundled(note, retry) {
    // a fallback for this launch only: the window shows the note (and Retry when the checkout wasn't ready)
    global[RUN] = { from: 'installed', note: note || '', retry: !!retry };
    require(bundledMain);
  }

  function startCheckout(cfg, { othersRunning = false } = {}) {
    const dir = cfg.dir;
    let commit = '';
    try {
      commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8', windowsHide: true }).trim();
    } catch {
      /* git missing: still try to start, without rollback */
    }
    // mark this start; the window loading clears the mark and records the commit as good. Not while another copy
    // runs: this launch won't open a window (the lock), and that copy's own mark must stay its own.
    if (!othersRunning) du.writeConfig({ ...du.readConfig(), booting: commit ? { commit, at: Date.now() } : null });
    const started = () => {
      if (timer) clearTimeout(timer);
      const c = du.readConfig();
      // (a rollback notice in lastError stays until Settings → Updates is used, so the person sees it)
      du.writeConfig({ ...c, booting: null, lastGood: commit || c.lastGood });
    };
    const failed = (why) => {
      // leave the mark: the next start rolls back to the last good commit
      try {
        du.writeConfig({ ...du.readConfig(), lastError: String(why).slice(0, 500) });
      } catch {
        /* best effort */
      }
      app.relaunch();
      app.exit(1);
    };
    // longer after an update staged new packages (readyTimeoutMs): a slow first start isn't a failed one
    const waitMs = du.readyTimeoutMs ? du.readyTimeoutMs(dir) : du.READY_TIMEOUT_MS;
    // (a launch that leaves because another copy runs never times out: it has no mark to judge)
    const timer = othersRunning ? null : setTimeout(() => failed(`Commit ${commit.slice(0, 7)} didn't open its window within ${Math.round(waitMs / 1000)} seconds.`), waitMs);
    app.on('browser-window-created', (_e, win) => win.webContents.once('did-finish-load', started));
    global[RUN] = { from: 'checkout', dir, commit };
    try {
      require(path.join(dir, du.mainEntry || path.join('electron', 'main.cjs')));
    } catch (err) {
      failed(err && err.stack ? err.stack : err);
    }
  }

  let cfg = null;
  let decision = { load: 'bundled' };
  // is another copy of the app running? The single-instance lock says (the app's main asks again: same answer)
  let othersRunning = false;
  try {
    othersRunning = typeof app.requestSingleInstanceLock === 'function' && !app.requestSingleInstanceLock();
  } catch {
    othersRunning = false;
  }
  try {
    if (du) {
      cfg = du.readConfig();
      // asked a few times: a virus scanner's first look at node_modules or dist can fail a check for a moment
      let missing = cfg.enabled ? du.checkoutMissingAtLaunch(cfg.dir) : [];
      // set up or rebuilt from a program a packaged app started (a terminal in the Claude app, say):
      // Windows kept it in that app's private AppData, where only that app sees it at the usual path
      const adopted = missing.length ? du.adoptContained(cfg, du.findContainedCheckout(cfg.dir)) : null;
      if (adopted) {
        cfg = du.writeConfig(adopted);
        missing = [];
      }
      const ready = cfg.enabled && !missing.length;
      let head = '';
      if (ready) {
        try {
          head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: cfg.dir, encoding: 'utf8', windowsHide: true }).trim();
        } catch {
          /* git missing: no skip of a bad commit */
        }
      }
      decision = du.decideBoot(cfg, { ready, head, missing, othersRunning });
      if (decision.rollbackTo) execFileSync('git', ['reset', '--hard', '--quiet', decision.rollbackTo], { cwd: cfg.dir, windowsHide: true });
      // never turns Dev install off: a fallback to the installed copy is for this launch only
      const next = du.configAfterBoot(cfg, decision);
      if (next) cfg = du.writeConfig(next);
    }
  } catch (err) {
    decision = { load: 'bundled', retry: true, note: `The launcher hit an error (${err && err.message ? err.message : err}), so this launch used the installed copy.` };
  }

  if (decision.load === 'checkout' && cfg) startCheckout(cfg, { othersRunning });
  else startBundled(decision.note || '', decision.retry);
}

module.exports = { launch };
