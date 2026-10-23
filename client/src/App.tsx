import { useEffect, useState } from 'react';
import { ZOOM, clampZoom, loadZoom, saveZoom, stepZoom, zoomKey } from './zoom';
import { StockNumbers } from './pages/StockNumbers';
import { Settings } from './pages/Settings';

// The app's screens (docs/APP-DESIGN.md). Stage 0 builds only Stock numbers; the others are
// listed so the layout is settled, and say which stage brings them.
const SCREENS = [
  { id: 'numbers', label: 'Stock numbers', stage: 0 },
  { id: 'proposals', label: 'Proposals and log', stage: 0, later: 'Arrives with the shadow gate (stage 0, second part): what the local model proposed and what the gate decided.' },
  { id: 'portfolio', label: 'Paper portfolio', stage: 1, later: 'Arrives in stage 1 (paper trading).' },
  { id: 'risk', label: 'Risk and limits', stage: 1, later: 'Arrives in stage 1. Limits can be tightened at once; loosening waits for the next trading day.' },
  { id: 'settings', label: 'Settings', stage: 0 },
] as const;

type Id = (typeof SCREENS)[number]['id'];

const storage = () => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

/** The app's own zoom: header buttons, Ctrl+= / Ctrl+− / Ctrl+0 and Ctrl+wheel (zoom.ts). */
function useZoom() {
  const [zoom, setZoomState] = useState(() => loadZoom(storage()));
  const setZoom = (n: number) => setZoomState(clampZoom(n));
  useEffect(() => {
    saveZoom(storage(), zoom);
    document.documentElement.style.setProperty('--zoom', String(zoom / 100));
  }, [zoom]);
  useEffect(() => {
    // taken from the browser (preventDefault) so its own page zoom doesn't change as well
    const onKey = (e: KeyboardEvent) => {
      const k = zoomKey(e);
      if (k == null) return;
      e.preventDefault();
      setZoomState((z) => (k === 0 ? ZOOM.normal : stepZoom(z, k)));
    };
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey) || !e.deltaY) return;
      e.preventDefault();
      setZoomState((z) => stepZoom(z, e.deltaY < 0 ? 1 : -1));
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('wheel', onWheel);
    };
  }, []);
  return { zoom, setZoom };
}

export function App() {
  const [screen, setScreen] = useState<Id>('numbers');
  const { zoom, setZoom } = useZoom();
  const current = SCREENS.find((s) => s.id === screen)!;
  return (
    <div className={zoom >= 150 ? 'app big-zoom' : 'app'}>
      <header className="top">
        <div className="brand">
          <span className="flake" aria-hidden="true">
            ❄
          </span>
          Frost Trader <span className="stage">Stage 0 · read-only</span>
        </div>
        <nav aria-label="Screens">
          {SCREENS.map((s) => (
            <button key={s.id} className={s.id === screen ? 'on' : ''} onClick={() => setScreen(s.id)} aria-current={s.id === screen ? 'page' : undefined}>
              {s.label}
            </button>
          ))}
        </nav>
        <div className="zoom" role="group" aria-label="Zoom">
          <button onClick={() => setZoom(stepZoom(zoom, -1))} disabled={zoom <= ZOOM.min} title="Zoom out (Ctrl+−)" aria-label="Zoom out">
            −
          </button>
          <button onClick={() => setZoom(ZOOM.normal)} title="Back to 100% (Ctrl+0)" aria-label={`Zoom ${zoom}%, reset to 100%`}>
            {zoom}%
          </button>
          <button onClick={() => setZoom(stepZoom(zoom, 1))} disabled={zoom >= ZOOM.max} title="Zoom in (Ctrl+=)" aria-label="Zoom in">
            +
          </button>
        </div>
        <button className="kill" disabled title="Nothing is trading in stage 0, so there is nothing to stop. The kill switch is wired in with paper trading.">
          Kill switch
        </button>
      </header>
      <main>
        {screen === 'numbers' ? (
          <StockNumbers />
        ) : screen === 'settings' ? (
          <Settings />
        ) : (
          <div className="panel">
            <h2>{current.label}</h2>
            <p className="muted">{'later' in current ? current.later : ''}</p>
          </div>
        )}
      </main>
      <footer className="foot small muted">Paper only. Not financial advice. No orders are placed from this app in stage 0.</footer>
    </div>
  );
}
