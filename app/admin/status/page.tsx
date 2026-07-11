"use client"

/**
 * /admin/status — internal super-admin operational dashboard (cycle 45).
 *
 * Aggregates the existing read-only admin endpoints into one page:
 *   - /api/admin/health/services   service probes (postgres / redis / stripe / smtp / providers)
 *   - /api/admin/queues            queue counts (waiting / active / failed)
 *   - /api/admin/stats/users       user totals + MRR + new/active this week
 *   - /metrics                     prometheus exposition (histogram percentiles)
 *
 * Auto-refreshes every 30s. Pure read-only; mounted under the existing
 * <AuthGuard requireAdmin> in app/admin/layout.tsx so super-admin
 * checks bubble up from the API endpoints themselves.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { RefreshCw } from "lucide-react"
import { authenticatedFetch } from "@/lib/authenticated-fetch"

type ServiceStatus = "ok" | "healthy" | "up" | "degraded" | "warn" | "down" | "fail" | "unknown" | string

interface ServicesSnapshot {
  overall?: string
  services?: Record<string, { status?: ServiceStatus; latency_ms?: number; detail?: string } | ServiceStatus>
}

interface QueuesSnapshot {
  queues?: Array<{ name: string; counts?: Record<string, number> }>
  error?: string
}

interface UserStatsSnapshot {
  totalUsers?: number
  activeThisWeek?: number
  newThisWeek?: number
  mrrUsd?: number
  mrr?: number
  [k: string]: any
}

interface PercentileBucket {
  metric: string
  p50?: number
  p95?: number
  count?: number
}

function statusVariant(s: ServiceStatus | undefined): "default" | "secondary" | "destructive" {
  if (!s) return "secondary"
  const v = String(s).toLowerCase()
  if (v === "ok" || v === "healthy" || v === "up") return "default"
  if (v === "degraded" || v === "warn") return "secondary"
  return "destructive"
}

/**
 * Very lightweight Prometheus text-format parser — extracts p50/p95
 * from any `*_bucket{le="..."}` histograms we expose. Designed to be
 * forgiving: if /metrics returns HTML/error, we just show nothing.
 */
function parsePercentiles(text: string): PercentileBucket[] {
  if (typeof text !== "string" || !text.length) return []
  const histograms = new Map<string, { buckets: Array<{ le: number; v: number }>; count: number }>()
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue
    const m = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)_bucket\{([^}]*)\}\s+([0-9.eE+-]+)/)
    if (m) {
      const name = m[1]
      const labels = m[2]
      const value = Number(m[3])
      const leMatch = labels.match(/le="([^"]+)"/)
      if (!leMatch) continue
      const le = leMatch[1] === "+Inf" ? Infinity : Number(leMatch[1])
      if (!Number.isFinite(value) || Number.isNaN(le)) continue
      const entry = histograms.get(name) || { buckets: [], count: 0 }
      entry.buckets.push({ le, v: value })
      histograms.set(name, entry)
      continue
    }
    const cm = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)_count\s+([0-9.eE+-]+)/)
    if (cm) {
      const name = cm[1]
      const count = Number(cm[2])
      const entry = histograms.get(name) || { buckets: [], count: 0 }
      entry.count = count
      histograms.set(name, entry)
    }
  }
  const result: PercentileBucket[] = []
  for (const [name, h] of histograms.entries()) {
    if (!h.buckets.length || !h.count) continue
    const sorted = h.buckets.slice().sort((a, b) => a.le - b.le)
    const pick = (pct: number): number | undefined => {
      const target = h.count * pct
      for (const b of sorted) {
        if (b.v >= target) return b.le === Infinity ? undefined : b.le
      }
      return undefined
    }
    result.push({ metric: name, p50: pick(0.5), p95: pick(0.95), count: h.count })
  }
  return result.sort((a, b) => a.metric.localeCompare(b.metric)).slice(0, 12)
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await authenticatedFetch(url, { headers: { Accept: "application/json" } })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

async function fetchPublicMetrics(): Promise<string | null> {
  try {
    const res = await fetch("/metrics", { headers: { Accept: "text/plain" } })
    if (!res.ok) return null
    return await res.text()
  } catch {
    return null
  }
}

