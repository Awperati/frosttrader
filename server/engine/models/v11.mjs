// The v11 model inside the app: the features of v11_features.py, computed the same way, and the
// LightGBM trees exported by scripts/export_v11.py (v11.json beside this file), evaluated here so no
// Python is needed at run time. test/v11-parity.test.mjs checks both against Python's own output.
//
// v11 (train_trading_model_v11.py, trained on Alpaca IEX bars): long only; at a bar's close, buy when
// the 3-model average probability that the trade wins is at least the threshold; exit on a close a
// set distance under the highest close since the buy (exit.stop × ATR(14) at the buy for kind "atr"),
// after exit.maxHold bars, or at the session close. The market features are averages over
// the model's 38 stocks at the same bar, so all 38 are needed to score any one of them.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const MODEL_FILE = path.join(here, 'v11.json');

let cached = null;
/** The exported model: { features, threshold, exit, universe, models: [{ trees }] }. */
export function loadModel(file = MODEL_FILE) {
  if (cached?.file === file) return cached.model;
  const model = JSON.parse(fs.readFileSync(file, 'utf8'));
  cached = { file, model };
  return model;
}

const nyParts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function nyOf(t) {
  const p = Object.fromEntries(nyParts.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, minute: Number(p.hour) * 60 + Number(p.minute) };
}

const NaN_ = Number.NaN;
const ok = (x) => Number.isFinite(x);

/** pandas rolling(n).mean(): NaN unless all n values in the window are numbers. */
function rollMean(x, n) {
  const out = new Array(x.length).fill(NaN_);
  for (let i = n - 1; i < x.length; i++) {
    let s = 0;
    let good = true;
    for (let k = i - n + 1; k <= i; k++) {
      if (!ok(x[k])) {
        good = false;
        break;
      }
      s += x[k];
    }
    if (good) out[i] = s / n;
  }
  return out;
}

/** pandas rolling(n).std() (ddof 1). */
function rollStd(x, n) {
  const out = new Array(x.length).fill(NaN_);
  for (let i = n - 1; i < x.length; i++) {
    let s = 0;
    let good = true;
    for (let k = i - n + 1; k <= i; k++) {
      if (!ok(x[k])) {
        good = false;
        break;
      }
      s += x[k];
    }
    if (!good) continue;
    const m = s / n;
    let q = 0;
    for (let k = i - n + 1; k <= i; k++) q += (x[k] - m) ** 2;
    out[i] = Math.sqrt(q / (n - 1));
  }
  return out;
}

const pct = (c, k) => c.map((v, i) => (i >= k ? v / c[i - k] - 1 : NaN_));

/**
 * Every per-stock feature for every bar of one stock's history (oldest first, regular session,
 * 5-minute bars { t, o, h, l, c, v }). Returns one object per bar.
 */
export function stockFeatures(bars) {
  const list = bars.filter((b) => b.v > 0 && b.h >= b.l && b.c > 0);
  const n = list.length;
  const c = list.map((b) => b.c);
  const h = list.map((b) => b.h);
  const l = list.map((b) => b.l);
  const o = list.map((b) => b.o);
  const v = list.map((b) => b.v);
  const ny = list.map((b) => nyOf(b.t));
  const day = ny.map((x) => x.day);
  const bar = ny.map((x) => Math.floor((x.minute - 570) / 5));

  const ret = pct(c, 1);
  const mom5 = pct(c, 5);
  const delta = c.map((x, i) => (i ? x - c[i - 1] : NaN_));
  const gain = rollMean(delta.map((d) => (d > 0 ? d : 0)), 14);
  const loss = rollMean(delta.map((d) => (d < 0 ? -d : 0)), 14);
  const ma5 = rollMean(c, 5);
  const ma20 = rollMean(c, 20);
  const ma50 = rollMean(c, 50);
  const vMa20 = rollMean(v, 20);
  const vStd20 = rollStd(v, 20);
  const vol20 = rollStd(ret, 20);
  const vol50 = rollStd(ret, 50);
  const tr = c.map((_, i) => (i ? Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])) : h[i] - l[i]));
  const atr = rollMean(tr, 14);
  const e20 = [];
  for (let i = 0; i < n; i++) e20.push(i ? (2 / 21) * c[i] + (1 - 2 / 21) * e20[i - 1] : c[i]);

  // per-day running values and the opening range
  const vwap = new Array(n);
  const sessHi = new Array(n);
  const orHi = {};
  const orLo = {};
  const firstOpen = {};
  const lastClose = {};
  const days = [];
  let pv = 0;
  let vv = 0;
  let hi = -Infinity;
  for (let i = 0; i < n; i++) {
    if (i === 0 || day[i] !== day[i - 1]) {
      pv = 0;
      vv = 0;
      hi = -Infinity;
      days.push(day[i]);
      firstOpen[day[i]] = o[i];
    }
    pv += ((h[i] + l[i] + c[i]) / 3) * v[i];
    vv += v[i];
    vwap[i] = pv / vv;
    hi = Math.max(hi, h[i]);
    sessHi[i] = hi;
    lastClose[day[i]] = c[i];
    if (bar[i] < 3) {
      orHi[day[i]] = Math.max(orHi[day[i]] ?? -Infinity, h[i]);
      orLo[day[i]] = Math.min(orLo[day[i]] ?? Infinity, l[i]);
    }
  }
  const dayNo = Object.fromEntries(days.map((d, k) => [d, k]));
  const closeBack = (d, back) => {
    const k = dayNo[d] - back;
    return k >= 0 ? lastClose[days[k]] : NaN_;
  };

  // relative volume: this bar's volume over the mean of up to the 10 previous same-time bars (min 3)
  const rvol = new Array(n).fill(NaN_);
  const seen = {};
  for (let i = 0; i < n; i++) {
    const prev = (seen[bar[i]] ||= []);
    const w = prev.slice(-10);
    if (w.length >= 3) rvol[i] = v[i] / (w.reduce((s, x) => s + x, 0) / w.length);
    prev.push(v[i]);
  }

  const out = [];
  for (let i = 0; i < n; i++) {
    const tod = (ny[i].minute + 240) / 60;
    const pdc = closeBack(day[i], 1);
    const a = atr[i];
    const oh = orHi[day[i]];
    const ol = orLo[day[i]];
    out.push({
      t: list[i].t,
      day: day[i],
      bar_of_day: bar[i],
      close: c[i],
      atr: a,
      return: ret[i],
      vol_change: v[i] / vMa20[i] - 1,
      high_low_range: (h[i] - l[i]) / c[i],
      close_position: (c[i] - l[i]) / (h[i] - l[i] + 1e-8),
      volatility_20: vol20[i],
      ma_dist: c[i] / ma20[i] - 1,
      rsi_14: 100 - 100 / (1 + gain[i] / (loss[i] + 1e-8)),
      momentum_5: mom5[i],
      momentum_10: i >= 10 ? c[i] / c[i - 10] - 1 : NaN_,
      vol_spike: v[i] / vStd20[i],
      gap: ret[i],
      time_of_day: tod,
      ma_dist_50: c[i] / ma50[i] - 1,
      momentum_20: i >= 20 ? c[i] / c[i - 20] - 1 : NaN_,
      volatility_50: vol50[i],
      ma_dist_5: c[i] / ma5[i] - 1,
      trend_up_50: c[i] > ma50[i] ? 1 : 0,
      tod_sin: Math.sin((2 * Math.PI * tod) / 24),
      tod_cos: Math.cos((2 * Math.PI * tod) / 24),
      atr_pct: a / c[i],
      vwap_dist: (c[i] - vwap[i]) / a,
      rvol_tod: rvol[i],
      ema20_slope: i >= 3 ? (e20[i] - e20[i - 3]) / a : NaN_,
      or_pos: bar[i] >= 3 && ok(oh) && ok(ol) ? (c[i] - ol) / (oh - ol + 1e-8) : NaN_,
      sess_hi_dist: (c[i] - sessHi[i]) / a,
      pdc_dist: (c[i] - pdc) / a,
      gap_day: firstOpen[day[i]] / pdc - 1,
      daily_trend: pdc / closeBack(day[i], 6) - 1,
      hourly_trend: i >= 12 ? c[i] / c[i - 12] - 1 : NaN_,
    });
  }
  return out;
}

