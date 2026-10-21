// A signal that needs data the app doesn't have yet (news, order book, options). It is listed on
// the "How it decides" page so the gap is visible, but it never fires until a data source that
// provides its feed is plugged in and the signal gets a real module of its own.
export function needsData(id, name, feed, tell) {
  return {
    id,
    name,
    kind: 'avoid',
    tell,
    needs: [feed],
    horizon: 12,
    available: () => false,
    evaluate: () => null,
  };
}