export default function AdminStatusPage() {
  const [services, setServices] = useState<ServicesSnapshot | null>(null)
  const [queues, setQueues] = useState<QueuesSnapshot | null>(null)
  const [userStats, setUserStats] = useState<UserStatsSnapshot | null>(null)
  const [metricsText, setMetricsText] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    const [s, q, u, m] = await Promise.all([
      fetchJson<ServicesSnapshot>("/api/admin/health/services"),
      fetchJson<QueuesSnapshot>("/api/admin/queues"),
      fetchJson<UserStatsSnapshot>("/api/admin/stats/users"),
      fetchPublicMetrics(),
    ])
    setServices(s)
    setQueues(q)
    setUserStats(u)
    setMetricsText(m)
    setLastRefresh(new Date())
    setLoading(false)
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  useEffect(() => {
    const id = setInterval(refresh, 30_000)
    return () => clearInterval(id)
  }, [refresh])

  const percentiles = useMemo(() => (metricsText ? parsePercentiles(metricsText) : []), [metricsText])
  const serviceRows = useMemo(() => {
    const out: Array<{ name: string; status: string; detail?: string; latency?: number }> = []
    const src = services?.services || {}
    for (const [name, info] of Object.entries(src)) {
      if (info && typeof info === "object") {
        const status = (info.status as string) || "unknown"
        out.push({ name, status, detail: info.detail, latency: info.latency_ms })
      } else {
        out.push({ name, status: String(info ?? "unknown") })
      }
    }
    return out
  }, [services])

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Estado operativo</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Snapshot consolidado para super-admin · auto-refresh 30s
            {lastRefresh ? ` · last ${lastRefresh.toLocaleTimeString()}` : ""}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={refresh} disabled={loading} className="gap-1.5">
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          Recargar
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Servicios</CardTitle>
          <CardDescription>
            /api/admin/health/services · overall: <span className="font-mono">{services?.overall || "—"}</span>
          </CardDescription>
        </CardHeader>
        <CardContent>
          {serviceRows.length === 0 ? (
            <p className="text-sm text-muted-foreground">Sin datos.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-muted-foreground border-b">
                    <th className="py-2 pr-4">Servicio</th>
                    <th className="py-2 pr-4">Estado</th>
                    <th className="py-2 pr-4">Latencia</th>
                    <th className="py-2">Detalle</th>
                  </tr>
                </thead>
                <tbody>
                  {serviceRows.map((row) => (
                    <tr key={row.name} className="border-b last:border-0">
                      <td className="py-2 pr-4 font-mono">{row.name}</td>
                      <td className="py-2 pr-4">
                        <Badge variant={statusVariant(row.status)}>{row.status}</Badge>
                      </td>
                      <td className="py-2 pr-4 text-muted-foreground">
                        {typeof row.latency === "number" ? `${row.latency}ms` : "—"}
                      </td>
                      <td className="py-2 text-muted-foreground truncate max-w-md">{row.detail || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Colas</CardTitle>
          <CardDescription>/api/admin/queues</CardDescription>
        </CardHeader>
        <CardContent>
          {queues?.error ? (
            <p className="text-sm text-destructive">{queues.error}</p>
          ) : !queues?.queues?.length ? (
            <p className="text-sm text-muted-foreground">Sin colas registradas.</p>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {queues.queues.map((q) => (
                <div key={q.name} className="border rounded-md p-3">
                  <div className="font-mono text-sm mb-2">{q.name}</div>
                  <div className="grid grid-cols-3 gap-2 text-xs">
                    {Object.entries(q.counts || {}).map(([k, v]) => (
                      <div key={k} className="text-center">
                        <div className="text-lg font-semibold">{v}</div>
                        <div className="text-muted-foreground">{k}</div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Usuarios</CardTitle>
          <CardDescription>/api/admin/stats/users</CardDescription>
        </CardHeader>
        <CardContent>
          {!userStats ? (
            <p className="text-sm text-muted-foreground">Sin datos.</p>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="text-center">
                <div className="text-2xl font-bold">{userStats.totalUsers ?? "—"}</div>
                <div className="text-xs text-muted-foreground">Total</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold">{userStats.newThisWeek ?? "—"}</div>
                <div className="text-xs text-muted-foreground">Nuevos (7d)</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold">{userStats.activeThisWeek ?? "—"}</div>
                <div className="text-xs text-muted-foreground">Activos (7d)</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold">
                  ${typeof userStats.mrrUsd === "number" ? userStats.mrrUsd.toFixed(2) : userStats.mrr ?? "—"}
                </div>
                <div className="text-xs text-muted-foreground">MRR</div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Latencias (p50 / p95)</CardTitle>
          <CardDescription>/metrics · derivadas de histogramas Prometheus</CardDescription>
        </CardHeader>
        <CardContent>
          {percentiles.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {metricsText === null ? "Endpoint /metrics no accesible." : "No se detectaron histogramas."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-muted-foreground border-b">
                    <th className="py-2 pr-4">Métrica</th>
                    <th className="py-2 pr-4">p50</th>
                    <th className="py-2 pr-4">p95</th>
                    <th className="py-2">Muestras</th>
                  </tr>
                </thead>
                <tbody>
                  {percentiles.map((p) => (
                    <tr key={p.metric} className="border-b last:border-0">
                      <td className="py-2 pr-4 font-mono text-xs">{p.metric}</td>
                      <td className="py-2 pr-4">{typeof p.p50 === "number" ? p.p50 : "—"}</td>
                      <td className="py-2 pr-4">{typeof p.p95 === "number" ? p.p95 : "—"}</td>
                      <td className="py-2 text-muted-foreground">{p.count ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