const V8 = ['return', 'vol_change', 'high_low_range', 'close_position', 'volatility_20', 'ma_dist', 'rsi_14', 'momentum_5', 'momentum_10', 'vol_spike', 'gap', 'time_of_day', 'ma_dist_50', 'momentum_20', 'volatility_50', 'ma_dist_5', 'trend_up_50', 'tod_sin', 'tod_cos'];

const mean = (xs) => {
  const g = xs.filter(ok);
  return g.length ? g.reduce((s, x) => s + x, 0) / g.length : NaN_;
};

/**
 * Feature rows for every stock at time t (default: each stock's newest bar), with the market
 * features averaged over every stock that has a bar at t. { SYMBOL: row | null }.
 */
export function featuresAt(barsBySymbol, t = null) {
  const per = {};
  for (const [s, bars] of Object.entries(barsBySymbol)) {
    const rows = stockFeatures(bars || []);
    per[s] = t == null ? rows.at(-1) ?? null : rows.find((r) => r.t === t) ?? null;
  }
  const out = {};
  const byT = {};
  for (const r of Object.values(per)) if (r) (byT[r.t] ||= []).push(r);
  for (const [s, r] of Object.entries(per)) {
    if (!r) {
      out[s] = null;
      continue;
    }
    const peers = byT[r.t];
    const mktRet = mean(peers.map((p) => p.return));
    const mktMom = mean(peers.map((p) => p.hourly_trend));
    out[s] = { ...r, mkt_ret: mktRet, mkt_mom_12: mktMom, mkt_vwap: mean(peers.map((p) => p.vwap_dist)), rel_ret: r.return - mktRet, rel_mom_12: r.hourly_trend - mktMom };
  }
  return out;
}

/** As in training: the model only scores a bar whose v8 features and ATR are all numbers. */
export const tradable = (row) => !!row && ok(row.atr) && V8.every((k) => ok(row[k]));

/** One tree's raw output (LightGBM's numerical split rule, missing values included). */
function walkTree(tree, x) {
  let node = 0;
  for (;;) {
    const [f, threshold, defaultLeft, missing, left, right] = tree.nodes[node];
    let fv = x[f];
    if (Number.isNaN(fv) && missing !== 2) fv = 0; // NaN counts as 0 unless the split learned NaN
    let goLeft;
    if ((missing === 1 && Math.abs(fv) <= 1e-35) || (missing === 2 && Number.isNaN(fv))) goLeft = defaultLeft === 1;
    else goLeft = fv <= threshold;
    const next = goLeft ? left : right;
    if (next < 0) return tree.leaves[~next];
    node = next;
  }
}

/** The probability the trade wins: the mean of each model's sigmoid(sum of its trees). */
export function score(model, row) {
  const x = model.features.map((k) => (ok(row[k]) ? row[k] : NaN_));
  let p = 0;
  for (const m of model.models) {
    let raw = 0;
    for (const tree of m.trees) {
      if (tree.leaves.length === 1 && !tree.nodes.length) raw += tree.leaves[0];
      else raw += walkTree(tree, x);
    }
    p += 1 / (1 + Math.exp(-raw));
  }
  return p / model.models.length;
}
