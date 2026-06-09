"use client"

import { useEffect, useState, useCallback } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { AlertTriangle, CheckCircle, XCircle, MinusCircle, RefreshCw, Activity, Server, Database, Wifi, HardDrive, Eye, EyeOff } from "lucide-react"
import { ThinkingIndicator } from "@/components/ui/thinking-indicator"

type CheckStatus = "healthy" | "degraded" | "unhealthy" | "skipped"

interface CheckDetails {
  [key: string]: any
}

interface HealthCheck {
  name: string
  status: CheckStatus
  critical: boolean
  latency_ms: number
  details?: CheckDetails
}

interface HealthData {
  status: string
  timestamp: string
  uptime_s?: number
  checks: HealthCheck[]
}

const statusConfig: Record<CheckStatus, { color: string; bg: string; Icon: React.ElementType }> = {
  healthy: { color: "text-green-600", bg: "bg-green-50 border-green-200", Icon: CheckCircle },
  degraded: { color: "text-yellow-600", bg: "bg-yellow-50 border-yellow-200", Icon: AlertTriangle },
  unhealthy: { color: "text-red-600", bg: "bg-red-50 border-red-200", Icon: XCircle },
  skipped: { color: "text-gray-400", bg: "bg-gray-50 border-gray-200", Icon: MinusCircle },
}

function statusLabel(s: CheckStatus) {
  switch (s) {
    case "healthy": return "Sano"
    case "degraded": return "Degradado"
    case "unhealthy": return "Caído"
    case "skipped": return "Omitido"
  }
}

function iconForCheck(name: string) {
  switch (name) {
    case "database": return Database
    case "redis": return Server
    case "queue": return Activity
    case "process": return HardDrive
    case "model_providers": return Wifi
    default: return Activity
  }
}

export default function HealthDashboard() {
  const [health, setHealth] = useState<HealthData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showDetails, setShowDetails] = useState<Record<string, boolean>>({})
  const [autoRefresh, setAutoRefresh] = useState(true)

  const fetchHealth = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const res = await fetch("/api/health")
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setHealth(data)
    } catch (err: any) {
      setError(err.message || "Error al conectar con el servidor")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchHealth()
  }, [fetchHealth])

  // Poll every 30s when auto-refresh is on
  useEffect(() => {
    if (!autoRefresh) return
    const interval = setInterval(fetchHealth, 30000)
    return () => clearInterval(interval)
  }, [autoRefresh, fetchHealth])

  function toggleDetails(name: string) {
    setShowDetails((prev) => ({ ...prev, [name]: !prev[name] }))
  }

  const criticalCount = health?.checks.filter((c) => c.status !== "healthy" && c.critical).length ?? 0
  const allHealthy = health?.checks.every((c) => c.status === "healthy" || c.status === "skipped")

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Dashboard de Salud</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Estado del sistema siraGPT
          </p>
        </div>
        <div className="flex items-center gap-3">
          {health && (
            <Badge
              variant={allHealthy ? "default" : criticalCount > 0 ? "destructive" : "secondary"}
              className="text-sm px-3 py-1"
            >
              {allHealthy ? "Todo bien" : criticalCount > 0 ? `${criticalCount} crítico(s)` : "Degradado"}
            </Badge>
          )}
          <Button variant="outline" size="sm" onClick={() => setAutoRefresh((v) => !v)} className="gap-1.5">
            {autoRefresh ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            {autoRefresh ? "Auto" : "Manual"}
          </Button>
          <Button variant="outline" size="sm" onClick={fetchHealth} disabled={loading} className="gap-1.5">
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            Recargar
          </Button>
        </div>
      </div>

      {/* Error state */}
      {error && (
        <Card className="border-red-300 bg-red-50">
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-red-700">
              <XCircle className="h-5 w-5" />
              <span>Error al obtener datos de salud: {error}</span>
            </div>
            <Button variant="outline" size="sm" onClick={fetchHealth} className="mt-3">
              Reintentar
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Loading state */}
      {loading && !health && !error && (
        <Card>
          <CardContent className="pt-6 text-center">
            <ThinkingIndicator size="lg" className="mx-auto text-muted-foreground" />
            <p className="mt-2 text-sm text-muted-foreground">Verificando estado del sistema...</p>
          </CardContent>
        </Card>
      )}

      {/* Overall status */}
      {health && (
        <>
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-lg flex items-center gap-2">
                <Activity className="h-5 w-5" />
                Resumen
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="text-center">
                  <div className="text-3xl font-bold">{health.checks.length}</div>
                  <div className="text-xs text-muted-foreground">Servicios</div>
                </div>
                <div className="text-center">
                  <div className="text-3xl font-bold text-green-600">
                    {health.checks.filter((c) => c.status === "healthy").length}
                  </div>
                  <div className="text-xs text-muted-foreground">Saludables</div>
                </div>
                <div className="text-center">
                  <div className="text-3xl font-bold text-yellow-600">
                    {health.checks.filter((c) => c.status === "degraded").length}
                  </div>
                  <div className="text-xs text-muted-foreground">Degradados</div>
                </div>
                <div className="text-center">
                  <div className="text-3xl font-bold text-red-600">{criticalCount}</div>
                  <div className="text-xs text-muted-foreground">Críticos</div>
                </div>
              </div>
              {health.timestamp && (
                <p className="text-xs text-muted-foreground mt-4 text-center">
                  Última verificación: {new Date(health.timestamp).toLocaleString("es-BO")}
                </p>
              )}
            </CardContent>
          </Card>

          {/* Check cards */}
          <div className="grid gap-4">
            {health.checks.map((check) => {
              const cfg = statusConfig[check.status]
              const Icon = cfg.Icon
              const CheckIcon = iconForCheck(check.name)
              const hasDetails = check.details && Object.keys(check.details).length > 0
              const show = showDetails[check.name]

              return (
                <Card key={check.name} className={`border ${cfg.bg}`}>
                  <CardHeader className="pb-3 flex flex-row items-start justify-between">
                    <div className="flex items-start gap-3">
                      <CheckIcon className="h-5 w-5 mt-0.5 text-muted-foreground" />
                      <div>
                        <CardTitle className="text-base capitalize">{check.name.replace(/_/g, " ")}</CardTitle>
                        <CardDescription className="text-xs">
                          {check.critical ? "Crítico" : "No crítico"} · {check.latency_ms}ms
                        </CardDescription>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Icon className={`h-5 w-5 ${cfg.color}`} />
                      <span className={`text-sm font-medium ${cfg.color}`}>
                        {statusLabel(check.status)}
                      </span>
                    </div>
                  </CardHeader>
                  {hasDetails && (
                    <CardContent className="pt-0 pb-3">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => toggleDetails(check.name)}
                        className="text-xs gap-1 h-6 px-2"
                      >
                        {show ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                        {show ? "Ocultar detalles" : "Ver detalles"}
                      </Button>
                      {show && check.details && (
                        <pre className="mt-2 text-xs bg-muted p-3 rounded-md overflow-auto max-h-48 text-muted-foreground">
                          {JSON.stringify(check.details, null, 2)}
                        </pre>
                      )}
                    </CardContent>
                  )}
                </Card>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
