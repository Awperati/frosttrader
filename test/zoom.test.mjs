// Tests for the app zoom (client/src/zoom.ts) and the chart's time-axis zoom (client/src/chartzoom.ts).
// Both are TypeScript without imports: Node 22.18+ runs them as they are.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ZOOM, ZOOM_KEY, clampZoom, stepZoom, loadZoom, saveZoom, zoomKey } from '../client/src/zoom.ts';
import { MIN_BARS, fullWindow, isFull, selectRange, zoomAt } from '../client/src/chartzoom.ts';

const memory = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => void m.set(k, String(v)), m };
};

test('zoom limits: 50–200 % in 10 % steps; anything odd is 100 %', () => {
  assert.deepEqual([ZOOM.min, ZOOM.max, ZOOM.step, ZOOM.normal], [50, 200, 10, 100]);
  assert.equal(clampZoom(30), 50);
  assert.equal(clampZoom(500), 200);
  assert.equal(clampZoom(114), 110);
  assert.equal(clampZoom('130'), 130);
  for (const bad of ['abc', NaN, undefined, Infinity, -Infinity]) assert.equal(clampZoom(bad), 100);
  assert.equal(stepZoom(100, 1), 110);
  assert.equal(stepZoom(100, -1), 90);
  assert.equal(stepZoom(200, 1), 200);
  assert.equal(stepZoom(50, -1), 50);
  let z = 100;
  for (let i = 0; i < 30; i++) z = stepZoom(z, 1);
  assert.equal(z, 200);
});

test('the zoom is saved per device and restored; blocked storage falls back to 100 %', () => {
  const s = memory();
  assert.equal(loadZoom(s), 100, 'nothing saved yet');
  saveZoom(s, 140);
  assert.equal(s.m.get(ZOOM_KEY), '140');
  assert.equal(loadZoom(s), 140);
  saveZoom(s, 999);
  assert.equal(loadZoom(s), 200, 'saved clamped');
  s.m.set(ZOOM_KEY, 'garbage');
  assert.equal(loadZoom(s), 100);
  const blocked = { getItem: () => { throw new Error('SecurityError'); }, setItem: () => { throw new Error('QuotaExceeded'); } };
  assert.equal(loadZoom(blocked), 100);
  assert.doesNotThrow(() => saveZoom(blocked, 120));
  assert.equal(loadZoom(null), 100);
});

test('zoom keys: Ctrl+= / Ctrl++ in, Ctrl+- out, Ctrl+0 reset; nothing without Ctrl', () => {
  const k = (key, o = {}) => zoomKey({ ctrlKey: true, metaKey: false, altKey: false, key, ...o });
  assert.equal(k('='), 1);
  assert.equal(k('+'), 1);
  assert.equal(k('-'), -1);
  assert.equal(k('0'), 0);
  assert.equal(k('a'), null);
  assert.equal(k('=', { ctrlKey: false }), null);
  assert.equal(k('=', { ctrlKey: false, metaKey: true }), 1, 'Cmd on a Mac');
  assert.equal(k('0', { altKey: true }), null);
});

test('chart zoom: the wheel zooms around the pointer and stays inside the bars', () => {
  const n = 260;
  const full = fullWindow(n);
  assert.deepEqual(full, { a: 0, b: 259 });
  assert.equal(isFull(full, n), true);
  const w = zoomAt(full, n, 130, 0.8);
  assert.equal(w.b - w.a + 1, 208);
  assert.ok(w.a <= 130 && w.b >= 130, 'the bar under the pointer stays in view');
  assert.equal(isFull(w, n), false);
  // zooming in a lot stops at MIN_BARS; zooming out a lot is the whole chart again
  let z = full;
  for (let i = 0; i < 50; i++) z = zoomAt(z, n, 10, 0.5);
  assert.equal(z.b - z.a + 1, MIN_BARS);
  assert.ok(z.a >= 0 && z.a <= 10 && z.b >= 10);
  for (let i = 0; i < 50; i++) z = zoomAt(z, n, 10, 1.25);
  assert.deepEqual(z, full);
  // at the edges the window is pushed back inside
  const edge = zoomAt({ a: 200, b: 259 }, n, 259, 0.5);
  assert.equal(edge.b, 259);
  assert.ok(edge.a >= 0);
  assert.deepEqual(zoomAt(fullWindow(1), 1, 0, 0.5), { a: 0, b: 0 });
  assert.deepEqual(zoomAt(fullWindow(5), 5, 2, 0.5), { a: 0, b: 4 }, 'fewer bars than MIN_BARS: all of them');
});

test('chart zoom: a drag selects a range in either direction; a click is not a zoom', () => {
  assert.deepEqual(selectRange(40, 80, 260), { a: 40, b: 80 });
  assert.deepEqual(selectRange(80, 40, 260), { a: 40, b: 80 });
  assert.equal(selectRange(40, 41, 260), null);
  assert.deepEqual(selectRange(100, 103, 260), { a: 100, b: 109 }, 'at least MIN_BARS');
  assert.deepEqual(selectRange(255, 258, 260), { a: 250, b: 259 }, 'pushed back inside at the end');
  assert.deepEqual(selectRange(-5, 400, 260), { a: 0, b: 259 });
});
