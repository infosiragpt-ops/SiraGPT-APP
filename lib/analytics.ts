/**
 * analytics — typed, no-op-safe façade over `posthog-js` for the
 * Next.js client. Components should import `track`, `identify`,
 * `reset`, and the typed event names from here rather than touching
 * `posthog-js` directly. Three reasons:
 *
 *   1. Disabled by default: when `NEXT_PUBLIC_POSTHOG_KEY` is not
 *      set, every helper here is a no-op. Components don't need
 *      `if (process.env...)` boilerplate.
 *
 *   2. Typed event names: a small union prevents free-form strings
 *      (`'chat.send'`, `'chat-send'`, `'chat sent'`) from drifting
 *      across the codebase. Adding a new event = one line here +
 *      one call site.
 *
 *   3. Failure isolation: any throw from the SDK is swallowed
 *      defensively. Analytics must never break the chat surface.
 *
 * Initialization is owned by `components/posthog-client-init.tsx` —
 * keep it co-located with `SentryClientInit` so observability boot
 * is one chunk of layout.tsx.
 */

export type AnalyticsEvent =
  | "chat.message_sent"
  | "chat.file_uploaded"
  | "model.selected"
  | "plan.upgrade_started"
  | "error.client_boundary"
  | "error.route"
  | "error.global"
  | "page.not_found"

type AnalyticsProperties = Record<string, string | number | boolean | null | undefined>

type PostHogLike = {
  capture: (event: string, properties?: AnalyticsProperties) => void
  identify: (id: string, traits?: AnalyticsProperties) => void
  reset: () => void
  __loaded?: boolean
}

declare global {
  interface Window {
    posthog?: PostHogLike
  }
}

function client(): PostHogLike | null {
  if (typeof window === "undefined") return null
  const ph = window.posthog
  // posthog-js sets `__loaded` once init has completed. Before that,
  // queueing capture() calls would buffer them in memory but we'd
  // rather just no-op so we don't risk spinning unbounded queues
  // when the SDK isn't going to load (key missing, init failed).
  if (!ph || !ph.__loaded) return null
  return ph
}

/**
 * track — fire an analytics event. Returns nothing on purpose: callers
 * should treat analytics as side-effectful logging, not as an
 * operation they need to confirm. Anything that needs delivery
 * confirmation belongs on the backend.
 */
export function track(event: AnalyticsEvent, properties?: AnalyticsProperties): void {
  const ph = client()
  if (!ph) return
  try {
    ph.capture(event, properties)
  } catch {
    // Analytics failure is never user-facing.
  }
}

/**
 * identify — bind subsequent events to the given user id (typically
 * Prisma User.id). Pass any non-PII traits in `traits` (plan, locale,
 * createdAt). NEVER pass email / name / payment instrument — those
 * belong only on the PostHog "person" profile via server-side
 * `posthog.alias` if at all.
 */
export function identify(id: string, traits?: AnalyticsProperties): void {
  const ph = client()
  if (!ph || !id) return
  try {
    ph.identify(id, traits)
  } catch {
    // ignore
  }
}

/**
 * reset — call on logout. Drops the client-side identifier so the
 * next anonymous session is bucketed correctly.
 */
export function reset(): void {
  const ph = client()
  if (!ph) return
  try {
    ph.reset()
  } catch {
    // ignore
  }
}
