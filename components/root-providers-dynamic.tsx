"use client"

// This file exists so that next/dynamic with ssr:false can be used from a
// Server Component (app/layout.tsx). Next.js 15 forbids { ssr: false } inside
// Server Components — it must live in a "use client" file.
//
// The dynamic() call here keeps RootProviders (ThemeProvider + AuthProvider +
// SettingsProvider + AppWrapper + the entire UI shell) in its own webpack
// chunk. That chunk split prevents app/layout.js from exceeding ~1 MB, which
// is the threshold at which the Replit dev-preview proxy silently truncates
// the response and breaks hydration.
//
// ssr: false is intentional — RootProviders is a tree of client-only hooks
// and browser APIs (localStorage, navigator, keyboard events). Attempting SSR
// caused Next.js to print "Bail out to client-side rendering: next/dynamic"
// to stderr on every request, which Replit's crash detector mis-read as a
// runtime error.

import dynamic from "next/dynamic"

const RootProvidersDynamic = dynamic(
  () => import("@/components/root-providers").then(m => m.RootProviders),
  { ssr: false }
)

export { RootProvidersDynamic as RootProviders }
