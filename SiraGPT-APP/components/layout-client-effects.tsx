"use client"

import nextDynamic from "next/dynamic"

const SentryClientInit = nextDynamic(
  () => import("@/components/sentry-client-init").then((m) => m.SentryClientInit),
  { ssr: false }
)
const PostHogClientInit = nextDynamic(
  () => import("@/components/posthog-client-init").then((m) => m.PostHogClientInit),
  { ssr: false }
)
const WebVitalsReporter = nextDynamic(
  () => import("@/app/web-vitals").then((m) => m.WebVitalsReporter),
  { ssr: false }
)
const SyncfusionBannerRemover = nextDynamic(
  () => import("@/components/SyncfusionBannerRemover").then((m) => m.SyncfusionBannerRemover),
  { ssr: false }
)
const OfficeClipboardBridge = nextDynamic(
  () => import("@/components/office-clipboard-bridge").then((m) => m.OfficeClipboardBridge),
  { ssr: false }
)

export function LayoutClientEffects() {
  return (
    <>
      <SentryClientInit />
      <PostHogClientInit />
      <WebVitalsReporter />
      <SyncfusionBannerRemover />
      <OfficeClipboardBridge />
    </>
  )
}
