import type React from "react"
import type { Metadata } from "next"
import { Inter, JetBrains_Mono } from "next/font/google"
import "./globals.css"
import { ThemeProvider } from "@/components/theme-provider"
import { AuthProvider } from "@/lib/auth-context-integrated"
import { Toaster } from "@/components/ui/sonner"
import { AppWrapper } from "@/components/app-wrapper"
import 'katex/dist/katex.min.css';
import { SettingsProvider } from "@/lib/settings-context"
import { SyncfusionBannerRemover } from "@/components/SyncfusionBannerRemover"
import { NextIntlClientProvider } from "next-intl"
import { getLocale, getMessages } from "next-intl/server"
import { isRTL } from "@/lib/i18n/locales"

// Inter — primary UI typeface. Load the full weight range + Latin-ext
// (tildes / ñ in Spanish content) so headings at 700 and fine chrome
// at 400/500 render crisply without falling back to system fonts.
// `display: "swap"` keeps the first paint instant; `variable` exposes
// `--font-sans` so Tailwind + globals.css both pull from the same font.
const inter = Inter({
  subsets: ["latin", "latin-ext"],
  weight: ["300", "400", "500", "600", "700", "800"],
  display: "swap",
  variable: "--font-sans",
  fallback: ["system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
})

// JetBrains Mono — used for `code`, `pre`, and any tabular digit usage.
// Designed for code (0 has a dot, l/1 unambiguous), ligatures off by
// default so AI responses with markdown code blocks read cleanly.
const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
  variable: "--font-mono",
  fallback: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
})

export const metadata: Metadata = {
  title: "Sira Gpt Platform",
  description: "Multi-LLM AI Platform with Text, Image, Audio & Video Generation",
  generator: 'v0.dev'
}

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
    <html lang={locale} dir={dir} suppressHydrationWarning className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <head>
        {/* Fallback CDN if local CSS fails */}
        <link
          rel="stylesheet"
          href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css"
          integrity="sha384-n8MVd4RsNIU0tAv4ct0nTaAbDJwPJzDEaqSD1odI+WdtXRGWt2kTvGFasHpSy3SV"
          crossOrigin="anonymous"
        />
      </head>
      <body className={inter.className}>
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
