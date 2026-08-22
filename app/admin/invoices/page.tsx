"use client"

import { AdminPageHeader, AdminPageBody } from "@/components/admin/admin-chrome"

import { useEffect, useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Download, ExternalLink } from 'lucide-react'
import { apiClient } from '@/lib/api'
import { toast } from 'sonner'

interface AdminStripeInvoice {
  id: string
  number?: string
  status?: string
  amountPaid: number
  currency: string
  hostedInvoiceUrl?: string
  invoicePdf?: string
  created: string | Date
  customerEmail?: string | null
  user?: { id: string; name: string | null; email: string } | null
}

const STATUS_LABEL: Record<string, string> = {
  paid: 'Pagada',
  open: 'Abierta',
  draft: 'Borrador',
  void: 'Anulada',
  uncollectible: 'Incobrable',
}

function dash(value?: string | null) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text || null
}

function statusLabel(status?: string) {
  const key = String(status || '').trim().toLowerCase()
  if (!key) return null
  return STATUS_LABEL[key] || status!.toUpperCase()
}

export default function AdminInvoicesPage() {
  const [invoices, setInvoices] = useState<AdminStripeInvoice[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    load()
  }, [])

  const load = async () => {
    try {
      const res = await apiClient.getAdminStripeInvoices()
      setInvoices(res.invoices || [])
    } catch (e) {
      console.error(e)
      toast.error('No se pudieron cargar las facturas')
    } finally {
      setLoading(false)
    }
  }

  const download = async (id: string) => {
    try {
      const blob = await apiClient.downloadAdminStripeInvoice(id)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `invoice-${id}.pdf`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (e: any) {
      toast.error(e.message || 'No se pudo descargar')
    }
  }

  const renderEmail = (inv: AdminStripeInvoice) => {
    const email = dash(inv.customerEmail) || dash(inv.user?.email)
    if (!email) {
      return <span className="text-muted-foreground">—</span>
    }
    return (
      <span
        className="select-all whitespace-nowrap font-mono text-[13px] text-foreground/90"
        title={email}
      >
        {email}
      </span>
    )
  }

  const renderUser = (inv: AdminStripeInvoice) => {
    const name = dash(inv.user?.name)
    if (!name) {
      return <span className="text-muted-foreground">—</span>
    }
    return <span className="text-sm">{name}</span>
  }

  return (
    <>
      <AdminPageHeader
        title="Facturas"
        description="Facturas de Stripe de la plataforma"
        actions={<Button variant="outline" size="sm" className="h-8 text-[13px]" onClick={load}>Actualizar</Button>}
      />
      <AdminPageBody className="space-y-3">

      <Card>
        <CardHeader>
          <CardTitle>Facturas</CardTitle>
          <CardDescription>Total: {invoices.length}</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="p-8">Cargando…</div>
          ) : invoices.length === 0 ? (
            <div className="rounded-lg border p-8 text-center text-sm text-muted-foreground">No hay facturas</div>
          ) : (
            <>
            {/* Desktop/tablet table; phones get the card list below. */}
            <div className="hidden border rounded-lg overflow-x-auto md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Fecha</TableHead>
                    <TableHead>Factura</TableHead>
                    <TableHead>Estado</TableHead>
                    <TableHead>Importe</TableHead>
                    <TableHead>Usuario</TableHead>
                    <TableHead>Correo</TableHead>
                    <TableHead>Acciones</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {invoices.map(inv => (
                    <TableRow key={inv.id}>
                      <TableCell>{new Date(inv.created).toLocaleString()}</TableCell>
                      <TableCell className="font-mono">{inv.number || inv.id}</TableCell>
                      <TableCell>
                        <Badge variant={(inv.status || '').toUpperCase() === 'PAID' ? 'default' : 'secondary'}>
                          {statusLabel(inv.status) || '—'}
                        </Badge>
                      </TableCell>
                      <TableCell>${Number(inv.amountPaid ?? 0).toFixed(2)} {inv.currency?.toUpperCase?.()}</TableCell>
                      <TableCell>{renderUser(inv)}</TableCell>
                      <TableCell>{renderEmail(inv)}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Button size="sm" variant="outline" onClick={() => download(inv.id)}>
                            <Download className="h-3 w-3 mr-1"/> PDF
                          </Button>
                          {inv.hostedInvoiceUrl && (
                            <Button size="sm" variant="ghost" onClick={() => window.open(inv.hostedInvoiceUrl!, '_blank')}>
                              <ExternalLink className="h-3 w-3"/>
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {/* Mobile card list */}
            <div className="space-y-2 md:hidden">
              {invoices.map(inv => (
                <div key={inv.id} className="rounded-lg border bg-card p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-mono text-xs">{inv.number || inv.id}</span>
                    <Badge variant={(inv.status || '').toUpperCase() === 'PAID' ? 'default' : 'secondary'}>
                      {statusLabel(inv.status) || '—'}
                    </Badge>
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-2 text-sm">
                    <span className="font-medium">${Number(inv.amountPaid ?? 0).toFixed(2)} {inv.currency?.toUpperCase?.()}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{new Date(inv.created).toLocaleString()}</span>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {dash(inv.user?.name) || '—'}
                  </div>
                  <div className="mt-0.5">{renderEmail(inv)}</div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => download(inv.id)}>
                      <Download className="h-3 w-3 mr-1"/> PDF
                    </Button>
                    {inv.hostedInvoiceUrl && (
                      <Button size="sm" variant="ghost" onClick={() => window.open(inv.hostedInvoiceUrl!, '_blank')}>
                        <ExternalLink className="h-3 w-3 mr-1"/> Stripe
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
            </>
          )}
        </CardContent>
      </Card>
      </AdminPageBody>
    </>
  )
}
