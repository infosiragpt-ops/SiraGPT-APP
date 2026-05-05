// ──────────────────────────────────────────────────────────────
// siraGPT — 404 Not Found
// ──────────────────────────────────────────────────────────────
// Shown when the user hits a route that doesn't exist.
// ──────────────────────────────────────────────────────────────

import Link from "next/link"
import { Home, ArrowLeft, Search } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"

export const dynamic = "force-static"
export const revalidate = false

export default function NotFound() {
  return (
    <div className="flex min-h-[50vh] items-center justify-center p-4">
      <Card className="mx-auto max-w-md p-6 text-center shadow-lg">
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-muted">
          <span className="text-3xl font-bold text-muted-foreground/40">404</span>
        </div>

        <h1 className="mb-2 text-xl font-semibold">
          P&aacute;gina no encontrada
        </h1>

        <p className="mb-6 text-sm text-muted-foreground">
          La p&aacute;gina que buscas no existe o fue movida.
          Revisa la URL o vuelve al inicio.
        </p>

        <div className="flex flex-wrap items-center justify-center gap-3">
          <Button asChild variant="default" size="sm">
            <Link href="/">
              <Home className="mr-1.5 h-4 w-4" />
              Ir al inicio
            </Link>
          </Button>

          <Button
            asChild
            variant="outline"
            size="sm"
          >
            <Link href="/chat">
              <ArrowLeft className="mr-1.5 h-4 w-4" />
              Ir al chat
            </Link>
          </Button>
        </div>
      </Card>
    </div>
  )
}
