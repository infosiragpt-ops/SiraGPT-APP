"use client"

import { useEffect, useMemo, useState } from "react"
import { Activity, Bot, Database, DollarSign, Download, FileText, RefreshCw, Users } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { ThemeToggle } from "@/components/theme-toggle"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { apiClient } from "@/lib/api"
import { toast } from "sonner"

type AnalyticsSnapshot = {
  totalUsers?: number
  activeUsers?: number
  totalRevenue?: number
  totalApiUsage?: number
  totalChats?: number
  totalMessages?: number
  usersByPlan?: Record<string, number>
}

type AuditRow = {
  id: string
  actorName?: string | null
  actorId?: string | null
  action: string
  resourceType?: string | null
  createdAt: string
}

type ServicesSnapshot = {
  overall?: string
  services?: Record<string, { status?: string; detail?: string; latency_ms?: number } | string>
}

const PLAN_LABELS: Record<string, string> = {
  FREE: "Free",
  Free: "Free",
  PRO: "Pro",
  Pro: "Pro",
  PRO_MAX: "Pro Max",
  ENTERPRISE: "Enterprise",
  Enterprise: "Enterprise",
}

function formatNumber(value: unknown): string {
  const n = Number(value ?? 0)
  return Number.isFinite(n) ? n.toLocaleString() : "0"
}

function formatCurrency(value: unknown): string {
  const n = Number(value ?? 0)
  return Number.isFinite(n)
    ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(n)
    : "$0"
}

function formatDate(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return "Sin fecha"
  return date.toLocaleString("es-BO")
}

function normalizeServiceRows(snapshot: ServicesSnapshot | null) {
  return Object.entries(snapshot?.services || {}).map(([name, raw]) => {
    const info = typeof raw === "string" ? { status: raw } : raw || {}
    return {
      name,
      status: String(info.status || "unknown"),
      detail: info.detail,
      latency: info.latency_ms,
    }
  })
}

