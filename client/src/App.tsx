import { useState } from 'react';
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

export function App() {
  const [screen, setScreen] = useState<Id>('numbers');
  const current = SCREENS.find((s) => s.id === screen)!;
  return (
    <div className="app">
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
