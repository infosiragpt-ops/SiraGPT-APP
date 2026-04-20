import type React from "react"
import type { Metadata } from "next"
import { Inter } from "next/font/google"
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

const inter = Inter({ subsets: ["latin"] })

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
    <html lang={locale} dir={dir} suppressHydrationWarning>
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