function downloadText(filename: string, content: string, type = "text/plain;charset=utf-8") {
  const blob = new Blob([content], { type })
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

export function AdminDashboard() {
  const [analytics, setAnalytics] = useState<AnalyticsSnapshot | null>(null)
  const [recentActivity, setRecentActivity] = useState<AuditRow[]>([])
  const [services, setServices] = useState<ServicesSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [exportingUsers, setExportingUsers] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadDashboard = async () => {
    setError(null)
    setRefreshing(true)
    try {
      const [analyticsResult, activityResult, servicesResult] = await Promise.allSettled([
        apiClient.getAnalytics(),
        apiClient.getAdminAuditLogs({ page: 1, limit: 6 }),
        apiClient.getAdminServiceHealth(),
      ])

      if (analyticsResult.status === "fulfilled") {
        setAnalytics(analyticsResult.value as AnalyticsSnapshot)
      } else {
        throw analyticsResult.reason
      }

      if (activityResult.status === "fulfilled") {
        const payload = activityResult.value as { items?: AuditRow[] }
        setRecentActivity(Array.isArray(payload.items) ? payload.items : [])
      } else {
        setRecentActivity([])
      }

      if (servicesResult.status === "fulfilled") {
        setServices(servicesResult.value as ServicesSnapshot)
      } else {
        setServices(null)
      }
    } catch (err: any) {
      const message = err?.message || "No se pudo cargar el panel real"
      setError(message)
      toast.error(message)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  useEffect(() => {
    loadDashboard()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const planRows = useMemo(() => {
    const source = analytics?.usersByPlan || {}
    const rows = Object.entries(source).map(([plan, count]) => ({
      plan: PLAN_LABELS[plan] || plan,
      count: Number(count || 0),
    }))
    return rows.sort((a, b) => b.count - a.count)
  }, [analytics])

  const serviceRows = useMemo(() => normalizeServiceRows(services).slice(0, 5), [services])

  const stats = [
    {
      title: "Usuarios totales",
      value: formatNumber(analytics?.totalUsers),
      description: "Registrados en base de datos",
      icon: Users,
    },
    {
      title: "Usuarios activos",
      value: formatNumber(analytics?.activeUsers),
      description: "Actividad real últimos 7 días",
      icon: Activity,
    },
    {
      title: "Ingresos totales",
      value: formatCurrency(analytics?.totalRevenue),
      description: "Pagos completados",
      icon: DollarSign,
    },
    {
      title: "Registros API",
      value: formatNumber(analytics?.totalApiUsage),
      description: "Filas reales de uso API",
      icon: Bot,
    },
  ]

  const exportUsers = async () => {
    setExportingUsers(true)
    try {
      const csv = await apiClient.exportUsersCsv()
      downloadText(`siragpt-users-${new Date().toISOString().slice(0, 10)}.csv`, csv, "text/csv;charset=utf-8")
      toast.success("Usuarios exportados")
    } catch (err: any) {
      toast.error(err?.message || "No se pudo exportar usuarios")
    } finally {
      setExportingUsers(false)
    }
  }

  if (loading && !analytics) {
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

  return (
    <div className="flex-1 space-y-4 sm:space-y-6 p-3 sm:p-4 lg:p-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sm:gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 sm:gap-3">
            <SidebarTrigger className="md:hidden" />
            <div>
              <h1 className="text-2xl sm:text-3xl font-bold">Panel de administración</h1>
              <p className="text-muted-foreground text-sm sm:text-base mt-1">
                Datos reales sincronizados con Sira GPT
              </p>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <ThemeToggle />
          <Button size="sm" className="text-sm gap-2" onClick={loadDashboard} disabled={refreshing}>
            <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
            Refrescar datos
          </Button>
        </div>
      </div>

      {error ? (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardContent className="pt-6 text-sm text-destructive">{error}</CardContent>
        </Card>
      ) : null}

      <div className="grid gap-3 sm:gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((stat) => (
          <Card key={stat.title}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">{stat.title}</CardTitle>
              <stat.icon className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stat.value}</div>
              <p className="mt-1 text-xs text-muted-foreground">{stat.description}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Usuarios por plan</CardTitle>
            <CardDescription>Distribución real por plan de cuenta</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {planRows.length === 0 ? (
                <p className="text-sm text-muted-foreground">Sin usuarios por plan.</p>
              ) : planRows.map((row) => {
                const total = Number(analytics?.totalUsers || 0)
                const progress = total > 0 ? Math.round((row.count / total) * 100) : 0
                return (
                  <div key={row.plan} className="flex items-center justify-between gap-3">
                    <span className="text-sm">{row.plan}</span>
                    <div className="flex min-w-[132px] items-center gap-2">
                      <Progress value={progress} className="w-20" />
                      <Badge variant="outline">{formatNumber(row.count)}</Badge>
                    </div>
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Estado del sistema</CardTitle>
            <CardDescription>{services?.overall ? `Salud general: ${services.overall}` : "Lectura en vivo del backend"}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {serviceRows.length === 0 ? (
                <p className="text-sm text-muted-foreground">No se pudo leer el estado de servicios.</p>
              ) : serviceRows.map((service) => (
                <div key={service.name} className="flex items-center justify-between gap-3 text-sm">
                  <span className="truncate capitalize">{service.name.replace(/([A-Z])/g, " $1")}</span>
                  <Badge variant={["ok", "healthy", "up"].includes(service.status.toLowerCase()) ? "default" : "secondary"}>
                    {service.status}
                  </Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Acciones rápidas</CardTitle>
            <CardDescription>Acciones conectadas al backend real</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <Button variant="outline" size="sm" className="w-full justify-start gap-2" onClick={exportUsers} disabled={exportingUsers}>
              {exportingUsers ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              Exportar usuarios
            </Button>
            <Button variant="outline" size="sm" className="w-full justify-start gap-2" onClick={() => window.location.assign("/admin/reports")}>
              <FileText className="h-4 w-4" />
              Generar reportes
            </Button>
            <Button variant="outline" size="sm" className="w-full justify-start gap-2" onClick={() => window.location.assign("/admin/database")}>
              <Database className="h-4 w-4" />
              Ver base de datos
            </Button>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Actividad reciente</CardTitle>
          <CardDescription>Últimos eventos reales del audit log</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {recentActivity.length === 0 ? (
              <p className="text-sm text-muted-foreground">Sin actividad reciente disponible.</p>
            ) : recentActivity.map((activity) => (
              <div key={activity.id} className="flex items-center gap-3">
                <div className="h-2 w-2 rounded-full bg-blue-500" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{activity.actorName || activity.actorId || "Sistema"}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {activity.action}{activity.resourceType ? ` · ${activity.resourceType}` : ""}
                  </p>
                </div>
                <span className="whitespace-nowrap text-xs text-muted-foreground">{formatDate(activity.createdAt)}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
