import type React from "react"
import type { Metadata, Viewport } from "next"
import { headers } from "next/headers"
import { GeistSans } from "geist/font/sans"
import { GeistMono } from "geist/font/mono"
import "./globals.css"
import { NextIntlClientProvider } from "next-intl"
import { getLocale, getMessages } from "next-intl/server"
import { isRTL } from "@/lib/i18n/locales"
import { LayoutClientEffects } from "@/components/layout-client-effects"
// RootProviders is loaded from a Client Component wrapper that uses
// next/dynamic with ssr:false. Moving the dynamic() call into a "use client"
// file is required — Next.js 15 forbids ssr:false in Server Components.
// The chunk split keeps app/layout.js small so the Replit dev proxy delivers
// it intact (it truncates responses larger than ~1 MB).
import { RootProviders } from "@/components/root-providers-dynamic"

// Routes that must NOT advertise themselves as canonical — they're
// authenticated surfaces (chat, settings, billing) or transient (auth
// callbacks, share previews). They're already disallowed in robots.ts;
// omitting canonical here keeps Google from accidentally indexing a
// canonical URL it can't crawl.
const NON_CANONICAL_PREFIXES = [
  "/admin",
  "/super-admin",
  "/billing",
  "/share",
  "/chat",
  "/projects",
  "/settings",
  "/library",
  "/voice",
  "/codex",
  "/gpts/create",
  "/auth/callback",
  "/api",
]

/**
 * Build the canonical URL for the current request. We strip the query
 * string and any trailing slash (except for "/" itself) so duplicate
 * variants collapse onto a single canonical, and we omit the tag
 * entirely for non-indexable routes.
 */
function canonicalFromPathname(pathname: string | null | undefined): string | undefined {
  if (!pathname) return "/"
  const clean = pathname.split("?")[0].split("#")[0]
  if (NON_CANONICAL_PREFIXES.some((p) => clean === p || clean.startsWith(`${p}/`))) {
    return undefined
  }
  if (clean === "/" || clean === "") return "/"
  // Collapse trailing slash on deep paths so /foo and /foo/ map to /foo.
  return clean.endsWith("/") ? clean.slice(0, -1) : clean
}

export async function generateMetadata(): Promise<Metadata> {
  const h = await headers()
  const pathname = h.get("x-pathname") || "/"
  const canonical = canonicalFromPathname(pathname)
  const meta: Metadata = {
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
  // Per-route canonical computed from the x-pathname header injected
  // by middleware. Pages on the NON_CANONICAL list (chat, settings,
  // billing, etc.) omit the tag entirely so Google doesn't try to
  // canonicalise them to themselves while robots.txt also disallows
  // them — the conflicting signals were what Lighthouse was flagging.
  alternates: canonical ? { canonical } : undefined,
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
  return meta
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
      <head suppressHydrationWarning>
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
          suppressHydrationWarning
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
        {/*
          #77 — Skip-to-content link (Lote A · accesibilidad). Hidden
          until the user tabs into it as the first focusable element,
          then slides into view. Targets the #main-content wrapper
          below, which has tabIndex=-1 so it can receive focus
          programmatically without entering the natural tab order.
          Pinned to the top of <body> so it's always the first stop
          regardless of which page renders.
        */}
        <a href="#main-content" className="skip-to-content">
          Saltar al contenido
        </a>
        <LayoutClientEffects />
        <NextIntlClientProvider locale={locale} messages={messages}>
          <RootProviders>
            <div id="main-content" tabIndex={-1} className="outline-none">
              {children}
            </div>
          </RootProviders>
        </NextIntlClientProvider>
      </body>
    </html>
  )
}
//layout.tsx
