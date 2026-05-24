"use client"

import { useEffect, useMemo, useState } from "react"
import { CreditCard, DollarSign, Filter, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { apiClient } from "@/lib/api"
import { toast } from "sonner"

type PaymentRow = {
  id: string
  userId: string
  amount: number
  currency?: string
  status: string
  plan?: string
  provider?: string
  createdAt?: string
  user?: { name?: string | null; email?: string | null } | null
}

type AnalyticsPayload = {
  totalRevenue?: number
  totalPayments?: number
}

const STATUS_OPTIONS = [
  { value: "all", label: "Todos" },
  { value: "COMPLETED", label: "Completados" },
  { value: "PENDING", label: "Pendientes" },
  { value: "FAILED", label: "Fallidos" },
  { value: "CANCELLED", label: "Cancelados" },
]

function formatCurrency(value: unknown, currency = "USD") {
  const n = Number(value || 0)
  return Number.isFinite(n)
    ? new Intl.NumberFormat("en-US", { style: "currency", currency: currency || "USD", maximumFractionDigits: 2 }).format(n)
    : "$0"
}

function formatDate(value?: string) {
  if (!value) return "N/A"
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleString("es-BO") : "N/A"
}

function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  const normalized = status.toUpperCase()
  if (normalized === "COMPLETED") return "default"
  if (normalized === "PENDING") return "secondary"
  if (normalized === "FAILED" || normalized === "CANCELLED") return "destructive"
  return "outline"
}

export default function PaymentsPage() {
  const [payments, setPayments] = useState<PaymentRow[]>([])
  const [statusFilter, setStatusFilter] = useState("all")
  const [analytics, setAnalytics] = useState<AnalyticsPayload | null>(null)
  const [totalCount, setTotalCount] = useState(0)
  const [loading, setLoading] = useState(false)

  const loadPayments = async () => {
    setLoading(true)
    try {
      const [paymentResult, analyticsResult] = await Promise.allSettled([
        apiClient.getAllPayments(
          statusFilter === "all"
            ? { page: 1, limit: 500 }
            : { page: 1, limit: 500, status: statusFilter },
        ),
        apiClient.getAnalytics(),
      ])

      if (paymentResult.status !== "fulfilled") throw paymentResult.reason

      const data = paymentResult.value as { payments?: PaymentRow[]; pagination?: { total?: number } }
      setPayments(Array.isArray(data.payments) ? data.payments : [])
      setTotalCount(Number(data.pagination?.total || data.payments?.length || 0))

      if (analyticsResult.status === "fulfilled") {
        setAnalytics(analyticsResult.value as AnalyticsPayload)
      }
    } catch (error: any) {
      console.error("Failed to load payments:", error)
      toast.error(error?.message || "No se pudieron cargar pagos reales")
      setPayments([])
      setTotalCount(0)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadPayments()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter])

  const totals = useMemo(() => {
    const completed = payments.filter((p) => p.status?.toUpperCase() === "COMPLETED")
    const pending = payments.filter((p) => p.status?.toUpperCase() === "PENDING")
    return {
      loadedRevenue: completed.reduce((sum, p) => sum + Number(p.amount || 0), 0),
      pendingRevenue: pending.reduce((sum, p) => sum + Number(p.amount || 0), 0),
      completedPayments: completed.length,
      loadedPayments: payments.length,
    }
  }, [payments])

  return (
    <div className="flex-1 space-y-4 sm:space-y-6 p-3 sm:p-4 lg:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 sm:gap-3">
            <SidebarTrigger className="md:hidden" />
            <div>
              <h1 className="text-2xl sm:text-3xl font-bold">Pagos</h1>
              <p className="text-muted-foreground text-sm sm:text-base mt-1">Transacciones reales registradas en la plataforma</p>
            </div>
          </div>
        </div>
        <Button variant="outline" onClick={loadPayments} disabled={loading} className="gap-2">
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          Recargar
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Ingresos totales</CardTitle>
            <DollarSign className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatCurrency(analytics?.totalRevenue ?? totals.loadedRevenue)}</div>
            <p className="text-xs text-muted-foreground">Pagos completados reales</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Ingresos pendientes</CardTitle>
            <CreditCard className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatCurrency(totals.pendingRevenue)}</div>
            <p className="text-xs text-muted-foreground">Registros cargados</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Completados</CardTitle>
            <CreditCard className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totals.completedPayments.toLocaleString()}</div>
            <p className="text-xs text-muted-foreground">En registros cargados</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Transacciones</CardTitle>
            <CreditCard className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{(analytics?.totalPayments ?? totalCount).toLocaleString()}</div>
            <p className="text-xs text-muted-foreground">Total backend</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Filtros</CardTitle>
        </CardHeader>
        <CardContent>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="gap-2">
                <Filter className="h-4 w-4" />
                Estado: {STATUS_OPTIONS.find((option) => option.value === statusFilter)?.label || statusFilter}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              {STATUS_OPTIONS.map((option) => (
                <DropdownMenuItem key={option.value} onClick={() => setStatusFilter(option.value)}>
                  {option.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Transacciones ({totalCount.toLocaleString()})</CardTitle>
          <CardDescription>Mostrando hasta 500 registros reales ordenados por fecha</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Transacción</TableHead>
                  <TableHead>Usuario</TableHead>
                  <TableHead>Monto</TableHead>
                  <TableHead>Plan</TableHead>
                  <TableHead>Proveedor</TableHead>
                  <TableHead>Estado</TableHead>
                  <TableHead>Fecha</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {payments.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="h-28 text-center text-muted-foreground">
                      {loading ? "Cargando pagos..." : "Sin pagos para este filtro."}
                    </TableCell>
                  </TableRow>
                ) : payments.map((payment) => (
                  <TableRow key={payment.id}>
                    <TableCell className="font-mono text-sm">{payment.id}</TableCell>
                    <TableCell>
                      <div className="text-sm font-medium">{payment.user?.name || payment.user?.email || payment.userId}</div>
                      {payment.user?.email ? <div className="text-xs text-muted-foreground">{payment.user.email}</div> : null}
                    </TableCell>
                    <TableCell className="font-medium">{formatCurrency(payment.amount, payment.currency || "USD")}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{payment.plan || "N/A"}</Badge>
                    </TableCell>
                    <TableCell className="capitalize">{payment.provider || "N/A"}</TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(payment.status)}>{payment.status}</Badge>
                    </TableCell>
                    <TableCell>{formatDate(payment.createdAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
