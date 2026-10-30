import { useEffect, useState } from 'react';
import { ZOOM, clampZoom, loadZoom, saveZoom, stepZoom, zoomKey } from './zoom';
import { StockNumbers } from './pages/StockNumbers';
import { Settings } from './pages/Settings';
import { Portfolio } from './pages/Portfolio';
import { api, SIGN_IN_EVENT, type AuthStatus } from './api';
import { SignIn } from './pages/SignIn';
import { PiBanner } from './components/PiBanner';

// The app's screens (docs/APP-DESIGN.md). Built: Stock numbers, Paper portfolio and Settings; the
// others are listed so the layout is settled, and say which stage brings them.
const SCREENS = [
  { id: 'numbers', label: 'Stock numbers', stage: 0 },
  { id: 'proposals', label: 'Proposals and log', stage: 0, later: 'Arrives with the shadow gate (stage 0, second part): what the local model proposed and what the gate decided.' },
  { id: 'portfolio', label: 'Paper portfolio', stage: 1 },
  { id: 'risk', label: 'Risk and limits', stage: 1, later: 'The paper agents’ risk preset and halts are in Settings → Paper agents. Live limits arrive with the one-time live enablement, which is not built.' },
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

/** On the private website: is a sign-in needed? On this computer never. */
function useSignIn() {
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [needed, setNeeded] = useState(false);
  const check = () =>
    api.authStatus().then(
      (a) => (setAuth(a), setNeeded(a.remote && !a.signedIn)),
      () => setNeeded(false),
    );
  useEffect(() => {
    void check();
    const on = () => setNeeded(true);
    window.addEventListener(SIGN_IN_EVENT, on);
    return () => window.removeEventListener(SIGN_IN_EVENT, on);
  }, []);
  return { auth, needed, done: () => void check() };
}

/** Paper or LIVE, always on screen: LIVE when the owner's live switch-on is valid. */
function useLiveBadge() {
  const [live, setLive] = useState<{ on: boolean; stopped: boolean }>({ on: false, stopped: false });
  useEffect(() => {
    const read = () => api.live().then((s) => setLive({ on: s.enabled, stopped: !!s.stopped }), () => {});
    void read();
    const t = window.setInterval(read, 30_000);
    return () => window.clearInterval(t);
  }, []);
  return live;
}

export function App() {
  const signIn = useSignIn();
  if (signIn.needed) return <SignIn onDone={signIn.done} />;
  return <Main remote={!!signIn.auth?.remote} />;
}

function Main({ remote }: { remote: boolean }) {
  const [screen, setScreen] = useState<Id>('numbers');
  const { zoom, setZoom } = useZoom();
  const live = useLiveBadge();
  async function kill() {
    const what = live.on ? 'sell every paper AND LIVE position (real money)' : 'sell every paper position';
    if (!window.confirm(`Kill switch: ${what} and stop all agents until you resume?`)) return;
    try {
      await api.kill('Kill switch pressed');
      setScreen('portfolio');
    } catch (e) {
      window.alert(`Kill switch failed: ${(e as Error).message}`);
    }
  }
  const current = SCREENS.find((s) => s.id === screen)!;
  return (
    <div className={zoom >= 150 ? 'app big-zoom' : 'app'}>
      <header className="top">
        <div className="brand">
          <span className="flake" aria-hidden="true">
            ❄
          </span>
          Frost Trader{' '}
          {live.on ? (
            <span className={live.stopped ? 'stage live stopped' : 'stage live'} title="Live trading is switched on (Settings → Live trading)">
              {live.stopped ? 'LIVE · stopped' : 'LIVE · real money'}
            </span>
          ) : (
            <span className="stage">PAPER · no real money</span>
          )}
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
        <button className="kill" onClick={kill} title="Sell everything and stop every agent until you resume (Paper portfolio)">
          Kill switch
        </button>
        {remote ? (
          <button className="signout" onClick={() => api.signOut().then(() => window.location.reload())}>
            Sign out
          </button>
        ) : null}
      </header>
      <PiBanner />
      <main>
        {screen === 'numbers' ? (
          <StockNumbers />
        ) : screen === 'settings' ? (
          <Settings />
        ) : screen === 'portfolio' ? (
          <Portfolio />
        ) : (
          <div className="panel">
            <h2>{current.label}</h2>
            <p className="muted">{'later' in current ? current.later : ''}</p>
          </div>
        )}
      </main>
      <footer className="foot small muted">{live.on ? 'LIVE trading is on for the agents you chose: real money, inside your limits.' : 'Paper only: no real money.'} Not financial advice.</footer>
    </div>
  );
}
