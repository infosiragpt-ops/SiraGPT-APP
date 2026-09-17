/** Delete before acknowledging, in bounded batches. Pending confirmations stay
 * buffered until the acknowledgment completes. The final flush runs even when
 * cancellation or deletion fails; it never acknowledges an uncertain delete.
 * Production supplies private storage removal and the existing durable journal. */
export async function removeAndAcknowledge(keys: ReadonlyArray<string>, signal: AbortSignal,
  remove: (key: string) => Promise<void>, acknowledge: (keys: string[]) => Promise<void>): Promise<void> {
  let confirmed: string[] = [];
  const flush = async (): Promise<void> => {
    if (!confirmed.length) return;
    await acknowledge(confirmed);
    confirmed = [];
  };
  try {
    for (const key of keys) {
      signal.throwIfAborted();
      await remove(key);
      confirmed.push(key);
      if (confirmed.length >= 100) await flush();
    }
  } finally {
    // Keep the existing finally error precedence and retry of an unacknowledged
    // full batch. The outer cleanup worker records any remaining obligation.
    await flush();
  }
}
