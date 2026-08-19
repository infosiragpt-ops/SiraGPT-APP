// ──────────────────────────────────────────────────────────────
// siraGPT — 404 Not Found
// ──────────────────────────────────────────────────────────────
// Shown when the user hits a route that doesn't exist. Mirrors
// the brand language: subtle gradient ring, soft shadow, single
// strong CTA, and a quiet secondary route into the chat. No
// loud "404" — the affordance is meant to feel like a polite
// detour, not a crash screen.
// ──────────────────────────────────────────────────────────────

import Link from "next/link"
import { ArrowLeft, Compass, Home } from "lucide-react"
import { Button } from "@/components/ui/button"

export const dynamic = "force-static"
export const revalidate = false

export default function NotFound() {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-gradient-to-b from-background to-muted/20 p-4">
      {/* Decorative soft glow — same palette as the marketing hero */}
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-1/2 -z-10 h-[520px] w-[520px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-gradient-to-br from-violet-500/10 via-fuchsia-500/8 to-pink-500/10 blur-3xl"
      />

      <div className="mx-auto w-full max-w-md text-center">
        <div className="mx-auto mb-6 inline-flex h-16 w-16 items-center justify-center rounded-2xl border border-border/60 bg-card shadow-[0_8px_24px_-12px_rgba(15,23,42,0.18)] dark:shadow-[0_12px_32px_-16px_rgba(0,0,0,0.5)]">
          <Compass className="h-7 w-7 text-foreground/70" strokeWidth={1.6} />
        </div>

        <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
          Error 404
        </p>
        <h1 className="mb-3 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
          Página no encontrada
        </h1>
        <p className="mx-auto mb-8 max-w-sm text-[15px] leading-relaxed text-muted-foreground">
          La página que buscas no existe o fue movida. Revisa la URL o regresa al inicio.
        </p>

        <div className="flex flex-wrap items-center justify-center gap-2.5">
          <Button asChild size="default" className="h-10 rounded-xl px-5 font-semibold">
            <Link href="/">
              <Home className="mr-1.5 h-4 w-4" />
              Ir al inicio
            </Link>
          </Button>
          <Button asChild size="default" variant="outline" className="h-10 rounded-xl px-5 font-semibold">
            <Link href="/chat">
              <ArrowLeft className="mr-1.5 h-4 w-4" />
              Ir al chat
            </Link>
          </Button>
        </div>
      </div>
    </div>
  )
}
