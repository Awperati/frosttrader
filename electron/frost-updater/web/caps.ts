// The window's half of the shared updater: what the running main process can do. After a Dev install update the
// window can be newer than the main process (the checkout's dist was rebuilt and a reload showed it before a
// restart): features whose method the main process lacks are hidden, and a banner asks to restart. The main
// process lists its methods under one call ('app.rpcs' by default); one too old to answer is older than the window.
export interface Caps {
  /** The method names the main process answers; null when it couldn't say (older than this window). */
  rpcs: Set<string> | null;
  /** The window is newer than the main process: restart to finish updating. */
  stale: boolean;
}

/** A once-only loader of the caps, from the app's own call(method) to its main process. */
export function capsLoader(call: (method: string) => Promise<unknown>, method = 'app.rpcs'): () => Promise<Caps> {
  let loaded: Promise<Caps> | null = null;
  return () => {
    if (!loaded) {
      loaded = call(method)
        .then((list) => ({ rpcs: new Set(Array.isArray(list) ? (list as string[]) : []), stale: false }))
        .catch((err) => (/Unknown action/i.test(String(err && err.message)) ? { rpcs: null, stale: true } : { rpcs: null, stale: false }));
    }
    return loaded;
  };
}

/** True only when the main process is known to answer this method. */
export const hasRpc = (caps: Caps | null, method: string) => !!caps && !!caps.rpcs && caps.rpcs.has(method);
