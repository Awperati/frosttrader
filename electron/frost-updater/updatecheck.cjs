// "Check every: 1 hour" (Settings → Updates): while Frost AI runs from the source checkout, look for a new
// version every hour as well as at launch. Each tick runs the same job as the launch check (updates.job
// 'update': pull, stage packages, build into dist.next) and, when there is a new version, shows the usual
// "update ready, restart" notice. It never restarts or swaps by itself.
//
// A tick is skipped while an update job is running, while the app is quitting, or when there is no
// network; a failed job's error is recorded by the job itself (once, main.cjs updates.job).
const dns = require('dns');

const DEFAULT_MIN = 60;

/** Minutes between checks from the dev install config: checkEveryMin, 60 by default, 0 = off. */
function intervalMin(cfg) {
  const v = cfg && cfg.checkEveryMin;
  if (v === 0 || v === '0') return 0;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.max(5, Math.round(n)) : DEFAULT_MIN;
}

/** Is there a network that reaches GitHub? A DNS lookup, no connection made. */
function online({ lookup = dns.promises.lookup, host = 'github.com', timeoutMs = 5000 } = {}) {
  return Promise.race([
    lookup(host).then(() => true, () => false),
    new Promise((resolve) => setTimeout(resolve, timeoutMs, false).unref?.()),
  ]);
}

class UpdateCheck {
  /**
   * readConfig  () => the dev install config (checkEveryMin)
   * busy        () => an update job is running
   * quitting    () => the app is closing
   * run         () => Promise of updates.job('update') → { to } when a new version is staged
   * ready       (to) => show the "update ready, restart" notice
   * isOnline    () => Promise<boolean>
   */
  constructor({ readConfig, busy = () => false, quitting = () => false, run, ready = () => {}, isOnline = online, timers = { setInterval, clearInterval } } = {}) {
    Object.assign(this, { readConfig, busy, quitting, run, ready, isOnline, timers });
    this.timer = null;
    this.every = 0;
  }

  /** Start (or restart) the hourly timer from the current setting; off stops it. */
  start() {
    this.stop();
    let cfg = {};
    try {
      cfg = this.readConfig() || {};
    } catch {
      cfg = {};
    }
    this.every = intervalMin(cfg);
    if (!this.every) return false;
    this.timer = this.timers.setInterval(() => void this.tick(), this.every * 60_000);
    if (this.timer && this.timer.unref) this.timer.unref();
    return true;
  }

  stop() {
    if (this.timer) this.timers.clearInterval(this.timer);
    this.timer = null;
  }

  /** One check. Resolves what happened: 'ran' | 'ready' | 'busy' | 'quitting' | 'offline' | 'off' | 'failed'. */
  async tick() {
    if (this.quitting()) return 'quitting';
    let cfg = {};
    try {
      cfg = this.readConfig() || {};
    } catch {
      /* the defaults */
    }
    if (!intervalMin(cfg)) return 'off';
    if (this.busy() || this.running) return 'busy';
    this.running = true;
    try {
      if (!(await this.isOnline())) return 'offline';
      if (this.quitting()) return 'quitting';
      const r = await this.run();
      if (r && r.to) {
        this.ready(r.to);
        return 'ready';
      }
      return 'ran';
    } catch {
      return 'failed'; // the job wrote lastError (once) and logged it
    } finally {
      this.running = false;
    }
  }
}

module.exports = { UpdateCheck, intervalMin, online, DEFAULT_MIN };
