// The boot smoke harness (the owner's rule, 24 Oct 2026): before an installer or an update prompt, start the REAL
// main process, hidden, with a throwaway data folder seeded like an older version left it (never his real data),
// and check the window loads with no uncaught exception. Each app's test seeds its own state and reads its own
// self-test line; this runs the process, keeps it from making a sound, and never leaves it running.
//
//   const r = await bootSmoke({ electron, cwd, env, marker: 'SELFTEST ', timeoutMs: 120_000 })
//   r.result  the JSON after the marker (the app's self-test line), or null
//   r.errors  lines that look like a crash: uncaught exceptions, ReferenceError/TypeError, a dead renderer
//   r.out     everything it printed (for a failure message)
import { spawn } from 'node:child_process';

const CRASH = /Uncaught|ReferenceError|TypeError: (?!Failed to fetch)|before initialization|render-process-gone|A JavaScript error occurred/;

export function bootSmoke({ electron, cwd, args = ['.'], env = {}, marker = 'SELFTEST ', timeoutMs = 120_000 }) {
  return new Promise((resolve, reject) => {
    const e = { ...process.env, ...env };
    delete e.ELECTRON_RUN_AS_NODE; // or Electron runs as plain Node
    const p = spawn(electron, [...args, '--mute-audio'], { cwd, env: e, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    const stop = setTimeout(() => p.kill(), timeoutMs); // never left running
    p.on('error', reject);
    p.on('exit', (code) => {
      clearTimeout(stop);
      const line = out.split(/\r?\n/).find((l) => l.startsWith(marker));
      let result = null;
      try {
        result = line ? JSON.parse(line.slice(marker.length)) : null;
      } catch {
        result = null;
      }
      const errors = out.split(/\r?\n/).filter((l) => CRASH.test(l));
      resolve({ code, result, errors, out });
    });
  });
}
