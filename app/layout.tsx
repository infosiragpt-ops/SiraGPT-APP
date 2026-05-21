import type React from "react"
import type { Metadata, Viewport } from "next"
import nextDynamic from "next/dynamic"
import { GeistSans } from "geist/font/sans"
import { GeistMono } from "geist/font/mono"
import "./globals.css"
import { NextIntlClientProvider } from "next-intl"
import { getLocale, getMessages } from "next-intl/server"
import { isRTL } from "@/lib/i18n/locales"
// RootProviders bundles ThemeProvider + AuthProvider + SettingsProvider +
// AppWrapper (+ ChatProvider, SidebarProvider, AppShell, ArtifactPanel,
// BackgroundStreams, etc.). Loading it via nextDynamic moves all of that
// into its own webpack chunk so app/layout.js stays small enough for the
// Replit dev proxy to deliver intact (it truncates large responses).
const RootProviders = nextDynamic(
  () => import("@/components/root-providers").then(m => m.RootProviders),
  { ssr: true }
)

// Side-effect-only client components: they run inside useEffect on the
// browser and never render visible markup. Pulling them in synchronously
// inflates the layout chunk past the Replit preview proxy's ~1 MB cap
// (Sentry, PostHog, web-vitals, and Syncfusion shims each pull in their
// own SDKs). Loading them via next/dynamic with ssr:false makes webpack
// put each one in its own chunk that's fetched after hydration, keeping
// app/layout.js small enough for the dev iframe to load it intact.
const SentryClientInit = nextDynamic(
  () => import("@/components/sentry-client-init").then(m => m.SentryClientInit),
  { ssr: false }
)
const PostHogClientInit = nextDynamic(
  () => import("@/components/posthog-client-init").then(m => m.PostHogClientInit),
  { ssr: false }
)
const WebVitalsReporter = nextDynamic(
  () => import("./web-vitals").then(m => m.WebVitalsReporter),
  { ssr: false }
)
const SyncfusionBannerRemover = nextDynamic(
  () => import("@/components/SyncfusionBannerRemover").then(m => m.SyncfusionBannerRemover),
  { ssr: false }
)

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
  publisher: "Sira GPT",
  applicationName: "Sira GPT",
  category: "technology",
  // Explicit canonical so search engines collapse duplicate variants
  // (trailing slash, query strings, www, etc.) onto a single URL.
  alternates: {
    canonical: "/",
  },
  // Explicit robots directives — Lighthouse otherwise warns
  // "Page is blocked from indexing" whenever it cannot find a positive
  // index/follow signal. We also opt into Google's max-* hints so rich
  // results aren't truncated.
  robots: {
    index: true,
    follow: true,
    nocache: false,
    googleBot: {
      index: true,
      follow: true,
      "max-snippet": -1,
      "max-image-preview": "large",
      "max-video-preview": -1,
    },
  },
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
      { url: "/sira-gpt-192.png", sizes: "192x192", type: "image/png" },
      { url: "/sira-gpt-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [
      { url: "/sira-gpt-180.png", sizes: "180x180", type: "image/png" },
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
        {/*
          KaTeX CSS is already bundled via `import 'katex/dist/katex.min.css'`
          at the top of this file, which Next.js inlines/serves from
          `_next/static`. We previously also referenced a CDN copy here,
          which doubled the request and re-painted equations on
          stylesheet swap. The bundled copy is sufficient.
        */}
        {/*
          JSON-LD structured data — feeds Google's Knowledge Graph and
          enables rich results (sitelinks search box, organization
          card). Inlined in the document head so crawlers see it on
          first byte without waiting for hydration.
        */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@graph": [
                {
                  "@type": "Organization",
                  "@id": "https://siragpt.com/#organization",
                  name: "Sira GPT",
                  url: "https://siragpt.com",
                  logo: "https://siragpt.com/sira-gpt-512.png",
                },
                {
                  "@type": "WebSite",
                  "@id": "https://siragpt.com/#website",
                  url: "https://siragpt.com",
                  name: "Sira GPT",
                  description:
                    "Plataforma multi-LLM con generación de texto, imagen, audio y video.",
                  inLanguage: "es",
                  publisher: { "@id": "https://siragpt.com/#organization" },
                },
                {
                  "@type": "SoftwareApplication",
                  name: "Sira GPT",
                  applicationCategory: "BusinessApplication",
                  operatingSystem: "Web, iOS, Android",
                  url: "https://siragpt.com",
                  description:
                    "ChatGPT, Claude, Gemini, Grok y más en una sola plataforma. Chatea, genera imágenes, analiza documentos, diseña prototipos e investiga con IA.",
                  offers: {
                    "@type": "Offer",
                    price: "0",
                    priceCurrency: "USD",
                  },
                  publisher: { "@id": "https://siragpt.com/#organization" },
                },
              ],
            }),
          }}
        />
      </head>
      <body className={GeistSans.className}>
        <SentryClientInit />
        <PostHogClientInit />
        <WebVitalsReporter />
        <SyncfusionBannerRemover />
        <NextIntlClientProvider locale={locale} messages={messages}>
          <RootProviders>{children}</RootProviders>
        </NextIntlClientProvider>
      </body>
    </html>
  )
}
//layout.tsx
