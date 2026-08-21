"use client"

import { useCallback, useState } from "react"
import { FlaskConical, Loader2, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { toast } from "sonner"

type CheckResult = {
  name: string
  ok: boolean
  detail: string
}

export default function AdminPruebaPage() {
  const [running, setRunning] = useState(false)
  const [results, setResults] = useState<CheckResult[]>([])

  const runChecks = useCallback(async () => {
    setRunning(true)
    setResults([])
    const checks: CheckResult[] = []

    try {
      const healthRes = await fetch("/api/health")
      const health = await healthRes.json().catch(() => null)
      checks.push({
        name: "Frontend",
        ok: true,
        detail: `Next.js respondiendo (HTTP ${healthRes.status})`,
      })

      const backendCheck = (health?.checks || []).find(
        (check: { name?: string }) => check?.name === "backend",
      )
      checks.push({
        name: "Backend",
        ok: Boolean(backendCheck),
        detail: backendCheck
          ? `Estado: ${backendCheck.status} (${backendCheck.latency_ms ?? "?"} ms)`
          : "Sin reporte del backend en /api/health",
      })
    } catch {
      checks.push({
        name: "Frontend",
        ok: false,
        detail: "No se pudo contactar /api/health",
      })
    }

    setResults(checks)
    const failed = checks.filter((check) => !check.ok).length
    if (failed === 0) toast.success("Prueba completada sin errores")
    else toast.warning(`Prueba completada con ${failed} problema(s)`)
    setRunning(false)
  }, [])

  return (
    <div className="flex min-h-full w-full flex-col">
      <header className="flex h-14 flex-shrink-0 items-center gap-3 border-b px-4">
        <SidebarTrigger />
        <FlaskConical className="h-5 w-5 text-muted-foreground" />
        <div>
          <h1 className="text-sm font-semibold leading-none">Prueba</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Diagnóstico rápido de la plataforma
          </p>
        </div>
        <Button
          size="sm"
          className="ml-auto"
          onClick={runChecks}
          disabled={running}
        >
          {running ? (
            <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="mr-1.5 h-4 w-4" />
          )}
          Ejecutar prueba
        </Button>
      </header>

      <main className="flex-1 space-y-4 p-6">
        <Card>
          <CardHeader>
            <CardTitle>Resultado</CardTitle>
            <CardDescription>
              Pulsa «Ejecutar prueba» para verificar los servicios principales.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {results.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Aún no se ha ejecutado ninguna prueba.
              </p>
            ) : (
              <ul className="space-y-2">
                {results.map((check) => (
                  <li
                    key={check.name}
                    className="flex items-start gap-2 rounded-md border p-3"
                  >
                    <span
                      className={
                        check.ok
                          ? "mt-0.5 h-2 w-2 flex-shrink-0 rounded-full bg-emerald-500"
                          : "mt-0.5 h-2 w-2 flex-shrink-0 rounded-full bg-red-500"
                      }
                    />
                    <div>
                      <p className="text-sm font-medium">{check.name}</p>
                      <p className="text-xs text-muted-foreground">{check.detail}</p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  )
}
