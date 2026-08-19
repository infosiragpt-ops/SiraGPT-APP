"use client"

import { useEffect, useMemo, useState, type ReactNode } from "react"
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
import { Ban, CircleCheckBig, RefreshCw, ShieldCheck, ThumbsUp, UsersRound } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { apiClient } from "@/lib/api"
import { toast } from "sonner"

const COLORS = ["#0f172a", "#2563eb", "#16a34a", "#f59e0b", "#dc2626", "#7c3aed"]

type AnalyticsPayload = {
  totalUsers?: number
  activeUsers?: number
  totalRevenue?: number
  totalApiUsage?: number
  usersByPlan?: Record<string, number>
  apiUsageByModel?: Array<{ model: string; tokens?: number; count?: number }>
  revenueByMonth?: Record<string, number>
}

type UserStatsPayload = {
  signupTrend?: Array<{ date: string; count: number }>
  breakdownByPlan?: Record<string, number>
}

type UsageStatsPayload = {
  byModel?: Array<{ model: string; provider?: string; tokens?: number; calls?: number; cost?: number }>
  totalTokens?: number
  totalCost?: number
}

type ProductQualityPayload = {
  adoption?: {
    activeUsers?: number
    adopters?: number
    adoptionRate?: number | null
  }
  outcomes?: {
    started?: number
    terminal?: number
    completed?: number
    failed?: number
    cancelled?: number
    successRate?: number | null
    cancellationRate?: number | null
  }
  satisfaction?: {
    assistantMessages?: number
    feedbackResponses?: number
    satisfactionRate?: number | null
    feedbackCoverageRate?: number | null
    suppressed?: boolean
  }
  trend?: Array<{
    date: string
    started: number | null
    completed: number | null
    failed: number | null
    cancelled: number | null
    suppressed?: boolean
  }>
  privacy?: {
    containsPii?: boolean
    aggregationOnly?: boolean
    minimumCohort?: number
  }
}

type AnalyticsState = {
  summary: AnalyticsPayload
  userStats: UserStatsPayload | null
  usageStats: UsageStatsPayload | null
  productQuality: ProductQualityPayload | null
}

function rangeFor(value: string) {
  const days = value === "90d" ? 90 : value === "30d" ? 30 : 7
  const to = new Date()
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000)
  return { from: from.toISOString(), to: to.toISOString() }
}

function formatNumber(value: unknown) {
  const n = Number(value || 0)
  return Number.isFinite(n) ? n.toLocaleString() : "0"
}

function formatCurrency(value: unknown) {
  const n = Number(value || 0)
  return Number.isFinite(n)
    ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(n)
    : "$0"
}

function safePercent(part: unknown, total: unknown) {
  const p = Number(part || 0)
  const t = Number(total || 0)
  if (!Number.isFinite(p) || !Number.isFinite(t) || t <= 0) return "0.0"
  return ((p / t) * 100).toFixed(1)
}

function formatRate(value: number | null | undefined) {
  if (value == null || !Number.isFinite(Number(value))) return "Protegido"
  return `${(Number(value) * 100).toFixed(1)}%`
}

function QualityMetric({
  icon,
  label,
  value,
  detail,
}: {
  icon: ReactNode
  label: string
  value: string
  detail: string
}) {
  return (
    <Card>
      <CardContent className="p-4 sm:p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-muted-foreground">{label}</p>
            <p className="mt-2 text-2xl font-semibold tabular-nums">{value}</p>
          </div>
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border bg-muted/40 text-foreground">
            {icon}
          </div>
        </div>
        <p className="mt-3 text-xs leading-5 text-muted-foreground">{detail}</p>
      </CardContent>
    </Card>
  )
}

