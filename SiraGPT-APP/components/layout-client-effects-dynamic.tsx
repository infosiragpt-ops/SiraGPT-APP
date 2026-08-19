"use client"

// Same pattern as root-providers-dynamic.tsx:
// next/dynamic with ssr:false must live in a "use client" file because
// Next.js 15 forbids { ssr: false } inside Server Components.
//
// Wrapping LayoutClientEffects in its own ssr:false boundary prevents
// React from generating a <div hidden=""> RSC transport container at the
// top of <body> for its deferred children (Sentry, PostHog, etc.).
// That hidden div was appearing BEFORE the <a> skip-link in the server
// HTML, while the client rendered <a> as the first body child →
// structural hydration mismatch → unhandlederror → false crash detection.
//
// With ssr:false here the server renders null for this whole subtree;
// the client renders it fresh, no hidden div, no mismatch.

import dynamic from "next/dynamic"

const LayoutClientEffectsDynamic = dynamic(
  () => import("@/components/layout-client-effects").then(m => m.LayoutClientEffects),
  { ssr: false },
)

export { LayoutClientEffectsDynamic as LayoutClientEffects }
