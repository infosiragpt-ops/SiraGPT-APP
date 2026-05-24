"use client"

import { useEffect, useState } from "react"
import { Activity, Bot, Database, FileText, MessageSquare, Users } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { ThemeToggle } from "@/components/theme-toggle"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { apiClient } from "@/lib/api"

interface SystemStats {
  database?: {
    users?: number
    chats?: number
    messages?: number
    files?: number
    payments?: number
    apiUsage?: number
  }
  storage?: {
    totalFiles?: number
    totalSize?: number
  }
  usersByPlan?: Record<string, number>
}

interface AuditRow {
  id: string
  action: string
  actorName?: string | null
  actorId?: string | null
  createdAt: string
  resourceType?: string | null
}

function bytesToHuman(bytes: number | undefined | null): string {
  if (!bytes || bytes < 0) return "—"
  const units = ["B", "KB", "MB", "GB", "TB"]
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`
}

function formatRelative(iso: string): string {
  try {
    const delta = Date.now() - new Date(iso).getTime()
    if (!Number.isFinite(delta) || delta < 0) return "—"
    const m = Math.floor(delta / 60000)
    if (m < 1) return "hace segundos"
    if (m < 60) return `hace ${m} min`
    const h = Math.floor(m / 60)
    if (h < 24) return `hace ${h} h`
    const d = Math.floor(h / 24)
    return `hace ${d} d`
  } catch {
    return "—"
  }
}

function actionTone(action: string): "success" | "warning" | "active" {
  if (/(failed|denied|revoked|rate_limit|abuse)/i.test(action)) return "warning"
  if (/(payment|invoice|upgrade|subscription)/i.test(action)) return "success"
  return "active"
}

export function AdminDashboard() {
  const [stats, setStats] = useState<SystemStats | null>(null)
  const [statsError, setStatsError] = useState<string | null>(null)
  const [activity, setActivity] = useState<AuditRow[] | null>(null)
  const [activityError, setActivityError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setStatsError(null)
    setActivityError(null)

    Promise.allSettled([
      apiClient.getSystemStats() as Promise<SystemStats>,
      apiClient.getAdminAuditLogs({ limit: 6 }) as Promise<{ items?: AuditRow[]; logs?: AuditRow[] }>,
    ])
      .then(([statsRes, activityRes]) => {
        if (cancelled) return
        if (statsRes.status === "fulfilled") {
          setStats(statsRes.value || {})
        } else {
          setStatsError(statsRes.reason?.message || "No se pudieron cargar las métricas")
        }
        if (activityRes.status === "fulfilled") {
          const payload = activityRes.value || {}
          const items = Array.isArray(payload.items)
            ? payload.items
            : Array.isArray(payload.logs)
              ? payload.logs
              : []
          setActivity(items)
        } else {
          setActivityError(activityRes.reason?.message || "No se pudo cargar la actividad reciente")
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [refreshKey])

  if (loading && !stats && !activity) {
    return (
      <div className="flex-1 space-y-4 sm:space-y-6 p-3 sm:p-4 lg:p-6">
        <div className="animate-pulse">
          <div className="flex items-center gap-2 sm:gap-3 mb-3 sm:mb-4">
            <SidebarTrigger className="md:hidden" />
            <div>
              <div className="h-6 sm:h-8 bg-muted rounded w-32 sm:w-48 mb-2"></div>
              <div className="h-3 sm:h-4 bg-muted rounded w-48 sm:w-64"></div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  const db = stats?.database || {}
  const storage = stats?.storage || {}
  const planMap = stats?.usersByPlan || {}
  const planEntries = Object.entries(planMap)
  const planTotal = planEntries.reduce((acc, [, v]) => acc + (Number(v) || 0), 0)

  const statCards = [
    {
      title: "Usuarios totales",
      value: typeof db.users === "number" ? db.users.toLocaleString() : "—",
      hint: typeof db.users === "number" ? null : "Pendiente",
      icon: Users,
    },
    {
      title: "Chats totales",
      value: typeof db.chats === "number" ? db.chats.toLocaleString() : "—",
      hint: typeof db.chats === "number" ? null : "Pendiente",
      icon: MessageSquare,
    },
    {
      title: "Mensajes procesados",
      value: typeof db.messages === "number" ? db.messages.toLocaleString() : "—",
      hint: typeof db.messages === "number" ? null : "Pendiente",
      icon: Bot,
    },
    {
      title: "Archivos en biblioteca",
      value:
        typeof db.files === "number"
          ? `${db.files.toLocaleString()} (${bytesToHuman(storage.totalSize)})`
          : "—",
      hint: typeof db.files === "number" ? null : "Pendiente",
      icon: FileText,
    },
  ]

  return (
    <div className="flex-1 space-y-4 sm:space-y-6 p-3 sm:p-4 lg:p-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sm:gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 sm:gap-3">
            <SidebarTrigger className="md:hidden" />
            <div>
              <h1 className="text-2xl sm:text-3xl font-bold">Panel de administración</h1>
              <p className="text-muted-foreground text-sm sm:text-base mt-1">Resumen general de tu plataforma Sira GPT</p>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <ThemeToggle />
          <Button
            size="sm"
            className="text-sm"
            onClick={() => setRefreshKey((k) => k + 1)}
            disabled={loading}
          >
            {loading ? "Actualizando…" : "Refrescar datos"}
          </Button>
        </div>
      </div>

      {statsError && (
        <Card className="border-amber-500/40 bg-amber-50/40 dark:bg-amber-950/20">
          <CardContent className="p-4 text-sm text-amber-700 dark:text-amber-300">
            No se pudieron cargar las métricas en vivo ({statsError}). Mostrando los campos disponibles.
          </CardContent>
        </Card>
      )}

      {/* Stats Grid — datos reales desde /api/admin/stats */}
      <div className="grid gap-3 sm:gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        {statCards.map((stat) => (
          <Card key={stat.title}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">{stat.title}</CardTitle>
              <stat.icon className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stat.value}</div>
              <div className="text-xs text-muted-foreground">
                {stat.hint ? <Badge variant="outline">{stat.hint}</Badge> : "Origen: base de datos"}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Plan Distribution and System Health */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Usuarios por plan</CardTitle>
            <CardDescription>
              {planEntries.length > 0 ? "Distribución en vivo" : "Pendiente de cómputo"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {planEntries.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Sin desglose por plan disponible aún. Se mostrará automáticamente cuando el
                endpoint <code>/api/admin/stats</code> incluya <code>usersByPlan</code>.
              </p>
            ) : (
              <div className="space-y-3">
                {planEntries.map(([plan, count]) => {
                  const pct = planTotal > 0 ? Math.round((Number(count) / planTotal) * 100) : 0
                  return (
                    <div key={plan} className="flex justify-between items-center">
                      <span className="text-sm capitalize">{plan.toLowerCase()}</span>
                      <div className="flex items-center gap-2">
                        <Progress value={pct} className="w-20" />
                        <Badge variant="outline">{Number(count).toLocaleString()}</Badge>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Estado del sistema</CardTitle>
            <CardDescription>
              {statsError
                ? "API admin: error"
                : stats
                  ? "API admin: operativa"
                  : "Verificando…"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <div className="flex items-center space-x-2">
                <div className={`h-2 w-2 rounded-full ${stats ? "bg-green-500" : "bg-amber-500"}`}></div>
                <span className="text-sm">
                  Base de datos: {stats ? "respondió" : "pendiente"}
                </span>
              </div>
              <div className="flex items-center space-x-2">
                <div className={`h-2 w-2 rounded-full ${stats ? "bg-green-500" : "bg-amber-500"}`}></div>
                <span className="text-sm">
                  API: {stats ? "operativa" : statsError ? "error" : "verificando"}
                </span>
              </div>
              <div className="flex items-center space-x-2">
                <div className={`h-2 w-2 rounded-full ${activity !== null ? "bg-green-500" : "bg-amber-500"}`}></div>
                <span className="text-sm">
                  Audit log: {activity !== null ? "respondió" : "pendiente"}
                </span>
              </div>
              <p className="pt-2 text-xs text-muted-foreground">
                Para diagnóstico completo, abrir Estado o Reportes.
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Acciones rápidas</CardTitle>
            <CardDescription>Atajos a otras secciones del panel</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <Button variant="outline" size="sm" className="w-full justify-start" asChild>
              <a href="/admin/users">Exportar usuarios</a>
            </Button>
            <Button variant="outline" size="sm" className="w-full justify-start" asChild>
              <a href="/admin/reports">Generar reporte</a>
            </Button>
            <Button variant="outline" size="sm" className="w-full justify-start" asChild>
              <a href="/admin/database">Backup del sistema</a>
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* Recent Activity — desde audit logs reales */}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between space-y-0">
          <div>
            <CardTitle>Actividad reciente</CardTitle>
            <CardDescription>Últimas acciones registradas en el audit log</CardDescription>
          </div>
          <Database className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          {activityError ? (
            <p className="text-sm text-amber-600">{activityError}</p>
          ) : activity === null ? (
            <p className="text-sm text-muted-foreground">Cargando audit log…</p>
          ) : activity.length === 0 ? (
            <p className="text-sm text-muted-foreground">Sin actividad reciente registrada.</p>
          ) : (
            <div className="space-y-4">
              {activity.map((item) => {
                const tone = actionTone(item.action || "")
                return (
                  <div key={item.id} className="flex items-center gap-3">
                    <div
                      className={`w-2 h-2 rounded-full flex-shrink-0 ${
                        tone === "success"
                          ? "bg-green-500"
                          : tone === "warning"
                            ? "bg-yellow-500"
                            : "bg-blue-500"
                      }`}
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">
                        {item.actorName || item.actorId || "Sistema"}
                      </p>
                      <p className="text-xs text-muted-foreground truncate">
                        <Activity className="inline h-3 w-3 mr-1 align-text-bottom" />
                        {item.action}
                        {item.resourceType ? ` · ${item.resourceType}` : ""}
                      </p>
                    </div>
                    <span className="text-xs text-muted-foreground flex-shrink-0">
                      {formatRelative(item.createdAt)}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
