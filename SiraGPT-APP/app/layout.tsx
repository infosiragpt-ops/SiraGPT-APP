import type React from "react"
import type { Metadata, Viewport } from "next"
import { headers } from "next/headers"
import { GeistSans } from "geist/font/sans"
import { GeistMono } from "geist/font/mono"
import "./globals.css"
import "./video-liquid.css"
import { NextIntlClientProvider } from "next-intl"
import { getLocale, getMessages, getTranslations } from "next-intl/server"
import { isRTL, SUPPORTED_LOCALES } from "@/lib/i18n/locales"
// LayoutClientEffects is loaded via a "use client" dynamic wrapper (ssr:false)
// to prevent React from emitting a <div hidden=""> RSC transport container
// before the <a> skip-link in the server HTML. That hidden div made the first
// body child differ between server and client → structural hydration mismatch.
import { LayoutClientEffects } from "@/components/layout-client-effects-dynamic"
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
  "/apps",
  "/orgs",
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
  const locale = await getLocale()
  const t = await getTranslations({ locale, namespace: "common" })

  const titleDefault = t("meta.titleDefault")
  const titleTemplate = t("meta.titleTemplate")
  const description = t("meta.description")

  const alternates: Metadata["alternates"] = canonical
    ? {
        canonical,
        languages: Object.fromEntries(
          SUPPORTED_LOCALES.map((loc) => [loc, `https://siragpt.com${canonical}`])
        ),
      }
    : undefined

  const meta: Metadata = {
    metadataBase: new URL("https://siragpt.com"),
    title: {
      default: titleDefault,
      template: titleTemplate,
    },
    description,
    keywords: ["IA", "ChatGPT", "Claude", "Gemini", "generación de imágenes", "asistente IA", "plataforma IA", "productividad"],
    authors: [{ name: "SiraGPT" }],
    creator: "SiraGPT",
    publisher: "SiraGPT",
    applicationName: "SiraGPT",
    category: "technology",
    alternates,
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
    openGraph: {
      type: "website",
      locale: locale.replace("-", "_"),
      siteName: "SiraGPT",
      title: titleDefault,
      description,
      images: [{ url: "/sira-gpt.png", width: 1200, height: 630, alt: "SiraGPT" }],
    },
    twitter: {
      card: "summary_large_image",
      title: titleDefault,
      description,
      images: ["/sira-gpt.png"],
    },
    manifest: "/manifest.webmanifest",
    appleWebApp: {
      capable: true,
      title: "SiraGPT",
      statusBarStyle: "black-translucent",
    },
    icons: {
      icon: [
        { url: "/favicon.ico", sizes: "any" },
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
  const t = await getTranslations("common")
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
          React 18.3 hydration-mismatch filter + EOF-reload guard.

          React 18.3 reports RECOVERABLE errors (hydration mismatches) through
          window.reportError(), which dispatches a browser `error` event that
          Replit's crash detector intercepts as a fatal crash — even though
          React immediately regenerates the tree client-side and the app works
          correctly. We override window.reportError to suppress those specific
          messages so they never reach the crash detector.

          "Unexpected EOF" happens when the SSR stream is cut mid-flight
          because the old Next.js process dies during a restart. The browser
          gets an incomplete HTML, React tries to hydrate it, fails, and
          reports an error. We intercept the EOF event and schedule a reload
          after 2 s, giving the new process time to start so the next load
          delivers a complete page and a clean hydration.
        */}
        <script
          suppressHydrationWarning
          dangerouslySetInnerHTML={{
            __html: `(function(){var _re=window.reportError;window.reportError=function(e){var m=(e&&e.message)||'';if(m.indexOf('Hydration failed')!==-1||m.indexOf('did not match the client')!==-1||m.indexOf('while hydrating')!==-1)return;typeof _re==='function'&&_re.call(this,e);};var rl=false;function rf(){if(!rl){rl=true;setTimeout(function(){location.reload();},2000);}}window.addEventListener('unhandledrejection',function(e){var m=(e.reason&&e.reason.message)||'';if(m.indexOf('Unexpected EOF')!==-1){e.preventDefault();rf();}});window.addEventListener('error',function(e){if((e.message||'').indexOf('Unexpected EOF')!==-1){e.preventDefault();rf();}},true);})();`,
          }}
        />
        {/*
          Medianoche (OLED) theme boot — runs before first paint so a
          midnight user never sees the regular dark canvas flash. The
          flag lives outside next-themes ("midnight" is a flavor of the
          dark theme, not a sensitive theme), and the CSS is scoped to
          `.dark.midnight`, so the class is inert while in light mode.
        */}
        <script
          suppressHydrationWarning
          dangerouslySetInnerHTML={{
            __html:
              "try{if(localStorage.getItem('sira-theme-midnight')==='1'){document.documentElement.classList.add('midnight')}}catch(e){}",
          }}
        />
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
                  name: "SiraGPT",
                  url: "https://siragpt.com",
                  logo: "https://siragpt.com/sira-gpt-512.png",
                },
                {
                  "@type": "WebSite",
                  "@id": "https://siragpt.com/#website",
                  url: "https://siragpt.com",
                  name: "SiraGPT",
                  description:
                    "Plataforma multi-LLM con generación de texto, imagen, audio y video.",
                  inLanguage: "es",
                  publisher: { "@id": "https://siragpt.com/#organization" },
                },
                {
                  "@type": "SoftwareApplication",
                  name: "SiraGPT",
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
          {t("skipToContent")}
        </a>
        <span aria-live="polite" className="sr-only" data-app-bootstrap-status />
        {/*
          LayoutClientEffects is intentionally placed INSIDE NextIntlClientProvider
          rather than as a direct <body> child. When a Client Component (even ssr:false)
          is a direct Server-Component child of <body>, React places its RSC flight
          boundary (<div hidden="">) BEFORE all preceding static content in the body.
          That caused the RSC boundary to appear before the <a> skip-link in the server
          HTML, while the client rendered <a> as the first body child →
          structural hydration mismatch → unhandlederror → false crash detection.
          By nesting LayoutClientEffects inside the Client Component boundary of
          NextIntlClientProvider, the RSC boundary stays inside that subtree and never
          pollutes the top-level body ordering.
        */}
        <NextIntlClientProvider locale={locale} messages={messages}>
          <LayoutClientEffects />
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
