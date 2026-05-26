"use client"

/**
 * web-vitals — Next.js `useReportWebVitals` integration that pipes
 * Core Web Vitals (CLS, FID, LCP, TTFB, INP) into PostHog via the
 * shared `lib/analytics` façade.
 *
 * Why a hook instead of a side-effect module?
 *   - `useReportWebVitals` is Next.js's official, hot-reload-safe API.
 *     Registering listeners manually risks double-firing under React's
 *     strict mode and HMR.
 *   - The hook is invoked from `app/layout.tsx`, so it boots once per
 *     navigation root, not once per page transition.
 *
 * The PostHog event name (`web_vitals.<metric>`) is intentionally
 * outside the typed `AnalyticsEvent` union: web-vitals are infra-grade
 * metrics, not product events, so we use the raw `window.posthog`
 * capture and silently no-op when the SDK isn't ready (e.g. PostHog
 * key not configured in dev).
 *
 * Property names match PostHog's "Web vitals" dashboard convention so
 * they show up in the canned funnel without extra mapping.
 */

import { useReportWebVitals } from "next/web-vitals"

// Subset of Next.js's `NextWebVitalsMetric` we actually report. Kept
// permissive so future metrics (e.g. Next.js custom timings) flow
// through without code changes.
type ReportedMetric = {
  id: string
  name: string
  label: string
  value: number
  startTime?: number
  delta?: number
  rating?: "good" | "needs-improvement" | "poor"
  navigationType?: string
}

const RELEVANT = new Set(["CLS", "FID", "LCP", "TTFB", "INP", "FCP"])

function reportToPostHog(metric: ReportedMetric) {
  if (typeof window === "undefined") return
  const ph: any = (window as any).posthog
  // PostHog might not be loaded (no key, blocked by extension, etc.).
  // Web vitals must never throw into the layout tree.
  if (!ph || !ph.__loaded || typeof ph.capture !== "function") return

  try {
    ph.capture(`web_vitals.${metric.name.toLowerCase()}`, {
      metric_id: metric.id,
      metric_name: metric.name,
      metric_label: metric.label,
      metric_value: metric.value,
      metric_delta: metric.delta,
      metric_rating: metric.rating,
      navigation_type: metric.navigationType,
      // Round to 2 decimals so PostHog's auto-aggregation (which keys on
      // exact value) doesn't get a Cartesian explosion of buckets.
      value_rounded: Math.round(metric.value * 100) / 100,
      path: window.location?.pathname,
    })
  } catch {
    // Telemetry must never affect UX.
  }
}

export function WebVitalsReporter(): null {
  useReportWebVitals((metric) => {
    // Drop noisy custom Next.js metrics (e.g. `Next.js-hydration`)
    // unless they're in the curated list. Keeping the allow-list small
    // protects our PostHog event volume budget.
    if (!RELEVANT.has(metric.name)) return
    reportToPostHog(metric as ReportedMetric)
  })
  return null
}
