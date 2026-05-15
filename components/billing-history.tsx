"use client"

import { useState, useEffect } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Receipt, Download, ExternalLink, Calendar, CreditCard, CheckCircle, XCircle, Clock, AlertTriangle } from 'lucide-react'
import { useAuth } from '@/lib/auth-context-integrated'
import { apiClient } from '@/lib/api'
import { toast } from 'sonner'

interface BillingRecord {
  id: string
  amount: number
  currency: string
  status: 'PENDING' | 'COMPLETED' | 'FAILED' | 'CANCELLED'
  plan: string
  provider: 'STRIPE'
  providerId?: string
  createdAt: string
  updatedAt: string
}


export default function BillingHistory() {
  const { user } = useAuth()
  const [billingData, setBillingData] = useState<BillingRecord[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchBillingHistory()
  }, [])

  const fetchBillingHistory = async () => {
    try {
      const response = await apiClient.getPayments({ page: 1, limit: 50 })
      setBillingData(response.payments || [])
    } catch (error) {
      console.error('Failed to fetch billing history:', error)
      toast.error('Failed to load billing history')
    } finally {
      setLoading(false)
    }
  }

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'COMPLETED':
        return <CheckCircle className="h-4 w-4 text-green-500" />
      case 'FAILED':
        return <XCircle className="h-4 w-4 text-red-500" />
      case 'CANCELLED':
        return <XCircle className="h-4 w-4 text-gray-500" />
      case 'PENDING':
        return <Clock className="h-4 w-4 text-yellow-500" />
      default:
        return <AlertTriangle className="h-4 w-4 text-gray-400" />
    }
  }

  const getStatusBadge = (status: string) => {
    const variants: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
      COMPLETED: "default",
      PENDING: "secondary",
      FAILED: "destructive",
      CANCELLED: "outline"
    }
    const labels: Record<string, string> = {
      COMPLETED: "Completado",
      PENDING: "Pendiente",
      FAILED: "Fallido",
      CANCELLED: "Cancelado",
    }

    return (
      <Badge variant={variants[status] || "outline"} className="flex items-center gap-1">
        {getStatusIcon(status)}
        {labels[status] || status}
      </Badge>
    )
  }

  const getProviderIcon = () => {
    return '💳' // Only Stripe supported
  }

  const handleDownloadPaymentInvoice = async (paymentId: string) => {
    try {
      const blob = await apiClient.downloadInvoice(paymentId)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `invoice-${paymentId}.pdf`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      toast.success('Invoice downloaded')
    } catch (error) {
      toast.error('Failed to download invoice')
    }
  }

  if (!user) return null

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Receipt className="h-5 w-5" />
          Billing History
        </CardTitle>
        <CardDescription>
          View your payment history and download invoices
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center justify-center p-8">
            <div className="animate-pulse">Cargando historial de facturación…</div>
          </div>
        ) : billingData.length === 0 ? (
          <div className="text-center py-8">
            <Receipt className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
            <p className="text-muted-foreground">No hay historial de facturación</p>
            <p className="text-sm text-muted-foreground mt-1">
              Tu historial de pagos aparecerá aquí en cuanto realices una compra
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Summary Cards */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="p-4 bg-muted/50 rounded-lg">
                <div className="flex items-center gap-2 mb-2">
                  <CheckCircle className="h-4 w-4 text-green-500" />
                  <span className="text-sm font-medium">Total pagado</span>
                </div>
                <p className="text-2xl font-bold">
                  ${billingData
                    .filter(p => p.status === 'COMPLETED')
                    .reduce((sum, p) => sum + p.amount, 0)
                    .toFixed(2)}
                </p>
              </div>
              
              <div className="p-4 bg-muted/50 rounded-lg">
                <div className="flex items-center gap-2 mb-2">
                  <Calendar className="h-4 w-4 text-blue-500" />
                  <span className="text-sm font-medium">Transacciones</span>
                </div>
                <p className="text-2xl font-bold">{billingData.length}</p>
              </div>
              
              <div className="p-4 bg-muted/50 rounded-lg">
                <div className="flex items-center gap-2 mb-2">
                  <CreditCard className="h-4 w-4 text-purple-500" />
                  <span className="text-sm font-medium">Plan actual</span>
                </div>
                <p className="text-lg font-semibold">{user.plan}</p>
              </div>
            </div>

            {/* Payments (App internal records) */}
            <div className="border rounded-lg overflow-hidden">
              <div className="px-4 py-3 border-b text-sm font-medium flex items-center justify-between">
                <div>
                  Pagos
                  <span className="text-muted-foreground ml-2 text-xs">(historial interno)</span>
                </div>
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Fecha</TableHead>
                    <TableHead>Monto</TableHead>
                    <TableHead>Plan</TableHead>
                    <TableHead>Proveedor</TableHead>
                    <TableHead>Estado</TableHead>
                    <TableHead>Acciones</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {billingData.map((payment) => (
                    <TableRow key={payment.id}>
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="font-medium">
                            {new Date(payment.createdAt).toLocaleDateString()}
                          </span>
                          <span className="text-sm text-muted-foreground">
                            {new Date(payment.createdAt).toLocaleTimeString()}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <span className="font-semibold">
                          ${payment.amount.toFixed(2)} {payment.currency}
                        </span>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{payment.plan}</Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <span>{getProviderIcon()}</span>
                          <span className="text-sm">Stripe</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        {getStatusBadge(payment.status)}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          {payment.status === 'COMPLETED' && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => handleDownloadPaymentInvoice(payment.id)}
                            >
                              <Download className="h-3 w-3 mr-1" />
                              Factura
                            </Button>
                          )}
                    
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

          </div>
        )}
      </CardContent>
    </Card>
  )
}