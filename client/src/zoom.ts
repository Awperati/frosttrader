// The app's own zoom (header − / 100% / +, Ctrl+= / Ctrl+− / Ctrl+0, Ctrl+wheel). It scales the app
// with CSS `zoom` on .app (Firefox 126+, Chrome, Edge) and leaves the browser's own page zoom alone: the
// keys and Ctrl+wheel are taken by the app (preventDefault), so the two never both change at once.
// Saved per device in localStorage. No imports, so tests run it directly (test/zoom.test.mjs).

export const ZOOM = { min: 50, max: 200, step: 10, normal: 100 } as const;
export const ZOOM_KEY = 'frosttrader.zoom';

/** A zoom percentage on the 10% grid, inside 50–200. Anything unreadable is 100. */
export function clampZoom(n: unknown): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return ZOOM.normal;
  const snapped = Math.round(v / ZOOM.step) * ZOOM.step;
  return Math.min(ZOOM.max, Math.max(ZOOM.min, snapped));
}

/** One step in or out (dir = 1 or -1). */
export const stepZoom = (cur: number, dir: 1 | -1) => clampZoom(clampZoom(cur) + dir * ZOOM.step);

type Store = Pick<Storage, 'getItem' | 'setItem'> | null | undefined;

/** The saved zoom, or 100 when there is none or storage is blocked (private window, previews). */
export function loadZoom(store: Store): number {
  try {
    const raw = store?.getItem(ZOOM_KEY);
    return raw == null ? ZOOM.normal : clampZoom(raw);
  } catch {
    return ZOOM.normal;
  }
}

/** Save it; a blocked storage is ignored (the zoom still applies for this visit). */
export function saveZoom(store: Store, n: number): void {
  try {
    store?.setItem(ZOOM_KEY, String(clampZoom(n)));
  } catch {
    /* storage blocked */
  }
}

/** What a key press means for the zoom: 1 in, -1 out, 0 back to 100%, null not a zoom key. */
export function zoomKey(e: { ctrlKey: boolean; metaKey: boolean; altKey: boolean; key: string }): 1 | -1 | 0 | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  if (e.key === '=' || e.key === '+') return 1;
  if (e.key === '-' || e.key === '_') return -1;
  if (e.key === '0') return 0;
  return null;
}
