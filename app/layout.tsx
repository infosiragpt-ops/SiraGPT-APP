import type React from "react"
import type { Metadata } from "next"
import { GeistSans } from "geist/font/sans"
import { GeistMono } from "geist/font/mono"
import "./globals.css"
import { ThemeProvider } from "@/components/theme-provider"
import { AuthProvider } from "@/lib/auth-context-integrated"
import { Toaster } from "@/components/ui/sonner"
import { AppWrapper } from "@/components/app-wrapper"
import 'katex/dist/katex.min.css';
import { SettingsProvider } from "@/lib/settings-context"
import { SyncfusionBannerRemover } from "@/components/SyncfusionBannerRemover"
import { SentryClientInit } from "@/components/sentry-client-init"
import { NextIntlClientProvider } from "next-intl"
import { getLocale, getMessages } from "next-intl/server"
import { isRTL } from "@/lib/i18n/locales"

// Geist Sans — Vercel's in-house UI typeface, the same font used on
// v0.dev, Vercel's dashboard, and most serious AI/dev tooling built
// on Next.js. It replaces the previous Inter choice because at the
// small UI sizes we actually ship (13–15 px) Geist reads crisper,
// has tighter apertures, and a more distinctive character-set
// calibration than Inter.
//
// The `geist` package already exposes both fonts as variable-font
// CSS vars (`--font-geist-sans` / `--font-geist-mono`). We re-expose
// them as `--font-sans` / `--font-mono` so globals.css and Tailwind
// stay format-agnostic — if we ever swap Geist for another typeface,
// nothing downstream changes.
//
// Geist Mono pairs with it for code, pre, kbd, samp — the 0 has a
// dot, l / 1 / I are unambiguous, ligatures off by default so AI
// code blocks read like real source.

export const metadata: Metadata = {
  title: "Sira Gpt Platform",
  description: "Multi-LLM AI Platform with Text, Image, Audio & Video Generation",
  generator: 'v0.dev'
}

export const dynamic = "force-dynamic"

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  // Resolve the per-request locale + messages on the server so the
  // first paint already ships in the right language. The messages
  // object is handed to the client provider; any hook call via
  // useTranslations() reads from it without an extra round-trip.
  const locale = await getLocale()
  const messages = await getMessages()
  const dir = isRTL(locale) ? "rtl" : "ltr"

  return (
    <html
      lang={locale} dir={dir}
      suppressHydrationWarning
      className={`${GeistSans.variable} ${GeistMono.variable}`}
      style={{
        // Mirror Geist's native variables onto our app-wide alias so
        // globals.css + Tailwind can reference a single --font-sans /
        // --font-mono regardless of which typeface is active.
        "--font-sans": "var(--font-geist-sans)",
        "--font-mono": "var(--font-geist-mono)",
      } as React.CSSProperties}
    >
      <head>
        {/* Fallback CDN if local CSS fails */}
        <link
          rel="stylesheet"
          href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css"
          integrity="sha384-n8MVd4RsNIU0tAv4ct0nTaAbDJwPJzDEaqSD1odI+WdtXRGWt2kTvGFasHpSy3SV"
          crossOrigin="anonymous"
        />
      </head>
      <body className={GeistSans.className}>
        <SentryClientInit />
        <SyncfusionBannerRemover />
        <NextIntlClientProvider locale={locale} messages={messages}>
          <ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange>
            <AuthProvider>
              <SettingsProvider>
                <AppWrapper>
                  {children}
                </AppWrapper>
                <Toaster />
              </SettingsProvider>
            </AuthProvider>
          </ThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  )
}
//layout.tsx
