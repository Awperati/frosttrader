// When the agents run on the Pi (runHere:false) and a Pi source is set, mirror the Pi's READ-ONLY
// data files onto this PC over tailscale ssh, so the PC app can show the real numbers with a
// "Running on the Pi" banner instead of an empty local view. PULL ONLY — this never writes to the Pi.
//
// The owner's secrets are never read or copied: we pull a fixed allowlist of data files (which does not
// include any key/token file), and also pass --exclude for alpaca-keys.json and finviz-token.json as a
// belt-and-braces guard. If the Pi is unreachable the caller shows a clear error and the last good
// mirror; it never silently falls back to empty numbers (that guard lives in app.mjs: a read is refused
// until at least one sync has succeeded).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

// The only files the read-only views need. No key/token file is in this list.
export const PULL = ['agents-host.json', 'agents-settings.json', 'allocations.json', 'fx.json', 'audit.jsonl', 'agents', 'journal'];
// Never copy these, even if they somehow sat under a pulled folder.
export const NEVER = ['alpaca-keys.json', 'finviz-token.json'];
const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

/**
 * The Pi source, or null when none is set. Precedence: env (FROSTTRADER_PI_SSH/DIR) wins, then the app's
 * own settings (settings.pi, written by Settings → Paper agents — the real source of truth), then the
 * legacy DATA_DIR/pi-source.json. An empty ssh target means "no Pi set".
 */
export function piSource({ env = process.env, dataDir, settings } = {}) {
  let j = null;
  try {
    j = JSON.parse(fs.readFileSync(path.join(dataDir, 'pi-source.json'), 'utf8'));
  } catch {
    /* none */
  }
  const sshTarget = String(env.FROSTTRADER_PI_SSH || settings?.pi?.sshTarget || j?.sshTarget || '').trim();
  const remoteDir = String(env.FROSTTRADER_PI_DIR || settings?.pi?.remoteDir || j?.remoteDir || 'frosttrader/data').trim();
  return sshTarget ? { sshTarget, remoteDir } : null;
}

/** The remote command: tar only the allowlisted paths that exist, excluding the secret files. */
export function remoteTarCmd(remoteDir) {
  const ex = NEVER.map((f) => `--exclude=${f}`).join(' ');
  // `ls -d ... 2>/dev/null` expands to only the entries that exist, so a missing file never fails tar.
  return `cd ${shq(remoteDir)} && tar czf - ${ex} $(ls -d ${PULL.join(' ')} 2>/dev/null)`;
}

/** Real pull: tailscale ssh streams a tarball of the allowlist; we extract it into `dir`. Async. */
function defaultPull({ source, dir, timeoutMs = 60_000 }) {
  return new Promise((resolve, reject) => {
    const tgz = path.join(dir, '_pull.tgz');
    const out = fs.createWriteStream(tgz);
    const ssh = spawn('tailscale', ['ssh', source.sshTarget, remoteTarCmd(source.remoteDir)], { windowsHide: true });
    let err = '';
    const timer = setTimeout(() => ssh.kill(), timeoutMs);
    ssh.stdout.pipe(out);
    ssh.stderr.on('data', (d) => (err += d));
    ssh.on('error', (e) => (clearTimeout(timer), reject(e)));
    ssh.on('close', (code) => {
      clearTimeout(timer);
      out.end(() => {
        if (code !== 0) return reject(new Error(`tailscale ssh exit ${code}: ${err.slice(0, 200)}`));
        // Extract with a relative archive name from cwd=dir: a Windows path like C:\... on tar's command
        // line is misread by GNU tar as a remote host:path (the drive-letter colon), so keep colons off it.
        const x = spawn('tar', ['-xzf', path.basename(tgz)], { cwd: dir, windowsHide: true });
        let xe = '';
        x.stderr.on('data', (d) => (xe += d));
        x.on('error', reject);
        x.on('close', (xc) => {
          try {
            fs.rmSync(tgz, { force: true });
          } catch {
            /* ignore */
          }
          xc === 0 ? resolve() : reject(new Error(`extract exit ${xc}: ${xe.slice(0, 200)}`));
        });
      });
    });
  });
}

/**
 * The mirror. `source` is from piSource() (or null). `pull` is injectable for tests. A failed sync keeps
 * the previous good data and records the error (reachable:false); it never clears the mirror.
 */
export function createPiMirror({ dataDir, source = null, now = Date.now, pull = defaultPull, log = console }) {
  const dir = path.join(dataDir, 'pi-mirror');
  let src = source;
  let state = { everSynced: false, syncedAt: null, error: null, reachable: null };
  let busy = null;
  const same = (a, b) => (a?.sshTarget || '') === (b?.sshTarget || '') && (a?.remoteDir || '') === (b?.remoteDir || '');
  return {
    get configured() {
      return !!src;
    },
    get source() {
      return src;
    },
    // Point the mirror at a (possibly new) Pi — the owner changed "Run agents on" in Settings. Changing the
    // target forgets the reachable/synced state so the banner never shows a stale "synced" for the old Pi.
    setSource(next) {
      const n = next && next.sshTarget ? { sshTarget: next.sshTarget, remoteDir: next.remoteDir } : null;
      if (!same(n, src)) state = { everSynced: false, syncedAt: null, error: null, reachable: null };
      src = n;
      return src;
    },
    dir,
    status() {
      return { ...state, source: src ? { sshTarget: src.sshTarget, remoteDir: src.remoteDir } : null };
    },
    sync() {
      if (!src) return Promise.resolve(state);
      if (busy) return busy; // one sync at a time
      busy = (async () => {
        fs.mkdirSync(dir, { recursive: true });
        try {
          await pull({ source: src, dir });
          state = { everSynced: true, syncedAt: now(), error: null, reachable: true };
        } catch (e) {
          state = { everSynced: state.everSynced, syncedAt: state.syncedAt, error: String(e?.message || e).slice(0, 300), reachable: false };
          log.warn?.(`pi-mirror: ${state.error}`);
        }
        return state;
      })().finally(() => (busy = null));
      return busy;
    },
  };
}
