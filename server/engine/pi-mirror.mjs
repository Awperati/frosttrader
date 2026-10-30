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

/** The Pi source, or null when none is set. Env wins, then DATA_DIR/pi-source.json. */
export function piSource({ env = process.env, dataDir }) {
  let j = null;
  try {
    j = JSON.parse(fs.readFileSync(path.join(dataDir, 'pi-source.json'), 'utf8'));
  } catch {
    /* none */
  }
  const sshTarget = String(env.FROSTTRADER_PI_SSH || j?.sshTarget || '').trim();
  const remoteDir = String(env.FROSTTRADER_PI_DIR || j?.remoteDir || 'frosttrader/data').trim();
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
        const x = spawn('tar', ['-xzf', tgz, '-C', dir], { windowsHide: true });
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
export function createPiMirror({ dataDir, source, now = Date.now, pull = defaultPull, log = console }) {
  const dir = path.join(dataDir, 'pi-mirror');
  let state = { everSynced: false, syncedAt: null, error: null, reachable: null };
  let busy = null;
  return {
    get configured() {
      return !!source;
    },
    dir,
    status() {
      return { ...state, source: source ? { sshTarget: source.sshTarget, remoteDir: source.remoteDir } : null };
    },
    sync() {
      if (!source) return Promise.resolve(state);
      if (busy) return busy; // one sync at a time
      busy = (async () => {
        fs.mkdirSync(dir, { recursive: true });
        try {
          await pull({ source, dir });
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
