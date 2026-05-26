// ──────────────────────────────────────────────────────────────
// siraGPT — Next.js Instrumentation
// ──────────────────────────────────────────────────────────────
// Runs once at server startup (both `next dev` and standalone
// production). Used here to silence one specific class of
// expected post-deploy log noise: "Failed to find Server Action".
//
// Why this exists:
//   Whenever we redeploy, users with the app open in a browser
//   tab still hold the OLD client bundle for a few seconds. Any
//   Server Action they trigger in that window arrives at the NEW
//   server with a Server Action ID that no longer exists, and
//   Next.js logs:
//     Error: Failed to find Server Action "x". This request
//     might be from an older or newer deployment.
//
//   This is EXPECTED behaviour and is already handled end-to-end:
//     1. next.config.mjs pins `encryptionKey` + `generateBuildId`
//        so the IDs only change when the action source code
//        actually changes.
//     2. app/error.tsx + app/global-error.tsx catch the error on
//        the client and trigger a single `window.location.reload()`
//        guarded by sessionStorage to pull the new bundle.
//
//   The user never sees a broken UI — they see a 200 ms blink
//   and the page is back. The server log line, however, keeps
//   surfacing in deployment logs as if it were a real error,
//   which is misleading. This filter drops only that one
//   specific message; every other error keeps flowing.
//
// Safety:
//   - Match is anchored to the EXACT Next.js error string.
//   - Filter only runs in nodejs runtime (not edge / browser).
//   - Counter is exposed via console at 5-min intervals so a
//     pathological spike still becomes visible — we never go
//     completely silent on this class of error.
// ──────────────────────────────────────────────────────────────

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const STALE_ACTION_RE =
    /Failed to find Server Action ".+?"\. This request might be from an older or newer deployment/;

  let suppressedSinceLastReport = 0;
  let totalSuppressed = 0;
  const REPORT_INTERVAL_MS = 5 * 60 * 1000;

  function messageMatches(args: unknown[]): boolean {
    for (const arg of args) {
      if (!arg) continue;
      if (typeof arg === 'string' && STALE_ACTION_RE.test(arg)) return true;
      if (arg instanceof Error) {
        if (STALE_ACTION_RE.test(arg.message || '')) return true;
        if (STALE_ACTION_RE.test(arg.stack || '')) return true;
      }
      if (typeof arg === 'object') {
        const maybeMsg = (arg as { message?: unknown }).message;
        if (typeof maybeMsg === 'string' && STALE_ACTION_RE.test(maybeMsg)) return true;
      }
    }
    return false;
  }

  const originalError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    if (messageMatches(args)) {
      suppressedSinceLastReport += 1;
      totalSuppressed += 1;
      return;
    }
    originalError(...args);
  };

  // unhandledRejection — Next.js bubbles the stale-action error up
  // as a rejected promise from the action handler. Node would
  // print it to stderr without going through console.error, so we
  // intercept here too and re-emit only real rejections.
  process.on('unhandledRejection', (reason) => {
    const text =
      reason instanceof Error
        ? `${reason.message}\n${reason.stack ?? ''}`
        : String(reason);
    if (STALE_ACTION_RE.test(text)) {
      suppressedSinceLastReport += 1;
      totalSuppressed += 1;
      return;
    }
    // Real rejection — keep the default Node behaviour: log it
    // and let any other listeners handle it.
    originalError('[unhandledRejection]', reason);
  });

  // Periodic summary so a sudden spike in stale-action errors
  // still becomes visible (e.g. a deploy that breaks the
  // encryption key would generate one of these per request).
  setInterval(() => {
    if (suppressedSinceLastReport === 0) return;
    originalError(
      `[instrumentation] suppressed ${suppressedSinceLastReport} stale Server Action errors in the last 5 min (total since boot: ${totalSuppressed}). Auto-reload on client handles them; this log is a noise-reduction summary.`,
    );
    suppressedSinceLastReport = 0;
  }, REPORT_INTERVAL_MS).unref();
}