export default function AnalyticsPage() {
  const [analytics, setAnalytics] = useState<AnalyticsState | null>(null)
  const [timeRange, setTimeRange] = useState("7d")
  const [loading, setLoading] = useState(false)

  const loadAnalytics = async () => {
    setLoading(true)
    try {
      const range = rangeFor(timeRange)
      const [summaryResult, userStatsResult, usageStatsResult, productQualityResult] = await Promise.allSettled([
        apiClient.getAnalytics(),
        apiClient.getAdminUserStats(range),
        apiClient.getAdminUsageStats(range),
        apiClient.getAdminProductQualityStats(range),
      ])

      if (summaryResult.status !== "fulfilled") throw summaryResult.reason

      setAnalytics({
        summary: summaryResult.value as AnalyticsPayload,
        userStats: userStatsResult.status === "fulfilled" ? (userStatsResult.value as UserStatsPayload) : null,
        usageStats: usageStatsResult.status === "fulfilled" ? (usageStatsResult.value as UsageStatsPayload) : null,
        productQuality: productQualityResult.status === "fulfilled"
          ? (productQualityResult.value as ProductQualityPayload)
          : null,
      })
    } catch (error: any) {
      console.error("Failed to load analytics:", error)
      toast.error(error?.message || "No se pudieron cargar métricas reales")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadAnalytics()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeRange])

  const userGrowth = useMemo(() => {
    return (analytics?.userStats?.signupTrend || []).map((row) => ({
      date: row.date,
      users: Number(row.count || 0),
    }))
  }, [analytics])

  const revenueTrend = useMemo(() => {
    return Object.entries(analytics?.summary.revenueByMonth || {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, revenue]) => ({ date, revenue: Number(revenue || 0) }))
  }, [analytics])

  const modelUsage = useMemo(() => {
    const detailed = analytics?.usageStats?.byModel || []
    if (detailed.length) {
      return detailed.slice(0, 8).map((model) => ({
        name: model.model,
        value: Number(model.calls || 0),
        usage: Number(model.tokens || 0),
        cost: Number(model.cost || 0),
      }))
    }

    return (analytics?.summary.apiUsageByModel || []).slice(0, 8).map((model) => ({
      name: model.model,
      value: Number(model.count || 0),
      usage: Number(model.tokens || 0),
      cost: 0,
    }))
  }, [analytics])

  const productQualityTrend = useMemo(() => {
    return (analytics?.productQuality?.trend || []).map((row) => ({
      date: row.date,
      Iniciadas: row.started,
      Completadas: row.completed,
      Fallidas: row.failed,
      Canceladas: row.cancelled,
    }))
  }, [analytics])

  const usersByPlan = analytics?.userStats?.breakdownByPlan || analytics?.summary.usersByPlan || {}
  const totalUsers = Number(analytics?.summary.totalUsers || 0)
  const totalRevenue = Number(analytics?.summary.totalRevenue || 0)
  const activeUsers = Number(analytics?.summary.activeUsers || 0)
  const totalApiUsage = Number(analytics?.summary.totalApiUsage || 0)
  const productQuality = analytics?.productQuality
  const adoption = productQuality?.adoption
  const outcomes = productQuality?.outcomes
  const satisfaction = productQuality?.satisfaction
  const hasProductQualityEvents = productQualityTrend.some((row) =>
    [row.Iniciadas, row.Completadas, row.Fallidas, row.Canceladas].some(
      (value) => typeof value === "number" && value > 0,
    ),
  )

  if (!analytics && loading) {
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
              <h1 className="text-2xl sm:text-3xl font-bold">Métricas</h1>
              <p className="text-muted-foreground text-sm sm:text-base mt-1">
                Analítica real desde base de datos, pagos y uso API
              </p>
            </div>
          </div>
        </div>
        <div className="flex gap-1 sm:gap-2 flex-shrink-0 flex-wrap">
          {(["7d", "30d", "90d"] as const).map((range) => (
            <Button
              key={range}
              variant={timeRange === range ? "default" : "outline"}
              onClick={() => setTimeRange(range)}
              size="sm"
              className="text-xs sm:text-sm"
            >
              {range === "7d" ? "7 días" : range === "30d" ? "30 días" : "90 días"}
            </Button>
          ))}
          <Button variant="outline" size="sm" onClick={loadAnalytics} disabled={loading} className="gap-2">
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            Recargar
          </Button>
        </div>
      </div>

      <section aria-labelledby="product-quality-title" className="space-y-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 id="product-quality-title" className="text-lg font-semibold sm:text-xl">Calidad del producto</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Adopción, resultados y satisfacción en el periodo seleccionado
            </p>
          </div>
          {productQuality?.privacy?.aggregationOnly && (
            <div className="inline-flex w-fit items-center gap-2 rounded-md border px-3 py-2 text-xs text-muted-foreground">
              <ShieldCheck className="h-4 w-4" aria-hidden="true" />
              Datos agregados · cohorte mínima {productQuality.privacy.minimumCohort || 5}
            </div>
          )}
        </div>

        {!productQuality ? (
          <Card>
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              La analítica de calidad no está disponible para esta cuenta administrativa.
            </CardContent>
          </Card>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <QualityMetric
                icon={<UsersRound className="h-5 w-5" aria-hidden="true" />}
                label="Adopción activa"
                value={formatRate(adoption?.adoptionRate)}
                detail={`${formatNumber(adoption?.adopters)} de ${formatNumber(adoption?.activeUsers)} usuarios activos`}
              />
              <QualityMetric
                icon={<CircleCheckBig className="h-5 w-5" aria-hidden="true" />}
                label="Generaciones exitosas"
                value={formatRate(outcomes?.successRate)}
                detail={`${formatNumber(outcomes?.completed)} de ${formatNumber(outcomes?.terminal)} resultados finalizados`}
              />
              <QualityMetric
                icon={<Ban className="h-5 w-5" aria-hidden="true" />}
                label="Cancelaciones"
                value={formatRate(outcomes?.cancellationRate)}
                detail={`${formatNumber(outcomes?.cancelled)} cancelaciones en el periodo`}
              />
              <QualityMetric
                icon={<ThumbsUp className="h-5 w-5" aria-hidden="true" />}
                label="Satisfacción"
                value={formatRate(satisfaction?.satisfactionRate)}
                detail={`${formatNumber(satisfaction?.feedbackResponses)} valoraciones · ${formatRate(satisfaction?.feedbackCoverageRate)} de cobertura`}
              />
            </div>

            <Card>
              <CardHeader>
                <CardTitle className="text-base sm:text-lg">Evolución de ejecuciones</CardTitle>
                <CardDescription>Inicios y resultados diarios de chat y agentes</CardDescription>
              </CardHeader>
              <CardContent>
                {!hasProductQualityEvents ? (
                  <div className="h-[280px] content-center text-center text-sm text-muted-foreground">
                    Sin ejecuciones registradas en el periodo.
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height={300}>
                    <BarChart data={productQualityTrend} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="date" interval="preserveStartEnd" minTickGap={24} />
                      <YAxis allowDecimals={false} />
                      <Tooltip />
                      <Legend />
                      <Bar dataKey="Iniciadas" fill="#334155" radius={[3, 3, 0, 0]} />
                      <Bar dataKey="Completadas" fill="#16a34a" radius={[3, 3, 0, 0]} />
                      <Bar dataKey="Fallidas" fill="#dc2626" radius={[3, 3, 0, 0]} />
                      <Bar dataKey="Canceladas" fill="#d97706" radius={[3, 3, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Crecimiento de usuarios</CardTitle>
          <CardDescription>Altas reales registradas por día</CardDescription>
        </CardHeader>
        <CardContent>
          {userGrowth.length === 0 ? (
            <div className="h-[300px] content-center text-center text-sm text-muted-foreground">Sin altas en el rango disponible.</div>
          ) : (
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={userGrowth}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" />
                <YAxis allowDecimals={false} />
                <Tooltip />
                <Line type="monotone" dataKey="users" stroke="#2563eb" strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Ingresos por mes</CardTitle>
            <CardDescription>Pagos completados agregados por mes</CardDescription>
          </CardHeader>
          <CardContent>
            {revenueTrend.length === 0 ? (
              <div className="h-[300px] content-center text-center text-sm text-muted-foreground">Sin pagos completados.</div>
            ) : (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={revenueTrend}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" />
                  <YAxis />
                  <Tooltip formatter={(value) => formatCurrency(value)} />
                  <Bar dataKey="revenue" fill="#16a34a" />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Uso por modelo</CardTitle>
            <CardDescription>Distribución real por registros de uso API</CardDescription>
          </CardHeader>
          <CardContent>
            {modelUsage.length === 0 ? (
              <div className="h-[300px] content-center text-center text-sm text-muted-foreground">Sin uso API registrado.</div>
            ) : (
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie
                    data={modelUsage}
                    cx="50%"
                    cy="50%"
                    labelLine={false}
                    label={({ name, percent }: any) => `${name} ${(percent * 100).toFixed(0)}%`}
                    outerRadius={80}
                    fill="#8884d8"
                    dataKey="value"
                  >
                    {modelUsage.map((entry, index) => (
                      <Cell key={`cell-${entry.name}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Modelos con uso</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {modelUsage.length === 0 ? (
                <p className="text-sm text-muted-foreground">Sin registros.</p>
              ) : modelUsage.map((model, index) => (
                <div key={model.name} className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <div className="h-3 w-3 rounded-full" style={{ backgroundColor: COLORS[index % COLORS.length] }} />
                    <span className="truncate text-sm font-medium">{model.name}</span>
                  </div>
                  <span className="text-sm text-muted-foreground">{formatNumber(model.usage)}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Usuarios por plan</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {Object.entries(usersByPlan).length === 0 ? (
                <p className="text-sm text-muted-foreground">Sin datos de planes.</p>
              ) : Object.entries(usersByPlan).map(([plan, count]) => (
                <div key={plan} className="flex justify-between gap-3">
                  <span className="text-sm">{plan.replace("_", " ")}</span>
                  <span className="text-sm font-medium">{formatNumber(count)}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Métricas clave</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <div className="flex justify-between gap-3">
                <span className="text-sm">Ingresos por usuario</span>
                <span className="text-sm font-medium">{formatCurrency(totalUsers > 0 ? totalRevenue / totalUsers : 0)}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-sm">Usuarios activos</span>
                <span className="text-sm font-medium">{safePercent(activeUsers, totalUsers)}%</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-sm">Registros API por usuario</span>
                <span className="text-sm font-medium">{formatNumber(totalUsers > 0 ? totalApiUsage / totalUsers : 0)}</span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
