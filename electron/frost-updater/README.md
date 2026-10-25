# frost-updater (vendored)

The Frost suite's shared "Dev install" updater: an app runs from a git checkout of its own source and updates
with a pull; the installed exe stays as the launcher. Canonical copy: **Awperati/frost-updater**. This folder is a
vendored copy (VERSION, MANIFEST.json); don't edit it here, change it there and sync it in (`node sync.mjs <app>`
in that repo). A test in each app checks the copy matches its MANIFEST.

| File | What it does |
|---|---|
| `devupdate.cjs` | `createDevUpdate(config)`: devinstall.json, launch decisions (booting marks, rollback to lastGood, bad commits), the checkout update (fetch, pull, packages staged in `deps.next` and swapped in at the next start, never `npm ci` in the live folder, the window built into `dist.next`), the launch-time check and repair, the start marks (`startedOk`, `notStarted`, the restart lock), adaptive ready timeout, rollback note |
| `boot.cjs` | `launch({ updater, bundledMain, runGlobal })`: the launcher the installed exe runs |
| `updatecheck.cjs` | the hourly and at-launch check (`UpdateCheck`) |
| `ghauth.cjs` | git's sign-in to GitHub through the GitHub CLI, for one command, nothing stored |
| `web/caps.ts` | the window's "the main process is older: restart" check (`capsLoader`, `hasRpc`) |
| `smoke.mjs` | the boot smoke harness: the real main process on a seeded temp data folder |

Each app supplies `electron/frost-updater.config.cjs`:

```js
module.exports = {
  appName: 'FrostFlow',                                   // in messages
  repoUrl: 'https://github.com/Awperati/Jobflow.git',
  defaultDir: path.join(os.homedir(), 'FrostFlow', 'src'), // outside AppData (see devupdate.cjs)
  legacyDir: '',                                           // an older default, used if a checkout is there
  home: () => dataDir,                                     // devinstall.json lives here
  mainEntry: 'electron/main.cjs',
  restartArg: '--frostflow-restart',
  runtimePaths: [],                                        // deep paths loaded from node_modules, beyond package.json
  // optional: windowPaths, buildArgs (npx …, into dist.next), auth (async () => ({ env, login }))
  // 1.1.0, optional: distDir ('dist'; the window's folder in the checkout), releasesUrl (default the repo's latest
  // release), configDefaults (under devinstall.json's saved values, e.g. { auto: true, checkEveryMin: 60 })
};
```

and wires: `package.json` "main" → `electron/boot.cjs` (calls `launch`), the main process's first lines run
`preflight` and take the single-instance lock before touching packages, its window load calls `startedOk`, a
second launch calls `notStarted`, "Restart" relaunches with `RESTART_ARG`, and Settings → Updates calls `update` /
`setup` / `readConfig` / `writeConfig`. Frost AI (Awperati/frostmind) is the reference integration.
