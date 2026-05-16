import type React from "react"
import type { Metadata, Viewport } from "next"
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
import { GlobalDropRedirector } from "@/components/GlobalDropRedirector"
import { SentryClientInit } from "@/components/sentry-client-init"
import { PostHogClientInit } from "@/components/posthog-client-init"
import { NextIntlClientProvider } from "next-intl"
import { getLocale, getMessages } from "next-intl/server"
import { isRTL } from "@/lib/i18n/locales"

export const metadata: Metadata = {
  metadataBase: new URL("https://siragpt.com"),
  title: {
    default: "Sira GPT — Plataforma de IA Multimodal",
    template: "%s · Sira GPT",
  },
  description: "Plataforma multi-LLM con generación de texto, imagen, audio y video. GPT-4, Claude, Gemini y más en un solo lugar.",
  keywords: ["IA", "ChatGPT", "Claude", "Gemini", "generación de imágenes", "asistente IA", "plataforma IA", "productividad"],
  authors: [{ name: "Sira GPT" }],
  creator: "Sira GPT",
  // OG tags so Slack / WhatsApp / Twitter previews show a branded
  // card instead of a generic Next.js placeholder.
  openGraph: {
    type: "website",
    locale: "es_ES",
    siteName: "Sira GPT",
    title: "Sira GPT — Plataforma de IA Multimodal",
    description: "GPT-4, Claude, Gemini y más en un solo lugar. Chatea, genera imágenes, analiza documentos.",
    images: [{ url: "/sira-gpt.png", width: 1200, height: 630, alt: "Sira GPT" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Sira GPT — Plataforma de IA Multimodal",
    description: "GPT-4, Claude, Gemini y más en un solo lugar.",
    images: ["/sira-gpt.png"],
  },
  // Web App Manifest — lets the browser surface the "Install" /
  // "Add to Home Screen" affordance with our branded icon, name and
  // launcher shortcuts (Nuevo chat / Biblioteca / Proyectos).
  manifest: "/manifest.webmanifest",
  // Sets the apple-mobile-web-app-* meta tags so iOS treats the
  // installed PWA-style shortcut as a full-screen app, hiding the
  // Safari chrome and respecting the notch.
  appleWebApp: {
    capable: true,
    title: "Sira GPT",
    statusBarStyle: "black-translucent",
  },
  // Standalone icons. The 180×180 link is the one iOS Home Screen
  // actually uses; the other sizes flow through the manifest.
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/sira-gpt.png", sizes: "192x192", type: "image/png" },
    ],
    apple: [
      { url: "/sira-gpt.png", sizes: "180x180", type: "image/png" },
    ],
  },
}

// `viewport-fit=cover` is what makes `env(safe-area-inset-*)` resolve
// to non-zero values on notched iPhones. Without it, the notch eats
// the top of the header on iOS Safari. `interactiveWidget: "resizes-content"`
// lets the page resize when the virtual keyboard opens so the composer
// doesn't slide under the keyboard on Android Chrome.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  minimumScale: 1,
  userScalable: true,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#05070a" },
  ],
}

export const dynamic = "force-dynamic"

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const locale = await getLocale()
  const messages = await getMessages()
  const dir = isRTL(locale) ? "rtl" : "ltr"

  return (
    <html
      lang={locale} dir={dir}
      suppressHydrationWarning
      className={`${GeistSans.variable} ${GeistMono.variable}`}
      style={{
        "--font-sans": "var(--font-geist-sans)",
        "--font-mono": "var(--font-geist-mono)",
      } as React.CSSProperties}
    >
      <head>
        <link
          rel="stylesheet"
          href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css"
          integrity="sha384-n8MVd4RsNIU0tAv4ct0nTaAbDJwPJzDEaqSD1odI+WdtXRGWt2kTvGFasHpSy3SV"
          crossOrigin="anonymous"
        />
      </head>
      <body className={GeistSans.className}>
        <SentryClientInit />
        <PostHogClientInit />
        <SyncfusionBannerRemover />
        <NextIntlClientProvider locale={locale} messages={messages}>
          <ThemeProvider attribute="class" defaultTheme="light" enableSystem disableTransitionOnChange>
            <AuthProvider>
              <SettingsProvider>
                <AppWrapper>
                  {children}
                </AppWrapper>
                <GlobalDropRedirector />
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
