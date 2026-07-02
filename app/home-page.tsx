"use client"

import { BrandLogo } from "@/components/BrandLogo"
import { LoginButton } from "@/components/AuthNavButtons"
import { ThemeToggle } from "@/components/theme-toggle"
import { useEffect, type ComponentType } from "react"
import { motion } from "framer-motion"

/**
 * Landing minimalista: fondo blanco, el encabezado de siempre y solo los
 * cuatro botones de descarga (iPhone · Android · Mac · Windows).
 *
 * Los `href` son placeholders hasta que existan los binarios / fichas de
 * store reales — actualizarlos aquí cuando estén publicados.
 */
const DOWNLOADS: {
  platform: string
  href: string
  icon: ComponentType<{ className?: string }>
}[] = [
  { platform: "iPhone", href: "#", icon: AppleIcon },
  { platform: "Android", href: "#", icon: AndroidIcon },
  { platform: "Mac", href: "#", icon: AppleIcon },
  { platform: "Windows", href: "#", icon: WindowsIcon },
]

export default function HomePage() {
  useEffect(() => {
    const htmlEl = document.documentElement
    const bodyEl = document.body

    htmlEl.style.overflow = "auto"
    htmlEl.style.height = "auto"
    htmlEl.style.overscrollBehavior = "auto"

    bodyEl.style.overflow = "auto"
    bodyEl.style.height = "auto"
    bodyEl.style.overscrollBehavior = "auto"

    return () => {
      htmlEl.style.overflow = ""
      htmlEl.style.height = ""
      htmlEl.style.overscrollBehavior = ""

      bodyEl.style.overflow = ""
      bodyEl.style.height = ""
      bodyEl.style.overscrollBehavior = ""
    }
  }, [])

  return (
    <div className="relative min-h-screen overflow-x-hidden bg-white text-neutral-950 dark:bg-neutral-950 dark:text-white">
      <header className="fixed top-0 z-50 w-full border-b border-neutral-200/80 bg-white/90 backdrop-blur-xl dark:border-white/10 dark:bg-neutral-950/90">
        <div className="mx-auto flex w-full max-w-7xl items-center justify-between px-4 py-3 md:px-6 md:py-4">
          <BrandLogo />

          <motion.div
            className="flex items-center gap-2 md:gap-3"
            initial={{ opacity: 0, x: 16 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.35 }}
          >
            <ThemeToggle />
            <LoginButton href="/auth/login" />
          </motion.div>
        </div>
      </header>

      <main className="sira-home-main flex min-h-screen items-center justify-center px-5">
        <h1 className="sr-only">Sira GPT — Descargas</h1>

        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45 }}
          className="grid w-full max-w-xs grid-cols-1 gap-3 sm:max-w-lg sm:grid-cols-2 lg:max-w-4xl lg:grid-cols-4"
        >
          {DOWNLOADS.map(({ platform, href, icon: Icon }) => (
            <a
              key={platform}
              href={href}
              className="group flex min-h-14 items-center justify-center gap-3 rounded-xl bg-neutral-950 px-5 py-3 text-white transition duration-200 hover:bg-neutral-800 active:scale-[0.98] dark:bg-white dark:text-neutral-950 dark:hover:bg-neutral-200"
              aria-label={`Descargar Sira GPT para ${platform}`}
            >
              <Icon className="h-6 w-6 shrink-0" />
              <span className="text-left leading-tight">
                <span className="block text-[10px] font-medium uppercase tracking-wide opacity-70">
                  Descargar para
                </span>
                <span className="block text-base font-bold">{platform}</span>
              </span>
            </a>
          ))}
        </motion.div>
      </main>

      <style jsx global>{`
        .sira-home-main {
          padding-top: 88px !important;
        }

        @media (min-width: 1024px) {
          .sira-home-main {
            padding-top: 80px !important;
          }
        }
      `}</style>
    </div>
  )
}

function AppleIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.03 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.56-1.702" />
    </svg>
  )
}

function AndroidIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M17.523 15.341c-.551 0-.999-.448-.999-1s.448-.999.999-.999c.551 0 .999.448.999.999s-.448 1-.999 1m-11.046 0c-.551 0-.999-.448-.999-1s.448-.999.999-.999c.551 0 .999.448.999.999s-.448 1-.999 1m11.405-6.02 1.997-3.46a.416.416 0 0 0-.152-.567.416.416 0 0 0-.568.152l-2.022 3.503C15.59 8.244 13.853 7.851 12 7.851s-3.59.393-5.137 1.099L4.841 5.447a.416.416 0 0 0-.568-.152.416.416 0 0 0-.152.567l1.997 3.46C2.689 11.187.343 14.659 0 18.761h24c-.344-4.102-2.689-7.574-6.118-9.44" />
    </svg>
  )
}

function WindowsIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M0 3.449 9.75 2.1v9.451H0m10.949-9.602L24 0v11.4H10.949M0 12.6h9.75v9.451L0 20.699M10.949 12.6H24V24l-13.051-1.851" />
    </svg>
  )
}
