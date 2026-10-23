// Zoom on the price chart's time axis (components/PriceChart.tsx): a window [a, b] of bar indexes,
// both ends included. Wheel zooms around the bar under the pointer; a drag selects a range. No imports,
// so tests run it directly (test/zoom.test.mjs).

export type Win = { a: number; b: number };
/** The fewest bars a zoomed chart shows. */
export const MIN_BARS = 10;

export const fullWindow = (n: number): Win => ({ a: 0, b: Math.max(0, n - 1) });
export const isFull = (w: Win, n: number) => w.a <= 0 && w.b >= n - 1;

/** A window of `len` bars kept inside 0..n-1, at least MIN_BARS (or all of them). */
function fit(a: number, len: number, n: number): Win {
  const size = Math.min(n, Math.max(Math.min(MIN_BARS, n), Math.round(len)));
  const start = Math.min(Math.max(0, Math.round(a)), n - size);
  return { a: start, b: start + size - 1 };
}

/**
 * Zoom around bar `at`: factor < 1 zooms in (fewer bars), > 1 zooms out. The bar under the pointer
 * stays where it is on screen.
 */
export function zoomAt(w: Win, n: number, at: number, factor: number): Win {
  if (n <= 1) return fullWindow(n);
  const len = w.b - w.a + 1;
  const next = len * factor;
  const share = len > 1 ? (at - w.a) / (len - 1) : 0.5;
  return fit(at - share * (next - 1), next, n);
}

/** The window a drag from bar i to bar j selects (either direction), or null for a tiny drag. */
export function selectRange(i: number, j: number, n: number): Win | null {
  const a = Math.max(0, Math.min(i, j));
  const b = Math.min(n - 1, Math.max(i, j));
  if (b - a + 1 < 3) return null;
  return fit(a, b - a + 1, n);
}
