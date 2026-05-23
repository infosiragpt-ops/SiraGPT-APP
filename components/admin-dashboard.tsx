"use client"

import { useState, useEffect } from "react"
import { Users, Bot, Activity, TrendingUp, TrendingDown, DollarSign } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { ThemeToggle } from "@/components/theme-toggle"
import { SidebarTrigger } from "@/components/ui/sidebar"

export function AdminDashboard() {
  const [analytics, setAnalytics] = useState<any>(null)

  useEffect(() => {
    // Simulate loading analytics data
    setTimeout(() => {
      setAnalytics({
        totalUsers: 2847,
        activeUsers: 1234,
        totalRevenue: 45231,
        totalApiCalls: 892000,
        usersByPlan: {
          Free: 1500,
          Pro: 800,
          Enterprise: 547,
        },
      })
    }, 1000)
  }, [])

  if (!analytics) {
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

  const stats = [
    {
      title: "Usuarios totales",
      value: analytics.totalUsers.toLocaleString(),
      change: "+12,5%",
      trend: "up",
      icon: Users,
    },
    {
      title: "Usuarios activos",
      value: analytics.activeUsers.toLocaleString(),
      change: "+8,2%",
      trend: "up",
      icon: Activity,
    },
    {
      title: "Ingresos totales",
      value: `$${analytics.totalRevenue.toLocaleString()}`,
      change: "+15,3%",
      trend: "up",
      icon: DollarSign,
    },
    {
      title: "Llamadas API",
      value: `${(analytics.totalApiCalls / 1000).toFixed(0)}K`,
      change: "-2,1%",
      trend: "down",
      icon: Bot,
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
          <Button size="sm" className="text-sm">Refrescar datos</Button>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid gap-3 sm:gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((stat) => (
          <Card key={stat.title}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">{stat.title}</CardTitle>
              <stat.icon className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stat.value}</div>
              <div className="flex items-center text-xs text-muted-foreground">
                {stat.trend === "up" && <TrendingUp className="mr-1 h-3 w-3 text-green-500" />}
                {stat.trend === "down" && <TrendingDown className="mr-1 h-3 w-3 text-red-500" />}
                <span
                  className={
                    stat.trend === "up"
                      ? "text-green-500"
                      : stat.trend === "down"
                        ? "text-red-500"
                        : "text-muted-foreground"
                  }
                >
                  {stat.change}
                </span>
                <span className="ml-1">vs. mes anterior</span>
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
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <div className="flex justify-between items-center">
                <span className="text-sm">Free</span>
                <div className="flex items-center gap-2">
                  <Progress value={60} className="w-20" />
                  <Badge variant="outline">{analytics.usersByPlan.Free}</Badge>
                </div>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm">Pro</span>
                <div className="flex items-center gap-2">
                  <Progress value={35} className="w-20" />
                  <Badge variant="secondary">{analytics.usersByPlan.Pro}</Badge>
                </div>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm">Enterprise</span>
                <div className="flex items-center gap-2">
                  <Progress value={25} className="w-20" />
                  <Badge variant="default">{analytics.usersByPlan.Enterprise}</Badge>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Estado del sistema</CardTitle>
            <CardDescription>Todos los servicios operativos</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <div className="flex items-center space-x-2">
                <div className="h-2 w-2 rounded-full bg-green-500"></div>
                <span className="text-sm">Base de datos: conectada</span>
              </div>
              <div className="flex items-center space-x-2">
                <div className="h-2 w-2 rounded-full bg-green-500"></div>
                <span className="text-sm">API: operativa</span>
              </div>
              <div className="flex items-center space-x-2">
                <div className="h-2 w-2 rounded-full bg-green-500"></div>
                <span className="text-sm">Servicios de IA: activos</span>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Acciones rápidas</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <Button variant="outline" size="sm" className="w-full justify-start">
              Exportar usuarios
            </Button>
            <Button variant="outline" size="sm" className="w-full justify-start">
              Generar reporte
            </Button>
            <Button variant="outline" size="sm" className="w-full justify-start">
              Backup del sistema
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* Recent Activity */}
      <Card>
        <CardHeader>
          <CardTitle>Actividad reciente</CardTitle>
          <CardDescription>Últimas acciones de usuarios y eventos del sistema</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {[
              { user: "Juan Pérez", action: "Inició nuevo chat", time: "hace 2 min", status: "active" },
              { user: "Ana Gómez", action: "Mejoró a PRO", time: "hace 5 min", status: "success" },
              { user: "Miguel Torres", action: "Alcanzó el límite de API", time: "hace 10 min", status: "warning" },
              { user: "Sofía Ruiz", action: "Cuenta creada", time: "hace 15 min", status: "success" },
            ].map((activity, index) => (
              <div key={index} className="flex items-center gap-3">
                <div
                  className={`w-2 h-2 rounded-full ${
                    activity.status === "success"
                      ? "bg-green-500"
                      : activity.status === "warning"
                        ? "bg-yellow-500"
                        : "bg-blue-500"
                  }`}
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{activity.user}</p>
                  <p className="text-xs text-muted-foreground">{activity.action}</p>
                </div>
                <span className="text-xs text-muted-foreground">{activity.time}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
