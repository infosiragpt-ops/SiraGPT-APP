"use client"

import { useEffect, useMemo, useState } from "react"
import { Activity, Bot, Database, DollarSign, Download, FileText, RefreshCw, Users } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { ThemeToggle } from "@/components/theme-toggle"
import { AdminPageHeader, AdminStatCard, AdminPageBody } from "@/components/admin/admin-chrome"
import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
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
      <>
        <AdminPageHeader title="Panel" description="Cargando datos reales…" />
        <AdminPageBody>
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="admin-stat animate-pulse">
                <div className="h-3 w-16 rounded bg-muted" />
                <div className="mt-2 h-6 w-20 rounded bg-muted" />
              </div>
            ))}
          </div>
        </AdminPageBody>
      </>
    )
  }

  return (
    <>
      <AdminPageHeader
        title="Panel"
        description="Datos reales sincronizados con Sira GPT"
        actions={
          <>
            <ThemeToggle />
            <Button size="sm" className="h-8 gap-1.5 text-[13px]" onClick={loadDashboard} disabled={refreshing}>
              <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
              Refrescar
            </Button>
          </>
        }
      />
      <AdminPageBody className="space-y-4">

      {error ? (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardContent className="pt-6 text-sm text-destructive">{error}</CardContent>
        </Card>
      ) : null}

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {stats.map((stat) => (
          <AdminStatCard
            key={stat.title}
            title={stat.title}
            value={stat.value}
            description={stat.description}
            icon={stat.icon}
          />
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
              {exportingUsers ? <ThinkingIndicator size="sm" /> : <Download className="h-4 w-4" />}
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
      </AdminPageBody>
    </>
  )
}
