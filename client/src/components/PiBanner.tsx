import { useEffect, useState } from 'react';
import { api, type PiStatus } from '../api';

// When the agents run on the Pi, this PC is a read-only viewer: the numbers come mirrored from the Pi.
// This banner shows that, with the last sync time — or a clear error if the Pi can't be reached (it
// never silently implies the local, empty numbers). It refreshes the mirror on load and every minute.
export function PiBanner() {
  const [st, setSt] = useState<PiStatus | null>(null);
  useEffect(() => {
    let live = true;
    const tick = async () => {
      try {
        const s = await api.piSync(); // pull fresh from the Pi, then return the resulting status
        if (live) setSt(s);
      } catch {
        try {
          if (live) setSt(await api.pi());
        } catch {
          /* server not answering */
        }
      }
    };
    void tick();
    const t = window.setInterval(tick, 60_000);
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, []);
  if (!st) return null;
  // Running locally on this PC: say so loudly, so an empty local view is never mistaken for the Pi's.
  if (st.runHere) {
    return (
      <div className="pi-banner local" role="status">
        <b>Agents are running on THIS PC</b>
        <span> — local simulation. The Pi is the real runner. Switch in Settings → Paper agents → “Run agents on”.</span>
      </div>
    );
  }
  // Chose the Pi but gave no address: warn instead of silently showing the empty local numbers.
  if (!st.configured) {
    return (
      <div className="pi-banner bad" role="status">
        <b>No Pi address set</b>
        <span> — you chose “The Pi” but set no address. Add it in Settings → Paper agents.</span>
      </div>
    );
  }
  if (!st.runningOnPi) return null;
  const when = st.syncedAt ? new Date(st.syncedAt).toLocaleTimeString() : null;
  const bad = !!st.error || st.reachable === false;
  return (
    <div className={bad ? 'pi-banner bad' : 'pi-banner'} role="status">
      <b>Running on the Pi</b>
      {bad ? (
        <span>
          {' '}— can’t reach the Pi{st.error ? `: ${st.error}` : ''}. Showing the last data I have{when ? ` (synced ${when})` : ' (none yet)'}.
        </span>
      ) : (
        <span>
          {' '}— live numbers mirrored from the Pi{when ? `, last synced ${when}` : ' (syncing…)'}.
        </span>
      )}
    </div>
  );
}
