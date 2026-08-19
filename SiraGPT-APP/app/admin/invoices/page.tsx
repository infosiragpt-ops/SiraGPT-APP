"use client"

import { useEffect, useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Download, ExternalLink, FileText } from 'lucide-react'
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
  user?: { id: string; name: string | null; email: string } | null
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
      toast.error('Failed to load invoices')
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
      toast.error(e.message || 'Download failed')
    }
  }

  return (
    <div className="flex-1 space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-2"><FileText className="h-6 w-6"/>Invoices</h1>
          <p className="text-muted-foreground">All Stripe invoices across the platform</p>
        </div>
        <Button variant="outline" onClick={load}>Refresh</Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Invoices</CardTitle>
          <CardDescription>Total: {invoices.length}</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="p-8">Loading…</div>
          ) : invoices.length === 0 ? (
            <div className="rounded-lg border p-8 text-center text-sm text-muted-foreground">No invoices found</div>
          ) : (
            <>
            {/* Desktop/tablet table; phones get the card list below. */}
            <div className="hidden border rounded-lg overflow-x-auto md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Invoice #</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Amount</TableHead>
                    <TableHead>User</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {invoices.map(inv => (
                    <TableRow key={inv.id}>
                      <TableCell>{new Date(inv.created).toLocaleString()}</TableCell>
                      <TableCell className="font-mono">{inv.number || inv.id}</TableCell>
                      <TableCell>
                        <Badge variant={(inv.status || '').toUpperCase() === 'PAID' ? 'default' : 'secondary'}>
                          {(inv.status || '').toUpperCase() || 'UNKNOWN'}
                        </Badge>
                      </TableCell>
                      <TableCell>${Number(inv.amountPaid ?? 0).toFixed(2)} {inv.currency?.toUpperCase?.()}</TableCell>
                      <TableCell>
                        {inv.user ? (
                          <div className="flex flex-col text-sm">
                            <span>{inv.user.name || inv.user.email}</span>
                            <span className="text-muted-foreground">{inv.user.email}</span>
                          </div>
                        ) : (
                          <span className="text-muted-foreground">Unknown</span>
                        )}
                      </TableCell>
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
                      {(inv.status || '').toUpperCase() || 'UNKNOWN'}
                    </Badge>
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-2 text-sm">
                    <span className="font-medium">${Number(inv.amountPaid ?? 0).toFixed(2)} {inv.currency?.toUpperCase?.()}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{new Date(inv.created).toLocaleString()}</span>
                  </div>
                  <div className="mt-1 truncate text-xs text-muted-foreground">
                    {inv.user ? (inv.user.name || inv.user.email) : 'Unknown'}
                  </div>
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
    </div>
  )
}
