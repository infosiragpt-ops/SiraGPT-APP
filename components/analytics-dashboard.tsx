"use client"

import { useState, useEffect } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { 
  BarChart3,
  TrendingUp,
  Users,
  DollarSign,
  Calendar,
  ArrowUpDown,
  RefreshCw
} from 'lucide-react'
import { toast } from 'sonner'
import { apiClient } from '@/lib/api'

import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
interface AnalyticsData {
  revenue: {
    mrr: number
    totalRevenue: number
    revenueByPlan: Array<{ plan: string; revenue: number; count: number }>
    averageRevenuePerUser: number
  }
  subscriptions: {
    active: number
    new: number
    cancelled: number
    netGrowth: number
    planDistribution: Array<{ plan: string; count: number; percentage: string }>
  }
  conversions: {
    freeUsers: number
    conversions: number
    conversionRate: number
    averageDaysToConvert: number
  }
  churn: {
    churnedCustomers: number
    churnRate: number
    lifetimeValue: number
    retentionRate: string
  }
}

interface AnalyticsDashboardProps {
  isAdmin: boolean
}

export default function AnalyticsDashboard({ isAdmin }: AnalyticsDashboardProps) {
  const [analytics, setAnalytics] = useState<AnalyticsData | null>(null)
  const [loading, setLoading] = useState(false)
  const [period, setPeriod] = useState('30d')

  useEffect(() => {
    if (isAdmin) {
      fetchAnalytics()
    }
  }, [isAdmin, period])

  const fetchAnalytics = async () => {
    if (!isAdmin) return

    setLoading(true)
    try {
      const data = await apiClient.getSubscriptionAnalytics(period)
      setAnalytics(data)
    } catch (error: any) {
      console.error('Error fetching analytics:', error)
      toast.error('Failed to load analytics')
    } finally {
      setLoading(false)
    }
  }

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD'
    }).format(amount)
  }

  if (!isAdmin) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <p className="text-muted-foreground">Se requiere acceso de administrador para ver las métricas</p>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Métricas de suscripciones</h2>
          <p className="text-muted-foreground">Ingresos, conversiones y métricas de suscripción</p>
        </div>

        <div className="flex items-center gap-2">
          <select
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            className="px-3 py-1 border rounded text-sm"
          >
            <option value="7d">Últimos 7 días</option>
            <option value="30d">Últimos 30 días</option>
            <option value="90d">Últimos 90 días</option>
          </select>
          
          <Button 
            variant="outline" 
            size="sm" 
            onClick={fetchAnalytics}
            disabled={loading}
          >
            {loading ? (
              <ThinkingIndicator size="sm" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
          </Button>
        </div>
      </div>

      {loading && !analytics ? (
        <Card>
          <CardContent className="flex items-center justify-center py-12">
            <ThinkingIndicator size="lg" className="mr-2" />
            <span>Cargando métricas…</span>
          </CardContent>
        </Card>
      ) : analytics ? (
        <>
          {/* Key Metrics */}
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Ingresos recurrentes mensuales</CardTitle>
                <DollarSign className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{formatCurrency(analytics.revenue.mrr)}</div>
                <p className="text-xs text-muted-foreground">
                  {formatCurrency(analytics.revenue.averageRevenuePerUser)} por usuario
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Suscripciones activas</CardTitle>
                <Users className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{analytics.subscriptions.active}</div>
                <p className="text-xs text-muted-foreground">
                  {analytics.subscriptions.netGrowth >= 0 ? '+' : ''}{analytics.subscriptions.netGrowth} en este periodo
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Tasa de conversión</CardTitle>
                <TrendingUp className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{analytics.conversions.conversionRate}%</div>
                <p className="text-xs text-muted-foreground">
                  {analytics.conversions.conversions} de {analytics.conversions.freeUsers} usuarios Free
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Tasa de retención</CardTitle>
                <BarChart3 className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{analytics.churn.retentionRate}%</div>
                <p className="text-xs text-muted-foreground">
                  {analytics.churn.churnedCustomers} cancelaciones en este periodo
                </p>
              </CardContent>
            </Card>
          </div>

          {/* Revenue Breakdown */}
          <div className="grid gap-6 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Ingresos por plan</CardTitle>
                <CardDescription>
                  Ingresos totales: {formatCurrency(analytics.revenue.totalRevenue)}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {analytics.revenue.revenueByPlan.map((plan) => (
                  <div key={plan.plan} className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">{plan.plan}</Badge>
                      <span className="text-sm text-muted-foreground">{plan.count} users</span>
                    </div>
                    <span className="font-medium">{formatCurrency(plan.revenue)}</span>
                  </div>
                ))}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Distribución por plan</CardTitle>
                <CardDescription>
                  Desglose de suscripciones activas
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {analytics.subscriptions.planDistribution.map((plan) => (
                  <div key={plan.plan} className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">{plan.plan}</Badge>
                    </div>
                    <div className="text-right">
                      <span className="font-medium">{plan.count}</span>
                      <span className="text-sm text-muted-foreground ml-2">({plan.percentage}%)</span>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>

          {/* Conversion Metrics */}
          <Card>
            <CardHeader>
              <CardTitle>Insights de conversión</CardTitle>
              <CardDescription>
                Cómo se convierten los usuarios de gratuitos a planes de pago
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 md:grid-cols-3">
                <div className="text-center p-4 border rounded-lg">
                  <div className="text-2xl font-bold text-blue-600">{analytics.conversions.freeUsers}</div>
                  <p className="text-sm text-muted-foreground">Usuarios Free</p>
                </div>
                <div className="text-center p-4 border rounded-lg">
                  <div className="text-2xl font-bold text-green-600">{analytics.conversions.conversions}</div>
                  <p className="text-sm text-muted-foreground">Conversiones</p>
                </div>
                <div className="text-center p-4 border rounded-lg">
                  <div className="text-2xl font-bold text-purple-600">
                    {Math.round(analytics.conversions.averageDaysToConvert)} d
                  </div>
                  <p className="text-sm text-muted-foreground">Tiempo promedio para convertir</p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Churn Analysis */}
          <Card>
            <CardHeader>
              <CardTitle>Cancelaciones y valor por cliente</CardTitle>
              <CardDescription>
                Retención y valor del cliente
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <div className="flex justify-between">
                    <span className="text-sm">Tasa de cancelación</span>
                    <span className="font-medium">{analytics.churn.churnRate}%</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-sm">Tasa de retención</span>
                    <span className="font-medium">{analytics.churn.retentionRate}%</span>
                  </div>
                </div>
                <div className="space-y-2">
                  <div className="flex justify-between">
                    <span className="text-sm">Valor de vida del cliente</span>
                    <span className="font-medium">{formatCurrency(analytics.churn.lifetimeValue)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-sm">Clientes cancelados</span>
                    <span className="font-medium">{analytics.churn.churnedCustomers}</span>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </>
      ) : (
        <Card>
          <CardContent className="flex items-center justify-center py-8">
            <p className="text-muted-foreground">No hay métricas disponibles</p>
          </CardContent>
        </Card>
      )}
    </div>
  )
}