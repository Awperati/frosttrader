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
  if (!st || !st.runningOnPi) return null;
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
