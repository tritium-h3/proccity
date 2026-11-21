/** Latest-wins tickets: a result is applied only if its ticket is still the newest. */
export function createLatestGate(): { next(): number; isLatest(ticket: number): boolean } {
  let latest = 0;
  return {
    next: () => ++latest,
    isLatest: ticket => ticket === latest,
  };
}
